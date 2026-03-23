#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { UIWatcher } = require(path.join(__dirname, '..', 'src', 'main', 'ui-watcher.js'));

const results = {
  passed: 0,
  failed: 0,
  tests: []
};

async function testAsync(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'FAIL', error: error.message });
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
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

async function run() {
  console.log('\n========================================');
  console.log('  Windows Observation Flow Tests');
  console.log('========================================\n');

  await testAsync('normalized TradingView launch heals focus drift and verifies target', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'run_command', command: 'Start-Process "tradeing view"', shell: 'powershell' }
    ], {
      userMessage: 'open tradeing view'
    });

    const launchAction = rewritten.find((action) => action?.type === 'key' && action?.key === 'enter');
    assert(launchAction && launchAction.verifyTarget, 'Launch rewrite should produce a verifyTarget hint');
    assert.strictEqual(launchAction.verifyTarget.appName, 'TradingView');

    const foregroundSequence = [
      { success: true, hwnd: 111, title: 'README.md - Visual Studio Code', processName: 'code', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' }
    ];

    let focusCalls = 0;
    let restoreCalls = 0;

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => {
        if (action?.processName === 'tradingview') return 777;
        return 0;
      },
      getForegroundWindowHandle: async () => 777,
      focusWindow: async (hwnd) => {
        focusCalls++;
        return { success: hwnd === 777 };
      },
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' };
      },
      getRunningProcessesByNames: async () => ([
        { pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }
      ]),
      executeAction: async (action) => {
        if (action?.type === 'restore_window') restoreCalls++;
        return { success: true, action: action?.type || 'unknown', message: 'ok' };
      }
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Bring TradingView to the front',
        verification: 'TradingView should be focused',
        actions: [
          {
            type: 'bring_window_to_front',
            title: 'TradingView',
            processName: 'tradingview',
            verifyTarget: launchAction.verifyTarget
          },
          { type: 'wait', ms: 50 }
        ]
      }, null, null, {
        userMessage: 'bring tradeing view to front and tell me what you see',
        actionExecutor: async (action) => ({ success: true, action: action.type, message: 'executed' })
      });

      if (!execResult.success) {
        console.error('Combined flow diagnostic:', JSON.stringify(execResult, null, 2));
      }

      assert.strictEqual(execResult.success, true, 'Combined flow should succeed after bounded refocus');
      assert.strictEqual(execResult.focusVerification.verified, true, 'Focus verification should recover from drift');
      assert.strictEqual(execResult.focusVerification.drifted, true, 'Focus verification should record drift recovery');
      assert.strictEqual(execResult.focusVerification.expectedWindowHandle, 777, 'Focus verification should track the intended target window');
      assert.strictEqual(execResult.postVerification.verified, true, 'Post-launch verification should confirm the normalized target');
      assert(execResult.postVerification.runningPids.includes(4242), 'Post verification should report the TradingView PID');
      assert(focusCalls >= 1, 'Focus verification should attempt to refocus the target window');
      assert(restoreCalls >= 1, 'Focus verification should attempt a restore before re-focus when metadata is available');
    });
  });

  await testAsync('watcher waitForFreshState resolves after matching foreground update', async () => {
    const watcher = new UIWatcher({ pollInterval: 50 });
    watcher.cache.activeWindow = { hwnd: 111, title: 'Old Window', processName: 'code' };
    watcher.cache.lastUpdate = 100;

    const pending = watcher.waitForFreshState({
      targetHwnd: 777,
      sinceTs: 100,
      timeoutMs: 300
    });

    setTimeout(() => {
      watcher.cache.activeWindow = { hwnd: 777, title: 'TradingView', processName: 'tradingview' };
      watcher.cache.lastUpdate = 250;
      watcher.emit('poll-complete', {
        elements: [],
        activeWindow: watcher.cache.activeWindow,
        pollTime: 0,
        hasChanges: true
      });
    }, 20);

    const freshState = await pending;
    assert.strictEqual(freshState.fresh, true, 'waitForFreshState should resolve when a matching window update arrives');
    assert.strictEqual(freshState.timedOut, false, 'waitForFreshState should not timeout when a matching update arrives');
    assert.strictEqual(freshState.activeWindow.hwnd, 777, 'Fresh watcher state should report the expected window');
  });

  await testAsync('watcher context warns when UI state is stale', async () => {
    const watcher = new UIWatcher();
    watcher.cache.activeWindow = {
      hwnd: 777,
      title: 'TradingView',
      processName: 'tradingview',
      bounds: { x: 0, y: 0, width: 1200, height: 800 }
    };
    watcher.cache.windowTopology = { 777: {} };
    watcher.cache.elements = [
      {
        type: 'Window',
        name: 'TradingView',
        automationId: '',
        windowHandle: 777,
        center: { x: 600, y: 400 },
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        isEnabled: true
      }
    ];
    watcher.cache.lastUpdate = Date.now() - 2500;

    const context = watcher.getContextForAI();
    assert(context.includes('Freshness'), 'Stale watcher context should include a freshness warning');
    assert(context.includes('stale UI snapshot'), 'Stale watcher context should identify stale UI state explicitly');
  });

  console.log('\n========================================');
  console.log('  Windows Observation Flow Summary');
  console.log('========================================');
  console.log(`  Total:  ${results.passed + results.failed}`);
  console.log(`  Passed: ${results.passed}`);
  console.log(`  Failed: ${results.failed}`);
  console.log('========================================\n');

  process.exit(results.failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});