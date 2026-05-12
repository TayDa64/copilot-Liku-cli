#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const { shutdownSharedUIAHost } = uiAutomation;
const {
  writeFailureArtifactBundle
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));

const {
  createTradingViewRuntimeRecovery
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'runtime', 'recovery.js'));
const TEST_TIMEOUT_MS = 30000;
const TEST_FILTER = String(process.env.LIKU_TEST_FILTER || '').trim().toLowerCase();
const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL tradingview runtime recovery timed out after ${TEST_TIMEOUT_MS}ms`);
  process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

async function test(name, fn) {
  if (TEST_FILTER && !String(name || '').toLowerCase().includes(TEST_FILTER)) {
    console.log(`SKIP ${name}`);
    return;
  }
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    try {
      const artifact = await writeFailureArtifactBundle({
        suiteName: 'test-tradingview-runtime-recovery',
        failureName: name,
        phase: 'test',
        error,
        extra: {
          testName: name
        }
      });
      if (artifact?.filePath) {
        console.error(`Artifact: ${artifact.filePath}`);
      }
    } catch (artifactError) {
      console.error(`Artifact capture failed: ${artifactError.message}`);
    }
    process.exitCode = 1;
  }
}

function buildTradingViewForeground() {
  return {
    success: true,
    hwnd: 777,
    title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
    processName: 'tradingview',
    windowKind: 'main'
  };
}

function buildPineRecoveryAction() {
  return {
    type: 'key',
    key: 'enter',
    verify: {
      target: 'pine-editor'
    },
    searchSurfaceContract: {
      id: 'open-pine-editor'
    }
  };
}

function buildDirectPineRecoveryAction() {
  return {
    type: 'key',
    key: 'ctrl+e',
    verify: {
      target: 'pine-editor'
    },
    tradingViewShortcut: {
      id: 'open-pine-editor',
      surface: 'pine-editor'
    }
  };
}

function buildSemanticIconPineRecoveryAction() {
  return {
    type: 'click_element',
    text: 'Pine',
    verify: {
      target: 'pine-editor'
    },
    searchSurfaceContract: {
      id: 'open-pine-editor',
      route: 'semantic-icon'
    },
    tradingViewShortcut: {
      id: 'open-pine-editor',
      surface: 'pine-editor'
    }
  };
}

function buildNewPineIndicatorRecoveryAction() {
  return {
    type: 'key',
    key: 'ctrl+i',
    verify: {
      target: 'pine-editor'
    },
    tradingViewShortcut: {
      id: 'new-pine-indicator',
      surface: 'pine-editor'
    }
  };
}

async function main() {
  await test('maybeRecoverTradingViewPineEditorOpen accepts a visible Pine surface without clicking again', async () => {
    const foreground = buildTradingViewForeground();
    const findCalls = [];
    let clickCount = 0;
    let checkpointCalls = 0;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        findElementByText: async (text, options = {}) => {
          findCalls.push({ text, options });
          if (text === 'Add to chart') {
            return {
              success: true,
              element: {
                Name: 'Add to chart',
                WindowHandle: 777,
                Bounds: { CenterX: 520, CenterY: 640 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async () => {
          clickCount += 1;
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => {
        checkpointCalls += 1;
        return { applicable: true, verified: false, foreground };
      }
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildPineRecoveryAction(),
      { applicable: true, classification: 'editor-active' },
      foreground,
      { classification: 'editor-active', verified: false },
      { expectedWindowHandle: 777 }
    );

    assert(result?.recovered, 'visible Pine surface should recover without extra interaction');
    assert.strictEqual(clickCount, 0, 'visible Pine surface should not trigger another click');
    assert.strictEqual(checkpointCalls, 0, 'visible Pine surface should not need a relaxed checkpoint retry');
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'surface-probe');
    assert.strictEqual(result?.checkpoint?.pineEditorSurfaceProbe?.text, 'Add to chart');
    assert.strictEqual(findCalls[0]?.options?.windowHandle, 777, 'surface probe should stay scoped to the foreground TradingView window');
    assert.strictEqual(findCalls[0]?.options?.foregroundOnly, true, 'surface probe should stay foreground-scoped');
  });

  await test('maybeRecoverTradingViewPineEditorOpen trusts fresh watcher Pine anchors without a host probe', async () => {
    const foreground = buildTradingViewForeground();
    let hostProbeCalls = 0;
    let checkpointCalls = 0;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: true,
            anchorText: 'Add to chart',
            foreground
          };
        },
        click: async () => {
          throw new Error('watcher-first Pine proof should not click again');
        }
      },
      getUIWatcher: () => ({
        cache: {
          lastUpdate: Date.now(),
          updateCount: 14,
          activeWindow: foreground,
          elements: [
            {
              name: 'Add to chart',
              type: 'Button',
              windowHandle: 777,
              bounds: { x: 420, y: 640, width: 120, height: 32 }
            }
          ]
        }
      }),
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => {
        checkpointCalls += 1;
        return { applicable: true, verified: false, foreground };
      }
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert(result?.recovered, 'fresh watcher Pine anchors should recover without host Pine proof');
    assert.strictEqual(checkpointCalls, 0, 'watcher Pine proof should not need a relaxed checkpoint retry');
    assert.strictEqual(hostProbeCalls, 0, 'watcher Pine proof should not call the host Pine surface probe');
    assert.strictEqual(result?.pineEditorSurfaceProbe?.matchedBy, 'watcher-pine-surface-anchor');
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'surface-probe');
  });

  await test('maybeRecoverTradingViewPineEditorOpen fails closed for ctrl+i when the TradingView command surface remains open', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    let pineProbeCalls = 0;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          pineProbeCalls += 1;
          return {
            active: true,
            anchorText: 'My Script',
            visibleAnchors: ['My Script', 'All changes saved'],
            matchedBy: 'chromium-cdp-dom',
            foreground
          };
        },
        findElementsByWindowWithHost: async (_searchText, options = {}) => {
          const normalizedControlType = String(options?.controlType || '').trim().toLowerCase();
          if (normalizedControlType === 'edit') {
            return {
              success: true,
              count: 1,
              element: {
                Name: 'Search',
                ControlType: 'ControlType.Edit',
                WindowHandle: 777,
                Bounds: { X: 330, Y: 138, Width: 365, Height: 34, CenterX: 512, CenterY: 155 }
              },
              elements: [
                {
                  Name: 'Search',
                  ControlType: 'ControlType.Edit',
                  WindowHandle: 777,
                  Bounds: { X: 330, Y: 138, Width: 365, Height: 34, CenterX: 512, CenterY: 155 }
                }
              ],
              stats: { visited: 4, timedOut: false }
            };
          }

          return {
            success: true,
            count: 2,
            element: {
              Name: 'Search tool or function',
              ControlType: 'ControlType.Text',
              WindowHandle: 777,
              Bounds: { X: 321, Y: 90, Width: 180, Height: 24, CenterX: 411, CenterY: 102 }
            },
            elements: [
              {
                Name: 'Search tool or function',
                ControlType: 'ControlType.Text',
                WindowHandle: 777,
                Bounds: { X: 321, Y: 90, Width: 180, Height: 24, CenterX: 411, CenterY: 102 }
              },
              {
                Name: 'Search',
                ControlType: 'ControlType.Edit',
                WindowHandle: 777,
                Bounds: { X: 330, Y: 138, Width: 365, Height: 34, CenterX: 512, CenterY: 155 }
              }
            ],
            stats: { visited: 4, timedOut: false }
          };
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildNewPineIndicatorRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert.strictEqual(result?.recovered, false, 'Ctrl+I proof should fail closed while command search still covers the Pine surface');
    assert.strictEqual(result?.recoveredBy, 'command-surface-open');
    assert(/Ctrl\+I left the command quick-search surface open/i.test(String(result?.error || '')), 'Failure should explain that the command surface still owns input');
    assert.strictEqual(result?.pineEditorSurfaceProbe?.matchedBy, 'chromium-cdp-dom', 'Underlying Pine DOM proof should still be captured for diagnosis');
    assert.strictEqual(result?.pineEditorCommandSurfaceProbe?.matched, true, 'The lingering command surface should be preserved in recovery metadata');
    assert.strictEqual(pineProbeCalls >= 1, true, 'Ctrl+I proof should still record the underlying Pine DOM state before failing closed');
  });

  await test('maybeRecoverTradingViewPineEditorOpen accepts ctrl+i once Pine is visible and the command surface is closed', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    let checkpointCalls = 0;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        probeTradingViewPineEditorSurface: async () => ({
          active: true,
          anchorText: 'Untitled script',
          visibleAnchors: ['Untitled script', 'Add to chart'],
          matchedBy: 'chromium-cdp-dom',
          foreground
        }),
        findElementsByWindowWithHost: async () => ({
          success: true,
          count: 0,
          element: null,
          elements: [],
          stats: { visited: 3, timedOut: false }
        })
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => {
        checkpointCalls += 1;
        return {
          applicable: true,
          verified: false,
          foreground,
          matchReason: 'process'
        };
      }
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildNewPineIndicatorRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert.strictEqual(result?.recovered, true, 'Ctrl+I proof should accept a clean Pine surface once the command surface is absent');
    assert.strictEqual(result?.recoveredBy, 'new-pine-indicator-proof');
    assert.strictEqual(result?.checkpoint?.matchReason, 'new-pine-indicator-surface-probe');
    assert.strictEqual(checkpointCalls, 0, 'Immediate Pine proof should avoid a redundant relaxed checkpoint');
  });

  await test('maybeRecoverTradingViewPineEditorOpen rejects stale save-confirmed Pine proof for ctrl+i fresh-script recovery', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    let checkpointCalls = 0;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        probeTradingViewPineEditorSurface: async () => ({
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
        }),
        findElementsByWindowWithHost: async () => ({
          success: true,
          count: 0,
          element: null,
          elements: [],
          stats: { visited: 3, timedOut: false }
        })
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => {
        checkpointCalls += 1;
        return {
          applicable: true,
          verified: false,
          foreground,
          pineSurfaceExpectation: 'fresh-script',
          pineSurfaceExpectationMatched: false,
          matchReason: 'process'
        };
      }
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildNewPineIndicatorRecoveryAction(),
      {
        applicable: true,
        classification: 'editor-active',
        requiresObservedChange: true,
        pineSurfaceExpectation: 'fresh-script'
      },
      foreground,
      {
        classification: 'editor-active',
        verified: false,
        foreground,
        pineSurfaceExpectation: 'fresh-script',
        pineSurfaceExpectationMatched: false
      },
      { expectedWindowHandle: 777 }
    );

    assert.strictEqual(result?.recovered, false, 'Ctrl+I recovery should fail closed when only a saved-state Pine probe is visible');
    assert.strictEqual(result?.recoveredBy, 'new-pine-indicator-proof');
    assert(/trustworthy Pine Editor surface for safe authoring/i.test(String(result?.error || '')));
    assert.strictEqual(result?.checkpoint?.verified, false);
    assert.strictEqual(
      result?.checkpoint?.pineEditorSurfaceProbe?.anchorText
        || result?.checkpoint?.pineEditorSurfaceProbe?.text
        || result?.pineEditorSurfaceProbe?.anchorText
        || result?.pineEditorSurfaceProbe?.text,
      'All changes saved'
    );
    assert.strictEqual(checkpointCalls >= 1, true, 'stale saved-state proof should force the relaxed checkpoint path instead of immediate recovery');
  });

  await test('maybeRecoverTradingViewPineEditorOpen does not click a generic Pine surface after Ctrl+K misses and instead retries the bounded direct route', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const findCalls = [];
    const clicks = [];
    const checkpointCalls = [];
    const keyPresses = [];
    let pineSurfaceVisible = false;
    let genericPineSurfaceClicked = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text, options = {}) => {
          findCalls.push({ text, options });
          if (pineSurfaceVisible && text === 'Add to chart') {
            return {
              success: true,
              element: {
                Name: 'Add to chart',
                WindowHandle: 777,
                Bounds: { CenterX: 520, CenterY: 640 }
              }
            };
          }
          if (!pineSurfaceVisible && text === 'Open Pine Editor') {
            return {
              success: true,
              element: {
                Name: 'Open Pine Editor',
                WindowHandle: 777,
                Bounds: { CenterX: 640, CenterY: 320 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
          if (Number(x) === 640 && Number(y) === 320) {
            genericPineSurfaceClicked = true;
          }
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+e') {
            pineSurfaceVisible = true;
          }
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async (spec, beforeForeground, options = {}) => {
        checkpointCalls.push({ spec, beforeForeground, options });
        return {
          applicable: true,
          verified: pineSurfaceVisible,
          foreground,
          matchReason: pineSurfaceVisible ? 'title' : 'process',
          observedChange: pineSurfaceVisible
        };
      }
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    const openResultCall = findCalls.find((call) => call.text === 'Open Pine Editor');

    assert.strictEqual(openResultCall, undefined, 'quick-search recovery should not probe a generic Pine result after Ctrl+K');
    assert.strictEqual(genericPineSurfaceClicked, false, 'quick-search recovery must not click a generic Pine surface outside the bounded route');
    assert(result?.recovered, 'quick-search recovery should reuse the bounded chart-focus Ctrl+E route instead of clicking a generic Pine target');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'quick-search recovery should only click the bounded chart-focus point before retrying Ctrl+E');
    assert.deepStrictEqual(keyPresses, ['escape', 'ctrl+e'], 'quick-search recovery should dismiss the command surface before retrying the bounded direct Pine shortcut');
    assert.strictEqual(checkpointCalls.length, 1, 'bounded direct retry should run one relaxed checkpoint retry');
    assert.strictEqual(result?.checkpoint?.verified, true);
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'chart-focus-ctrl-e');
    assert.strictEqual(result?.checkpoint?.pineEditorResultClick, undefined);
  });

  await test('maybeRecoverTradingViewPineEditorOpen trusts the host Pine surface proof and avoids legacy text probes during direct retry', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const findCalls = [];
    const clicks = [];
    const keyPresses = [];
    let pineSurfaceVisible = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        probeTradingViewPineEditorSurface: async () => (
          pineSurfaceVisible
            ? {
                active: true,
                anchorText: 'Add to chart',
                visibleAnchors: ['Add to chart'],
                matchedBy: 'uia-host-pine-surface-header-scan',
                foreground,
                element: {
                  Name: 'Add to chart',
                  WindowHandle: 777,
                  Bounds: { CenterX: 540, CenterY: 640 }
                }
              }
            : {
                active: false,
                foreground,
                reason: 'no-visible-pine-anchor'
              }
        ),
        findElementByText: async (text, options = {}) => {
          findCalls.push({ text, options });
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+e') {
            pineSurfaceVisible = true;
          }
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildDirectPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert(result?.recovered, 'host Pine surface proof should allow direct recovery to finish without legacy text scanning');
    assert.deepStrictEqual(findCalls, [], 'host-backed Pine proof should replace the slow legacy foreground text probes');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'direct Pine retry should still use the bounded chart-focus click once');
    assert.deepStrictEqual(keyPresses, ['ctrl+e'], 'direct Pine retry should still use the official shortcut once');
    assert.strictEqual(result?.checkpoint?.pineEditorSurfaceProbe?.matchedBy, 'uia-host-pine-surface-header-scan');
  });

  await test('maybeRecoverTradingViewPineEditorOpen reuses a cached negative Pine probe when watcher state is unchanged', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];
    let hostProbeCalls = 0;

    const watcher = {
      cache: {
        lastUpdate: Date.now(),
        updateCount: 41,
        activeWindow: foreground,
        elements: []
      }
    };

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        probeTradingViewPineEditorSurface: async () => {
          hostProbeCalls += 1;
          return {
            active: false,
            foreground,
            reason: 'no-visible-pine-anchor'
          };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
        }
      },
      getUIWatcher: () => watcher,
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert.strictEqual(result?.recovered, false, 'unchanged watcher state should keep the recovery fail-closed when Pine never appears');
    assert.strictEqual(hostProbeCalls, 1, 'unchanged watcher state should not rerun the same host Pine probe twice');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'bounded chart-focus recovery should still run once');
    assert.deepStrictEqual(keyPresses, ['escape', 'ctrl+e'], 'bounded direct recovery should still execute once');
    assert.strictEqual(result?.pineEditorSurfaceProbe, null, 'cached negative probe should remain explicit on the failing recovery result');
  });

  await test('maybeRecoverTradingViewPineEditorOpen can fall back to a bounded chart-focus Ctrl+E recovery when quick-search selection is not interactable', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];
    let pineSurfaceVisible = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text) => {
          if (pineSurfaceVisible && text === 'Add to chart') {
            return {
              success: true,
              element: {
                Name: 'Add to chart',
                WindowHandle: 777,
                Bounds: { CenterX: 540, CenterY: 640 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+e') {
            pineSurfaceVisible = true;
          }
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: pineSurfaceVisible,
        foreground,
        matchReason: pineSurfaceVisible ? 'title' : 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert(result?.recovered, 'bounded chart-focus Ctrl+E recovery should recover Pine Editor activation when quick-search selection is not interactable');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'direct Pine recovery should click the established bounded chart-focus point before Ctrl+E');
    assert.deepStrictEqual(keyPresses, ['escape', 'ctrl+e'], 'direct Pine recovery should dismiss quick search before using the official Ctrl+E shortcut');
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'chart-focus-ctrl-e');
    assert.strictEqual(result?.checkpoint?.pineEditorQuickSearchDismissal?.key, 'escape');
    assert.strictEqual(result?.checkpoint?.pineEditorDirectShortcut?.key, 'ctrl+e');
    assert.deepStrictEqual(result?.checkpoint?.pineEditorChartFocusClick?.coordinates, { x: 520, y: 382 });
  });

  await test('maybeRecoverTradingViewPineEditorOpen can retry a direct Ctrl+E opener with a bounded chart-focus recovery', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];
    let pineSurfaceVisible = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text) => {
          if (pineSurfaceVisible && text === 'Add to chart') {
            return {
              success: true,
              element: {
                Name: 'Add to chart',
                WindowHandle: 777,
                Bounds: { CenterX: 540, CenterY: 640 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+e') {
            pineSurfaceVisible = true;
          }
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: pineSurfaceVisible,
        foreground,
        matchReason: pineSurfaceVisible ? 'title' : 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildDirectPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert(result?.recovered, 'bounded direct Ctrl+E recovery should retry Pine Editor activation when the first opener was not observed');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'direct Pine recovery should re-click the bounded chart-focus point before retrying Ctrl+E');
    assert.deepStrictEqual(keyPresses, ['ctrl+e'], 'direct Pine recovery should retry the official Ctrl+E shortcut without injecting a quick-search dismissal');
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'chart-focus-ctrl-e-retry');
    assert.strictEqual(result?.checkpoint?.pineEditorQuickSearchDismissal, undefined, 'direct Ctrl+E retry should not record a quick-search dismissal step');
    assert.strictEqual(result?.checkpoint?.pineEditorDirectShortcut?.key, 'ctrl+e');
    assert.deepStrictEqual(result?.checkpoint?.pineEditorChartFocusClick?.coordinates, { x: 520, y: 382 });
  });

  await test('maybeRecoverTradingViewPineEditorOpen reuses the established chart-focus point when one was already proven', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];
    let pineSurfaceVisible = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text) => {
          if (pineSurfaceVisible && text === 'Add to chart') {
            return {
              success: true,
              element: {
                Name: 'Add to chart',
                WindowHandle: 777,
                Bounds: { CenterX: 540, CenterY: 640 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+e') {
            pineSurfaceVisible = true;
          }
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: pineSurfaceVisible,
        foreground,
        matchReason: pineSurfaceVisible ? 'title' : 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildDirectPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      {
        expectedWindowHandle: 777,
        chartFocusPoint: {
          x: 640,
          y: 410,
          windowHandle: 777
        }
      }
    );

    assert(result?.recovered, 'direct Pine recovery should still succeed when a prior bounded chart-focus point is supplied');
    assert.deepStrictEqual(clicks, [{ x: 640, y: 410, button: 'left' }], 'direct Pine recovery should reuse the previously proven chart-focus point instead of recomputing a different click');
    assert.deepStrictEqual(keyPresses, ['ctrl+e'], 'reused chart-focus recovery should still retry the official Ctrl+E shortcut once');
    assert.deepStrictEqual(result?.checkpoint?.pineEditorChartFocusClick?.coordinates, { x: 640, y: 410 });
  });

  await test('maybeRecoverTradingViewPineEditorOpen fails closed for semantic Pine activation when renderer proof is unavailable', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async () => ({ success: true, element: null }),
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildSemanticIconPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      {
        expectedWindowHandle: 777,
        activationProof: {
          observedChange: true,
          pineSurfaceObserved: false,
          disposition: 'renderer-proof-unavailable',
          likelyMeaning: 'TradingView was not launched with a remote debugging port, so Chromium renderer proof was unavailable.',
          after: { foreground }
        }
      }
    );

    assert.strictEqual(result?.recovered, false, 'semantic icon recovery should fail closed when renderer proof is unavailable');
    assert.strictEqual(result?.recoveredBy, 'renderer-proof-unavailable');
    assert.deepStrictEqual(clicks, [], 'semantic icon recovery should not click the chart again without renderer proof');
    assert.deepStrictEqual(keyPresses, [], 'semantic icon recovery should not send Ctrl+E or Ctrl+K when renderer proof is unavailable');
    assert.strictEqual(result?.checkpoint?.matchReason, 'renderer-proof-unavailable');
  });

  await test('maybeRecoverTradingViewPineEditorOpen can recover a semantic Pine icon opener with bounded chart-focus Ctrl+E retry', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];
    let pineSurfaceVisible = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text) => {
          if (pineSurfaceVisible && text === 'Add to chart') {
            return {
              success: true,
              element: {
                Name: 'Add to chart',
                WindowHandle: 777,
                Bounds: { CenterX: 540, CenterY: 640 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+e') {
            pineSurfaceVisible = true;
          }
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: pineSurfaceVisible,
        foreground,
        matchReason: pineSurfaceVisible ? 'title' : 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildSemanticIconPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert(result?.recovered, 'semantic icon opener should reuse bounded chart-focus Ctrl+E recovery when direct surface proof is unavailable');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'semantic icon recovery should click the bounded chart-focus point before Ctrl+E retry');
    assert.deepStrictEqual(keyPresses, ['ctrl+e'], 'semantic icon recovery should retry the official Ctrl+E shortcut');
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'chart-focus-ctrl-e-retry');
    assert.strictEqual(result?.checkpoint?.pineEditorDirectShortcut?.key, 'ctrl+e');
    assert.deepStrictEqual(result?.checkpoint?.pineEditorChartFocusClick?.coordinates, { x: 520, y: 382 });
  });

  await test('maybeRecoverTradingViewPineEditorOpen skips Ctrl+K fallback after semantic Pine activation already changed window state without exposing Pine', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async () => ({ success: true, element: null }),
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildSemanticIconPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      {
        classification: 'editor-active',
        verified: false,
        foreground,
        observedChange: true,
        freshObservation: true,
        hostSurfaceMatched: false,
        watcherSurfaceMatched: false
      },
      { expectedWindowHandle: 777 }
    );

    assert.strictEqual(result?.recovered, false, 'semantic icon recovery should fail closed when Pine still is not visible after the bounded direct retry');
    assert.strictEqual(result?.recoveredBy, 'chart-focus-ctrl-e-retry');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'semantic icon recovery should still try the bounded chart-focus click once');
    assert.deepStrictEqual(keyPresses, ['ctrl+e'], 'semantic icon recovery should stop after the bounded direct shortcut retry instead of sending Ctrl+K');
    assert(!keyPresses.includes('ctrl+k'), 'semantic icon recovery should not fall through into quick-search when the semantic path already changed TradingView state without exposing Pine');
  });

  await test('maybeRecoverTradingViewPineEditorOpen skips Ctrl+K fallback when semantic activation proof shows state change without a Pine surface even if the checkpoint lost observedChange', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async () => ({ success: true, element: null }),
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildSemanticIconPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      {
        classification: 'editor-active',
        verified: false,
        foreground,
        observedChange: false,
        freshObservation: false,
        hostSurfaceMatched: false,
        watcherSurfaceMatched: false
      },
      {
        expectedWindowHandle: 777,
        activationProof: {
          observedChange: true,
          pineSurfaceObserved: false,
          disposition: 'window-state-changed-without-pine-surface',
          after: { foreground }
        }
      }
    );

    assert.strictEqual(result?.recovered, false, 'semantic icon recovery should still fail closed when Pine stays unproven');
    assert.strictEqual(result?.recoveredBy, 'chart-focus-ctrl-e-retry');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }], 'semantic icon recovery should still reuse the bounded chart-focus click once');
    assert.deepStrictEqual(keyPresses, ['ctrl+e'], 'semantic icon recovery should not fall through into Ctrl+K when activation proof already proves the semantic path changed state without Pine');
    assert(!keyPresses.includes('ctrl+k'));
  });

  await test('maybeRecoverTradingViewPineEditorOpen can fall back from a failed direct Ctrl+E retry into a bounded quick-search recovery', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const clicks = [];
    const keyPresses = [];
    let quickSearchOpen = false;
    let pineSurfaceVisible = false;
    let quickSearchValue = '';
    let clipboardValue = 'original clipboard payload';

    try {
      uiAutomation.getSharedUIAHost = () => ({
        getText: async () => ({ success: true, method: 'ValuePattern', text: quickSearchValue }),
        setValue: async (_x, _y, value) => {
          quickSearchValue = String(value || '');
          return { success: true, method: 'ValuePattern', value: quickSearchValue };
        }
      });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementsByWindowWithHost: async (_searchText, options = {}) => {
            if (!quickSearchOpen) {
              return {
                success: true,
                count: 0,
                elements: [],
                stats: { visited: 0, timedOut: false }
              };
            }

            return {
              success: true,
              count: 2,
              elements: [
                {
                  Name: 'Search tool or function',
                  ControlType: 'ControlType.Text',
                  WindowHandle: 777,
                  Patterns: ['Text'],
                  Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
                },
                {
                  Name: 'Search',
                  ControlType: 'ControlType.Edit',
                  WindowHandle: 777,
                  Patterns: ['Value', 'Text'],
                  IsEnabled: true,
                  IsFocusable: true,
                  Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
                }
              ],
              stats: {
                visited: 6,
                timedOut: false
              }
            };
          },
          findElementByText: async (text, options = {}) => {
            if (pineSurfaceVisible && text === 'Add to chart') {
              return {
                success: true,
                element: {
                  Name: 'Add to chart',
                  WindowHandle: 777,
                  Bounds: { CenterX: 540, CenterY: 640 }
                }
              };
            }

            if (
              quickSearchOpen
              && text === 'Search tool or function'
              && String(options?.controlType || '').trim().toLowerCase() === 'text'
            ) {
              return {
                success: true,
                element: {
                  Name: 'Search tool or function',
                  ControlType: 'ControlType.Text',
                  WindowHandle: 777,
                  Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
                }
              };
            }

            if (
              quickSearchOpen
              && text === 'Search'
              && String(options?.controlType || '').trim().toLowerCase() === 'edit'
            ) {
              return {
                success: true,
                element: {
                  Name: 'Search',
                  ControlType: 'ControlType.Edit',
                  WindowHandle: 777,
                  Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
                }
              };
            }

            return { success: true, element: null };
          },
          click: async (x, y, button) => {
            clicks.push({ x, y, button });
          },
          pressKey: async (key) => {
            keyPresses.push(key);
            if (key === 'ctrl+k') {
              quickSearchOpen = true;
            }
            if (key === 'ctrl+c' && quickSearchOpen && quickSearchValue) {
              clipboardValue = quickSearchValue;
            }
            if (key === 'enter' && quickSearchOpen) {
              pineSurfaceVisible = true;
              quickSearchOpen = false;
            }
          },
          typeText: async (text) => {
            quickSearchValue = String(text || '');
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({
          applicable: true,
          verified: pineSurfaceVisible,
          foreground,
          matchReason: pineSurfaceVisible ? 'title' : 'process'
        })
      });

      const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
        buildDirectPineRecoveryAction(),
        { applicable: true, classification: 'editor-active', requiresObservedChange: true },
        foreground,
        { classification: 'editor-active', verified: false, foreground },
        { expectedWindowHandle: 777 }
      );

      assert(result?.recovered, 'bounded quick-search fallback should recover Pine Editor activation after a failed direct Ctrl+E retry');
      assert.strictEqual(result?.recoveredBy, 'quick-search-enter');
      assert.deepStrictEqual(
        keyPresses,
        ['ctrl+e', 'ctrl+k', 'ctrl+a', 'ctrl+c', 'enter'],
        'recovery should retry Ctrl+E once, prove or infer the command quick-search input state, then rely on the post-Enter Pine checkpoint'
      );
      assert.deepStrictEqual(clicks, [
        { x: 520, y: 382, button: 'left' },
        { x: 520, y: 166, button: 'left' }
      ], 'recovery should re-focus the chart once, then use the bounded TradingView quick-search guess lane before preflight');
      assert.strictEqual(result?.initialDirectShortcutRecovery?.recoveredBy, 'chart-focus-ctrl-e-retry');
      assert.strictEqual(result?.pineEditorQuickSearchOpen?.key, 'ctrl+k');
      assert.strictEqual(result?.pineEditorQuickSearchOpen?.success, true);
      assert.strictEqual(result?.pineEditorQuickSearchPreflight?.ready, true);
      assert.strictEqual(result?.pineEditorQuickSearchType?.success, true);
      assert.strictEqual(result?.pineEditorQuickSearchType?.method, 'SendKeys');
      assert.strictEqual(result?.pineEditorQuickSearchType?.quickSearchSemanticWrite?.success, false);
      assert.strictEqual(result?.pineEditorQuickSearchTypedVerification?.verified, false);
      assert.strictEqual(result?.pineEditorQuickSearchTypedVerification?.deferred, true);
      assert.strictEqual(result?.pineEditorQuickSearchTypedVerification?.satisfiedBy, 'post-enter-pine-checkpoint');
      assert.strictEqual(result?.pineEditorQuickSearchEnter?.success, true);
      assert.strictEqual(result?.checkpoint?.recoveredBy, 'quick-search-enter');
      assert.strictEqual(result?.checkpoint?.pineEditorSurfaceProbe?.text, 'Add to chart');
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('maybeRecoverTradingViewPineEditorOpen refuses to type Pine Editor into symbol search when command quick search is not verified', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const clicks = [];
    const keyPresses = [];
    const typedText = [];
    let symbolSearchOpen = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text, options = {}) => {
          if (
            symbolSearchOpen
            && text === 'Search'
            && String(options?.controlType || '').trim().toLowerCase() === 'edit'
          ) {
            return {
              success: true,
              element: {
                Name: 'Search',
                ControlType: 'ControlType.Edit',
                WindowHandle: 777,
                Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
              }
            };
          }
          return { success: true, element: null };
        },
        click: async (x, y, button) => {
          clicks.push({ x, y, button });
        },
        pressKey: async (key) => {
          keyPresses.push(key);
          if (key === 'ctrl+k') {
            symbolSearchOpen = true;
          }
          if (key === 'escape') {
            symbolSearchOpen = false;
          }
        },
        typeText: async (text) => {
          typedText.push(String(text || ''));
        },
        getClipboardText: async () => ({ success: true, text: 'original clipboard payload', error: null }),
        setClipboardText: async () => ({ success: true, error: null })
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({
        applicable: true,
        verified: false,
        foreground,
        matchReason: 'process'
      })
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildDirectPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false, foreground },
      { expectedWindowHandle: 777 }
    );

    assert.strictEqual(result?.recovered, false, 'symbol-search fallback should fail closed for Pine Editor activation');
    assert(/symbol search/i.test(String(result?.error || '')), 'failure should explain that Pine Editor was not typed into symbol search');
    assert.deepStrictEqual(keyPresses, ['ctrl+e', 'ctrl+k', 'escape']);
    assert.deepStrictEqual(typedText, [], 'Pine Editor must not be typed into an unverified symbol-search surface');
    assert.deepStrictEqual(clicks, [{ x: 520, y: 382, button: 'left' }]);
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping refuses Pine Editor typing on symbol-search-only surfaces', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const keyPresses = [];
    const findCalls = [];

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async (text, options = {}) => {
          findCalls.push({ text, options });
          if (
            text === 'Search'
            && String(options?.controlType || '').trim().toLowerCase() === 'edit'
          ) {
            return {
              success: true,
              element: {
                Name: 'Search',
                ControlType: 'ControlType.Edit',
                WindowHandle: 777,
                Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
              }
            };
          }
          return { success: true, element: null };
        },
        pressKey: async (key) => {
          keyPresses.push(key);
        },
        getClipboardText: async () => ({ success: true, text: 'original clipboard payload', error: null }),
        setClipboardText: async () => ({ success: true, error: null })
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
    });

    const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
      type: 'type',
      text: 'Pine Editor',
      searchSurfaceContract: {
        id: 'open-pine-editor',
        route: 'quick-search',
        surface: 'pine-editor',
        requiresCommandSurface: true
      }
    }, 777);

    assert.strictEqual(result?.applicable, true);
    assert.strictEqual(result?.ready, false, 'Pine Editor command route should fail before quick-search typing on symbol-search-only UI');
    assert(/symbol search/i.test(String(result?.error || '')), 'failure should explicitly describe symbol-search refusal');
    assert.strictEqual(result?.fallbackReason, 'command-surface-not-verified');
    assert.deepStrictEqual(keyPresses, ['escape'], 'preflight should dismiss the wrong search surface without selecting or clearing it');
    assert.strictEqual(findCalls.length, 0, 'Pine command preflight should fail closed before any legacy quick-search text probes');
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping can prove the command surface from the host focused element before typing', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const focusedCalls = [];
    const hostScanCalls = [];
    const findCalls = [];
    const clicks = [];

    uiAutomation.getSharedUIAHost = () => ({
      getText: async () => ({ success: true, method: 'ValuePattern', text: '' }),
      setValue: async (_x, _y, value) => ({ success: true, method: 'ValuePattern', value: String(value || '') })
    });

    try {
      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          getFocusedElementInWindowWithHost: async (windowHandle) => {
            focusedCalls.push(windowHandle);
            return {
              success: true,
              focused: true,
              reason: 'focused-descendant',
              element: {
                Name: 'Search tool or function',
                Value: '',
                ControlType: 'ControlType.Edit',
                WindowHandle: 777,
                Patterns: ['Value', 'Text'],
                HasKeyboardFocus: true,
                IsEnabled: true,
                IsFocusable: true,
                Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
              },
              targetWindow: foreground,
              focusedWindow: foreground,
              stats: { depth: 2, elapsedMs: 8 }
            };
          },
          findElementsByWindowWithHost: async (_searchText, options = {}) => {
            hostScanCalls.push(options);
            return {
              success: true,
              count: 0,
              elements: [],
              stats: { visited: 0, timedOut: false }
            };
          },
          findElementByText: async (text, options = {}) => {
            findCalls.push({ text, options });
            return { success: true, element: null };
          },
          click: async (x, y, button) => {
            clicks.push({ x, y, button });
          },
          getClipboardText: async () => ({ success: true, text: 'original clipboard payload', error: null }),
          setClipboardText: async () => ({ success: true, error: null })
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          id: 'open-pine-editor',
          route: 'quick-search',
          surface: 'pine-editor',
          requiresCommandSurface: true
        }
      }, 777);

      assert.strictEqual(result?.applicable, true);
      assert.strictEqual(result?.ready, true, 'focused host proof should allow Pine Editor typing to proceed');
      assert.strictEqual(result?.inputFocus?.matchedBy, 'uia-host-focused-quick-search-input', 'input focus should come from the host focused-element proof');
      assert.strictEqual(result?.inputFocus?.trustReason, 'uia-host-focused-quick-search-input');
      assert.strictEqual(result?.clearedBy, 'already-empty');
      assert.strictEqual(focusedCalls.length >= 2, true, 'command-surface verification and input focus should both query the host focused element');
      assert.strictEqual(hostScanCalls.length, 0, 'focused host proof should not widen into a bounded host scan');
      assert.strictEqual(clicks.length, 0, 'focused host proof should not click when the quick-search input is already focused');
      assert.strictEqual(findCalls.length, 0, 'focused host proof should not fall back to legacy quick-search text probes');
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping can prove the command surface from the bounded host scan before typing', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 20, y: 40, width: 1000, height: 900 }
    };
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const hostScanCalls = [];
    const findCalls = [];
    const clicks = [];

    uiAutomation.getSharedUIAHost = () => ({
      getText: async () => ({ success: true, method: 'ValuePattern', text: '' }),
      setValue: async (_x, _y, value) => ({ success: true, method: 'ValuePattern', value: String(value || '') })
    });

    try {
      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementsByWindowWithHost: async (_searchText, options = {}) => {
            hostScanCalls.push(options);
            return {
              success: true,
              count: 2,
              elements: [
                {
                  Name: 'Search tool or function',
                  ControlType: 'ControlType.Text',
                  WindowHandle: 777,
                  Patterns: ['Text'],
                  Bounds: { X: 420, Y: 118, Width: 360, Height: 28, CenterX: 600, CenterY: 132 }
                },
                {
                  Name: 'Search',
                  Value: '',
                  ControlType: 'ControlType.Edit',
                  WindowHandle: 777,
                  Patterns: ['Value', 'Text'],
                  IsEnabled: true,
                  IsFocusable: true,
                  Bounds: { X: 420, Y: 124, Width: 360, Height: 34, CenterX: 600, CenterY: 141 }
                }
              ],
              stats: { visited: 8, timedOut: false }
            };
          },
          findElementByText: async (text, options = {}) => {
            findCalls.push({ text, options });
            return { success: true, element: null };
          },
          click: async (x, y, button) => {
            clicks.push({ x, y, button });
          },
          getClipboardText: async () => ({ success: true, text: 'original clipboard payload', error: null }),
          setClipboardText: async () => ({ success: true, error: null })
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          id: 'open-pine-editor',
          route: 'quick-search',
          surface: 'pine-editor',
          requiresCommandSurface: true
        }
      }, 777);

      assert.strictEqual(result?.applicable, true);
      assert.strictEqual(result?.ready, true, 'host-backed command-surface proof should allow Pine Editor typing to proceed');
      assert.strictEqual(result?.inputFocus?.matchedBy, 'uia-host-quick-search-input-probe', 'input focus should come from the targeted host-backed quick-search probe');
      assert(['Edit', 'Text'].includes(String(result?.inputFocus?.controlType || '')), 'host-backed command-surface proof should preserve a trusted quick-search input or placeholder surface');
      assert.strictEqual(result?.clearedBy, 'already-empty');
      assert.strictEqual(hostScanCalls.length > 0, true, 'command-surface discovery should use the host-backed bounded window scan');
      assert.strictEqual(clicks.length, 1, 'host-backed input recovery should only click the discovered quick-search input once');
      assert.strictEqual(findCalls.length, 0, 'host-backed command-surface proof should not fall back to legacy quick-search text probes');
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping can fall back to clipboard selection when live UIA focus is unavailable', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    const keyLog = [];
    let clipboardValue = 'original clipboard payload';
    let sentinelValue = null;

    try {
      uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => ({ success: true, element: null }),
          pressKey: async (key) => {
            keyLog.push(key);
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            if (clipboardValue.startsWith('__LIKU_QS_')) {
              sentinelValue = clipboardValue;
            }
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      }, 777);

      assert(result?.ready, 'clipboard-selection fallback should allow the quick-search route to continue when UIA focus is unavailable');
      assert.strictEqual(result?.emptyConfirmed, false, 'clipboard miss fallback should distinguish assumed-empty continuation from semantic empty-state proof');
      assert.strictEqual(result?.fallbackAssumedFocused, true, 'clipboard miss fallback should mark the quick-search focus as an assumed keyboard continuation');
      assert.strictEqual(result?.clearedBy, 'clipboard-selection-miss-assumed-empty', 'clipboard miss fallback should preserve the bounded assumed-empty marker');
      assert.strictEqual(result?.expectedText, 'Pine Editor', 'clipboard miss fallback should preserve the intended TradingView quick-search query');
      assert.strictEqual(result?.inputFocus?.recoveredBy, 'clipboard-selection-miss', 'clipboard miss fallback should annotate the synthetic focus path');
      assert.strictEqual(result?.initialRead?.sentinelMatched, true, 'clipboard miss fallback should record the sentinel-matched copy miss');
      assert.strictEqual(result?.initialRead?.inferredEmpty, true, 'clipboard miss fallback should infer an empty field when the sentinel remains unchanged');
      assert.strictEqual(result?.finalRead?.sentinelMatched, true, 'clipboard miss fallback should preserve the final clipboard miss state');
      assert.strictEqual(clipboardValue, 'original clipboard payload', 'clipboard miss fallback should restore the original clipboard contents after probing');
      assert(sentinelValue && sentinelValue.startsWith('__LIKU_QS_'), 'clipboard miss fallback should seed a sentinel before probing');
      assert.deepStrictEqual(keyLog, ['ctrl+a', 'ctrl+c', 'right'], 'clipboard miss fallback should probe the keyboard-selected field and then collapse the selection');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping can continue after a bounded keyboard clear when stale quick-search text is detected', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    const keyLog = [];
    let clipboardValue = 'original clipboard payload';
    let copyCount = 0;

    try {
      uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => ({ success: true, element: null }),
          pressKey: async (key) => {
            keyLog.push(key);
            if (key === 'ctrl+c') {
              copyCount += 1;
              if (copyCount === 1) {
                clipboardValue = 'AAPL';
              }
            }
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      }, 777, {
        allowPostClearAssumedReady: true
      });

      assert(result?.ready, 'bounded stale-text keyboard clearing should allow the quick-search route to continue');
      assert.strictEqual(result?.emptyConfirmed, false, 'bounded stale-text keyboard clearing should rely on post-type verification instead of claiming an empty-field proof');
      assert.strictEqual(result?.fallbackAssumedFocused, true, 'bounded stale-text keyboard clearing should preserve the assumed-focus marker');
      assert.strictEqual(result?.clearedBy, 'keyboard-fallback-assumed-empty', 'bounded stale-text keyboard clearing should be annotated explicitly');
      assert.strictEqual(result?.keyboardFallback?.success, true, 'bounded stale-text keyboard clearing should record the successful ctrl+a/backspace clear step');
      assert.strictEqual(result?.finalRead, null, 'bounded stale-text keyboard clearing should skip the second clipboard readback and rely on typed verification instead');
      assert.deepStrictEqual(keyLog, ['ctrl+a', 'ctrl+c', 'right', 'ctrl+a', 'backspace'], 'bounded stale-text keyboard clearing should probe once, collapse the selection, then clear the stale text without a second clipboard read');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping tries a bounded TradingView top-center guess click before clipboard fallback', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    const clicks = [];
    const keyLog = [];
    let clipboardValue = 'original clipboard payload';

    try {
      uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => ({ success: true, element: null }),
          click: async (x, y, button) => {
            clicks.push({ x, y, button });
            return { success: true };
          },
          pressKey: async (key) => {
            keyLog.push(key);
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      }, 777);

      assert(result?.ready, 'bounded guess-click should still allow the clipboard fallback path to continue');
      assert.strictEqual(result?.focusRecovery?.recoveredBy, 'trusted-window-guess-click', 'bounded guess-click should be recorded as the focus recovery path before clipboard fallback');
      assert.deepStrictEqual(result?.focusRecovery?.guessClick?.coordinates, { x: 680, y: 186 }, 'bounded guess-click should target the trusted TradingView top-center quick-search lane');
      assert.deepStrictEqual(clicks, [{ x: 680, y: 186, button: 'left' }], 'bounded guess-click should issue one trusted TradingView top-center click before clipboard fallback');
      assert.deepStrictEqual(keyLog, ['ctrl+a', 'ctrl+c', 'right'], 'clipboard fallback should still probe and collapse the quick-search selection after the bounded guess-click');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping can use a guess-first clipboard preflight without semantic discovery', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    const clicks = [];
    const keyLog = [];
    let clipboardValue = 'original clipboard payload';
    let findElementCalls = 0;
    let findElementsCalls = 0;

    try {
      uiAutomation.findElements = async () => {
        findElementsCalls += 1;
        return { success: true, count: 0, element: null, elements: [] };
      };

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => {
            findElementCalls += 1;
            return { success: true, element: null };
          },
          click: async (x, y, button) => {
            clicks.push({ x, y, button });
            return { success: true };
          },
          pressKey: async (key) => {
            keyLog.push(key);
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      }, 777, {
        preferWindowGuessFirst: true,
        skipClipboardSurfaceDiscovery: true,
        timeoutMs: 5000,
        deadlineAt: Date.now() + 5000,
        cancelled: false,
        timeoutMessage: 'TradingView Pine quick-search fallback timed out after 5000ms'
      });

      assert(result?.ready, 'guess-first clipboard preflight should allow the quick-search route to continue without semantic discovery');
      assert.strictEqual(findElementCalls, 0, 'guess-first clipboard preflight should avoid semantic text discovery before probing the focused field');
      assert.strictEqual(findElementsCalls, 0, 'guess-first clipboard preflight should avoid bounds discovery when the Pine fallback opts into the trusted-window guess path');
      assert.strictEqual(result?.focusRecovery?.recoveredBy, 'trusted-window-guess-click', 'guess-first clipboard preflight should preserve the trusted-window guess recovery path');
      assert.deepStrictEqual(clicks, [{ x: 680, y: 186, button: 'left' }], 'guess-first clipboard preflight should still issue one bounded TradingView top-center click');
      assert.deepStrictEqual(keyLog, ['ctrl+a', 'ctrl+c', 'right'], 'guess-first clipboard preflight should still prove or infer the quick-search field state via clipboard selection');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping can discover a TradingView placeholder-text surface and clear it semantically', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const clicks = [];
    let currentQuickSearchValue = 'Pine Editor5m';

    try {
      uiAutomation.getSharedUIAHost = () => ({
        getText: async () => ({ success: true, method: 'ValuePattern', text: currentQuickSearchValue }),
        setValue: async (_x, _y, value) => {
          currentQuickSearchValue = String(value || '');
          return { success: true, method: 'ValuePattern', value: currentQuickSearchValue };
        }
      });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementsByWindowWithHost: async () => ({
            success: true,
            count: 1,
            elements: [
              {
                Name: 'Search tool or function',
                ControlType: 'ControlType.Text',
                WindowHandle: 777,
                Patterns: ['Text'],
                Bounds: { X: 330, Y: 138, Width: 365, Height: 34, CenterX: 512, CenterY: 155 }
              }
            ],
            stats: { visited: 5, timedOut: false }
          }),
          click: async (x, y, button) => {
            clicks.push({ x, y, button });
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      }, 777);

      assert(result?.ready, 'placeholder-text discovery should still ready the quick-search field for typing');
      assert.strictEqual(result?.emptyConfirmed, true, 'placeholder-text discovery should still require an empty-state proof');
      assert.strictEqual(result?.clearedBy, 'value-pattern', 'placeholder-text discovery should prefer semantic clearing once the surface is found');
      assert.strictEqual(result?.inputFocus?.controlType, 'Text', 'placeholder-text discovery should record the discovered Text-based input surface');
      assert.strictEqual(result?.inputFocus?.element?.Bounds?.CenterX, 512, 'placeholder-text discovery should preserve the semantic input bounds for later typing');
      assert.strictEqual(result?.finalRead?.normalizedText, '', 'placeholder-text discovery should prove the quick-search field empty after semantic clearing');
      assert.deepStrictEqual(clicks, [{ x: 512, y: 155, button: 'left' }], 'placeholder-text discovery should click the trusted quick-search placeholder before semantic clearing');
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('ensureTradingViewQuickSearchInputClearBeforeTyping bounds-search discovery respects a bounded timeout budget', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    const originalTimeoutEnv = process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS;
    const findElementCalls = [];
    let clipboardValue = 'original clipboard payload';

    try {
      process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS = '250';
      uiAutomation.findElements = async (options = {}) => {
        findElementCalls.push({
          controlType: String(options?.controlType || ''),
          timeoutMs: Number(options?.timeoutMs || 0) || 0
        });
        await new Promise((resolve) => setTimeout(resolve, 240));
        return { success: true, count: 0, element: null, elements: [] };
      };

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => ({ success: true, element: null }),
          pressKey: async () => {},
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const startedAt = Date.now();
      const result = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      }, 777);
      const elapsedMs = Date.now() - startedAt;

      assert(result?.ready, 'bounded discovery budget should still allow the clipboard fallback path to continue');
      assert.strictEqual(result?.fallbackAssumedFocused, true, 'bounded discovery budget should still preserve the clipboard-assumed fallback marker');
      assert(findElementCalls.length >= 1, 'bounds-search discovery should attempt at least one control type');
      assert(findElementCalls.length < 5, 'bounds-search discovery should stop before scanning every control type when the time budget is exhausted');
      assert.strictEqual(findElementCalls[0]?.controlType, 'Edit', 'bounds-search discovery should still prioritize Edit probes first');
      assert(findElementCalls.every((call) => call.timeoutMs <= 250 && call.timeoutMs >= 250), 'bounded discovery budget should pass the reduced timeout into each probe');
      assert(elapsedMs < 1200, 'bounded discovery budget should return quickly instead of spending minutes in sequential probes');
    } finally {
      uiAutomation.findElements = originalFindElements;
      if (originalTimeoutEnv === undefined) {
        delete process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS;
      } else {
        process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_DISCOVERY_TIMEOUT_MS = originalTimeoutEnv;
      }
    }
  });

  await test('executeTradingViewQuickSearchTypeAction skips semantic discovery when the preflight only established an assumed focus path', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    let findElementCalls = 0;
    let findElementsCalls = 0;
    const typedTexts = [];

    try {
      uiAutomation.findElements = async () => {
        findElementsCalls += 1;
        return { success: true, count: 0, element: null, elements: [] };
      };

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => {
            findElementCalls += 1;
            return { success: true, element: null };
          },
          typeText: async (text) => {
            typedTexts.push(String(text || ''));
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const result = await recovery.executeTradingViewQuickSearchTypeAction({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        },
        quickSearchPreflight: {
          applicable: true,
          ready: true,
          fallbackAssumedFocused: true,
          inputFocus: { focused: true },
          focusRecovery: { recoveredBy: 'trusted-window-guess-click' }
        }
      }, 777);

      assert.strictEqual(result?.success, true, 'assumed-focus quick-search typing should still succeed through bounded keyboard fallback');
      assert.strictEqual(result?.method, 'SendKeys', 'assumed-focus quick-search typing should bypass semantic write and use keyboard typing directly');
      assert.strictEqual(result?.quickSearchSemanticWrite?.success, false, 'assumed-focus quick-search typing should mark semantic write as unavailable without discovery');
      assert.strictEqual(findElementCalls, 0, 'assumed-focus quick-search typing should not re-enter semantic text discovery before keyboard fallback');
      assert.strictEqual(findElementsCalls, 0, 'assumed-focus quick-search typing should not re-enter bounded UIA search before keyboard fallback');
      assert.deepStrictEqual(typedTexts, ['Pine Editor'], 'assumed-focus quick-search typing should still type the intended TradingView query');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('verifyTradingViewQuickSearchTypedValue proves keyboard fallback queries through clipboard selection before Enter', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    let clipboardValue = 'original clipboard payload';
    let copyCount = 0;

    try {
      uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => ({ success: true, element: null }),
          pressKey: async (key) => {
            if (key === 'ctrl+c') {
              copyCount += 1;
              if (copyCount === 2) {
                clipboardValue = 'Pine Editor';
              }
            }
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const baseAction = {
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      };
      const quickSearchPreflight = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping(baseAction, 777);
      const verification = await recovery.verifyTradingViewQuickSearchTypedValue({
        ...baseAction,
        quickSearchPreflight
      }, {
        success: true,
        method: 'SendKeys'
      }, 777);

      assert.strictEqual(quickSearchPreflight?.fallbackAssumedFocused, true, 'setup should exercise the clipboard-assumed quick-search path');
      assert.strictEqual(verification?.applicable, true);
      assert.strictEqual(verification?.verified, true, 'clipboard verification should prove the typed TradingView query before Enter');
      assert.strictEqual(verification?.satisfiedBy, 'clipboard-selection');
      assert.strictEqual(verification?.actualText, 'Pine Editor');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('verifyTradingViewQuickSearchTypedValue skips semantic discovery when the preflight only established an assumed focus path', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    let clipboardValue = 'original clipboard payload';
    let copyCount = 0;
    let findElementCalls = 0;
    let findElementsCalls = 0;

    try {
      uiAutomation.findElements = async () => {
        findElementsCalls += 1;
        return { success: true, count: 0, element: null, elements: [] };
      };

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => {
            findElementCalls += 1;
            return { success: true, element: null };
          },
          pressKey: async (key) => {
            if (key === 'ctrl+c') {
              copyCount += 1;
              if (copyCount === 1) {
                clipboardValue = 'Pine Editor';
              }
            }
          },
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const verification = await recovery.verifyTradingViewQuickSearchTypedValue({
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        },
        quickSearchPreflight: {
          applicable: true,
          ready: true,
          fallbackAssumedFocused: true,
          inputFocus: { focused: true },
          focusRecovery: { recoveredBy: 'trusted-window-guess-click' }
        }
      }, {
        success: true,
        method: 'SendKeys'
      }, 777);

      assert.strictEqual(verification?.applicable, true);
      assert.strictEqual(verification?.verified, true, 'assumed-focus quick-search verification should still prove the typed query through clipboard selection');
      assert.strictEqual(verification?.satisfiedBy, 'clipboard-selection');
      assert.strictEqual(findElementCalls, 0, 'assumed-focus quick-search verification should not re-enter semantic text discovery before clipboard readback');
      assert.strictEqual(findElementsCalls, 0, 'assumed-focus quick-search verification should not re-enter UIA discovery before clipboard readback');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('verifyTradingViewQuickSearchTypedValue fails closed when clipboard verification cannot prove the typed query', async () => {
    const foreground = {
      ...buildTradingViewForeground(),
      bounds: { x: 40, y: 60, width: 1280, height: 900 }
    };
    const originalFindElements = uiAutomation.findElements;
    let clipboardValue = 'original clipboard payload';

    try {
      uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

      const recovery = createTradingViewRuntimeRecovery({
        systemAutomation: {
          getForegroundWindowInfo: async () => foreground,
          getWindowInfoByHandle: async () => foreground,
          findElementByText: async () => ({ success: true, element: null }),
          pressKey: async () => {},
          getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
          setClipboardText: async (value) => {
            clipboardValue = String(value || '');
            return { success: true, error: null };
          }
        },
        sleepMs: async () => {},
        verifyKeyObservationCheckpoint: async () => ({ applicable: true, verified: false, foreground })
      });

      const baseAction = {
        type: 'type',
        text: 'Pine Editor',
        searchSurfaceContract: {
          route: 'quick-search',
          id: 'open-pine-editor',
          surface: 'pine-editor'
        }
      };
      const quickSearchPreflight = await recovery.ensureTradingViewQuickSearchInputClearBeforeTyping(baseAction, 777);
      const verification = await recovery.verifyTradingViewQuickSearchTypedValue({
        ...baseAction,
        quickSearchPreflight
      }, {
        success: true,
        method: 'SendKeys'
      }, 777);

      assert.strictEqual(quickSearchPreflight?.fallbackAssumedFocused, true, 'setup should exercise the clipboard-assumed quick-search path');
      assert.strictEqual(verification?.applicable, true);
      assert.strictEqual(verification?.verified, false, 'clipboard verification should fail closed when the typed query cannot be proven');
      assert(/could not be verified|clipboard selection/i.test(String(verification?.error || '')), 'verification should explain that the typed TradingView query was not proven');
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });
}

main().catch((error) => {
  console.error('FAIL tradingview runtime recovery');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(async () => {
  clearTimeout(forcedExitTimer);
  await shutdownSharedUIAHost().catch(() => {});
});
