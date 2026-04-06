#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { createRuntimeTraceLog } = require(path.join(__dirname, '..', 'src', 'main', 'traces', 'runtime-trace-log.js'));
const { LIKU_HOME, ensureLikuStructure } = require(path.join(__dirname, '..', 'src', 'shared', 'liku-home.js'));
const {
  buildRuntimeTraceFixtureEntry,
  readRuntimeTraceEntries
} = require(path.join(__dirname, 'extract-runtime-trace-regression.js'));
const {
  DEFAULT_FIXTURE_DIR,
  upsertFixtureBundleEntry
} = require(path.join(__dirname, 'transcript-regression-fixtures.js'));

const FIXTURE_FILE = path.join(DEFAULT_FIXTURE_DIR, 'runtime-proof-regressions.json');
const TRACE_ALIAS_PREFIX = 'runtime://generated';

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function buildTraceFilePath(sessionId) {
  return path.join(LIKU_HOME, 'traces', `${sessionId}.jsonl`);
}

async function withPatchedSystemAutomation(overrides, fn) {
  const systemAutomation = aiService.systemAutomation;
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = systemAutomation[key];
    systemAutomation[key] = value;
  }

  try {
    return await fn(systemAutomation);
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      systemAutomation[key] = value;
    }
  }
}

function buildPanelOpenActionResult(action) {
  return {
    success: true,
    action: action.type,
    message: 'clicked',
    resolvedTarget: {
      targetId: action.targetId,
      resolutionMethod: 'clickPoint',
      resolvedPoint: { x: 42, y: 84 },
      stale: false,
      coordinateFallback: false,
      window: {
        appName: 'TradingView',
        windowTitle: 'Pine Editor - TradingView',
        pid: 321
      }
    },
    proof: {
      proofId: 'proof-panel-open-base',
      actionType: action.type,
      level: 1,
      levelName: 'target-grounded',
      status: 'verified',
      checks: [{
        kind: 'target-resolution',
        status: 'pass',
        targetId: action.targetId,
        method: 'clickPoint'
      }],
      limitations: []
    }
  };
}

function buildDomainKeyActionResult(action, proofId) {
  return {
    success: true,
    action: action.type,
    message: 'confirmed',
    proof: {
      proofId,
      actionType: action.type,
      level: 0,
      levelName: 'executed',
      status: 'bounded',
      checks: [],
      limitations: []
    }
  };
}

const CASES = [
  {
    fixtureName: 'runtime-proof-panel-open',
    description: 'Runtime proof regression for an inspect-grounded click that opens the Pine Editor surface.',
    notes: [
      'Represents the stable effect-verified proof contract for a surface-open TradingView action.'
    ],
    proofExpectationName: 'panel open click is effect-verified',
    expectedActionHints: ['Pine Editor'],
    userMessage: 'open the pine editor',
    actionPlan: {
      thought: 'Open the Pine Editor surface',
      verification: 'The Pine Editor should be visible',
      actions: [{
        type: 'click',
        targetId: 'region-1',
        reason: 'Open Pine Editor',
        verify: {
          kind: 'panel-open',
          target: 'pine-editor',
          appName: 'TradingView',
          titleHints: ['Pine Editor'],
          keywords: ['Pine Editor']
        }
      }]
    },
    foreground: {
      success: true,
      hwnd: 330552,
      title: 'Pine Editor - TradingView',
      processName: 'tradingview',
      windowKind: 'main'
    },
    actionExecutor: async (action) => buildPanelOpenActionResult(action),
    expected: {
      level: 2,
      status: 'verified',
      classification: 'panel-open',
      verifyKind: 'panel-open',
      requiredCheckKind: 'observation-checkpoint',
      requiredCheckStatus: 'pass'
    }
  },
  {
    fixtureName: 'runtime-proof-timeframe-updated',
    description: 'Runtime proof regression for explicit TradingView timeframe verification promoted to domain proof.',
    notes: [
      'Represents a level-3 TradingView domain proof for timeframe confirmation.'
    ],
    proofExpectationName: 'timeframe update is domain-verified',
    expectedActionHints: ['5m'],
    userMessage: 'set the TradingView chart to 5m',
    actionPlan: {
      thought: 'Apply the 5m timeframe in TradingView',
      verification: 'TradingView should show the 5m timeframe',
      actions: [{
        type: 'key',
        key: 'enter',
        reason: 'Confirm the 5m timeframe in TradingView',
        verify: {
          kind: 'timeframe-updated',
          target: '5m',
          appName: 'TradingView',
          keywords: ['5m', 'timeframe', 'TradingView']
        }
      }]
    },
    foreground: {
      success: true,
      hwnd: 330552,
      title: 'BTCUSD 5m - TradingView',
      processName: 'tradingview',
      windowKind: 'main'
    },
    actionExecutor: async (action) => buildDomainKeyActionResult(action, 'proof-timeframe-updated-base'),
    expected: {
      level: 3,
      status: 'verified',
      classification: 'chart-state',
      verifyKind: 'timeframe-updated',
      requiredCheckKind: 'domain-verification',
      requiredCheckStatus: 'pass'
    }
  },
  {
    fixtureName: 'runtime-proof-symbol-updated',
    description: 'Runtime proof regression for explicit TradingView symbol verification promoted to domain proof.',
    notes: [
      'Represents a level-3 TradingView domain proof for symbol confirmation.'
    ],
    proofExpectationName: 'symbol update is domain-verified',
    expectedActionHints: ['BTCUSD'],
    userMessage: 'set the TradingView symbol BTCUSD',
    actionPlan: {
      thought: 'Apply the BTCUSD symbol in TradingView',
      verification: 'TradingView should show the BTCUSD symbol',
      actions: [{
        type: 'key',
        key: 'enter',
        reason: 'Confirm the BTCUSD symbol in TradingView',
        verify: {
          kind: 'symbol-updated',
          target: 'btcusd',
          appName: 'TradingView',
          keywords: ['BTCUSD', 'symbol', 'TradingView']
        }
      }]
    },
    foreground: {
      success: true,
      hwnd: 330552,
      title: 'BTCUSD 5m - TradingView',
      processName: 'tradingview',
      windowKind: 'main'
    },
    actionExecutor: async (action) => buildDomainKeyActionResult(action, 'proof-symbol-updated-base'),
    expected: {
      level: 3,
      status: 'verified',
      classification: 'chart-state',
      verifyKind: 'symbol-updated',
      requiredCheckKind: 'domain-verification',
      requiredCheckStatus: 'pass'
    }
  }
];

async function captureFixtureCase(caseConfig) {
  const sessionId = `${caseConfig.fixtureName}-session`;
  const traceFilePath = buildTraceFilePath(sessionId);
  fs.rmSync(traceFilePath, { force: true });

  const runtimeTraceLog = createRuntimeTraceLog({
    sessionId,
    metadata: {
      mode: 'execute',
      thought: caseConfig.actionPlan.thought,
      verification: caseConfig.actionPlan.verification,
      userMessage: caseConfig.userMessage || null,
      actionCount: Array.isArray(caseConfig.actionPlan.actions) ? caseConfig.actionPlan.actions.length : 0,
      generatedBy: 'scripts/generate-runtime-proof-fixtures.js'
    }
  });

  aiService.setUIWatcher(null);

  const execResult = await withPatchedSystemAutomation({
    focusWindow: async () => ({ success: true }),
    executeAction: async (action) => ({ success: true, action: action?.type || 'unknown', message: 'ok' }),
    getRunningProcessesByNames: async () => [],
    getForegroundWindowInfo: async () => ({ ...caseConfig.foreground })
  }, async () => aiService.executeActions(
    caseConfig.actionPlan,
    null,
    null,
    {
      userMessage: caseConfig.userMessage,
      runtimeTraceLog,
      actionExecutor: caseConfig.actionExecutor
    }
  ));

  assert.strictEqual(execResult.success, true, `${caseConfig.fixtureName} should succeed`);
  assert(execResult.runtimeTrace, `${caseConfig.fixtureName} should surface runtime trace metadata`);
  assert(Array.isArray(execResult.results) && execResult.results.length > 0, `${caseConfig.fixtureName} should emit action results`);

  const targetResult = execResult.results.find((result) => (
    String(result?.proof?.observation?.verifyKind || '') === caseConfig.expected.verifyKind
  )) || null;
  assert(targetResult, `${caseConfig.fixtureName} should emit a proof result for verifyKind ${caseConfig.expected.verifyKind}`);

  const proof = targetResult.proof;
  assert(proof, `${caseConfig.fixtureName} should emit proof`);
  assert.strictEqual(proof.level, caseConfig.expected.level, `${caseConfig.fixtureName} proof level mismatch`);
  assert.strictEqual(proof.status, caseConfig.expected.status, `${caseConfig.fixtureName} proof status mismatch`);
  assert.strictEqual(proof.observation?.classification, caseConfig.expected.classification, `${caseConfig.fixtureName} classification mismatch`);
  assert.strictEqual(proof.observation?.verifyKind, caseConfig.expected.verifyKind, `${caseConfig.fixtureName} verifyKind mismatch`);
  assert(
    Array.isArray(proof.checks) && proof.checks.some((check) => (
      String(check?.kind || '') === caseConfig.expected.requiredCheckKind
      && String(check?.status || '') === caseConfig.expected.requiredCheckStatus
    )),
    `${caseConfig.fixtureName} missing ${caseConfig.expected.requiredCheckKind}:${caseConfig.expected.requiredCheckStatus} proof check`
  );

  const entries = readRuntimeTraceEntries(traceFilePath);
  const fixtureEntry = buildRuntimeTraceFixtureEntry(entries, {
    fixtureName: caseConfig.fixtureName,
    tracePath: `${TRACE_ALIAS_PREFIX}/${caseConfig.fixtureName}.jsonl`,
    sessionId
  });

  for (const hint of (caseConfig.expectedActionHints || [])) {
    const normalizedHint = String(hint || '').trim().toLowerCase();
    if (!normalizedHint) continue;

    const hintMatched = (fixtureEntry.actions || []).some((action) => {
      const haystack = [action?.reason, action?.text, action?.title, action?.processName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedHint);
    });

    assert(hintMatched, `${caseConfig.fixtureName} should retain runtime action evidence for ${hint}`);
  }

  fixtureEntry.description = caseConfig.description;
  fixtureEntry.notes = [
    'Generated from a persisted runtime proof trace JSONL via scripts/generate-runtime-proof-fixtures.js.',
    ...(Array.isArray(caseConfig.notes) ? caseConfig.notes : [])
  ];
  fixtureEntry.source = {
    ...(fixtureEntry.source || {}),
    origin: 'runtime-proof captured session'
  };
  fixtureEntry.proofExpectations = (fixtureEntry.proofExpectations || [])
    .filter((expectation) => String(expectation.verifyKind || '') === caseConfig.expected.verifyKind)
    .map((expectation, index) => ({
    ...expectation,
    name: caseConfig.proofExpectationName || expectation.name || `proof expectation ${index + 1}`,
    verifyKind: caseConfig.expected.verifyKind || expectation.verifyKind || null,
    requiredCheckKind: caseConfig.expected.requiredCheckKind || expectation.requiredCheckKind || null,
    requiredCheckStatus: caseConfig.expected.requiredCheckStatus || expectation.requiredCheckStatus || null
    }));

  assert(fixtureEntry.proofExpectations.length > 0, `${caseConfig.fixtureName} should retain at least one stable proof expectation`);

  upsertFixtureBundleEntry(FIXTURE_FILE, caseConfig.fixtureName, fixtureEntry, { overwrite: true });

  return {
    fixtureName: caseConfig.fixtureName,
    traceFilePath,
    fixtureFile: FIXTURE_FILE,
    proofLevel: proof.level,
    verifyKind: proof.observation?.verifyKind || null
  };
}

async function main() {
  ensureLikuStructure();

  const requestedFixture = getArgValue('--fixture');
  const selectedCases = requestedFixture
    ? CASES.filter((entry) => entry.fixtureName === requestedFixture)
    : CASES;

  if (selectedCases.length === 0) {
    throw new Error(`Unknown fixture name: ${requestedFixture}`);
  }

  const results = [];
  for (const caseConfig of selectedCases) {
    results.push(await captureFixtureCase(caseConfig));
  }

  console.log(`Updated runtime proof fixtures: ${path.relative(process.cwd(), FIXTURE_FILE)}`);
  for (const result of results) {
    console.log(`- ${result.fixtureName}: level=${result.proofLevel}, verifyKind=${result.verifyKind || 'n/a'}`);
    console.log(`  trace: ${result.traceFilePath}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
