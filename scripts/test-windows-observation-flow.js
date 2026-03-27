#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const fs = require('fs');

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

  await testAsync('TradingView alert accelerator blocks follow-up typing when no dialog change is observed', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView alert dialog and type a price',
        verification: 'TradingView should open the alert dialog',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'alt+a', reason: 'Open the Create Alert dialog' },
          { type: 'type', text: '20.02', reason: 'Enter alert price' }
        ]
      }, null, null, {
        userMessage: 'open the create alert dialog in tradingview and type 20.02',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, false, 'Execution should stop when the alert surface never changes');
      assert.deepStrictEqual(executed, ['focus_window', 'key'], 'Typing should not continue after an unverified alert accelerator');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, false, 'The checkpoint should fail when no dialog change is observed');
      assert.strictEqual(execResult.results[1].observationCheckpoint.classification, 'dialog-open', 'Alert accelerator should classify as a dialog-open checkpoint');
      assert(/surface change/i.test(execResult.results[1].error || ''), 'Failure should explain that no TradingView surface change was confirmed');
    });
  });

  await testAsync('TradingView alert accelerator allows typing after observed dialog transition', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView alert dialog and type a price',
        verification: 'TradingView should open the alert dialog',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'alt+a', reason: 'Open the Create Alert dialog' },
          { type: 'type', text: '20.02', reason: 'Enter alert price' }
        ]
      }, null, null, {
        userMessage: 'open the create alert dialog in tradingview and type 20.02',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the alert dialog is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'type'], 'Typing should continue only after the dialog transition is verified');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'The checkpoint should pass after dialog observation');
      assert.strictEqual(execResult.observationCheckpoints[0].observedChange, true, 'Dialog observation should record a visible foreground change');
      assert.strictEqual(execResult.observationCheckpoints[0].foreground.hwnd, 889, 'Checkpoint should retarget typing to the dialog window handle');
    });
  });

  await testAsync('explicit action.verify contract enables reusable TradingView dialog verification', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 889, title: 'Create Alert - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Advance the current TradingView workflow',
        verification: 'TradingView should show the requested next surface',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'alt+a',
            reason: 'Advance the current TradingView workflow',
            verify: {
              kind: 'dialog-visible',
              appName: 'TradingView',
              target: 'create-alert',
              keywords: ['create alert']
            }
          },
          { type: 'type', text: '20.02', reason: 'Enter alert price' }
        ]
      }, null, null, {
        userMessage: 'advance the current TradingView workflow and enter 20.02 when the surface opens',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the explicit verify contract is satisfied');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'type'], 'Typing should continue only after the explicit dialog contract is verified');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'dialog-open', 'Explicit verify metadata should map to a reusable dialog-open checkpoint');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Explicit verify metadata should drive the bounded post-key verification');
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

  await testAsync('chat continuation guard forces direct observation answer after screenshot-only detour', async () => {
    const chatPath = path.join(__dirname, '..', 'src', 'cli', 'commands', 'chat.js');
    const chatContent = fs.readFileSync(chatPath, 'utf8');

    assert(chatContent.includes('isLikelyObservationInput(effectiveUserMessage) && isScreenshotOnlyPlan(contActionData)'), 'Chat loop should detect screenshot-only observation detours');
    assert(chatContent.includes('buildForcedObservationAnswerPrompt(effectiveUserMessage)'), 'Chat loop should request a direct answer after screenshot-only detours');
    assert(chatContent.includes('Respond now in natural language only — no JSON action block.'), 'Forced observation prompt should require a natural-language answer');
  });

  await testAsync('screenshot module reports fallback capture mode markers', async () => {
    const screenshotPath = path.join(__dirname, '..', 'src', 'main', 'ui-automation', 'screenshot.js');
    const screenshotContent = fs.readFileSync(screenshotPath, 'utf8');

    assert(screenshotContent.includes('window-copyfromscreen'), 'Screenshot module should include window CopyFromScreen fallback mode');
    assert(screenshotContent.includes('screen-copyfromscreen'), 'Screenshot module should label full-screen capture mode');
    assert(screenshotContent.includes('captureMode'), 'Screenshot module should return capture mode metadata');
  });

  await testAsync('pending confirmations survive confirm call and resume executes remaining steps', async () => {
    aiService.clearPendingAction();

    const pending = {
      actionId: 'action-test-confirm',
      actionIndex: 0,
      remainingActions: [
        { type: 'key', key: 'enter', reason: 'Confirm 5m timeframe' },
        { type: 'wait', ms: 10 }
      ],
      completedResults: [],
      thought: 'Switch TradingView timeframe to 5m',
      verification: 'TradingView should show 5m timeframe'
    };

    aiService.setPendingAction(pending);
    const confirmed = aiService.confirmPendingAction('action-test-confirm');
    assert(confirmed && confirmed.confirmed, 'confirmPendingAction should preserve the pending action and mark it confirmed');
    assert(aiService.getPendingAction(), 'Pending action should still be available for resumeAfterConfirmation');

    const originalExecuteAction = aiService.systemAutomation.executeAction;
    const originalGetForegroundWindowInfo = aiService.systemAutomation.getForegroundWindowInfo;
    const originalFocusWindow = aiService.systemAutomation.focusWindow;
    try {
      aiService.systemAutomation.executeAction = async (action) => ({ success: true, action: action.type, message: 'ok' });
      aiService.systemAutomation.getForegroundWindowInfo = async () => ({ success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' });
      aiService.systemAutomation.focusWindow = async () => ({ success: true });

      const resumed = await aiService.resumeAfterConfirmation(null, null, {
        userMessage: 'yes, change the timeframe selector from 1m to 5m',
        actionExecutor: async (action) => ({ success: true, action: action.type, message: 'executed' })
      });

      assert.strictEqual(resumed.success, true, 'resumeAfterConfirmation should execute the confirmed pending actions');
      assert.strictEqual(aiService.getPendingAction(), null, 'Pending action should clear after successful resume');
      assert.strictEqual(resumed.results.length, 2, 'Resume should execute both the confirmed action and remaining wait');
      assert.strictEqual(resumed.observationCheckpoints.length, 1, 'Resume should return TradingView key checkpoint metadata');
      assert.strictEqual(resumed.observationCheckpoints[0].verified, true, 'TradingView timeframe confirm should pass its bounded settle checkpoint');
    } finally {
      aiService.systemAutomation.executeAction = originalExecuteAction;
      aiService.systemAutomation.getForegroundWindowInfo = originalGetForegroundWindowInfo;
      aiService.systemAutomation.focusWindow = originalFocusWindow;
      aiService.clearPendingAction();
    }
  });

  await testAsync('benign timeframe enter does not require destructive-style confirmation', async () => {
    const safety = aiService.analyzeActionSafety(
      { type: 'key', key: 'enter', reason: 'Confirm 5m timeframe' },
      { text: 'Change chart timeframe to 5m', buttonText: '', nearbyText: [] }
    );

    assert.strictEqual(safety.riskLevel, aiService.ActionRiskLevel.MEDIUM, 'Benign timeframe enter should remain medium risk');
    assert.strictEqual(safety.requiresConfirmation, false, 'Benign timeframe enter should not require extra confirmation');
  });

  await testAsync('TradingView DOM order-entry actions are elevated to high risk', async () => {
    const safety = aiService.analyzeActionSafety(
      { type: 'click', reason: 'Place limit order from DOM order book' },
      { text: 'Depth of Market', nearbyText: ['Limit Buy', 'Sell Mkt', 'Quantity'] }
    );

    assert(safety.riskLevel === aiService.ActionRiskLevel.HIGH || safety.riskLevel === aiService.ActionRiskLevel.CRITICAL, 'TradingView DOM order-entry actions should be high risk or higher');
    assert.strictEqual(safety.requiresConfirmation, true, 'TradingView DOM order-entry actions should require confirmation');
  });

  await testAsync('TradingView DOM flatten controls are treated as critical risk', async () => {
    const safety = aiService.analyzeActionSafety(
      { type: 'click', reason: 'Flatten the position from the DOM trading panel' },
      { text: 'Flatten', nearbyText: ['Depth of Market', 'Reverse', 'CXL ALL'] }
    );

    assert.strictEqual(safety.riskLevel, aiService.ActionRiskLevel.CRITICAL, 'TradingView DOM flatten actions should be critical risk');
    assert.strictEqual(safety.requiresConfirmation, true, 'TradingView DOM flatten actions should require confirmation');
  });

  await testAsync('TradingView DOM order-entry actions are blocked before execution in advisory-only mode', async () => {
    let executed = 0;

    const execResult = await aiService.executeActions({
      thought: 'Place a DOM order in TradingView',
      verification: 'No DOM order should be placed',
      actions: [
        { type: 'click', reason: 'Place a limit order in the Depth of Market order book' }
      ]
    }, null, null, {
      userMessage: 'place a limit order in the TradingView DOM',
      actionExecutor: async (action) => {
        executed++;
        return { success: true, action: action.type, message: 'executed' };
      }
    });

    assert.strictEqual(executed, 0, 'Advisory-only DOM order-entry actions should be blocked before execution');
    assert.strictEqual(execResult.success, false, 'Advisory-only DOM order-entry actions should fail closed');
    assert.strictEqual(execResult.results[0].blockedByPolicy, true, 'Blocked DOM order-entry should be marked as policy-blocked');
    assert(/advisory-only/i.test(execResult.results[0].error || ''), 'Blocked DOM order-entry should explain the advisory-only safety rail');
  });

  await testAsync('TradingView DOM actions remain blocked when resuming after confirmation', async () => {
    let executed = 0;
    aiService.clearPendingAction();
    aiService.setPendingAction({
      actionId: 'action-test-dom-resume',
      actionIndex: 0,
      confirmed: true,
      remainingActions: [
        { type: 'click', reason: 'Flatten the position from the DOM trading panel' }
      ],
      completedResults: [],
      thought: 'Flatten the TradingView DOM position',
      verification: 'No DOM position action should execute'
    });

    try {
      const resumed = await aiService.resumeAfterConfirmation(null, null, {
        userMessage: 'yes, flatten the position in the DOM',
        actionExecutor: async (action) => {
          executed++;
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(executed, 0, 'Advisory-only DOM resume actions should be blocked before execution');
      assert.strictEqual(resumed.success, false, 'Advisory-only DOM resume actions should fail closed');
      assert.strictEqual(resumed.results[0].blockedByPolicy, true, 'Blocked DOM resume action should be marked as policy-blocked');
      assert(/advisory-only/i.test(resumed.results[0].error || ''), 'Blocked DOM resume action should explain the advisory-only safety rail');
    } finally {
      aiService.clearPendingAction();
    }
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