const assert = require('assert');
const { createObservationCheckpointRuntime } = require('../src/main/ai-service/observation-checkpoints.js');

function createForeground() {
  return {
    success: true,
    hwnd: 777,
    title: 'LUNR / Unnamed',
    processName: 'TradingView',
    windowKind: 'main'
  };
}

function createWatcher() {
  return {
    isPolling: true,
    cache: {
      lastUpdate: Date.now(),
      activeWindow: createForeground(),
      elements: []
    },
    waitForFreshState: async () => ({
      fresh: true,
      timedOut: false,
      immediate: false,
      lastUpdate: Date.now(),
      activeWindow: createForeground()
    })
  };
}

function createVerifyTargetHint() {
  return {
    appName: 'TradingView',
    processNames: ['tradingview'],
    popupKeywords: [],
    titleHints: ['TradingView'],
    dialogTitleHints: ['Pine Editor'],
    pineKeywords: ['pine', 'pine editor', 'script', 'add to chart', 'publish script'],
    chartKeywords: ['chart'],
    indicatorKeywords: ['indicator'],
    preferredWindowKinds: ['main'],
    dialogWindowKinds: ['main']
  };
}

function createSpec() {
  return {
    applicable: true,
    classification: 'editor-active',
    appName: 'TradingView',
    verifyKind: 'editor-active',
    verifyTarget: 'pine-editor',
    domainProofEligible: false,
    tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
    requiresObservedChange: true,
    allowWindowHandleChange: false,
    timeoutMs: 25,
    verifyTargetHint: createVerifyTargetHint(),
    expectedKeywords: ['pine', 'pine editor', 'script'],
    expectedWindowKinds: ['main'],
    reason: 'test Pine editor checkpoint proof'
  };
}

function createActivationSpec() {
  return {
    ...createSpec(),
    key: 'enter',
    routeId: 'open-pine-editor',
    route: 'quick-search',
    preferRecoveryOverTextProbe: true
  };
}

function createRuntime(probeResult, tracker) {
  const watcher = createWatcher();
  return createObservationCheckpointRuntime({
    systemAutomation: {
      getForegroundWindowInfo: async () => createForeground(),
      executeAction: async (action) => {
        tracker.calls.push(action);
        return probeResult;
      }
    },
    getUIWatcher: () => watcher,
    sleepMs: async () => {},
    evaluateForegroundAgainstTarget: () => ({
      matched: true,
      matchReason: 'same-process',
      needsFollowUp: false,
      popupHint: null
    }),
    inferLaunchVerificationTarget: () => ({ appName: 'TradingView' }),
    buildVerifyTargetHintFromAppName: () => createVerifyTargetHint(),
    extractTradingViewObservationKeywords: () => [],
    inferTradingViewTradingMode: () => ({ mode: 'unknown', confidence: 'low', evidence: [] }),
    inferTradingViewObservationSpec: () => null,
    isTradingViewTargetHint: () => true,
    keyCheckpointSettleMs: 0,
    keyCheckpointTimeoutMs: 25,
    keyCheckpointMaxPolls: 1
  });
}

async function testStrongPineTextProbePasses() {
  const tracker = { calls: [] };
  const runtime = createRuntime({
    success: true,
    text: 'Strategy Tester\nSave script',
    method: 'WatcherCache (pine-editor-fallback)',
    pineStructuredSummary: {
      compactSummary: 'status=status-only'
    }
  }, tracker);

  const result = await runtime.verifyKeyObservationCheckpoint(createSpec(), createForeground(), {
    expectedWindowHandle: 777
  });

  assert.strictEqual(result.verified, true, 'Strong Pine text evidence should verify editor-active checkpoints.');
  assert.strictEqual(result.editorActiveMatched, true, 'Strong Pine text evidence should satisfy editor-active matching.');
  assert.strictEqual(result.pineEditorTextProbeMatched, true, 'The Pine text probe should be recorded as matched.');
  assert(result.pineEditorTextProbe.strongTerms.includes('strategy tester'), 'Strong Pine text evidence should preserve matched terms.');
  assert.strictEqual(tracker.calls.length, 1, 'Exactly one bounded Pine text probe should run.');
  assert.strictEqual(tracker.calls[0].type, 'get_text', 'The checkpoint should use a non-destructive get_text probe.');
}

async function testWeakSingleStarterDoesNotPass() {
  const tracker = { calls: [] };
  const runtime = createRuntime({
    success: true,
    text: 'My Script',
    method: 'WatcherCache (pine-editor-fallback)'
  }, tracker);

  const result = await runtime.verifyKeyObservationCheckpoint(createSpec(), createForeground(), {
    expectedWindowHandle: 777
  });

  assert.strictEqual(result.verified, false, 'A lone starter label should not verify editor-active checkpoints.');
  assert.strictEqual(result.editorActiveMatched, false, 'Weak Pine text evidence should stay below the verification threshold.');
  assert.strictEqual(result.pineEditorTextProbeMatched, false, 'Weak Pine text evidence should be recorded but not counted as matched.');
  assert.strictEqual(tracker.calls.length, 1, 'Weak evidence should still come from a single bounded text probe.');
}

async function testOpenPineActivationDefersTextProbeToRecovery() {
  const tracker = { calls: [] };
  const runtime = createRuntime({
    success: true,
    text: 'Strategy Tester\nSave script',
    method: 'WatcherCache (pine-editor-fallback)'
  }, tracker);

  const result = await runtime.verifyKeyObservationCheckpoint(createActivationSpec(), createForeground(), {
    expectedWindowHandle: 777
  });

  assert.strictEqual(result.verified, false, 'Activation checkpoints should fail fast when Pine surface is not yet proven.');
  assert.strictEqual(result.pineEditorTextProbeMatched, false, 'No Pine text probe should be counted during fast-fail activation checkpoints.');
  assert.strictEqual(result.pineEditorTextProbe?.skipped, true, 'Activation checkpoints should record that the Pine text probe was intentionally skipped.');
  assert.strictEqual(result.pineEditorTextProbe?.reason, 'defer-to-pine-editor-recovery', 'Skipped activation probes should explain the recovery hand-off.');
  assert.strictEqual(tracker.calls.length, 0, 'Activation checkpoints should defer the bounded text probe entirely and let recovery handle it.');
}

async function main() {
  await testStrongPineTextProbePasses();
  await testWeakSingleStarterDoesNotPass();
  await testOpenPineActivationDefersTextProbeToRecovery();
  console.log('PASS test-observation-checkpoints-pine-text-probe');
}

main().catch((error) => {
  console.error(error && (error.stack || error.message) ? (error.stack || error.message) : error);
  process.exit(1);
});
