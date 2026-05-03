'use strict';

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const { buildVerifyTargetHintFromAppName } = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js'));

async function withPatchedSystemAutomation(overrides, fn) {
  const systemAutomation = aiService.systemAutomation;
  const originals = {};
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const state = overrides && typeof overrides.__sharedState === 'object'
    ? overrides.__sharedState
    : { quickSearchValue: String(overrides?.initialQuickSearchValue || '') };
  const systemAutomationOverrides = { ...(overrides || {}) };
  delete systemAutomationOverrides.initialQuickSearchValue;
  delete systemAutomationOverrides.__sharedState;

  uiAutomation.getSharedUIAHost = () => ({
    getText: async () => ({ ok: true, method: 'ValuePattern', text: state.quickSearchValue }),
    setValue: async (_x, _y, value) => {
      state.quickSearchValue = String(value || '');
      return { ok: true, method: 'ValuePattern', value: state.quickSearchValue };
    }
  });

  const defaultFindElementByText = async (text, options = {}) => {
    const normalizedText = String(text || '').trim().toLowerCase();
    const normalizedControlType = String(options?.controlType || '').trim().toLowerCase();
    let foreground = null;
    try {
      foreground = await systemAutomation.getForegroundWindowInfo();
    } catch {}

    const mainHandle = Number(foreground?.hwnd || 777) || 777;
    const searchHandle = String(foreground?.windowKind || '').trim().toLowerCase() === 'owned' ? mainHandle : (mainHandle === 777 ? 892 : mainHandle);

    if (normalizedText === 'search tool or function' && normalizedControlType === 'text') {
      return {
        success: true,
        count: 1,
        element: {
          Name: 'Search tool or function',
          WindowHandle: searchHandle,
          Bounds: { X: 321, Y: 90, Width: 180, Height: 24, CenterX: 411, CenterY: 102 }
        },
        elements: []
      };
    }

    if (normalizedText === 'search' && normalizedControlType === 'edit') {
      return {
        success: true,
        count: 1,
        element: {
          Name: 'Search',
          WindowHandle: searchHandle,
          Bounds: { X: 330, Y: 138, Width: 365, Height: 34, CenterX: 512, CenterY: 155 }
        },
        elements: []
      };
    }

    return { success: true, count: 0, element: null, elements: [] };
  };

  if (typeof systemAutomationOverrides.findElementByText !== 'function') {
    systemAutomationOverrides.findElementByText = defaultFindElementByText;
  }

  if (typeof systemAutomationOverrides.click !== 'function') {
    systemAutomationOverrides.click = async () => ({ success: true });
  }

  for (const [key, value] of Object.entries(systemAutomationOverrides)) {
    originals[key] = systemAutomation[key];
    systemAutomation[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      systemAutomation[key] = value;
    }
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
  }
}

async function testCrossAppQuickSearchGuard() {
  const executed = [];
  const clicks = [];
  const previousWatcher = aiService.getUIWatcher();

  aiService.setUIWatcher({
    isPolling: true,
    cache: {
      lastUpdate: Date.now(),
      activeWindow: {
        hwnd: 777,
        title: 'LUNR ▲ 23.99 +18.53% / Unnamed',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: []
    },
    waitForFreshState: async () => ({
      fresh: false,
      timedOut: false,
      immediate: false,
      activeWindow: {
        hwnd: 777,
        title: 'LUNR ▲ 23.99 +18.53% / Unnamed',
        processName: 'tradingview',
        windowKind: 'main'
      },
      lastUpdate: Date.now()
    })
  });

  try {
    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => ({ success: true, hwnd: 777, title: 'LUNR ▲ 23.99 +18.53% / Unnamed', processName: 'tradingview', windowKind: 'main' }),
      focusWindow: async () => ({ success: true, actualForegroundHandle: 777, actualForeground: { success: true, hwnd: 777, title: 'LUNR ▲ 23.99 +18.53% / Unnamed', processName: 'tradingview', windowKind: 'main' }, exactMatch: true, outcome: 'exact' }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowHandle: 777, mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }]),
      findElementByText: async (text, options = {}) => {
        const normalizedText = String(text || '').trim();
        const normalizedControlType = String(options?.controlType || '').trim().toLowerCase();
        if (normalizedText === 'Search tool or function' && normalizedControlType === 'text') {
          return {
            success: true,
            count: 1,
            element: {
              Name: 'Search tool or function',
              WindowHandle: 891,
              Bounds: { X: 321, Y: 90, Width: 180, Height: 24, CenterX: 411, CenterY: 102 }
            },
            elements: []
          };
        }
        if (normalizedText === 'Search' && normalizedControlType === 'edit') {
          return {
            success: true,
            count: 1,
            element: {
              Name: 'Search',
              WindowHandle: 891,
              Bounds: { X: 330, Y: 138, Width: 365, Height: 34, CenterX: 512, CenterY: 155 }
            },
            elements: []
          };
        }
        return { success: false, error: 'Element not found', count: 0, element: null, elements: [] };
      },
      getWindowInfoByHandle: async (hwnd) => ({
        success: true,
        hwnd,
        title: 'Search - Visual Studio Code',
        processName: 'code',
        windowKind: 'main',
        ownerHwnd: 0
      }),
      click: async (x, y, button) => {
        clicks.push({ x, y, button });
        return { success: true };
      }
    }, async () => {
      const routeMetadata = { id: 'open-pine-editor', route: 'quick-search', surface: 'pine-editor' };
      const quickSearchShortcut = { id: 'symbol-search', surface: 'quick-search' };
      const execResult = await aiService.executeActions({
        thought: 'Do not trust a cross-app search box while trying to recover TradingView quick search',
        verification: 'TradingView quick search should be visible before typing',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'ctrl+k',
            reason: 'Open TradingView quick search',
            verify: { kind: 'dialog-visible', appName: 'TradingView', target: 'quick-search', keywords: ['quick search', 'symbol search', 'search'] },
            searchSurfaceContract: routeMetadata,
            tradingViewShortcut: quickSearchShortcut
          },
          {
            type: 'type',
            text: 'Pine Editor',
            reason: 'Type Pine Editor into the active TradingView quick-search box',
            searchSurfaceContract: routeMetadata,
            tradingViewShortcut: routeMetadata
          }
        ]
      }, null, null, {
        userMessage: 'open quick search in tradingview',
        actionExecutor: async (action) => {
          executed.push(`${action.type}:${action.key || action.text || ''}`);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, false, 'Execution should fail closed when the only quick-search match belongs to another app');
      assert.deepStrictEqual(executed, ['focus_window:', 'key:ctrl+k'], 'Typing should not proceed after a cross-app quick-search mismatch');
      assert.strictEqual(clicks.length, 0, 'Cross-app quick-search fallback should never drive a recovery click');
    });
  } finally {
    aiService.setUIWatcher(previousWatcher);
  }
}

async function testContaminatedQuickSearchClearsAndTypes() {
  const executed = [];
  const dirtyQuickSearchFixture = 'Pine Editor5mBTCUSDPine EditorAAPL';
  let currentChartSymbol = 'BTCUSD';
  let quickSearchOpen = false;
  const sharedState = { quickSearchValue: dirtyQuickSearchFixture };

  const buildMainForeground = () => ({ success: true, hwnd: 777, title: `TradingView - ${currentChartSymbol}`, processName: 'tradingview', windowKind: 'main' });
  const buildQuickSearchForeground = () => ({ success: true, hwnd: 892, title: 'Search tool or function - TradingView', processName: 'tradingview', windowKind: 'owned' });
  let currentForeground = buildMainForeground();

  await withPatchedSystemAutomation({
    __sharedState: sharedState,
    initialQuickSearchValue: dirtyQuickSearchFixture,
    resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
    getForegroundWindowHandle: async () => Number(currentForeground?.hwnd || 777) || 777,
    getForegroundWindowInfo: async () => {
      currentForeground = quickSearchOpen ? buildQuickSearchForeground() : buildMainForeground();
      return currentForeground;
    },
    focusWindow: async (hwnd) => {
      const numericHandle = Number(hwnd || currentForeground?.hwnd || 777) || 777;
      currentForeground = numericHandle === 892 ? buildQuickSearchForeground() : buildMainForeground();
      return { success: true, actualForegroundHandle: numericHandle, actualForeground: currentForeground };
    },
    getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowHandle: quickSearchOpen ? 892 : 777, mainWindowTitle: quickSearchOpen ? 'Search tool or function - TradingView' : 'TradingView', startTime: '2026-03-23T00:00:00Z' }]),
    pressKey: async () => ({ success: true })
  }, async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], { userMessage: 'focus on tradingview and change the ticker to aapl.' });

    const execResult = await aiService.executeActions({
      thought: 'Apply TradingView symbol AAPL with verification',
      verification: 'TradingView should show AAPL chart state',
      actions: rewritten
    }, null, null, {
      userMessage: 'focus on tradingview and change the ticker to aapl.',
      actionExecutor: async (action) => {
        executed.push(action.type === 'key' ? `key:${action.key}` : action.type === 'type' ? `type:${action.text}` : action.type);
        if (action.type === 'key' && action.key === 'ctrl+k') {
          quickSearchOpen = true;
          currentForeground = buildQuickSearchForeground();
        } else if (action.type === 'type') {
          sharedState.quickSearchValue = String(action.text || '');
        } else if (action.type === 'key' && action.key === 'enter') {
          quickSearchOpen = false;
          currentChartSymbol = 'AAPL';
          currentForeground = buildMainForeground();
        }
        return { success: true, action: action.type, message: 'executed' };
      }
    });

    const typedResult = execResult.results.find((result) => result?.action === 'type');
    if (!execResult.success) {
      console.error('DIAGNOSTIC contaminated quick-search execResult:', JSON.stringify({
        success: execResult.success,
        error: execResult.error || null,
        results: (execResult.results || []).map((result) => ({
          action: result?.action,
          success: result?.success,
          error: result?.error || null,
          quickSearchPreflight: result?.quickSearchPreflight || null,
          quickSearchTypedVerification: result?.quickSearchTypedVerification || null,
          observationCheckpoint: result?.observationCheckpoint
            ? {
              verified: result.observationCheckpoint.verified,
              verifyKind: result.observationCheckpoint.verifyKind,
              verifyTarget: result.observationCheckpoint.verifyTarget,
              matchReason: result.observationCheckpoint.matchReason,
              error: result.observationCheckpoint.error || null,
              foreground: result.observationCheckpoint.foreground || null
            }
            : null
        })),
        observationCheckpoints: (execResult.observationCheckpoints || []).map((checkpoint) => ({
          verified: checkpoint?.verified,
          verifyKind: checkpoint?.verifyKind,
          verifyTarget: checkpoint?.verifyTarget,
          matchReason: checkpoint?.matchReason,
          error: checkpoint?.error || null,
          foreground: checkpoint?.foreground || null
        }))
      }, null, 2));
    }
    assert.strictEqual(execResult.success, true, 'Execution should succeed after the contaminated quick-search regression fixture is proven empty and AAPL is applied');
    assert.strictEqual(typedResult?.quickSearchPreflight?.emptyConfirmed, true, 'Typing should only proceed after the quick-search input is proven empty');
    assert.strictEqual(typedResult?.quickSearchPreflight?.finalRead?.normalizedText, '', 'Preflight should prove the symbol-search input is empty before typing AAPL');
  });
}

async function main() {
  await testCrossAppQuickSearchGuard();
  console.log('PASS cross-app quick-search guard');
  await testContaminatedQuickSearchClearsAndTypes();
  console.log('PASS contaminated quick-search clearing');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});