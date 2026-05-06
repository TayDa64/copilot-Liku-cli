#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));

const {
  createTradingViewRuntimeRecovery
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'runtime', 'recovery.js'));

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

  await test('maybeRecoverTradingViewPineEditorOpen semantically clicks the TradingView Pine result when the surface is not yet visible', async () => {
    const foreground = buildTradingViewForeground();
    const findCalls = [];
    const clicks = [];
    const checkpointCalls = [];
    let pineSurfaceVisible = false;

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
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
          pineSurfaceVisible = true;
        }
      },
      sleepMs: async () => {},
      verifyKeyObservationCheckpoint: async (spec, beforeForeground, options = {}) => {
        checkpointCalls.push({ spec, beforeForeground, options });
        return {
          applicable: true,
          verified: true,
          foreground,
          matchReason: 'title',
          observedChange: true
        };
      }
    });

    const result = await recovery.maybeRecoverTradingViewPineEditorOpen(
      buildPineRecoveryAction(),
      { applicable: true, classification: 'editor-active', requiresObservedChange: true },
      foreground,
      { classification: 'editor-active', verified: false },
      { expectedWindowHandle: 777 }
    );

    const openResultCall = findCalls.find((call) => call.text === 'Open Pine Editor');

    assert(result?.recovered, 'semantic Pine result click should recover the Pine Editor open step');
    assert.deepStrictEqual(clicks, [{ x: 640, y: 320, button: 'left' }], 'recovery should click the UIA-reported Pine result center rather than a hard-coded coordinate');
    assert.strictEqual(openResultCall?.options?.windowHandle, 777, 'Pine result lookup should stay scoped to the foreground TradingView window');
    assert.strictEqual(openResultCall?.options?.foregroundOnly, true, 'Pine result lookup should stay foreground-scoped');
    assert.strictEqual(checkpointCalls.length, 1, 'semantic click recovery should run one relaxed checkpoint retry');
    assert.strictEqual(result?.checkpoint?.verified, true);
    assert.strictEqual(result?.checkpoint?.recoveredBy, 'semantic-click');
    assert.strictEqual(result?.checkpoint?.pineEditorResultClick?.text, 'Open Pine Editor');
    assert.strictEqual(result?.checkpoint?.pineEditorResultClick?.exact, true);
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
}

main().catch((error) => {
  console.error('FAIL tradingview runtime recovery');
  console.error(error.stack || error.message);
  process.exit(1);
});
