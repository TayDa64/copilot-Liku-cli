#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));
const { createTradingViewRuntimeRecovery } = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'runtime', 'recovery.js'));
const { shutdownSharedUIAHost } = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));

const TEST_TIMEOUT_MS = Math.max(
  20000,
  Number.parseInt(process.env.LIKU_TEST_TIMEOUT_MS || '60000', 10) || 60000
);

const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL host native clipboard state timed out after ${TEST_TIMEOUT_MS}ms`);
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

function buildForeground(overrides = {}) {
  return {
    success: true,
    hwnd: 777,
    pid: 4242,
    processName: 'tradingview',
    title: 'TradingView - Pine Editor',
    ownerHwnd: 0,
    isTopmost: false,
    isToolWindow: false,
    isMinimized: false,
    isMaximized: true,
    windowKind: 'main',
    bounds: { x: 40, y: 60, width: 1280, height: 900 },
    ...overrides
  };
}

async function withAutomationHost(hostOverrides, fn) {
  if (process.platform !== 'win32') {
    return fn();
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const sharedHost = typeof originalGetSharedUIAHost === 'function'
    ? (originalGetSharedUIAHost() || {})
    : {};
  const originalHostValues = new Map();

  for (const [key, value] of Object.entries(hostOverrides && typeof hostOverrides === 'object' ? hostOverrides : {})) {
    originalHostValues.set(key, sharedHost[key]);
    sharedHost[key] = value;
  }

  uiAutomation.getSharedUIAHost = () => sharedHost;
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    return await fn();
  } finally {
    for (const [key, value] of originalHostValues.entries()) {
      sharedHost[key] = value;
    }
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
}

async function main() {
  await test('system automation clipboard helpers honor exported overrides for hermetic tests', async () => {
    const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
    const originalGetClipboardText = systemAutomation.getClipboardText;
    const originalSetClipboardText = systemAutomation.setClipboardText;
    const clipboardWrites = [];

    process.env.LIKU_USE_AUTOMATION_HOST = '0';
    systemAutomation.getClipboardText = async () => ({
      success: true,
      text: 'override clipboard payload',
      error: null,
      source: 'test-override'
    });
    systemAutomation.setClipboardText = async (text) => {
      clipboardWrites.push(String(text ?? ''));
      return {
        success: true,
        error: null,
        source: 'test-override'
      };
    };

    try {
      const savedState = await systemAutomation.saveClipboardState();
      assert.strictEqual(savedState?.success, true);
      assert.strictEqual(savedState?.mode, 'text');
      assert.strictEqual(savedState?.text, 'override clipboard payload');
      assert.strictEqual(savedState?.source, 'test-override');

      const restored = await systemAutomation.restoreClipboardState({
        success: true,
        mode: 'text',
        text: 'restore payload'
      });
      assert.strictEqual(restored?.success, true);
      assert.deepStrictEqual(clipboardWrites, ['restore payload']);
    } finally {
      systemAutomation.getClipboardText = originalGetClipboardText;
      systemAutomation.setClipboardText = originalSetClipboardText;
      if (originalHostFlag === undefined) {
        delete process.env.LIKU_USE_AUTOMATION_HOST;
      } else {
        process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
      }
    }
  });

  await test('system automation routes clipboard state save and restore through the automation host token contract', async () => {
    if (process.platform !== 'win32') {
      console.log('SKIP system automation routes clipboard state save and restore through the automation host token contract (requires Windows automation host)');
      return;
    }

    const restoreCalls = [];

    await withAutomationHost({
      saveClipboardState: async () => ({
        token: 'clip-token-1',
        containsText: true,
        textLength: 22
      }),
      restoreClipboardState: async (token) => {
        restoreCalls.push(String(token || ''));
        return { ok: true };
      }
    }, async () => {
      const savedState = await systemAutomation.saveClipboardState();
      assert.deepStrictEqual(savedState, {
        success: true,
        token: 'clip-token-1',
        mode: 'host-token',
        containsText: true,
        textLength: 22,
        error: null,
        source: 'uia-host'
      });

      const restored = await systemAutomation.restoreClipboardState(savedState);
      assert.deepStrictEqual(restoreCalls, ['clip-token-1']);
      assert.deepStrictEqual(restored, {
        success: true,
        error: null,
        token: 'clip-token-1',
        source: 'uia-host'
      });
    });
  });

  await test('Pine save guard preserves clipboard through host-native save/restore instead of manual text restoration', async () => {
    if (process.platform !== 'win32') {
      console.log('SKIP Pine save guard preserves clipboard through host-native save/restore instead of manual text restoration (requires Windows automation host)');
      return;
    }

    const expectedScript = [
      '//@version=6',
      'indicator("Liku Live Save Probe", overlay=false)',
      'plot(close, title="Close")'
    ].join('\n');
    const keyCalls = [];
    const restoreCalls = [];
    const clipboardWrites = [];
    let clipboardReads = 0;
    let clipboardText = 'previous clipboard payload';
    let selectionActive = false;

    const result = await withAutomationHost({
      saveClipboardState: async () => ({
        token: 'pine-save-token',
        containsText: true,
        textLength: clipboardText.length
      }),
      restoreClipboardState: async (token) => {
        restoreCalls.push(String(token || ''));
        clipboardText = 'previous clipboard payload';
        return { ok: true };
      },
      getClipboardText: async () => {
        clipboardReads += 1;
        return { success: true, text: clipboardText };
      },
      setClipboardText: async (text) => {
        clipboardWrites.push(String(text || ''));
        clipboardText = String(text || '');
        return { success: true };
      }
    }, async () => systemAutomation.executeAction({
      type: 'key',
      key: 'ctrl+s',
      inputSurfaceContract: {
        appName: 'TradingView',
        route: 'pine-editor-authoring',
        surface: 'pine-editor',
        requiresPineEditorSurface: true
      },
      pinePreparedScriptText: expectedScript,
      pinePreparedScriptName: 'Liku Live Save Probe',
      reason: 'Save the freshly created Pine script'
    }, {
      pressKey: async (key) => {
        const normalizedKey = String(key || '').trim().toLowerCase();
        keyCalls.push(normalizedKey);
        if (normalizedKey === 'ctrl+a') {
          selectionActive = true;
          return;
        }
        if (normalizedKey === 'ctrl+c' && selectionActive) {
          clipboardText = expectedScript;
        }
      }
    }));

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineSaveGuard?.proof?.exactMatch, true);
    assert.deepStrictEqual(restoreCalls, ['pine-save-token']);
    assert.strictEqual(clipboardReads, 1, 'save guard should only read clipboard for editor proof, not for caller-state preservation');
    assert.deepStrictEqual(clipboardWrites, [], 'save guard should not manually rewrite caller clipboard when host restore is available');
    assert.strictEqual(clipboardText, 'previous clipboard payload');
    assert(keyCalls.includes('ctrl+s'), 'verified save should still press ctrl+s');
  });

  await test('TradingView quick-search clipboard fallback preserves caller clipboard through host-native save/restore', async () => {
    const foreground = buildForeground();
    const keyLog = [];
    const restoreCalls = [];
    let clipboardReads = 0;
    let clipboardWrites = 0;
    let clipboardValue = 'original clipboard payload';
    let savedClipboardValue = '';

    const recovery = createTradingViewRuntimeRecovery({
      systemAutomation: {
        getForegroundWindowInfo: async () => foreground,
        getWindowInfoByHandle: async () => foreground,
        findElementByText: async () => ({ success: true, element: null }),
        pressKey: async (key) => {
          keyLog.push(String(key || ''));
        },
        saveClipboardState: async () => {
          savedClipboardValue = clipboardValue;
          return {
            success: true,
            token: 'quick-search-token',
            mode: 'host-token',
            source: 'uia-host'
          };
        },
        restoreClipboardState: async (savedState) => {
          restoreCalls.push(String(savedState?.token || ''));
          clipboardValue = savedClipboardValue;
          return {
            success: true,
            token: String(savedState?.token || ''),
            source: 'uia-host'
          };
        },
        getClipboardText: async () => {
          clipboardReads += 1;
          return { success: true, text: clipboardValue, error: null };
        },
        setClipboardText: async (value) => {
          clipboardWrites += 1;
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

    assert(result?.ready, 'clipboard-selection fallback should still allow the quick-search continuation');
    assert.strictEqual(result?.initialRead?.sentinelMatched, true);
    assert.strictEqual(result?.finalRead?.sentinelMatched, true);
    assert.strictEqual(clipboardReads, 1, 'quick-search clipboard fallback should only read the captured selection state, not the caller clipboard for preservation');
    assert.strictEqual(clipboardWrites, 1, 'quick-search clipboard fallback should only write the sentinel payload directly');
    assert.deepStrictEqual(restoreCalls, ['quick-search-token']);
    assert.strictEqual(clipboardValue, 'original clipboard payload');
    assert.deepStrictEqual(keyLog, ['ctrl+a', 'ctrl+c', 'right']);
  });
}

main()
  .catch((error) => {
    console.error('FAIL host native clipboard state');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(forcedExitTimer);
    await shutdownSharedUIAHost().catch(() => {});
  });
