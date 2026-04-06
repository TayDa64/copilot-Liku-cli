#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_FIXTURE_DIR,
  sanitizeFixtureName,
  upsertFixtureBundleEntry
} = require(path.join(__dirname, 'transcript-regression-fixtures.js'));

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function readRuntimeTraceEntries(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildRuntimeTraceFixtureEntry(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Runtime trace is empty.');
  }

  const sessionStart = entries.find((entry) => entry.event === 'runtime:session:start') || null;
  const sessionId = String(options.sessionId || sessionStart?.session || '').trim() || `runtime-trace-${Date.now()}`;
  const plannedByIndex = new Map();
  const completeByIndex = new Map();
  const proofByIndex = new Map();

  for (const entry of entries) {
    const actionIndex = Number.isFinite(Number(entry.actionIndex)) ? Number(entry.actionIndex) : null;
    if (actionIndex === null) continue;

    if (entry.event === 'action:planned') {
      plannedByIndex.set(actionIndex, entry);
      continue;
    }

    if (entry.event === 'action:complete' || entry.event === 'action:error' || entry.event === 'action:target-resolved') {
      completeByIndex.set(actionIndex, {
        ...(completeByIndex.get(actionIndex) || {}),
        ...entry
      });
      continue;
    }

    if (entry.event === 'action:proof') {
      proofByIndex.set(actionIndex, entry);
    }
  }

  const indexes = Array.from(new Set([
    ...plannedByIndex.keys(),
    ...completeByIndex.keys(),
    ...proofByIndex.keys()
  ])).sort((left, right) => left - right);

  const actions = indexes.map((actionIndex) => {
    const planned = plannedByIndex.get(actionIndex) || {};
    const complete = completeByIndex.get(actionIndex) || {};
    const proofEntry = proofByIndex.get(actionIndex) || {};
    const plannedAction = planned.effectiveAction || planned.action || {};
    const completedAction = complete.action || {};

    return {
      index: actionIndex,
      type: completedAction.type || plannedAction.type || null,
      reason: completedAction.reason || plannedAction.reason || null,
      targetId: completedAction.targetId || plannedAction.targetId || null,
      key: completedAction.key || plannedAction.key || null,
      text: completedAction.text || plannedAction.text || null,
      scope: completedAction.scope || plannedAction.scope || null,
      title: completedAction.title || plannedAction.title || null,
      processName: completedAction.processName || plannedAction.processName || null,
      success: typeof complete.success === 'boolean' ? complete.success : null,
      error: complete.error || null,
      resolvedTarget: complete.resolvedTarget || null,
      observationCheckpoint: proofEntry.observationCheckpoint || null,
      proof: proofEntry.proof || null
    };
  });

  const proofExpectations = actions
    .filter((action) => action.proof && typeof action.proof === 'object')
    .map((action) => {
      const domainCheck = Array.isArray(action.proof?.checks)
        ? action.proof.checks.find((check) => String(check?.kind || '') === 'domain-verification' && String(check?.status || '') === 'pass')
        : null;
      const observationCheck = domainCheck || (Array.isArray(action.proof?.checks)
        ? action.proof.checks.find((check) => String(check?.kind || '') === 'observation-checkpoint' && String(check?.status || '') === 'pass')
        : null);
      return {
        name: `${action.type || 'action'} proof ${action.index}`,
        actionIndex: action.index,
        minProofLevel: Number.isFinite(Number(action.proof.level)) ? Number(action.proof.level) : 0,
        status: String(action.proof.status || '').trim() || null,
        actionType: action.type || null,
        classification: action.proof?.observation?.classification || action.observationCheckpoint?.classification || null,
        verifyKind: action.proof?.observation?.verifyKind || action.observationCheckpoint?.verifyKind || null,
        targetId: action.targetId || action.resolvedTarget?.targetId || null,
        requiredCheckKind: observationCheck ? String(observationCheck.kind || '').trim() || null : null,
        requiredCheckStatus: observationCheck ? String(observationCheck.status || '').trim() || null : null
      };
    });

  return {
    description: `Runtime proof regression for ${sanitizeFixtureName(options.fixtureName || sessionId)}`,
    source: {
      traceKind: 'runtime-proof',
      tracePath: options.tracePath || null,
      traceSessionId: sessionId,
      capturedAt: String(sessionStart?.ts || new Date().toISOString())
    },
    transcriptLines: [],
    prompts: [],
    assistantTurns: [],
    observedHeaders: {
      runtimeModels: [],
      requestedModels: [],
      providers: []
    },
    notes: [
      'Generated from runtime proof trace JSONL.',
      'Tighten proof expectations manually if only a subset of the captured actions should remain stable.'
    ],
    expectations: [],
    traceMeta: {
      sessionId,
      source: 'runtime-trace',
      mode: sessionStart?.metadata?.mode || null,
      filePath: options.tracePath || null
    },
    actions,
    proofExpectations
  };
}

function resolveOutputFile(fixtureName) {
  return path.join(DEFAULT_FIXTURE_DIR, `${sanitizeFixtureName(fixtureName || 'runtime-trace')}.json`);
}

function main() {
  const traceFile = getArgValue('--trace-file');
  if (!traceFile) {
    throw new Error('Provide --trace-file <path>.');
  }

  const entries = readRuntimeTraceEntries(traceFile);
  const requestedName = getArgValue('--fixture-name') || path.basename(traceFile, path.extname(traceFile));
  const fixtureName = sanitizeFixtureName(requestedName);
  const entry = buildRuntimeTraceFixtureEntry(entries, {
    fixtureName,
    tracePath: traceFile
  });
  const outputFile = resolveOutputFile(fixtureName);

  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ [fixtureName]: entry }, null, 2));
    return;
  }

  const stored = upsertFixtureBundleEntry(outputFile, fixtureName, entry, {
    overwrite: process.argv.includes('--overwrite')
  });
  console.log(`Saved runtime trace regression fixture: ${stored.filePath}`);
  console.log(`Fixture: ${fixtureName}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = {
  buildRuntimeTraceFixtureEntry,
  readRuntimeTraceEntries
};