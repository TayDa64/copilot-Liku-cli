#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createObservationCheckpointRuntime } = require(path.join(
  __dirname,
  '..',
  'src',
  'main',
  'ai-service',
  'observation-checkpoints.js'
));
const {
  buildVerifyTargetHintFromAppName
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js'));
const {
  extractTradingViewObservationKeywords,
  inferTradingViewTradingMode,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'verification.js'));

const TEST_TIMEOUT_MS = 30000;
const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL observation checkpoint host proof timed out after ${TEST_TIMEOUT_MS}ms`);
  process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

function buildTradingViewForeground(overrides = {}) {
  return {
    success: true,
    hwnd: 777,
    title: 'MN / Unnamed',
    processName: 'TradingView',
    windowKind: 'main',
    bounds: { x: 911, y: 8, width: 1016, height: 956 },
    ...overrides
  };
}

async function main() {
  await test('inferKeyObservationCheckpoint keeps Pine save shortcuts window-flexible while targeting pine-editor status', async () => {
    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => buildTradingViewForeground()
      },
      getUIWatcher: () => null,
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: () => ({
        matched: true,
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const checkpoint = runtime.inferKeyObservationCheckpoint({
      type: 'key',
      key: 'ctrl+s',
      reason: 'Save the freshly created Pine script before adding it to the chart',
      verify: {
        kind: 'status-visible',
        appName: 'TradingView',
        target: 'pine-editor',
        keywords: ['pine', 'save', 'save script', 'script name'],
        windowKinds: ['owned', 'palette', 'main'],
        requiresObservedChange: false
      }
    }, {
      thought: 'Create and save a fresh TradingView Pine script',
      verification: 'TradingView should keep Pine Editor active and show save-state evidence'
    }, 0, {
      userMessage: 'Create and save a fresh TradingView Pine script'
    });

    assert.strictEqual(checkpoint?.classification, 'input-surface-open');
    assert.strictEqual(checkpoint?.verifyKind, 'status-visible');
    assert.strictEqual(checkpoint?.verifyTarget, 'pine-editor');
    assert.strictEqual(checkpoint?.allowWindowHandleChange, true);
    assert.strictEqual(checkpoint?.requiresObservedChange, false);
    assert.strictEqual(checkpoint?.expectedWindowKinds.includes('owned'), true);
    assert.strictEqual(checkpoint?.expectedKeywords.includes('pine'), true);
  });

  await test('verifyKeyObservationCheckpoint accepts host Pine surface proof when watcher freshness times out', async () => {
    const foreground = buildTradingViewForeground();
    let hostProbeCalls = 0;

    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: true,
            anchorText: 'Add to chart',
            visibleAnchors: ['Add to chart', 'Publish script'],
            matchedBy: 'uia-host-pine-surface-header-scan',
            foreground
          };
        }
      },
      getUIWatcher: () => ({
        isPolling: true,
        cache: {
          lastUpdate: Date.now() - 5000,
          activeWindow: foreground,
          elements: []
        },
        waitForFreshState: async () => ({
          fresh: false,
          timedOut: true,
          immediate: false,
          activeWindow: foreground,
          lastUpdate: Date.now()
        })
      }),
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: (candidate) => ({
        matched: /tradingview/i.test(String(candidate?.processName || '')),
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const result = await runtime.verifyKeyObservationCheckpoint({
      applicable: true,
      classification: 'editor-active',
      appName: 'TradingView',
      verifyKind: 'editor-active',
      verifyTarget: 'pine-editor',
      verifyTargetHint: buildVerifyTargetHintFromAppName('TradingView'),
      domainProofEligible: false,
      tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
      requiresObservedChange: true,
      allowWindowHandleChange: false,
      timeoutMs: 1400,
      expectedKeywords: ['pine', 'pine editor', 'script', 'add to chart'],
      expectedWindowKinds: ['main'],
      reason: 'Open TradingView Pine Editor'
    }, foreground, {
      expectedWindowHandle: 777
    });

    assert.strictEqual(result?.verified, true);
    assert.strictEqual(result?.editorActiveMatched, true);
    assert.strictEqual(result?.hostSurfaceMatched, true);
    assert.strictEqual(result?.hostSurfaceAnchor, 'Add to chart');
    assert.strictEqual(result?.watcherSurfaceMatched, false);
    assert.strictEqual(result?.matchReason, 'pine-editor-surface-probe');
    assert.strictEqual(result?.pineEditorSurfaceProbe?.matchedBy, 'uia-host-pine-surface-header-scan');
    assert.strictEqual(result?.hostSurfaceProbeDecision?.reason, 'watcher-timeout');
    assert.strictEqual(hostProbeCalls >= 1, true);
  });

  await test('verifyKeyObservationCheckpoint rejects stale save-confirmed Pine proof for fresh-script activation', async () => {
    const foreground = buildTradingViewForeground();
    let hostProbeCalls = 0;

    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: true,
            anchorText: 'All changes saved',
            visibleAnchors: ['All changes saved'],
            visibleAnchorEntries: [{
              text: 'All changes saved',
              observedText: 'All changes saved',
              category: 'save-confirmed',
              source: 'dom-node'
            }],
            matchedBy: 'chromium-cdp-dom',
            foreground
          };
        }
      },
      getUIWatcher: () => ({
        isPolling: true,
        cache: {
          lastUpdate: Date.now(),
          activeWindow: foreground,
          elements: []
        },
        waitForFreshState: async () => ({
          fresh: false,
          timedOut: false,
          immediate: false,
          activeWindow: foreground,
          lastUpdate: Date.now()
        })
      }),
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: (candidate) => ({
        matched: /tradingview/i.test(String(candidate?.processName || '')),
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const result = await runtime.verifyKeyObservationCheckpoint({
      applicable: true,
      classification: 'editor-active',
      appName: 'TradingView',
      verifyKind: 'editor-active',
      verifyTarget: 'pine-editor',
      verifyTargetHint: buildVerifyTargetHintFromAppName('TradingView'),
      domainProofEligible: false,
      tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
      pineSurfaceExpectation: 'fresh-script',
      requiresObservedChange: true,
      allowWindowHandleChange: false,
      timeoutMs: 1400,
      expectedKeywords: ['pine', 'pine editor', 'script'],
      expectedWindowKinds: ['main'],
      reason: 'Create a fresh Pine indicator before inserting the prepared script'
    }, foreground, {
      expectedWindowHandle: 777
    });

    assert.strictEqual(result?.verified, false);
    assert.strictEqual(result?.hostSurfaceMatched, true);
    assert.strictEqual(result?.pineSurfaceExpectationMatched, false);
    assert.strictEqual(result?.pineSurfaceExpectationEvidence?.genericSavedSurfaceOnly, true);
    assert.strictEqual(result?.hostSurfaceAnchor, 'All changes saved');
    assert.strictEqual(hostProbeCalls >= 1, true);
    assert(/fresh Pine starter surface/i.test(String(result?.error || '')));
  });

  await test('verifyKeyObservationCheckpoint accepts starter-state Pine proof for fresh-script activation', async () => {
    const foreground = buildTradingViewForeground();
    let hostProbeCalls = 0;

    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: true,
            anchorText: 'My Script',
            visibleAnchors: ['My Script', 'Add to chart'],
            visibleAnchorEntries: [
              {
                text: 'My Script',
                observedText: 'My Script',
                category: 'starter',
                source: 'dom-node'
              },
              {
                text: 'Add to chart',
                observedText: 'Add to chart',
                category: 'surface',
                source: 'dom-node'
              }
            ],
            matchedBy: 'chromium-cdp-dom',
            foreground
          };
        }
      },
      getUIWatcher: () => ({
        isPolling: true,
        cache: {
          lastUpdate: Date.now() - 5000,
          activeWindow: foreground,
          elements: []
        },
        waitForFreshState: async () => ({
          fresh: false,
          timedOut: true,
          immediate: false,
          activeWindow: foreground,
          lastUpdate: Date.now()
        })
      }),
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: (candidate) => ({
        matched: /tradingview/i.test(String(candidate?.processName || '')),
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const result = await runtime.verifyKeyObservationCheckpoint({
      applicable: true,
      classification: 'editor-active',
      appName: 'TradingView',
      verifyKind: 'editor-active',
      verifyTarget: 'pine-editor',
      verifyTargetHint: buildVerifyTargetHintFromAppName('TradingView'),
      domainProofEligible: false,
      tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
      pineSurfaceExpectation: 'fresh-script',
      requiresObservedChange: true,
      allowWindowHandleChange: false,
      timeoutMs: 1400,
      expectedKeywords: ['pine', 'pine editor', 'script', 'my script'],
      expectedWindowKinds: ['main'],
      reason: 'Create a fresh Pine indicator before inserting the prepared script'
    }, foreground, {
      expectedWindowHandle: 777
    });

    assert.strictEqual(result?.verified, true);
    assert.strictEqual(result?.hostSurfaceMatched, true);
    assert.strictEqual(result?.pineSurfaceExpectationMatched, true);
    assert.strictEqual(result?.pineSurfaceExpectationEvidence?.starterVisible, true);
    assert.strictEqual(result?.hostSurfaceAnchor, 'My Script');
    assert.strictEqual(result?.matchReason, 'pine-editor-surface-probe');
    assert.strictEqual(hostProbeCalls >= 1, true);
  });

  await test('verifyKeyObservationCheckpoint accepts Pine save-status host proof and probes the live foreground hwnd when handles can change', async () => {
    const beforeForeground = buildTradingViewForeground({
      hwnd: 777,
      title: 'MN / Unnamed',
      windowKind: 'main'
    });
    const foreground = buildTradingViewForeground({
      hwnd: 778,
      title: 'Save script',
      windowKind: 'owned'
    });
    let hostProbeCalls = 0;
    let probedWindowHandle = 0;

    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async (options = {}) => {
          hostProbeCalls += 1;
          probedWindowHandle = Number(options?.windowHandle || 0) || 0;
          return {
            active: true,
            anchorText: 'All changes saved',
            visibleAnchors: ['All changes saved', 'My Script'],
            matchedBy: 'chromium-cdp-dom',
            foreground
          };
        }
      },
      getUIWatcher: () => ({
        isPolling: true,
        cache: {
          lastUpdate: Date.now() - 5000,
          activeWindow: foreground,
          elements: []
        },
        waitForFreshState: async () => ({
          fresh: false,
          timedOut: true,
          immediate: false,
          activeWindow: foreground,
          lastUpdate: Date.now()
        })
      }),
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: (candidate) => ({
        matched: /tradingview/i.test(String(candidate?.processName || '')),
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const result = await runtime.verifyKeyObservationCheckpoint({
      applicable: true,
      classification: 'input-surface-open',
      appName: 'TradingView',
      verifyKind: 'status-visible',
      verifyTarget: 'pine-editor',
      verifyTargetHint: buildVerifyTargetHintFromAppName('TradingView'),
      domainProofEligible: false,
      tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
      requiresObservedChange: false,
      allowWindowHandleChange: true,
      timeoutMs: 1400,
      expectedKeywords: ['pine', 'save', 'save script', 'script name', 'all changes saved'],
      expectedWindowKinds: ['owned', 'palette', 'main'],
      reason: 'Save the freshly created Pine script before adding it to the chart'
    }, beforeForeground, {
      expectedWindowHandle: 777
    });

    assert.strictEqual(result?.verified, true);
    assert.strictEqual(result?.hostSurfaceMatched, true);
    assert.strictEqual(result?.hostSurfaceAnchor, 'All changes saved');
    assert.strictEqual(result?.watcherSurfaceMatched, false);
    assert.strictEqual(result?.matchReason, 'pine-editor-surface-probe');
    assert.strictEqual(result?.hostSurfaceProbeDecision?.reason, 'watcher-timeout');
    assert.strictEqual(hostProbeCalls >= 1, true);
    assert.strictEqual(probedWindowHandle, 778);
  });

  await test('verifyKeyObservationCheckpoint verifies Pine Editor from fresh watcher anchors without a host probe', async () => {
    const foreground = buildTradingViewForeground();
    let hostProbeCalls = 0;

    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: true,
            anchorText: 'Add to chart',
            foreground
          };
        }
      },
      getUIWatcher: () => ({
        isPolling: true,
        cache: {
          lastUpdate: Date.now(),
          activeWindow: foreground,
          elements: [
            {
              name: 'Add to chart',
              type: 'Button',
              windowHandle: 777,
              bounds: { x: 100, y: 100, width: 120, height: 32 }
            }
          ]
        },
        waitForFreshState: async () => ({
          fresh: false,
          timedOut: false,
          immediate: false,
          activeWindow: foreground,
          lastUpdate: Date.now()
        })
      }),
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: (candidate) => ({
        matched: /tradingview/i.test(String(candidate?.processName || '')),
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const result = await runtime.verifyKeyObservationCheckpoint({
      applicable: true,
      classification: 'editor-active',
      appName: 'TradingView',
      verifyKind: 'editor-active',
      verifyTarget: 'pine-editor',
      verifyTargetHint: buildVerifyTargetHintFromAppName('TradingView'),
      domainProofEligible: false,
      tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
      requiresObservedChange: true,
      allowWindowHandleChange: false,
      timeoutMs: 1400,
      expectedKeywords: ['pine', 'pine editor', 'script', 'add to chart'],
      expectedWindowKinds: ['main'],
      reason: 'Open TradingView Pine Editor'
    }, foreground, {
      expectedWindowHandle: 777
    });

    assert.strictEqual(result?.verified, true);
    assert.strictEqual(result?.watcherSurfaceMatched, true);
    assert.strictEqual(result?.watcherSurfaceAnchor, 'add to chart');
    assert.strictEqual(result?.hostSurfaceMatched, false);
    assert.strictEqual(result?.hostSurfaceProbeDecision?.reason, 'watcher-surface-matched');
    assert.strictEqual(hostProbeCalls, 0);
  });

  await test('verifyKeyObservationCheckpoint fails cheaply when watcher state is stable with no Pine delta', async () => {
    const foreground = buildTradingViewForeground();
    let hostProbeCalls = 0;

    const runtime = createObservationCheckpointRuntime({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: true,
            anchorText: 'Add to chart',
            foreground
          };
        }
      },
      getUIWatcher: () => ({
        isPolling: true,
        cache: {
          lastUpdate: Date.now(),
          activeWindow: foreground,
          elements: []
        },
        waitForFreshState: async () => ({
          fresh: false,
          timedOut: false,
          immediate: false,
          activeWindow: foreground,
          lastUpdate: Date.now()
        })
      }),
      sleepMs: async () => {},
      evaluateForegroundAgainstTarget: (candidate) => ({
        matched: /tradingview/i.test(String(candidate?.processName || '')),
        matchReason: 'process',
        popupHint: null,
        needsFollowUp: false
      }),
      inferLaunchVerificationTarget: () => buildVerifyTargetHintFromAppName('TradingView'),
      observationProviders: [{
        toolName: 'tradingview',
        buildVerifyTargetHint: buildVerifyTargetHintFromAppName,
        extractObservationKeywords: extractTradingViewObservationKeywords,
        inferTradingMode: inferTradingViewTradingMode,
        inferObservationSpec: inferTradingViewObservationSpec,
        isTargetHint: isTradingViewTargetHint
      }]
    });

    const result = await runtime.verifyKeyObservationCheckpoint({
      applicable: true,
      classification: 'editor-active',
      appName: 'TradingView',
      verifyKind: 'editor-active',
      verifyTarget: 'pine-editor',
      verifyTargetHint: buildVerifyTargetHintFromAppName('TradingView'),
      domainProofEligible: false,
      tradingModeHint: { mode: 'unknown', confidence: 'low', evidence: [] },
      requiresObservedChange: true,
      allowWindowHandleChange: false,
      timeoutMs: 1400,
      expectedKeywords: ['pine', 'pine editor', 'script', 'add to chart'],
      expectedWindowKinds: ['main'],
      reason: 'Open TradingView Pine Editor'
    }, foreground, {
      expectedWindowHandle: 777
    });

    assert.strictEqual(result?.verified, false);
    assert.strictEqual(result?.watcherSurfaceMatched, false);
    assert.strictEqual(result?.hostSurfaceMatched, false);
    assert.strictEqual(result?.hostSurfaceProbeDecision?.reason, 'watcher-stable-no-delta');
    assert.strictEqual(hostProbeCalls, 0);
  });
}

main().catch((error) => {
  console.error('FAIL observation checkpoint host proof');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(() => {
  clearTimeout(forcedExitTimer);
});
