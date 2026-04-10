#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  extractAssistantTurns,
  extractObservedModelHeaders
} = require(path.join(__dirname, 'run-chat-inline-proof.js'));

const DEFAULT_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'transcripts');

function escapeRegexText(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeFixtureName(name) {
  return String(name || 'runtime-transcript')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'runtime-transcript';
}

function splitTranscriptLines(transcript) {
  return String(transcript || '').split(/\r?\n/);
}

function joinTranscriptLines(input) {
  if (Array.isArray(input)) {
    return input.map((line) => String(line || '')).join('\n').trimEnd();
  }
  return String(input || '').trimEnd();
}

function extractPromptLines(transcript) {
  return splitTranscriptLines(transcript)
    .filter((line) => /^>\s/.test(line))
    .map((line) => line.replace(/^>\s*/, '').trim())
    .filter(Boolean);
}

function parseRegexLiteral(spec) {
  const text = String(spec || '').trim();
  if (!text.startsWith('/')) return null;
  const lastSlash = text.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const source = text.slice(1, lastSlash);
  const flags = text.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) return null;
  return new RegExp(source, flags);
}

function patternSpecToRegex(spec) {
  if (spec instanceof RegExp) {
    return spec;
  }

  if (typeof spec === 'string') {
    const regexLiteral = parseRegexLiteral(spec);
    if (regexLiteral) return regexLiteral;
    return new RegExp(escapeRegexText(spec), 'i');
  }

  if (spec && typeof spec === 'object' && typeof spec.regex === 'string') {
    return new RegExp(spec.regex, typeof spec.flags === 'string' ? spec.flags : '');
  }

  throw new Error(`Unsupported pattern spec: ${JSON.stringify(spec)}`);
}

function regexToPatternSpec(regex) {
  const expression = regex instanceof RegExp
    ? regex
    : patternSpecToRegex(regex);
  return {
    regex: expression.source,
    flags: expression.flags || ''
  };
}

function normalizeCountSpec(countSpec) {
  if (!countSpec || typeof countSpec !== 'object') return null;
  return {
    pattern: patternSpecToRegex(countSpec.pattern),
    exactly: Number.isFinite(countSpec.exactly) ? countSpec.exactly : undefined,
    min: Number.isFinite(countSpec.min) ? countSpec.min : undefined,
    max: Number.isFinite(countSpec.max) ? countSpec.max : undefined
  };
}

function countRuntimeToSpec(countSpec) {
  if (!countSpec || typeof countSpec !== 'object') return null;
  return {
    pattern: regexToPatternSpec(countSpec.pattern),
    ...(Number.isFinite(countSpec.exactly) ? { exactly: countSpec.exactly } : {}),
    ...(Number.isFinite(countSpec.min) ? { min: countSpec.min } : {}),
    ...(Number.isFinite(countSpec.max) ? { max: countSpec.max } : {})
  };
}

function expectationSpecToRuntime(expectation = {}) {
  return {
    name: String(expectation.name || 'unnamed expectation'),
    ...(expectation.scope ? { scope: String(expectation.scope) } : {}),
    ...(Number.isFinite(expectation.turn) ? { turn: expectation.turn } : {}),
    include: Array.isArray(expectation.include) ? expectation.include.map(patternSpecToRegex) : [],
    exclude: Array.isArray(expectation.exclude) ? expectation.exclude.map(patternSpecToRegex) : [],
    ...(Array.isArray(expectation.count)
      ? { count: expectation.count.map(normalizeCountSpec).filter(Boolean) }
      : (expectation.count ? { count: normalizeCountSpec(expectation.count) } : {}))
  };
}

function expectationRuntimeToSpec(expectation = {}) {
  return {
    name: String(expectation.name || 'unnamed expectation'),
    ...(expectation.scope ? { scope: String(expectation.scope) } : {}),
    ...(Number.isFinite(expectation.turn) ? { turn: expectation.turn } : {}),
    ...(Array.isArray(expectation.include) && expectation.include.length
      ? { include: expectation.include.map(regexToPatternSpec) }
      : {}),
    ...(Array.isArray(expectation.exclude) && expectation.exclude.length
      ? { exclude: expectation.exclude.map(regexToPatternSpec) }
      : {}),
    ...(Array.isArray(expectation.count) && expectation.count.length
      ? { count: expectation.count.map(countRuntimeToSpec).filter(Boolean) }
      : (expectation.count ? { count: countRuntimeToSpec(expectation.count) } : {}))
  };
}

function normalizeTraceMeta(traceMeta = {}) {
  if (!traceMeta || typeof traceMeta !== 'object') return null;
  return {
    sessionId: String(traceMeta.sessionId || '').trim() || null,
    source: String(traceMeta.source || '').trim() || null,
    mode: String(traceMeta.mode || '').trim() || null,
    filePath: String(traceMeta.filePath || '').trim() || null
  };
}

function normalizeContextAuthority(contextAuthority = {}) {
  if (!contextAuthority || typeof contextAuthority !== 'object') return null;
  const summary = contextAuthority.summary && typeof contextAuthority.summary === 'object'
    ? {
        compartmentKey: String(contextAuthority.summary.compartmentKey || '').trim() || null,
        repoName: String(contextAuthority.summary.repoName || '').trim() || null,
        projectRoot: String(contextAuthority.summary.projectRoot || '').trim() || null,
        appId: String(contextAuthority.summary.appId || '').trim() || null,
        processName: String(contextAuthority.summary.processName || '').trim() || null,
        surfaceClass: String(contextAuthority.summary.surfaceClass || '').trim() || null,
        interactionMode: String(contextAuthority.summary.interactionMode || '').trim() || null,
        taskFamily: String(contextAuthority.summary.taskFamily || '').trim() || null,
        confidence: String(contextAuthority.summary.confidence || '').trim() || null,
        eligibility: contextAuthority.summary.eligibility && typeof contextAuthority.summary.eligibility === 'object'
          ? {
              tradingViewPine: contextAuthority.summary.eligibility.tradingViewPine === true,
              tradingViewPineReason: String(contextAuthority.summary.eligibility.tradingViewPineReason || '').trim() || null
            }
          : null
      }
    : null;

  const hash = String(contextAuthority.hash || '').trim() || null;
  if (!summary && !hash) return null;
  return { summary, hash };
}

function normalizeTraceRewrite(rewrite = {}) {
  if (!rewrite || typeof rewrite !== 'object') return null;
  return {
    stage: String(rewrite.stage || '').trim() || null,
    rewriter: String(rewrite.rewriter || '').trim() || null,
    category: String(rewrite.category || '').trim() || null,
    reason: String(rewrite.reason || '').trim() || null,
    beforeActionCount: Number.isFinite(Number(rewrite.beforeActionCount)) ? Number(rewrite.beforeActionCount) : null,
    afterActionCount: Number.isFinite(Number(rewrite.afterActionCount)) ? Number(rewrite.afterActionCount) : null,
    contextAuthority: normalizeContextAuthority(rewrite.contextAuthority)
  };
}

function normalizeTraceCheck(check = {}) {
  if (!check || typeof check !== 'object') return null;
  return {
    kind: String(check.kind || '').trim() || null,
    status: String(check.status || '').trim() || null,
    classification: String(check.classification || '').trim() || null,
    method: String(check.method || '').trim() || null,
    targetId: String(check.targetId || '').trim() || null,
    matchReason: String(check.matchReason || '').trim() || null
  };
}

function normalizeTraceProof(proof = {}) {
  if (!proof || typeof proof !== 'object') return null;

  const observation = proof.observation && typeof proof.observation === 'object'
    ? {
        classification: String(proof.observation.classification || '').trim() || null,
        verifyKind: String(proof.observation.verifyKind || '').trim() || null,
        verifyTarget: String(proof.observation.verifyTarget || '').trim() || null,
        verified: proof.observation.verified === true,
        reason: String(proof.observation.reason || '').trim() || null,
        tradingMode: proof.observation.tradingMode && typeof proof.observation.tradingMode === 'object'
          ? {
              mode: String(proof.observation.tradingMode.mode || '').trim() || null,
              confidence: String(proof.observation.tradingMode.confidence || '').trim() || null
            }
          : null
      }
    : null;

  return {
    proofId: String(proof.proofId || '').trim() || null,
    actionType: String(proof.actionType || '').trim() || null,
    level: Number.isFinite(Number(proof.level)) ? Number(proof.level) : 0,
    levelName: String(proof.levelName || '').trim() || null,
    status: String(proof.status || '').trim() || null,
    claim: String(proof.claim || '').trim() || null,
    error: String(proof.error || '').trim() || null,
    errorCode: String(proof.errorCode || '').trim() || null,
    checks: Array.isArray(proof.checks)
      ? proof.checks.map(normalizeTraceCheck).filter(Boolean)
      : [],
    limitations: Array.isArray(proof.limitations)
      ? proof.limitations.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
    boundedClaims: Array.isArray(proof.boundedClaims)
      ? proof.boundedClaims.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
    observation,
    tradingMode: proof.tradingMode && typeof proof.tradingMode === 'object'
      ? {
          mode: String(proof.tradingMode.mode || '').trim() || null,
          confidence: String(proof.tradingMode.confidence || '').trim() || null
        }
      : null
  };
}

function normalizeTraceAction(action = {}, index = 0) {
  if (!action || typeof action !== 'object') return null;

  const proof = normalizeTraceProof(action.proof);
  const observationCheckpoint = action.observationCheckpoint && typeof action.observationCheckpoint === 'object'
    ? {
        classification: String(action.observationCheckpoint.classification || '').trim() || null,
        verifyKind: String(action.observationCheckpoint.verifyKind || '').trim() || null,
        verifyTarget: String(action.observationCheckpoint.verifyTarget || '').trim() || null,
        verified: action.observationCheckpoint.verified === true,
        reason: String(action.observationCheckpoint.reason || action.observationCheckpoint.error || '').trim() || null,
        tradingMode: action.observationCheckpoint.tradingMode && typeof action.observationCheckpoint.tradingMode === 'object'
          ? {
              mode: String(action.observationCheckpoint.tradingMode.mode || '').trim() || null,
              confidence: String(action.observationCheckpoint.tradingMode.confidence || '').trim() || null
            }
          : null
      }
    : (proof?.observation || null);

  return {
    index: Number.isFinite(Number(action.index)) ? Number(action.index) : index,
    type: String(action.type || proof?.actionType || '').trim() || null,
    reason: String(action.reason || '').trim() || null,
    targetId: String(action.targetId || '').trim() || null,
    key: String(action.key || '').trim() || null,
    text: String(action.text || '').trim() || null,
    scope: String(action.scope || '').trim() || null,
    title: String(action.title || '').trim() || null,
    processName: String(action.processName || '').trim() || null,
    success: typeof action.success === 'boolean' ? action.success : null,
    error: String(action.error || '').trim() || null,
    resolvedTarget: action.resolvedTarget && typeof action.resolvedTarget === 'object'
      ? {
          targetId: String(action.resolvedTarget.targetId || '').trim() || null,
          resolutionMethod: String(action.resolvedTarget.resolutionMethod || '').trim() || null,
          coordinateFallback: action.resolvedTarget.coordinateFallback === true,
          stale: action.resolvedTarget.stale === true,
          fallbackReason: String(action.resolvedTarget.fallbackReason || '').trim() || null
        }
      : null,
    observationCheckpoint,
    proof
  };
}

function normalizeProofExpectation(expectation = {}, index = 0) {
  if (!expectation || typeof expectation !== 'object') return null;
  return {
    name: String(expectation.name || `proof expectation ${index + 1}`),
    actionIndex: Number.isFinite(Number(expectation.actionIndex)) ? Number(expectation.actionIndex) : index,
    minProofLevel: Number.isFinite(Number(expectation.minProofLevel)) ? Number(expectation.minProofLevel) : null,
    status: String(expectation.status || '').trim() || null,
    actionType: String(expectation.actionType || '').trim() || null,
    classification: String(expectation.classification || '').trim() || null,
    verifyKind: String(expectation.verifyKind || '').trim() || null,
    targetId: String(expectation.targetId || '').trim() || null,
    requiredCheckKind: String(expectation.requiredCheckKind || '').trim() || null,
    requiredCheckStatus: String(expectation.requiredCheckStatus || '').trim() || null
  };
}

function extractExpectationCandidateLines(turnText, maxCandidates = 2) {
  return splitTranscriptLines(turnText)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8 && line.length <= 140)
    .filter((line) => !/^\{/.test(line) && !/^\[\d+\//.test(line) && !/^```/.test(line))
    .slice(0, maxCandidates);
}

function buildSuggestedExpectations(transcript, assistantTurns = []) {
  const expectations = [];

  if (/Provider:\s+\S+/i.test(transcript) || /Copilot:\s+Authenticated/i.test(transcript)) {
    const include = [];
    if (/Provider:\s+\S+/i.test(transcript)) {
      include.push({ regex: 'Provider:\\s+\\S+', flags: 'i' });
    }
    if (/Copilot:\s+Authenticated/i.test(transcript)) {
      include.push({ regex: 'Copilot:\\s+Authenticated', flags: 'i' });
    }
    expectations.push({
      name: 'TODO confirm transcript header invariants',
      scope: 'transcript',
      include,
      notes: ['Tighten or replace these header expectations if the regression is not provider/auth related.']
    });
  }

  const firstTurn = assistantTurns[0] || '';
  const candidates = extractExpectationCandidateLines(firstTurn);
  if (candidates.length > 0) {
    expectations.push({
      name: 'TODO refine first assistant turn expectation',
      turn: 1,
      include: candidates.map((line) => ({ regex: escapeRegexText(line), flags: 'i' })),
      notes: ['Generated from the first assistant turn. Replace broad text matches with tighter regression checks before relying on this fixture.']
    });
  }

  if (expectations.length === 0) {
    expectations.push({
      name: 'TODO add transcript expectations',
      notes: ['No obvious expectation candidates were inferred. Add include/exclude/count checks manually.']
    });
  }

  return expectations;
}

function normalizeFixtureEntry(name, entry = {}, filePath = null) {
  const transcript = joinTranscriptLines(entry.transcriptLines || entry.transcript || '');
  const prompts = Array.isArray(entry.prompts) && entry.prompts.length
    ? entry.prompts.map((value) => String(value || '').trim()).filter(Boolean)
    : extractPromptLines(transcript);
  const assistantTurns = Array.isArray(entry.assistantTurns) && entry.assistantTurns.length
    ? entry.assistantTurns.map((value) => String(value || '').trim()).filter(Boolean)
    : extractAssistantTurns(transcript);
  const observedHeaders = entry.observedHeaders && typeof entry.observedHeaders === 'object'
    ? entry.observedHeaders
    : extractObservedModelHeaders(transcript);
  const runtimeExpectations = Array.isArray(entry.expectations)
    ? entry.expectations.map(expectationSpecToRuntime)
    : [];
  const proofExpectations = Array.isArray(entry.proofExpectations)
    ? entry.proofExpectations.map(normalizeProofExpectation).filter(Boolean)
    : [];
  const traceMeta = normalizeTraceMeta(entry.traceMeta || null);
  const actions = Array.isArray(entry.actions)
    ? entry.actions.map(normalizeTraceAction).filter(Boolean)
    : [];
  const rewrites = Array.isArray(entry.rewrites)
    ? entry.rewrites.map(normalizeTraceRewrite).filter(Boolean)
    : [];

  return {
    name,
    filePath,
    description: String(entry.description || name),
    transcript,
    transcriptLines: splitTranscriptLines(transcript),
    prompts,
    assistantTurns,
    observedHeaders,
    notes: Array.isArray(entry.notes) ? entry.notes.map((note) => String(note)) : [],
    source: entry.source && typeof entry.source === 'object' ? entry.source : {},
    expectations: Array.isArray(entry.expectations) ? entry.expectations : [],
    traceMeta,
    actions,
    rewrites,
    proofExpectations: Array.isArray(entry.proofExpectations) ? entry.proofExpectations : [],
    suite: {
      description: String(entry.description || name),
      expectations: runtimeExpectations,
      proofExpectations
    }
  };
}

function listJsonFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function loadTranscriptFixtures(rootDir = DEFAULT_FIXTURE_DIR) {
  const fixtures = [];
  for (const filePath of listJsonFiles(rootDir)) {
    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [name, entry] of Object.entries(bundle)) {
      fixtures.push(normalizeFixtureEntry(name, entry, filePath));
    }
  }
  return fixtures;
}

function buildFixtureSkeleton({
  fixtureName,
  description,
  transcript,
  sourceTracePath,
  capturedAt,
  source,
  notes,
  expectations
} = {}) {
  const normalizedTranscript = joinTranscriptLines(transcript || '');
  const resolvedFixtureName = sanitizeFixtureName(
    fixtureName
      || (sourceTracePath ? path.basename(sourceTracePath, path.extname(sourceTracePath)) : 'runtime-transcript')
  );
  const prompts = extractPromptLines(normalizedTranscript);
  const assistantTurns = extractAssistantTurns(normalizedTranscript);
  const observedHeaders = extractObservedModelHeaders(normalizedTranscript);
  const expectationSpecs = Array.isArray(expectations) && expectations.length
    ? expectations.map(expectationRuntimeToSpec)
    : buildSuggestedExpectations(normalizedTranscript, assistantTurns);

  return {
    fixtureName: resolvedFixtureName,
    entry: {
      description: String(description || `Runtime transcript regression for ${resolvedFixtureName}`),
      source: {
        ...(source && typeof source === 'object' ? source : {}),
        ...(sourceTracePath ? { tracePath: sourceTracePath } : {}),
        capturedAt: String(capturedAt || new Date().toISOString()),
        observedProviders: observedHeaders.providers,
        observedRuntimeModels: observedHeaders.runtimeModels,
        observedRequestedModels: observedHeaders.requestedModels
      },
      transcriptLines: splitTranscriptLines(normalizedTranscript),
      prompts,
      assistantTurns,
      observedHeaders,
      notes: Array.isArray(notes) && notes.length
        ? notes.map((note) => String(note))
        : [
          'Review and tighten the generated expectations before relying on this fixture as a long-term regression.',
          'Prefer concise sanitized transcript snippets over full raw session dumps.'
        ],
      expectations: expectationSpecs
    }
  };
}

function upsertFixtureBundleEntry(filePath, fixtureName, entry, options = {}) {
  const overwrite = options.overwrite === true;
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const bundle = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : {};

  if (!overwrite && Object.prototype.hasOwnProperty.call(bundle, fixtureName)) {
    throw new Error(`Fixture "${fixtureName}" already exists in ${filePath}. Use overwrite=true to replace it.`);
  }

  bundle[fixtureName] = entry;
  fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return normalizeFixtureEntry(fixtureName, entry, filePath);
}

module.exports = {
  DEFAULT_FIXTURE_DIR,
  buildFixtureSkeleton,
  escapeRegexText,
  expectationRuntimeToSpec,
  expectationSpecToRuntime,
  extractExpectationCandidateLines,
  extractPromptLines,
  joinTranscriptLines,
  loadTranscriptFixtures,
  normalizeFixtureEntry,
  patternSpecToRegex,
  regexToPatternSpec,
  sanitizeFixtureName,
  splitTranscriptLines,
  upsertFixtureBundleEntry
};