#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const skillRouter = require(path.join(__dirname, '..', 'src', 'main', 'memory', 'skill-router.js'));
const reflection = require(path.join(__dirname, '..', 'src', 'main', 'telemetry', 'reflection-trigger.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 1500, intervalMs = 50) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    const value = check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  const skillId = 'test-inline-lifecycle-harness';
  try {
    skillRouter.removeSkill(skillId);

    const first = skillRouter.upsertLearnedSkill({
      idHint: skillId,
      keywords: ['apple', 'browser', 'edge'],
      tags: ['awm', 'browser'],
      scope: {
        processNames: ['msedge'],
        windowTitles: ['Apple'],
        domains: ['apple.com']
      },
      content: '# Apple direct navigation\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://www.apple.com"\n4. key: enter'
    });
    assert.strictEqual(first.entry.status, 'candidate');

    const second = skillRouter.upsertLearnedSkill({
      idHint: skillId,
      keywords: ['apple', 'browser', 'edge'],
      tags: ['awm', 'browser'],
      scope: {
        processNames: ['msedge'],
        windowTitles: ['Apple'],
        domains: ['apple.com']
      },
      content: '# Apple direct navigation\n\n1. key: ctrl+t\n2. key: ctrl+l\n3. type: "https://www.apple.com"\n4. key: enter'
    });
    assert.strictEqual(second.entry.status, 'promoted');

    const promotedSelection = skillRouter.getRelevantSkillsSelection('open apple official site in edge', {
      currentProcessName: 'msedge',
      currentWindowTitle: 'Apple - Microsoft Edge',
      currentUrlHost: 'https://www.apple.com',
      limit: 1
    });
    assert.deepStrictEqual(promotedSelection.ids, [skillId]);

    skillRouter.recordSkillOutcome([skillId], 'success', {
      currentProcessName: 'msedge',
      currentWindowTitle: 'Apple - Microsoft Edge',
      currentUrlHost: 'https://www.apple.com',
      runningPids: [4321, 8765]
    });

    const enriched = await waitFor(() => {
      const skill = skillRouter.listSkills()[skillId];
      if (!skill) return null;
      const hasHost = Array.isArray(skill.scope?.domains) && skill.scope.domains.includes('apple.com');
      const hasTitle = Array.isArray(skill.scope?.windowTitles) && skill.scope.windowTitles.includes('Apple - Microsoft Edge');
      const hasPids = Array.isArray(skill.lastEvidence?.runningPids) && skill.lastEvidence.runningPids.length === 2;
      return hasHost && hasTitle && hasPids ? skill : null;
    });

    assert(enriched, 'Skill outcome enriches scope with host/title and stores PID evidence');

    const reflectionResult = reflection.applyReflectionResult(JSON.stringify({
      rootCause: 'The learned browser skill drifted and must be suppressed after repeated failures',
      recommendation: 'skill_update',
      details: {
        skillId,
        skillAction: 'quarantine',
        keywords: ['apple', 'browser', 'failure'],
        domains: ['apple.com'],
        windowTitles: ['Apple - Microsoft Edge']
      }
    }));

    assert.strictEqual(reflectionResult.applied, true);
    assert.strictEqual(reflectionResult.action, 'skill_quarantine');

    const quarantined = await waitFor(() => {
      const skill = skillRouter.listSkills()[skillId];
      return skill && skill.status === 'quarantined' ? skill : null;
    });

    assert(quarantined, 'Reflection directly quarantines a named skill');
    assert(quarantined.reflection && quarantined.reflection.action === 'quarantine', 'Reflection metadata is stored on skill');

    const postReflectionSelection = skillRouter.getRelevantSkillsSelection('open apple official site in edge', {
      currentProcessName: 'msedge',
      currentWindowTitle: 'Apple - Microsoft Edge',
      currentUrlHost: 'https://www.apple.com',
      limit: 1
    });
    assert.strictEqual(postReflectionSelection.ids.includes(skillId), false, 'Quarantined skill is no longer selected after reflection');

    console.log('PASS skill lifecycle integration harness');
  } finally {
    skillRouter.removeSkill(skillId);
  }
}

main().catch((error) => {
  console.error('FAIL skill lifecycle integration harness');
  console.error(error.stack || error.message);
  process.exit(1);
});