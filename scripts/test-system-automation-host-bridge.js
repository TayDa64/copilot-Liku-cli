#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));
const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const { shutdownSharedUIAHost } = uiAutomation;
const TEST_TIMEOUT_MS = 30000;
const forcedExitTimer = setTimeout(() => {
  console.error(`FAIL system automation host bridge timed out after ${TEST_TIMEOUT_MS}ms`);
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

async function withAutomationHost(host, fn) {
  const originalFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const originalGetter = uiAutomation.getSharedUIAHost;

  process.env.LIKU_USE_AUTOMATION_HOST = '1';
  uiAutomation.getSharedUIAHost = () => host;

  try {
    return await fn();
  } finally {
    if (originalFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalFlag;
    }
    uiAutomation.getSharedUIAHost = originalGetter;
  }
}

function buildWindowInfo(overrides = {}) {
  return {
    hwnd: 777,
    pid: 4242,
    processId: 4242,
    processName: 'tradingview',
    title: 'TradingView - Pine Editor',
    ownerHwnd: 0,
    isTopmost: false,
    isToolWindow: false,
    isMinimized: false,
    isMaximized: true,
    windowKind: 'main',
    bounds: { x: 10, y: 20, width: 1280, height: 900 },
    ...overrides
  };
}

async function main() {
  await test('getForegroundWindowHandle uses automation host when enabled', async () => {
    let callCount = 0;

    await withAutomationHost({
      getForegroundWindowInfo: async () => {
        callCount += 1;
        return buildWindowInfo({ hwnd: 9988 });
      }
    }, async () => {
      const result = await systemAutomation.getForegroundWindowHandle();
      assert.strictEqual(result, 9988);
      assert.strictEqual(callCount, 1);
    });
  });

  await test('getForegroundWindowInfo preserves structured foreground shape from automation host', async () => {
    let callCount = 0;

    await withAutomationHost({
      getForegroundWindowInfo: async () => {
        callCount += 1;
        return buildWindowInfo({ ownerHwnd: 444, isToolWindow: true, windowKind: 'palette' });
      }
    }, async () => {
      const result = await systemAutomation.getForegroundWindowInfo();
      assert.strictEqual(callCount, 1);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hwnd, 777);
      assert.strictEqual(result.pid, 4242);
      assert.strictEqual(result.processName, 'tradingview');
      assert.strictEqual(result.ownerHwnd, 444);
      assert.strictEqual(result.isToolWindow, true);
      assert.strictEqual(result.windowKind, 'palette');
      assert.deepStrictEqual(result.bounds, { x: 10, y: 20, width: 1280, height: 900 });
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('getWindowInfoByHandle routes through automation host when enabled', async () => {
    const lookedUpHandles = [];

    await withAutomationHost({
      getWindowInfoByHandle: async (hwnd) => {
        lookedUpHandles.push(hwnd);
        return buildWindowInfo({ hwnd, title: `Window ${hwnd}` });
      }
    }, async () => {
      const result = await systemAutomation.getWindowInfoByHandle(321);
      assert.deepStrictEqual(lookedUpHandles, [321]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hwnd, 321);
      assert.strictEqual(result.title, 'Window 321');
      assert.strictEqual(result.processName, 'tradingview');
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('getClipboardText and setClipboardText route through automation host when enabled', async () => {
    const writes = [];

    await withAutomationHost({
      getClipboardText: async () => ({ text: 'host clipboard payload' }),
      setClipboardText: async (text) => {
        writes.push(text);
        return { ok: true };
      }
    }, async () => {
      const readResult = await systemAutomation.getClipboardText();
      assert.deepStrictEqual(readResult, {
        success: true,
        text: 'host clipboard payload',
        error: null,
        source: 'uia-host'
      });

      const writeResult = await systemAutomation.setClipboardText('pine script payload');
      assert.deepStrictEqual(writes, ['pine script payload']);
      assert.deepStrictEqual(writeResult, {
        success: true,
        error: null,
        source: 'uia-host'
      });
    });
  });

  await test('getWindowInfoByHandle rejects invalid handles before host lookup', async () => {
    let hostCalled = false;

    await withAutomationHost({
      getWindowInfoByHandle: async () => {
        hostCalled = true;
        return buildWindowInfo();
      }
    }, async () => {
      const result = await systemAutomation.getWindowInfoByHandle(0);
      assert.strictEqual(hostCalled, false);
      assert.deepStrictEqual(result, { success: false, error: 'Invalid window handle' });
    });
  });

  await test('focusWindow routes through automation host when enabled', async () => {
    const calls = [];

    await withAutomationHost({
      focusWindow: async (hwnd) => {
        calls.push(hwnd);
        return {
          requestedWindowHandle: hwnd,
          actualForegroundHandle: hwnd,
          actualForeground: buildWindowInfo({ hwnd, title: `Focused ${hwnd}` }),
          exactMatch: true,
          restored: false,
          focusAttempted: true,
          outcome: 'exact'
        };
      }
    }, async () => {
      const result = await systemAutomation.focusWindow(456);
      assert.deepStrictEqual(calls, [456]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.requestedWindowHandle, 456);
      assert.strictEqual(result.actualForegroundHandle, 456);
      assert.strictEqual(result.actualForeground?.title, 'Focused 456');
      assert.strictEqual(result.actualForeground?.source, 'uia-host');
      assert.strictEqual(result.exactMatch, true);
    });
  });

  await test('restoreWindow routes through automation host when enabled', async () => {
    const calls = [];

    await withAutomationHost({
      restoreWindow: async (hwnd) => {
        calls.push(hwnd);
        return {
          hwnd,
          restored: true,
          window: buildWindowInfo({ hwnd, isMinimized: false })
        };
      }
    }, async () => {
      const result = await systemAutomation.restoreWindow(654);
      assert.deepStrictEqual(calls, [654]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hwnd, 654);
      assert.strictEqual(result.restored, true);
      assert.strictEqual(result.window?.source, 'uia-host');
      assert.strictEqual(result.source, 'uia-host');
    });
  });

  await test('resolveWindowHandle prefers automation host findWindow when enabled', async () => {
    const lookups = [];

    await withAutomationHost({
      findWindow: async (criteria) => {
        lookups.push(criteria);
        return buildWindowInfo({ hwnd: 909, title: 'TradingView - Watchlist' });
      }
    }, async () => {
      const hwnd = await systemAutomation.resolveWindowHandle({
        title: 'TradingView',
        processName: 'tradingview'
      });
      assert.strictEqual(hwnd, 909);
      assert.strictEqual(lookups.length, 1);
      assert.deepStrictEqual(lookups[0], {
        title: 'TradingView',
        titleMode: 'contains',
        processName: 'tradingview',
        className: ''
      });
    });
  });

  await test('clickElementByText uses host invoke and preserves no-coordinate fallback policy', async () => {
    const calls = [];

    await withAutomationHost({
      findElementsByWindow: async (hwnd, options) => {
        calls.push({ cmd: 'findElementsByWindow', hwnd, options });
        return {
          elements: [{
            Name: 'Pine',
            ControlType: 'ControlType.Button',
            AutomationId: '',
            WindowHandle: hwnd,
            Patterns: ['Invoke'],
            Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
          }],
          count: 1,
          stats: { visited: 5, timedOut: false }
        };
      },
      focusWindow: async (hwnd) => {
        calls.push({ cmd: 'focusWindow', hwnd });
        return {
          requestedWindowHandle: hwnd,
          actualForegroundHandle: hwnd,
          actualForeground: buildWindowInfo({ hwnd }),
          exactMatch: true,
          outcome: 'exact'
        };
      },
      invokeElementByWindow: async (hwnd, options) => {
        calls.push({ cmd: 'invokeElementByWindow', hwnd, options });
        return {
          method: 'Invoke',
          element: {
            Name: 'Pine',
            ControlType: 'ControlType.Button',
            WindowHandle: hwnd,
            Patterns: ['Invoke'],
            Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
          },
          stats: { visited: 5, timedOut: false }
        };
      }
    }, async () => {
      const result = await systemAutomation.clickElementByText('Pine', {
        windowHandle: 123,
        controlType: 'Button',
        exact: true,
        allowCoordinateFallback: false
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.source, 'uia-host');
      assert.strictEqual(result.method, 'Invoke');
      assert.deepStrictEqual(calls.map((call) => call.cmd), [
        'findElementsByWindow',
        'focusWindow',
        'invokeElementByWindow'
      ]);
      assert.strictEqual(calls[2].options.text, 'Pine');
      assert.strictEqual(calls[2].options.textMode, 'exact');
    });
  });

  await test('clickElementByText fails closed when host invoke fails and coordinate fallback is disabled', async () => {
    await withAutomationHost({
      findElementsByWindow: async (hwnd) => ({
        elements: [{
          Name: 'Pine',
          ControlType: 'ControlType.Button',
          WindowHandle: hwnd,
          Patterns: ['Invoke'],
          Bounds: { X: 10, Y: 20, Width: 40, Height: 30, CenterX: 30, CenterY: 35 }
        }],
        count: 1
      }),
      focusWindow: async (hwnd) => ({
        requestedWindowHandle: hwnd,
        actualForegroundHandle: hwnd,
        actualForeground: buildWindowInfo({ hwnd }),
        exactMatch: true,
        outcome: 'exact'
      }),
      invokeElementByWindow: async () => {
        throw new Error('InvokePattern failed');
      }
    }, async () => {
      const result = await systemAutomation.clickElementByText('Pine', {
        windowHandle: 123,
        controlType: 'Button',
        exact: true,
        allowCoordinateFallback: false
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.method, 'invoke-only');
      assert(/coordinate fallback is disabled/i.test(result.error));
    });
  });
}

main().catch((error) => {
  console.error('FAIL system automation host bridge');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(async () => {
  clearTimeout(forcedExitTimer);
  await shutdownSharedUIAHost().catch(() => {});
});
