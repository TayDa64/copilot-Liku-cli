#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

process.env.LIKU_DISABLE_REFLECTION = '1';

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const { shutdownSharedUIAHost } = uiAutomation;
const {
  writeFailureArtifactBundle
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));
const TEST_TIMEOUT_MS = 90000;
const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL system automation quick-search timed out after ${TEST_TIMEOUT_MS}ms`);
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
    try {
      const artifact = await writeFailureArtifactBundle({
        suiteName: 'test-system-automation-quick-search',
        failureName: name,
        phase: 'test',
        error,
        aiService,
        systemAutomation: aiService.systemAutomation,
        watcher: typeof aiService.getUIWatcher === 'function' ? aiService.getUIWatcher() : null,
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

function buildQuickSearchElement() {
  return {
    Name: 'Search',
    WindowHandle: 777,
    Bounds: {
      X: 330,
      Y: 138,
      Width: 365,
      Height: 34,
      CenterX: 512,
      CenterY: 155
    }
  };
}

function buildQuickSearchAction(overrides = {}) {
  return {
    type: 'type',
    text: 'Pine Editor',
    reason: 'Replace the active TradingView quick-search text with Pine Editor',
    searchSurfaceContract: {
      route: 'quick-search',
      appName: 'TradingView',
      id: 'open-pine-editor',
      surface: 'pine-editor'
    },
    tradingViewShortcut: {
      id: 'symbol-search',
      surface: 'quick-search'
    },
    quickSearchPreflight: {
      applicable: true,
      ready: true,
      emptyConfirmed: true,
      inputFocus: {
        focused: true,
        element: buildQuickSearchElement()
      }
    },
    ...overrides
  };
}

function buildTradingViewForeground() {
  return {
    success: true,
    hwnd: 777,
    title: 'TradingView Quick Search',
    processName: 'tradingview',
    windowKind: 'owned',
    ownerHwnd: 777,
    bounds: { x: 300, y: 120, width: 720, height: 420 }
  };
}

function buildInertAutomationRuntimeOptions(overrides = {}) {
  return {
    click: async () => ({ success: true, message: 'inert-click' }),
    doubleClick: async () => ({ success: true, message: 'inert-double-click' }),
    moveMouse: async () => ({ success: true, message: 'inert-move-mouse' }),
    typeText: async () => ({ success: true, message: 'inert-type' }),
    pressKey: async () => ({ success: true, message: 'inert-key' }),
    ...overrides
  };
}

async function withPatchedAIServiceSystemAutomation(overrides, fn) {
  const systemRef = aiService.systemAutomation;
  const originals = {};
  const effectiveOverrides = {
    click: async () => ({ success: true, message: 'inert-click' }),
    doubleClick: async () => ({ success: true, message: 'inert-double-click' }),
    moveMouse: async () => ({ success: true, message: 'inert-move-mouse' }),
    typeText: async () => ({ success: true, message: 'inert-type' }),
    pressKey: async () => ({ success: true, message: 'inert-key' }),
    focusWindow: async (hwnd) => ({
      success: true,
      requestedWindowHandle: Number(hwnd || 0) || 0,
      actualForegroundHandle: Number(hwnd || 0) || 0,
      actualForeground: buildTradingViewForeground(),
      exactMatch: true,
      outcome: 'exact'
    }),
    findElementByText: async () => ({
      success: true,
      count: 0,
      element: null,
      elements: []
    }),
    findElementsByWindowWithHost: async () => ({
      success: true,
      count: 0,
      element: null,
      elements: []
    }),
    ...(overrides || {})
  };
  const entries = Object.entries(effectiveOverrides);
  for (const [key, value] of entries) {
    originals[key] = systemRef[key];
    systemRef[key] = value;
  }

  try {
    return await fn(systemRef);
  } finally {
    for (const [key] of entries) {
      systemRef[key] = originals[key];
    }
  }
}

async function main() {
  await test('executeAction uses ValuePattern for trusted TradingView quick-search type actions', async () => {
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const hostCalls = [];

    uiAutomation.getSharedUIAHost = () => ({
      setValue: async (x, y, value) => {
        hostCalls.push({ kind: 'setValue', x, y, value: String(value || '') });
        return { ok: true, method: 'ValuePattern', value: String(value || '') };
      },
      getText: async (x, y) => {
        hostCalls.push({ kind: 'getText', x, y });
        return { ok: true, method: 'ValuePattern', text: 'Pine Editor' };
      }
    });

    try {
      const result = await systemAutomation.executeAction(buildQuickSearchAction(), {
        ...buildInertAutomationRuntimeOptions({
          typeText: async () => {
            throw new Error('keyboard fallback should not run when semantic write succeeds');
          }
        })
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.method, 'ValuePattern');
      assert.strictEqual(result.quickSearchSemanticWrite?.success, true);
      assert.deepStrictEqual(hostCalls, [
        { kind: 'setValue', x: 512, y: 155, value: 'Pine Editor' },
        { kind: 'getText', x: 512, y: 155 }
      ]);
      assert(/via ValuePattern/i.test(String(result.message || '')));
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('executeAction falls back to keyboard typing when semantic quick-search write is unavailable', async () => {
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const hostCalls = [];
    let typedText = null;

    uiAutomation.getSharedUIAHost = () => ({
      setValue: async (x, y, value) => {
        hostCalls.push({ kind: 'setValue', x, y, value: String(value || '') });
        throw new Error('ValuePattern not supported');
      },
      getText: async () => {
        throw new Error('getText should not run when setValue fails immediately');
      }
    });

    try {
      const result = await systemAutomation.executeAction(buildQuickSearchAction(), {
        ...buildInertAutomationRuntimeOptions({
          typeText: async (text) => {
            typedText = String(text || '');
          }
        })
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.fallback, true);
      assert.strictEqual(result.method, 'SendKeys');
      assert.strictEqual(result.quickSearchSemanticWrite?.applicable, true);
      assert.strictEqual(result.quickSearchSemanticWrite?.success, false);
      assert.strictEqual(typedText, 'Pine Editor');
      assert.deepStrictEqual(hostCalls, [
        { kind: 'setValue', x: 512, y: 155, value: 'Pine Editor' }
      ]);
      assert(/SendKeys fallback/i.test(String(result.message || '')));
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('ai-service passes quick-search preflight metadata into the execution action', async () => {
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    let currentQuickSearchValue = '';
    let capturedAction = null;
    const foreground = buildTradingViewForeground();

    uiAutomation.getSharedUIAHost = () => ({
      getText: async () => ({ ok: true, method: 'ValuePattern', text: currentQuickSearchValue }),
      setValue: async (_x, _y, value) => {
        currentQuickSearchValue = String(value || '');
        return { ok: true, method: 'ValuePattern', value: currentQuickSearchValue };
      }
    });

    try {
      await withPatchedAIServiceSystemAutomation({
        getForegroundWindowInfo: async () => foreground,
        findElementsByWindowWithHost: async (text, options = {}) => ({
          success: true,
          count: String(text || '').trim().toLowerCase() === 'search'
            && String(options?.controlType || '').trim().toLowerCase() === 'edit'
            ? 1
            : 0,
          element: String(text || '').trim().toLowerCase() === 'search'
            && String(options?.controlType || '').trim().toLowerCase() === 'edit'
            ? {
                ...buildQuickSearchElement(),
                ControlType: 'Edit',
                IsEnabled: true,
                SupportedPatterns: ['ValuePattern']
              }
            : null,
          elements: String(text || '').trim().toLowerCase() === 'search'
            && String(options?.controlType || '').trim().toLowerCase() === 'edit'
            ? [{
                ...buildQuickSearchElement(),
                ControlType: 'Edit',
                IsEnabled: true,
                SupportedPatterns: ['ValuePattern']
              }]
            : []
        }),
        click: async () => ({ success: true }),
        getWindowInfoByHandle: async (hwnd) => ({
          ...foreground,
          hwnd: Number(hwnd || 0) || 777
        })
      }, async () => {
        const execResult = await aiService.executeActions({
          thought: 'Open Pine Editor from TradingView quick search',
          verification: 'TradingView quick search should accept the Pine Editor query',
          actions: [
            {
              type: 'type',
              text: 'Pine Editor',
              reason: 'Replace the active TradingView quick-search text with Pine Editor',
              searchSurfaceContract: {
                route: 'quick-search',
                appName: 'TradingView',
                id: 'open-pine-editor',
                surface: 'pine-editor'
              },
              tradingViewShortcut: {
                id: 'symbol-search',
                surface: 'quick-search'
              }
            }
          ]
        }, null, null, {
          userMessage: 'open pine editor in tradingview',
          actionExecutor: async (action) => {
            capturedAction = action;
            currentQuickSearchValue = String(action?.text || '');
            return {
              success: true,
              action: action.type,
              message: 'ok',
              quickSearchSemanticWrite: {
                applicable: true,
                success: true,
                method: 'ValuePattern',
                readback: {
                  text: currentQuickSearchValue,
                  normalizedText: currentQuickSearchValue,
                  method: 'ValuePattern'
                }
              }
            };
          }
        });

        assert.strictEqual(execResult.success, true);
        assert(capturedAction, 'execution action should be captured');
        assert.strictEqual(capturedAction?.quickSearchPreflight?.applicable, true);
        assert.strictEqual(capturedAction?.quickSearchPreflight?.clearedBy, 'already-empty');
        assert.strictEqual(capturedAction?.quickSearchPreflight?.inputFocus?.element?.Bounds?.CenterX, 512);
        assert.strictEqual(execResult.results[0]?.quickSearchPreflight?.inputFocus?.element?.Bounds?.CenterY, 155);
        assert.strictEqual(execResult.results[0]?.quickSearchTypedVerification?.verified, true);
        assert.strictEqual(execResult.results[0]?.quickSearchTypedVerification?.satisfiedBy, 'value-pattern-readback');
      });
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    }
  });

  await test('ai-service discovers a trusted TradingView quick-search edit from bounds search and uses ValuePattern', async () => {
    const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
    const originalFindElements = uiAutomation.findElements;
    const foreground = buildTradingViewForeground();
    let currentQuickSearchValue = '';
    let capturedAction = null;

    uiAutomation.getSharedUIAHost = () => ({
      getText: async () => ({ ok: true, method: 'ValuePattern', text: currentQuickSearchValue }),
      setValue: async (_x, _y, value) => {
        currentQuickSearchValue = String(value || '');
        return { ok: true, method: 'ValuePattern', value: currentQuickSearchValue };
      }
    });

    uiAutomation.findElements = async (options = {}) => {
      if (String(options?.controlType || '').trim().toLowerCase() !== 'edit') {
        return { success: true, count: 0, element: null, elements: [] };
      }

      return {
        success: true,
        count: 1,
        element: {
          ...buildQuickSearchElement(),
          Name: '',
          ControlType: 'Edit',
          IsEnabled: true,
          SupportedPatterns: ['ValuePattern']
        },
        elements: [
          {
            ...buildQuickSearchElement(),
            Name: '',
            ControlType: 'Edit',
            IsEnabled: true,
            SupportedPatterns: ['ValuePattern']
          }
        ]
      };
    };

    try {
      await withPatchedAIServiceSystemAutomation({
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async (hwnd) => ({
          ...foreground,
          hwnd: Number(hwnd || 0) || 777
        }),
        findElementByText: async () => ({
          success: true,
          count: 0,
          element: null,
          elements: []
        }),
        click: async () => ({ success: true })
      }, async () => {
        const execResult = await aiService.executeActions({
          thought: 'Type Pine Editor into the active TradingView quick-search input',
          verification: 'TradingView quick search should accept the Pine Editor query through semantic input discovery',
          actions: [
            {
              type: 'type',
              text: 'Pine Editor',
              reason: 'Replace the active TradingView quick-search text with Pine Editor',
              searchSurfaceContract: {
                route: 'quick-search',
                appName: 'TradingView',
                id: 'symbol-search',
                surface: 'quick-search'
              },
              tradingViewShortcut: {
                id: 'symbol-search',
                surface: 'quick-search'
              }
            }
          ]
        }, null, null, {
          userMessage: 'type Pine Editor into the active TradingView quick search',
          actionExecutor: async (action) => {
            capturedAction = action;
            return systemAutomation.executeAction(action, buildInertAutomationRuntimeOptions({
              typeText: async () => {
                throw new Error('keyboard fallback should not run when bounds-based quick-search discovery finds a trusted edit');
              }
            }));
          }
        });

        assert.strictEqual(execResult.success, true);
        assert(capturedAction, 'the bounds-discovered quick-search action should be captured');
        assert.strictEqual(capturedAction?.quickSearchPreflight?.applicable, true);
        assert.strictEqual(capturedAction?.quickSearchPreflight?.inputFocus?.element?.Bounds?.CenterX, 512);
        assert.strictEqual(capturedAction?.quickSearchPreflight?.inputFocus?.controlType, 'Edit');
        assert.strictEqual(execResult.results[0]?.method, 'ValuePattern');
        assert.strictEqual(execResult.results[0]?.quickSearchSemanticWrite?.success, true);
        assert.strictEqual(execResult.results[0]?.quickSearchTypedVerification?.verified, true);
        assert.strictEqual(execResult.results[0]?.quickSearchTypedVerification?.satisfiedBy, 'value-pattern-readback');
      });
    } finally {
      uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ai-service fails closed before Enter when clipboard-assumed quick-search typing cannot be verified', async () => {
    const originalFindElements = uiAutomation.findElements;
    const foreground = buildTradingViewForeground();
    let clipboardValue = 'original clipboard payload';
    const keyLog = [];
    const executedActions = [];

    uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

    try {
      await withPatchedAIServiceSystemAutomation({
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async (hwnd) => ({
          ...foreground,
          hwnd: Number(hwnd || 0) || 777
        }),
        findElementByText: async () => ({ success: true, count: 0, element: null, elements: [] }),
        pressKey: async (key) => {
          keyLog.push(key);
        },
        getClipboardText: async () => ({ success: true, text: clipboardValue, error: null }),
        setClipboardText: async (value) => {
          clipboardValue = String(value || '');
          return { success: true, error: null };
        }
      }, async () => {
        const execResult = await aiService.executeActions({
          thought: 'Replace the active TradingView quick-search query and only continue if the typed value is proven',
          verification: 'TradingView quick search should only continue after the Pine Editor query is proven',
          actions: [
            {
              type: 'type',
              text: 'Pine Editor',
              reason: 'Replace the active TradingView quick-search text with Pine Editor',
              searchSurfaceContract: {
                route: 'quick-search',
                appName: 'TradingView',
                id: 'symbol-search',
                surface: 'quick-search'
              },
              tradingViewShortcut: {
                id: 'symbol-search',
                surface: 'quick-search'
              }
            },
            {
              type: 'key',
              key: 'enter',
              reason: 'Confirm the quick-search result after typing Pine Editor'
            }
          ]
        }, null, null, {
          userMessage: 'replace the text in the active tradingview quick search',
          actionExecutor: async (action) => {
            executedActions.push(action);
            return {
              success: true,
              action: action.type,
              message: action.type === 'type'
                ? 'Typed "Pine Editor" via SendKeys fallback'
                : `Pressed ${action.key}`,
              method: action.type === 'type' ? 'SendKeys' : undefined
            };
          }
        });

        const typedResult = execResult.results.find((entry) => entry?.quickSearchTypedVerification?.applicable === true);
        const typedActionIndex = executedActions.findIndex((entry) => entry?.type === 'type' && String(entry?.text || '') === 'Pine Editor');

        assert.strictEqual(execResult.success, false, 'execution should fail closed when the typed TradingView query is not proven');
  assert(typedResult, 'the quick-search sequence should surface one typed-query verification result');
  assert(typedActionIndex >= 0, 'the quick-search sequence should still execute the Pine Editor type step');
        assert.strictEqual(typedResult?.quickSearchPreflight?.fallbackAssumedFocused, true, 'setup should exercise the clipboard-assumed quick-search path');
        assert.strictEqual(typedResult?.quickSearchTypedVerification?.applicable, true);
        assert.strictEqual(typedResult?.quickSearchTypedVerification?.verified, false);
        assert(/could not be verified|clipboard selection/i.test(String(typedResult?.error || '')), 'type failure should explain that the TradingView query was never proven');
        assert(!executedActions.slice(typedActionIndex + 1).some((entry) => entry?.type === 'key' && String(entry?.key || '').trim().toLowerCase() === 'enter'), 'Enter should never execute after the TradingView query fails typed verification');
        assert.deepStrictEqual(keyLog, ['ctrl+a', 'ctrl+c', 'right', 'ctrl+a', 'ctrl+c', 'right'], 'preflight and post-type verification should each perform one bounded clipboard-selection probe');
      });
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ai-service fails closed when TradingView quick-search preflight times out before typing starts', async () => {
    const originalTimeoutEnv = process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_PREFLIGHT_TIMEOUT_MS;
    const foreground = buildTradingViewForeground();
    const executedActions = [];
    const keyLog = [];

    try {
      process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_PREFLIGHT_TIMEOUT_MS = '250';

      await withPatchedAIServiceSystemAutomation({
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async (hwnd) => ({
          ...foreground,
          hwnd: Number(hwnd || 0) || 777
        }),
        findElementByText: async () => new Promise((resolve) => {
          setTimeout(() => resolve({ success: true, count: 0, element: null, elements: [] }), 400);
        }),
        pressKey: async (key) => {
          keyLog.push(key);
        }
      }, async () => {
        const execResult = await aiService.executeActions({
          thought: 'Type Pine Editor into TradingView quick search only after preflight succeeds',
          verification: 'TradingView quick-search typing should fail closed if preflight hangs',
          actions: [
            {
              type: 'type',
              text: 'Pine Editor',
              reason: 'Replace the active TradingView quick-search text with Pine Editor',
              searchSurfaceContract: {
                route: 'quick-search',
                appName: 'TradingView',
                id: 'symbol-search',
                surface: 'quick-search'
              },
              tradingViewShortcut: {
                id: 'symbol-search',
                surface: 'quick-search'
              }
            }
          ]
        }, null, null, {
          userMessage: 'type Pine Editor into the active TradingView quick search',
          actionExecutor: async (action) => {
            executedActions.push(action);
            return { success: true, action: action.type, message: 'should not execute after a preflight timeout' };
          }
        });

        assert.strictEqual(execResult.success, false, 'execution should fail closed when TradingView quick-search preflight times out');
        assert.strictEqual(executedActions.length, 0, 'the type action should never execute after a preflight timeout');
        assert.strictEqual(execResult.results[0]?.quickSearchPreflight?.timedOut, true, 'timeout metadata should be preserved on the failed preflight result');
        assert(/quick-search preflight timed out/i.test(String(execResult.results[0]?.error || '')), 'failure should explain that quick-search preflight timed out before typing');

        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.deepStrictEqual(keyLog, [], 'timed-out quick-search preflight should not send delayed ctrl+a/ctrl+c/right cleanup after returning');
      });
    } finally {
      if (originalTimeoutEnv === undefined) {
        delete process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_PREFLIGHT_TIMEOUT_MS;
      } else {
        process.env.LIKU_TRADINGVIEW_QUICK_SEARCH_PREFLIGHT_TIMEOUT_MS = originalTimeoutEnv;
      }
    }
  });

  await test('ai-service can continue after keyboard fallback when post-type verification proves the quick-search query', async () => {
    const originalFindElements = uiAutomation.findElements;
    const foreground = buildTradingViewForeground();
    let clipboardValue = 'original clipboard payload';
    let copyCount = 0;
    const executedActions = [];

    uiAutomation.findElements = async () => ({ success: true, count: 0, element: null, elements: [] });

    try {
      await withPatchedAIServiceSystemAutomation({
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async (hwnd) => ({
          ...foreground,
          hwnd: Number(hwnd || 0) || 777
        }),
        findElementByText: async () => ({ success: true, count: 0, element: null, elements: [] }),
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
      }, async () => {
        const execResult = await aiService.executeActions({
          thought: 'Open Pine Editor from TradingView quick search',
          verification: 'TradingView quick search should continue only after the Pine Editor query is proven',
          actions: [
            {
              type: 'type',
              text: 'Pine Editor',
              reason: 'Replace the active TradingView quick-search text with Pine Editor',
              searchSurfaceContract: {
                route: 'quick-search',
                appName: 'TradingView',
                id: 'open-pine-editor',
                surface: 'pine-editor'
              },
              tradingViewShortcut: {
                id: 'symbol-search',
                surface: 'quick-search'
              }
            },
            {
              type: 'wait',
              ms: 1,
              reason: 'Prove the sequence can continue after the verified query'
            }
          ]
        }, null, null, {
          userMessage: 'open pine editor in tradingview',
          actionExecutor: async (action) => {
            executedActions.push(action);
            return {
              success: true,
              action: action.type,
              message: action.type === 'type'
                ? 'Typed "Pine Editor" via SendKeys fallback'
                : 'Waited 1ms',
              method: action.type === 'type' ? 'SendKeys' : undefined
            };
          }
        });

        const typedResult = execResult.results.find((entry) => entry?.quickSearchTypedVerification?.applicable === true);
        const typedActionIndex = executedActions.findIndex((entry) => entry?.type === 'type' && String(entry?.text || '') === 'Pine Editor');

        assert.strictEqual(execResult.success, true, 'execution should continue when the keyboard fallback query is proven after typing');
        assert(typedResult, 'the rewritten TradingView action sequence should still surface one typed-query verification result');
        assert(typedActionIndex >= 0, 'the rewritten TradingView action sequence should still execute the Pine Editor type step');
        assert.strictEqual(typedResult?.quickSearchPreflight?.fallbackAssumedFocused, true, 'setup should exercise the clipboard-assumed quick-search path');
        assert.strictEqual(typedResult?.quickSearchTypedVerification?.verified, true);
        assert.strictEqual(typedResult?.quickSearchTypedVerification?.satisfiedBy, 'clipboard-selection');
        assert(executedActions.slice(typedActionIndex + 1).length > 0, 'the TradingView action sequence should continue after the query is proven');
      });
    } finally {
      uiAutomation.findElements = originalFindElements;
    }
  });

  await test('ai-service preserves the TradingView target after a deferred Pine checkpoint sees browser foreground interference', async () => {
    const tradingViewForeground = {
      success: true,
      hwnd: 460832,
      title: 'LUNR ▲ 26.33 +6.17% / Unnamed',
      processName: 'TradingView',
      windowKind: 'main'
    };
    const browserForeground = {
      success: true,
      hwnd: 3407948,
      title: 'TradingView Workflow Optimization - Phased Implementation Task List (1).pdf - Microsoft Edge',
      processName: 'msedge',
      windowKind: 'main'
    };

    let currentForeground = tradingViewForeground;
    const focusCalls = [];
    const executedActions = [];
    let capturedReadbackAction = null;

    await withPatchedAIServiceSystemAutomation({
      getForegroundWindowInfo: async () => currentForeground,
      getForegroundWindowHandle: async () => Number(currentForeground?.hwnd || 0) || 0,
      focusWindow: async (hwnd) => {
        focusCalls.push(Number(hwnd || 0) || 0);
        currentForeground = tradingViewForeground;
        return { success: true, hwnd: Number(hwnd || 0) || 0 };
      },
      executeAction: async (action) => {
        if (action?.type === 'restore_window') {
          return { success: true, action: action.type, message: 'restore ignored in test harness' };
        }
        return { success: true, action: action?.type || 'unknown', message: 'ok' };
      }
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView Pine Editor and safely inspect it even if a browser steals foreground during the deferred activation checkpoint',
        verification: 'TradingView should remain the readback target for Pine Editor inspection',
        actions: [
          {
            type: 'key',
            key: 'ctrl+e',
            windowHandle: 460832,
            reason: 'Open TradingView Pine Editor through the official Pine shortcut route',
            tradingViewShortcut: {
              id: 'open-pine-editor',
              surface: 'pine-editor'
            },
            verify: {
              kind: 'panel-visible',
              appName: 'TradingView',
              target: 'pine-editor',
              keywords: ['pine', 'pine editor', 'script'],
              requiresObservedChange: false
            }
          },
          {
            type: 'get_text',
            text: 'Pine Editor',
            reason: 'Inspect the current visible Pine Editor state after the deferred activation checkpoint',
            pineEvidenceMode: 'safe-authoring-inspect',
            continueActions: [
              {
                type: 'wait',
                ms: 1,
                reason: 'Keep the semantic Pine activation path eligible for deferred readback continuation'
              }
            ]
          }
        ]
      }, null, null, {
        userMessage: 'open pine editor in tradingview and inspect it safely',
        actionExecutor: async (action) => {
          executedActions.push(action);
          if (action?.type === 'bring_window_to_front') {
            currentForeground = tradingViewForeground;
            return {
              success: true,
              action: action.type,
              hwnd: 460832,
              focusTarget: {
                requestedWindowHandle: 460832,
                actualForegroundHandle: 460832,
                actualForeground: tradingViewForeground
              },
              resolvedTarget: {
                windowHandle: 460832,
                hwnd: 460832,
                title: tradingViewForeground.title,
                processName: tradingViewForeground.processName
              },
              message: 'Focused TradingView'
            };
          }
          if (action?.type === 'click_element') {
            currentForeground = browserForeground;
            return {
              success: true,
              action: action.type,
              message: 'Clicked Pine icon'
            };
          }
          if (action?.type === 'get_text') {
            capturedReadbackAction = action;
            return {
              success: true,
              action: action.type,
              message: 'Got text via test harness',
              method: 'TestHarness',
              text: 'Pine Editor\nAdd to chart'
            };
          }
          return {
            success: true,
            action: action?.type || 'unknown',
            message: 'ok'
          };
        }
      });

      const openerResult = execResult.results.find((entry) => entry?.action === 'click_element');
      const getTextIndex = executedActions.findIndex((entry) => entry?.type === 'get_text');

      assert.strictEqual(execResult.success, true, 'Pine readback should continue after preserving the TradingView target through deferred browser interference');
      assert(openerResult?.deferredObservationCheckpoint, 'the Pine opener should still record a deferred activation checkpoint');
      assert.strictEqual(openerResult?.deferredObservationCheckpoint?.observationCheckpoint?.matchReason, 'browser-foreground', 'the deferred checkpoint should preserve the browser/PDF interference reason');
      assert(capturedReadbackAction, 'the Pine readback action should still execute after the deferred checkpoint');
      assert.strictEqual(capturedReadbackAction?.windowHandle, 460832, 'the Pine readback step should stay pinned to the original TradingView window handle');
      assert(focusCalls.length >= 1, 'the Pine readback path should perform at least one bounded refocus on the preserved TradingView target');
      assert.strictEqual(focusCalls[focusCalls.length - 1], 460832, 'the final Pine readback refocus should target the preserved TradingView window handle');
      assert(getTextIndex > 0, 'the Pine readback action should execute after the opener action');
    });
  });
}

main().catch((error) => {
  console.error('FAIL system automation quick-search');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(async () => {
  clearTimeout(forcedExitTimer);
  await shutdownSharedUIAHost().catch(() => {});
});
