/**
 * Reflection Trigger — RLVR feedback loop
 *
 * Evaluates failure telemetry and decides whether to invoke a Reflection
 * pass. The Reflection Agent is NOT a separate VS Code agent — it is a
 * prompt-driven pass within the existing AI service.
 *
 * When triggered, it:
 *   1. Analyzes the root cause from telemetry context
 *   2. Proposes a skill update, new negative policy, or memory note
 *   3. Returns structured JSON parsed by the caller
 *
 * Trigger conditions:
 *   - 2+ consecutive failures on the same task type
 *   - 3+ total failures in the current session
 *   - Explicit user request ("reflect", "what went wrong")
 */

const telemetryWriter = require('./telemetry-writer');
const memoryStore = require('../memory/memory-store');
const { mergeAppPolicy } = require('../preferences');

const CONSECUTIVE_FAIL_THRESHOLD = 2;
const SESSION_FAIL_THRESHOLD = 3;

// Track session-level failure counts
let sessionFailureCount = 0;
let lastTaskType = null;
let consecutiveFailCount = 0;

/**
 * Record an outcome and check if reflection should trigger.
 *
 * @param {object} telemetryPayload - The telemetry payload being recorded
 * @returns {{ shouldReflect: boolean, reason: string, failures: object[] }}
 */
function evaluateOutcome(telemetryPayload) {
  // Write telemetry first
  telemetryWriter.writeTelemetry(telemetryPayload);

  if (telemetryPayload.outcome !== 'failure') {
    // Success resets consecutive failure tracking
    if (lastTaskType === telemetryPayload.task) {
      consecutiveFailCount = 0;
    }
    return { shouldReflect: false, reason: 'success', failures: [] };
  }

  // Track failure
  sessionFailureCount++;

  if (lastTaskType === telemetryPayload.task) {
    consecutiveFailCount++;
  } else {
    lastTaskType = telemetryPayload.task;
    consecutiveFailCount = 1;
  }

  // Check trigger conditions
  if (consecutiveFailCount >= CONSECUTIVE_FAIL_THRESHOLD) {
    return {
      shouldReflect: true,
      reason: `${consecutiveFailCount} consecutive failures on same task type`,
      failures: telemetryWriter.getRecentFailures(5)
    };
  }

  if (sessionFailureCount >= SESSION_FAIL_THRESHOLD) {
    return {
      shouldReflect: true,
      reason: `${sessionFailureCount} total failures this session`,
      failures: telemetryWriter.getRecentFailures(5)
    };
  }

  return { shouldReflect: false, reason: 'below threshold', failures: [] };
}

/**
 * Build the system prompt for a reflection pass.
 *
 * @param {object[]} failures - Recent failure telemetry entries
 * @returns {string} System prompt for the reflection pass
 */
function buildReflectionPrompt(failures) {
  const failureSummary = failures.map((f, i) => {
    const actions = (f.actions || []).map(a => `  - ${a.type}: ${JSON.stringify(a)}`).join('\n');
    const verifier = f.verifier
      ? `  verifier: exit=${f.verifier.exitCode}, stderr="${f.verifier.stderr || ''}"`
      : '  verifier: none';
    return `Failure ${i + 1}:\n  task: ${f.task}\n  phase: ${f.phase}\n${actions}\n${verifier}`;
  }).join('\n\n');

  return `You are the Reflection Agent for Liku CLI. Analyze these recent failures and respond with ONLY a JSON object:

${failureSummary}

Respond with exactly this JSON structure:
{
  "rootCause": "Brief root cause analysis",
  "recommendation": "skill_update" | "negative_policy" | "memory_note" | "no_action",
  "details": {
    "skillId": "optional — ID of skill to update or create",
    "policyRule": "optional — negative policy rule to add",
    "noteContent": "optional — memory note content to record",
    "keywords": ["optional", "keywords"]
  }
}`;
}

/**
 * Parse the reflection response and apply the recommended action.
 *
 * @param {string} reflectionResponse - Raw AI response (expected JSON)
 * @returns {{ applied: boolean, action: string, detail: string }}
 */
function applyReflectionResult(reflectionResponse) {
  try {
    // Extract JSON from the response (may be wrapped in markdown)
    const jsonMatch = reflectionResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { applied: false, action: 'parse_error', detail: 'No JSON found in reflection response' };
    }

    const result = JSON.parse(jsonMatch[0]);

    switch (result.recommendation) {
      case 'memory_note': {
        if (result.details && result.details.noteContent) {
          memoryStore.addNote({
            type: 'episodic',
            content: result.details.noteContent,
            context: result.rootCause || '',
            keywords: result.details.keywords || [],
            tags: ['reflection', 'failure-analysis'],
            source: { type: 'reflection', timestamp: new Date().toISOString() }
          });
          return { applied: true, action: 'memory_note', detail: result.details.noteContent };
        }
        break;
      }

      case 'skill_update': {
        // Skill updates are deferred — we record the intent as a memory note
        // with type 'procedural' so the skill router can pick it up
        if (result.details) {
          memoryStore.addNote({
            type: 'procedural',
            content: result.details.noteContent || `Skill update needed: ${result.rootCause}`,
            context: result.rootCause || '',
            keywords: result.details.keywords || [],
            tags: ['skill-update', 'reflection'],
            source: { type: 'reflection', timestamp: new Date().toISOString() }
          });
          return { applied: true, action: 'skill_update_noted', detail: result.rootCause };
        }
        break;
      }

      case 'negative_policy': {
        // Apply negative policy to preferences AND record as a memory note
        if (result.details && result.details.policyRule) {
          // Write the policy into preferences if a target process is specified
          const processName = result.details.processName || result.details.targetApp || '_global';
          mergeAppPolicy(processName, {
            negativePolicies: [{
              rule: result.details.policyRule,
              reason: result.rootCause || 'Reflection-suggested policy',
              addedAt: new Date().toISOString(),
              source: 'reflection'
            }]
          }, { updatedBy: 'reflection-trigger' });

          // Also record in memory for contextual retrieval
          memoryStore.addNote({
            type: 'semantic',
            content: `Negative policy applied for ${processName}: ${result.details.policyRule}`,
            context: result.rootCause || '',
            keywords: result.details.keywords || [],
            tags: ['negative-policy', 'reflection', 'applied'],
            source: { type: 'reflection', timestamp: new Date().toISOString() }
          });
          return { applied: true, action: 'negative_policy_applied', detail: result.details.policyRule, processName };
        }
        break;
      }

      case 'no_action':
        return { applied: false, action: 'no_action', detail: result.rootCause || 'No action needed' };

      default:
        return { applied: false, action: 'unknown', detail: `Unknown recommendation: ${result.recommendation}` };
    }
  } catch (err) {
    return { applied: false, action: 'error', detail: err.message };
  }

  return { applied: false, action: 'incomplete', detail: 'Reflection result missing required details' };
}

/**
 * Reset session-level counters. Called on session start.
 */
function resetSession() {
  sessionFailureCount = 0;
  lastTaskType = null;
  consecutiveFailCount = 0;
}

module.exports = {
  evaluateOutcome,
  buildReflectionPrompt,
  applyReflectionResult,
  resetSession,
  CONSECUTIVE_FAIL_THRESHOLD,
  SESSION_FAIL_THRESHOLD
};
