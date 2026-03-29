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

  await testAsync('tradingview focus mismatch is not reported as clean success', async () => {
    let focusCalls = 0;

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 264274 : 0,
      getForegroundWindowHandle: async () => 1969552,
      getForegroundWindowInfo: async () => ({
        success: true,
        hwnd: 1969552,
        title: 'README.md - Visual Studio Code',
        processName: 'code',
        windowKind: 'main'
      })
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Focus TradingView before continuing',
        verification: 'TradingView should become the foreground window',
        actions: [
          { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' }
        ]
      }, null, null, {
        userMessage: 'focus tradingview',
        actionExecutor: async (action) => {
          focusCalls++;
          return {
            success: true,
            action: action.type,
            message: 'Focus requested for 264274 but foreground is 1969552',
            requestedWindowHandle: 264274,
            actualForegroundHandle: 1969552,
            actualForeground: {
              success: true,
              hwnd: 1969552,
              title: 'README.md - Visual Studio Code',
              processName: 'code',
              windowKind: 'main'
            },
            focusTarget: {
              requestedWindowHandle: 264274,
              requestedTarget: {
                title: 'TradingView',
                processName: 'tradingview',
                className: null
              },
              actualForegroundHandle: 1969552,
              actualForeground: {
                success: true,
                hwnd: 1969552,
                title: 'README.md - Visual Studio Code',
                processName: 'code',
                windowKind: 'main'
              },
              exactMatch: false,
              outcome: 'mismatch'
            }
          };
        }
      });

      assert.strictEqual(execResult.success, false, 'Persistent focus mismatch should fail bounded verification');
      assert.strictEqual(execResult.results[0].focusTarget.requestedWindowHandle, 264274, 'Focus result should preserve the requested target handle');
      assert.strictEqual(execResult.results[0].focusTarget.actualForegroundHandle, 1969552, 'Focus result should preserve the actual foreground handle');
      assert.strictEqual(execResult.results[0].focusTarget.outcome, 'mismatch', 'Focus result should expose mismatch outcome');
      assert.strictEqual(execResult.results[0].focusTarget.accepted, false, 'Mismatch focus should not be treated as an accepted target update');
      assert(/foreground is 1969552/i.test(execResult.results[0].message), 'Focus mismatch message should mention the actual foreground window');
      assert(focusCalls >= 1, 'Focus attempt should still be executed');
    });
  });

  await testAsync('last target window only updates on exact or recovered tradingview focus', async () => {
    const focusCalls = [];
    const foregroundSequence = [
      { success: true, hwnd: 264274, title: 'TradingView', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 264274 : 0,
      getForegroundWindowHandle: async () => 1969552,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 264274, title: 'TradingView', processName: 'tradingview', windowKind: 'main' };
      },
      focusWindow: async (hwnd) => {
        focusCalls.push(hwnd);
        return {
          success: true,
          requestedWindowHandle: hwnd,
          actualForegroundHandle: 264274,
          actualForeground: {
            success: true,
            hwnd: 264274,
            title: 'TradingView',
            processName: 'tradingview',
            windowKind: 'main'
          },
          exactMatch: true,
          outcome: 'exact'
        };
      }
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Focus TradingView and type into the active surface',
        verification: 'Typing should remain routed to TradingView',
        actions: [
          { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview', verifyTarget: { appName: 'TradingView', processNames: ['tradingview'], titleHints: ['TradingView'] } },
          { type: 'type', text: 'plot(close)' }
        ]
      }, null, null, {
        userMessage: 'focus tradingview and type plot(close)',
        actionExecutor: async (action) => {
          if (action.type === 'bring_window_to_front') {
            return {
              success: true,
              action: action.type,
              message: 'Focus requested for 264274 but foreground is 1969552',
              requestedWindowHandle: 264274,
              actualForegroundHandle: 1969552,
              actualForeground: {
                success: true,
                hwnd: 1969552,
                title: 'README.md - Visual Studio Code',
                processName: 'code',
                windowKind: 'main'
              },
              focusTarget: {
                requestedWindowHandle: 264274,
                requestedTarget: {
                  title: 'TradingView',
                  processName: 'tradingview',
                  className: null
                },
                actualForegroundHandle: 1969552,
                actualForeground: {
                  success: true,
                  hwnd: 1969552,
                  title: 'README.md - Visual Studio Code',
                  processName: 'code',
                  windowKind: 'main'
                },
                exactMatch: false,
                outcome: 'mismatch'
              }
            };
          }
          if (action.type === 'type') {
            return { success: true, action: action.type, message: 'typed' };
          }
          return aiService.systemAutomation.executeAction(action);
        }
      });

      assert.strictEqual(execResult.success, true, 'Typing flow should recover after re-focusing the requested TradingView target');
      assert.deepStrictEqual(focusCalls, [264274], 'Pre-typing refocus should stay on the requested TradingView handle instead of drifting to the accidental foreground window');
      assert.strictEqual(execResult.results[0].focusTarget.outcome, 'mismatch', 'Initial focus action should record the mismatch outcome');
      assert.strictEqual(execResult.results[0].focusTarget.accepted, false, 'Initial focus mismatch should not be treated as an accepted target update');
      assert.strictEqual(execResult.focusVerification.verified, true, 'Final focus verification should succeed after the guarded re-focus');
      assert.strictEqual(execResult.focusVerification.expectedWindowHandle, 264274, 'Focus verification should stay pinned to the requested TradingView handle');
    });
  });

  await testAsync('low-signal TradingView indicator request rewrites to deterministic indicator workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'open indicator search in tradingview and add anchored vwap'
    });

    assert(Array.isArray(rewritten), 'indicator rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, '/');
    assert.strictEqual(rewritten[2].verify.kind, 'dialog-visible');
    assert.strictEqual(rewritten[4].type, 'type');
    assert.strictEqual(rewritten[4].text, 'anchored vwap');
    assert.strictEqual(rewritten[6].verify.kind, 'indicator-present');
  });

  await testAsync('low-signal TradingView study-search alias request rewrites to deterministic indicator workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'open study search in tradingview and add anchored vwap'
    });

    assert(Array.isArray(rewritten), 'study-search alias rewrite should return an action array');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, '/');
    assert(rewritten[2].verify.keywords.includes('study search'), 'indicator rewrite should preserve study-search alias keywords');
  });

  await testAsync('low-signal TradingView alert request rewrites to deterministic alert workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'set an alert for a price target of $20.02 in tradingview'
    });

    assert(Array.isArray(rewritten), 'alert rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, 'alt+a');
    assert.strictEqual(rewritten[2].verify.kind, 'dialog-visible');
    assert.strictEqual(rewritten[4].type, 'type');
    assert.strictEqual(rewritten[4].text, '20.02');
  });

  await testAsync('low-signal TradingView new-alert alias request rewrites to deterministic alert workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'open new alert in tradingview and type 25.5'
    });

    assert(Array.isArray(rewritten), 'new-alert alias rewrite should return an action array');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, 'alt+a');
    assert(rewritten[2].verify.keywords.includes('new alert'), 'alert rewrite should preserve new-alert alias keywords');
    assert.strictEqual(rewritten[4].text, '25.5');
  });

  await testAsync('low-signal TradingView timeframe request rewrites to bounded timeframe workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'change the timeframe selector from 1m to 5m in tradingview'
    });

    assert(Array.isArray(rewritten), 'timeframe rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'type');
    assert.strictEqual(rewritten[2].text, '5m');
    assert.strictEqual(rewritten[4].type, 'key');
    assert.strictEqual(rewritten[4].key, 'enter');
    assert.strictEqual(rewritten[4].verify.kind, 'timeframe-updated');
  });

  await testAsync('low-signal TradingView symbol request rewrites to bounded symbol workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'change the symbol to NVDA in tradingview'
    });

    assert(Array.isArray(rewritten), 'symbol rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'type');
    assert.strictEqual(rewritten[2].text, 'NVDA');
    assert.strictEqual(rewritten[4].type, 'key');
    assert.strictEqual(rewritten[4].key, 'enter');
    assert.strictEqual(rewritten[4].verify.kind, 'symbol-updated');
  });

  await testAsync('low-signal TradingView watchlist request rewrites to bounded watchlist workflow', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'screenshot' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'select the watchlist symbol NVDA in tradingview'
    });

    assert(Array.isArray(rewritten), 'watchlist rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'type');
    assert.strictEqual(rewritten[2].text, 'NVDA');
    assert.strictEqual(rewritten[4].type, 'key');
    assert.strictEqual(rewritten[4].key, 'enter');
    assert.strictEqual(rewritten[4].verify.kind, 'watchlist-updated');
  });

  await testAsync('low-signal TradingView object tree request wraps the opener with bounded surface verification', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+shift+o' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'open object tree in tradingview'
    });

    assert(Array.isArray(rewritten), 'object tree rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.kind, 'panel-visible');
    assert.strictEqual(rewritten[2].verify.target, 'object-tree');
  });

  await testAsync('low-signal TradingView drawing search request wraps the opener before typing continues', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: '/' },
      { type: 'type', text: 'trend line' }
    ], {
      userMessage: 'search for trend line in tradingview drawing tools'
    });

    assert(Array.isArray(rewritten), 'drawing search rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.kind, 'input-surface-open');
    assert.strictEqual(rewritten[2].verify.target, 'drawing-search');
    assert.strictEqual(rewritten[4].type, 'type');
    assert.strictEqual(rewritten[4].text, 'trend line');
  });

  await testAsync('low-signal TradingView Pine Editor request wraps the opener with bounded panel verification', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+e' },
      { type: 'type', text: 'plot(close)' }
    ], {
      userMessage: 'open pine editor in tradingview and type plot(close)'
    });

    const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
    const typed = rewritten.find((action) => action?.type === 'type' && action?.text === 'plot(close)');

    assert(Array.isArray(rewritten), 'pine rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, 'ctrl+k');
    assert.strictEqual(opener.verify.kind, 'editor-active');
    assert.strictEqual(opener.verify.target, 'pine-editor');
    assert.strictEqual(opener.verify.requiresObservedChange, true);
    assert(typed, 'pine rewrite should preserve typing after the Pine Editor opener route');
  });

  await testAsync('low-signal TradingView Pine Editor status request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+e' }
    ], {
      userMessage: 'open pine editor in tradingview and read the visible compiler status'
    });

    const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
    const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');

    assert(Array.isArray(rewritten), 'pine editor status rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, 'ctrl+k');
    assert.strictEqual(opener.verify.target, 'pine-editor');
    assert(readback, 'pine editor status rewrite should gather Pine Editor text');
    assert.strictEqual(readback.pineEvidenceMode, 'compile-result');
  });

  await testAsync('low-signal TradingView pine-script-editor alias request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+e' }
    ], {
      userMessage: 'open pine script editor in tradingview and read the visible compiler status'
    });

    const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
    assert(Array.isArray(rewritten), 'pine editor alias rewrite should return an action array');
    assert.strictEqual(rewritten[2].key, 'ctrl+k');
    assert.strictEqual(opener.verify.target, 'pine-editor');
    assert(rewritten.some((action) => action?.type === 'get_text' && action?.text === 'Pine Editor'));
  });

  await testAsync('low-signal TradingView Pine diagnostics request rewrites to panel verification plus diagnostics get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+e' }
    ], {
      userMessage: 'open pine editor in tradingview and check diagnostics'
    });

    const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
    const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');

    assert(Array.isArray(rewritten), 'pine diagnostics rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, 'ctrl+k');
    assert.strictEqual(opener.verify.target, 'pine-editor');
    assert(readback, 'pine diagnostics rewrite should gather Pine Editor text');
    assert.strictEqual(readback.pineEvidenceMode, 'diagnostics');
  });

  await testAsync('low-signal TradingView Pine line-budget request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+e' }
    ], {
      userMessage: 'open pine editor in tradingview and check whether the script is near the 500 line limit'
    });

    const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
    const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');

    assert(Array.isArray(rewritten), 'pine line-budget rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].key, 'ctrl+k');
    assert.strictEqual(opener.verify.target, 'pine-editor');
    assert(readback, 'pine line-budget rewrite should gather Pine Editor text');
    assert(/line-budget hints/i.test(readback.reason), 'pine line-budget readback should mention line-budget hints');
  });

  await testAsync('low-signal TradingView Pine Logs evidence request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+shift+l' }
    ], {
      userMessage: 'open pine logs in tradingview and read output'
    });

    assert(Array.isArray(rewritten), 'pine logs evidence rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.target, 'pine-logs');
    assert.strictEqual(rewritten[4].type, 'get_text');
    assert.strictEqual(rewritten[4].text, 'Pine Logs');
    assert.strictEqual(rewritten[4].pineEvidenceMode, 'logs-summary');
  });

  await testAsync('low-signal TradingView Pine Profiler evidence request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+shift+p' }
    ], {
      userMessage: 'open pine profiler in tradingview and summarize the visible metrics'
    });

    assert(Array.isArray(rewritten), 'pine profiler evidence rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.target, 'pine-profiler');
    assert.strictEqual(rewritten[4].type, 'get_text');
    assert.strictEqual(rewritten[4].text, 'Pine Profiler');
    assert.strictEqual(rewritten[4].pineEvidenceMode, 'profiler-summary');
  });

  await testAsync('low-signal TradingView performance-profiler alias request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+shift+p' }
    ], {
      userMessage: 'open performance profiler in tradingview and summarize the visible metrics'
    });

    assert(Array.isArray(rewritten), 'pine profiler alias rewrite should return an action array');
    assert.strictEqual(rewritten[2].verify.target, 'pine-profiler');
    assert.strictEqual(rewritten[4].text, 'Pine Profiler');
    assert.strictEqual(rewritten[4].pineEvidenceMode, 'profiler-summary');
  });

  await testAsync('low-signal TradingView Pine Version History request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'alt+h' }
    ], {
      userMessage: 'open pine version history in tradingview and summarize the latest visible revisions'
    });

    assert(Array.isArray(rewritten), 'pine version history evidence rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
    assert.strictEqual(rewritten[4].type, 'get_text');
    assert.strictEqual(rewritten[4].text, 'Pine Version History');
  });

  await testAsync('low-signal TradingView revision-history alias request rewrites to panel verification plus get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'alt+h' }
    ], {
      userMessage: 'open revision history in tradingview and summarize the latest visible revisions'
    });

    assert(Array.isArray(rewritten), 'revision-history alias rewrite should return an action array');
    assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
    assert.strictEqual(rewritten[4].text, 'Pine Version History');
  });

  await testAsync('low-signal TradingView Pine Version History metadata request rewrites to provenance-summary get_text', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'alt+h' }
    ], {
      userMessage: 'open pine version history in tradingview and summarize the top visible revision metadata'
    });

    assert(Array.isArray(rewritten), 'pine version history metadata rewrite should return an action array');
    assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
    assert.strictEqual(rewritten[4].type, 'get_text');
    assert.strictEqual(rewritten[4].text, 'Pine Version History');
    assert.strictEqual(rewritten[4].pineEvidenceMode, 'provenance-summary');
  });

  await testAsync('verified pine logs workflow allows bounded evidence gathering without screenshot loop', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 889, title: 'Pine Logs - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 889, title: 'Pine Logs - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 889, title: 'Pine Logs - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 889, title: 'Pine Logs - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open Pine Logs and read the latest visible output',
        verification: 'TradingView should show Pine Logs before text is read',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'ctrl+shift+l', reason: 'Open Pine Logs', verify: { kind: 'panel-visible', appName: 'TradingView', target: 'pine-logs', keywords: ['pine logs', 'pine'] } },
          { type: 'get_text', text: 'Pine Logs', reason: 'Read visible Pine Logs output', pineEvidenceMode: 'logs-summary' }
        ]
      }, null, null, {
        userMessage: 'open pine logs in tradingview and read output',
        actionExecutor: async (action) => {
          executed.push(action.type);
          if (action.type === 'get_text') {
            return {
              success: true,
              action: action.type,
              text: 'Error at 12: mismatched input',
              method: 'TextPattern',
              message: 'Got text via TextPattern: "Error at 12: mismatched input"',
              pineStructuredSummary: {
                evidenceMode: 'logs-summary',
                outputSurface: 'pine-logs',
                outputSignal: 'errors-visible',
                visibleOutputEntryCount: 1,
                topVisibleOutputs: ['Error at 12: mismatched input'],
                compactSummary: 'signal=errors-visible | entries=1 | errors=1'
              }
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after Pine Logs is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'get_text'], 'Bounded evidence gathering should continue to read text after panel verification');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Pine Logs panel observation should pass');
      assert.strictEqual(execResult.results[2].text, 'Error at 12: mismatched input', 'Text evidence should be preserved on the get_text result');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.evidenceMode, 'logs-summary', 'Pine Logs readback should attach a structured logs summary');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.outputSignal, 'errors-visible', 'Pine Logs summary should classify visible errors');
      assert(!execResult.screenshotCaptured, 'Pine Logs evidence gathering should not require a screenshot loop');
    });
  });

  await testAsync('verified pine profiler workflow allows bounded evidence gathering without screenshot loop', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 890, title: 'Pine Profiler - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 890, title: 'Pine Profiler - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 890, title: 'Pine Profiler - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 890, title: 'Pine Profiler - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open Pine Profiler and summarize the latest visible metrics',
        verification: 'TradingView should show Pine Profiler before text is read',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'ctrl+shift+p', reason: 'Open Pine Profiler', verify: { kind: 'panel-visible', appName: 'TradingView', target: 'pine-profiler', keywords: ['pine profiler', 'profiler', 'pine'] } },
          { type: 'get_text', text: 'Pine Profiler', reason: 'Read visible Pine Profiler output', pineEvidenceMode: 'profiler-summary' }
        ]
      }, null, null, {
        userMessage: 'open pine profiler in tradingview and summarize the visible metrics',
        actionExecutor: async (action) => {
          executed.push(action.type);
          if (action.type === 'get_text') {
            return {
              success: true,
              action: action.type,
              text: 'Profiler: 12 calls, avg 1.3ms, max 3.8ms',
              method: 'TextPattern',
              message: 'Got text via TextPattern: "Profiler: 12 calls, avg 1.3ms, max 3.8ms"',
              pineStructuredSummary: {
                evidenceMode: 'profiler-summary',
                outputSurface: 'pine-profiler',
                outputSignal: 'metrics-visible',
                visibleOutputEntryCount: 1,
                functionCallCountEstimate: 12,
                avgTimeMs: 1.3,
                maxTimeMs: 3.8,
                topVisibleOutputs: ['Profiler: 12 calls, avg 1.3ms, max 3.8ms'],
                compactSummary: 'signal=metrics-visible | calls=12 | avgMs=1.3 | maxMs=3.8 | entries=1'
              }
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after Pine Profiler is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'get_text'], 'Bounded profiler evidence gathering should continue to read text after panel verification');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Pine Profiler panel observation should pass');
      assert.strictEqual(execResult.results[2].text, 'Profiler: 12 calls, avg 1.3ms, max 3.8ms', 'Profiler text evidence should be preserved on the get_text result');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.evidenceMode, 'profiler-summary', 'Pine Profiler readback should attach a structured profiler summary');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.functionCallCountEstimate, 12, 'Pine Profiler summary should expose the visible function call count');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.avgTimeMs, 1.3, 'Pine Profiler summary should expose the visible average timing');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.maxTimeMs, 3.8, 'Pine Profiler summary should expose the visible maximum timing');
      assert(!execResult.screenshotCaptured, 'Pine Profiler evidence gathering should not require a screenshot loop');
    });
  });

  await testAsync('verified pine version history workflow allows bounded provenance gathering without screenshot loop', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open Pine Version History and summarize the latest visible revisions',
        verification: 'TradingView should show Pine Version History before text is read',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'alt+h', reason: 'Open Pine Version History', verify: { kind: 'panel-visible', appName: 'TradingView', target: 'pine-version-history', keywords: ['pine version history', 'version history', 'pine'] } },
          { type: 'get_text', text: 'Pine Version History', reason: 'Read visible Pine Version History entries' }
        ]
      }, null, null, {
        userMessage: 'open pine version history in tradingview and summarize the latest visible revisions',
        actionExecutor: async (action) => {
          executed.push(action.type);
          if (action.type === 'get_text') {
            return {
              success: true,
              action: action.type,
              text: 'Revision 18 saved 2m ago; Revision 17 saved 18m ago',
              method: 'TextPattern',
              message: 'Got text via TextPattern: "Revision 18 saved 2m ago; Revision 17 saved 18m ago"'
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after Pine Version History is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'get_text'], 'Bounded provenance gathering should continue to read text after panel verification');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Pine Version History panel observation should pass');
      assert.strictEqual(execResult.results[2].text, 'Revision 18 saved 2m ago; Revision 17 saved 18m ago', 'Version History text evidence should be preserved on the get_text result');
      assert(!execResult.screenshotCaptured, 'Pine Version History provenance gathering should not require a screenshot loop');
    });
  });

  await testAsync('verified pine version history metadata workflow preserves top visible revision text without screenshot loop', async () => {
    const executed = [];
    const evidenceModes = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 891, title: 'Pine Version History - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open Pine Version History and summarize the top visible revision metadata',
        verification: 'TradingView should show Pine Version History before text is read',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'alt+h', reason: 'Open Pine Version History', verify: { kind: 'panel-visible', appName: 'TradingView', target: 'pine-version-history', keywords: ['pine version history', 'version history', 'pine'] } },
          { type: 'get_text', text: 'Pine Version History', reason: 'Read top visible Pine Version History revision metadata', pineEvidenceMode: 'provenance-summary' }
        ]
      }, null, null, {
        userMessage: 'open pine version history in tradingview and summarize the top visible revision metadata',
        actionExecutor: async (action) => {
          executed.push(action.type);
          if (action.type === 'get_text') {
            evidenceModes.push(action.pineEvidenceMode || null);
            return {
              success: true,
              action: action.type,
              text: 'Revision 18 saved 2m ago; Revision 17 saved 18m ago; showing 2 visible revisions',
              pineStructuredSummary: {
                latestVisibleRevisionLabel: 'Revision 18',
                latestVisibleRelativeTime: '2m ago',
                visibleRevisionCount: 2,
                visibleRecencySignal: 'recent-churn-visible',
                topVisibleRevisions: [
                  { label: 'Revision 18', relativeTime: '2m ago', revisionNumber: 18 },
                  { label: 'Revision 17', relativeTime: '18m ago', revisionNumber: 17 }
                ]
              },
              method: 'TextPattern',
              message: 'Got text via TextPattern: "Revision 18 saved 2m ago; Revision 17 saved 18m ago; showing 2 visible revisions"'
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after Pine Version History metadata view is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'get_text'], 'Version History metadata summary should continue to read text after panel verification');
      assert.deepStrictEqual(evidenceModes, ['provenance-summary'], 'Version History metadata workflow should preserve provenance-summary evidence mode');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Pine Version History panel observation should pass');
      assert.strictEqual(execResult.results[2].text, 'Revision 18 saved 2m ago; Revision 17 saved 18m ago; showing 2 visible revisions', 'Version History metadata text should be preserved on the get_text result');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.latestVisibleRevisionLabel, 'Revision 18', 'Version History metadata summary should expose the latest visible revision label');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.latestVisibleRelativeTime, '2m ago', 'Version History metadata summary should expose the latest visible relative time');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.visibleRevisionCount, 2, 'Version History metadata summary should expose the visible revision count');
      assert.strictEqual(execResult.results[2].pineStructuredSummary.visibleRecencySignal, 'recent-churn-visible', 'Version History metadata summary should expose a bounded visible recency signal');
      assert.deepStrictEqual(execResult.results[2].pineStructuredSummary.topVisibleRevisions, [
        { label: 'Revision 18', relativeTime: '2m ago', revisionNumber: 18 },
        { label: 'Revision 17', relativeTime: '18m ago', revisionNumber: 17 }
      ], 'Version History metadata summary should expose compact top visible revisions');
      assert(!execResult.screenshotCaptured, 'Pine Version History metadata gathering should not require a screenshot loop');
    });
  });

  await testAsync('verified pine editor diagnostics workflow gathers compile text without screenshot loop', async () => {
    const executed = [];
    const evidenceModes = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open Pine Editor and summarize the visible compiler status',
        verification: 'TradingView should show Pine Editor before text is read',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor', verify: { kind: 'panel-visible', appName: 'TradingView', target: 'pine-editor', keywords: ['pine editor', 'pine'] } },
          { type: 'get_text', text: 'Pine Editor', reason: 'Read visible Pine Editor compile-result text for a bounded diagnostics summary', pineEvidenceMode: 'compile-result' }
        ]
      }, null, null, {
        userMessage: 'open pine editor in tradingview and summarize the compile result',
        actionExecutor: async (action) => {
          executed.push(action.type);
          if (action.type === 'get_text') evidenceModes.push(action.pineEvidenceMode || null);
          if (action.type === 'get_text') {
            return {
              success: true,
              action: action.type,
              text: 'Compiler: no errors. Status: strategy loaded.',
              method: 'TextPattern',
              message: 'Got text via TextPattern: "Compiler: no errors. Status: strategy loaded."'
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after Pine Editor is observed');
      assert.deepStrictEqual(executed, ['bring_window_to_front', 'wait', 'key', 'wait', 'type', 'wait', 'click_element', 'wait', 'get_text'], 'Bounded Pine Editor diagnostics gathering should upgrade legacy opener plans into the TradingView quick-search route before reading text');
      assert.deepStrictEqual(evidenceModes, ['compile-result'], 'Pine Editor diagnostics gathering should preserve compile-result evidence mode');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Pine Editor panel observation should pass');
      assert.strictEqual(execResult.results.find((result) => result.action === 'get_text')?.text, 'Compiler: no errors. Status: strategy loaded.', 'Pine Editor status text should be preserved on the get_text result');
      assert(!execResult.screenshotCaptured, 'Pine Editor diagnostics gathering should not require a screenshot loop');
    });
  });

  await testAsync('verified pine editor diagnostics workflow preserves visible compiler errors text', async () => {
    const executed = [];
    const evidenceModes = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' },
      { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowHandle: async () => 777,
      getForegroundWindowInfo: async () => {
        return foregroundSequence.shift() || { success: true, hwnd: 892, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'owned' };
      },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open Pine Editor and check diagnostics',
        verification: 'TradingView should show Pine Editor before text is read',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor', verify: { kind: 'panel-visible', appName: 'TradingView', target: 'pine-editor', keywords: ['pine editor', 'pine'] } },
          { type: 'get_text', text: 'Pine Editor', reason: 'Read visible Pine Editor diagnostics and warnings text for bounded evidence gathering', pineEvidenceMode: 'diagnostics' }
        ]
      }, null, null, {
        userMessage: 'open pine editor in tradingview and check diagnostics',
        actionExecutor: async (action) => {
          executed.push(action.type);
          if (action.type === 'get_text') evidenceModes.push(action.pineEvidenceMode || null);
          if (action.type === 'get_text') {
            return {
              success: true,
              action: action.type,
              text: 'Compiler error at line 42: mismatched input. Warning: script has unused variable.',
              method: 'TextPattern',
              message: 'Got text via TextPattern: "Compiler error at line 42: mismatched input. Warning: script has unused variable."'
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after Pine Editor diagnostics surface is observed');
      assert.deepStrictEqual(executed, ['bring_window_to_front', 'wait', 'key', 'wait', 'type', 'wait', 'click_element', 'wait', 'get_text'], 'Bounded Pine Editor diagnostics should upgrade legacy opener plans into the TradingView quick-search route before reading text');
      assert.deepStrictEqual(evidenceModes, ['diagnostics'], 'Pine diagnostics gathering should preserve diagnostics evidence mode');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Pine Editor panel observation should pass');
      assert.strictEqual(execResult.results.find((result) => result.action === 'get_text')?.text, 'Compiler error at line 42: mismatched input. Warning: script has unused variable.', 'Pine Editor diagnostics text should be preserved on the get_text result');
      assert(!execResult.screenshotCaptured, 'Pine Editor diagnostics gathering should not require a screenshot loop');
    });
  });

  await testAsync('low-signal TradingView DOM request wraps the opener with bounded panel verification', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'ctrl+d' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'open depth of market in tradingview'
    });

    assert(Array.isArray(rewritten), 'dom rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.kind, 'panel-visible');
    assert.strictEqual(rewritten[2].verify.target, 'dom-panel');
  });

  await testAsync('low-signal TradingView paper trading request rewrites to bounded paper-assist verification', async () => {
    const rewritten = aiService.rewriteActionsForReliability([
      { type: 'key', key: 'alt+t' },
      { type: 'wait', ms: 250 }
    ], {
      userMessage: 'open paper trading in tradingview'
    });

    assert(Array.isArray(rewritten), 'paper trading rewrite should return an action array');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[0].processName, 'tradingview');
    assert.strictEqual(rewritten[2].type, 'key');
    assert.strictEqual(rewritten[2].verify.kind, 'panel-visible');
    assert.strictEqual(rewritten[2].verify.target, 'paper-trading-panel');
  });

  await testAsync('passive TradingView observation prompt preserves concrete focus-and-screenshot plan', async () => {
    const original = [
      { type: 'focus_window', windowHandle: 264274 },
      { type: 'wait', ms: 1000 },
      { type: 'screenshot' }
    ];

    const rewritten = aiService.rewriteActionsForReliability(original, {
      userMessage: 'I have tradingview open in the background, what do you think?'
    });

    assert.deepStrictEqual(rewritten, original, 'Passive TradingView observation prompts should preserve a concrete existing-window observation plan');
    assert.strictEqual(rewritten[0].type, 'focus_window');
    assert.strictEqual(rewritten[0].windowHandle, 264274);
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

  await testAsync('pine creation flow avoids clear-first behavior without explicit overwrite request', async () => {
    const original = [
      { type: 'focus_window', windowHandle: 264274 },
      { type: 'wait', ms: 1000 },
      { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
      { type: 'wait', ms: 1000 },
      { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
      { type: 'key', key: 'backspace', reason: 'Clear editor for new script' },
      { type: 'type', text: 'indicator("LUNR Confidence")' }
    ];

    const rewritten = aiService.rewriteActionsForReliability(original, {
      userMessage: 'tradingview application is showing LUNR, in tradingview, create a pine script that will build my confidence level when making decisions.'
    });

    const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
    assert(Array.isArray(rewritten), 'workflow should rewrite');
    assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
    assert.strictEqual(rewritten[2].key, 'ctrl+k');
    assert.strictEqual(opener.verify.kind, 'editor-active');
    assert(rewritten.some((action) => action?.type === 'get_text' && action?.text === 'Pine Editor'), 'safe authoring should inspect the Pine Editor state first');
    assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'safe authoring should remove select-all by default');
    assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'backspace'), 'safe authoring should remove destructive clear-first steps by default');
  });

  await testAsync('explicit TradingView indicator contracts allow bounded add-indicator continuation', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 889, title: 'Indicators - TradingView', processName: 'tradingview', windowKind: 'palette' },
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
        thought: 'Add Anchored VWAP in TradingView',
        verification: 'TradingView should open indicator search and add Anchored VWAP',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: '/',
            reason: 'Open the TradingView indicator search',
            verify: {
              kind: 'dialog-visible',
              appName: 'TradingView',
              target: 'indicator-search',
              keywords: ['indicator', 'indicators', 'anchored vwap']
            }
          },
          { type: 'type', text: 'Anchored VWAP', reason: 'Search for Anchored VWAP' },
          {
            type: 'key',
            key: 'enter',
            reason: 'Add Anchored VWAP to the chart',
            verify: {
              kind: 'indicator-present',
              appName: 'TradingView',
              target: 'indicator-present',
              keywords: ['anchored vwap']
            }
          }
        ]
      }, null, null, {
        userMessage: 'open indicator search in tradingview and add anchored vwap',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after bounded indicator workflow verification');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'type', 'key'], 'Indicator workflow should continue through search and add actions');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'input-surface-open', 'Indicator search should be treated as an input-surface checkpoint');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Indicator search surface should verify before typing');
      assert.strictEqual(execResult.observationCheckpoints[1].classification, 'chart-state', 'Indicator add should map to a chart-state checkpoint');
      assert.strictEqual(execResult.observationCheckpoints[1].verified, true, 'Indicator add should verify before the workflow claims success');
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
    assert(chatContent.includes('buildBoundedObservationFallback(effectiveUserMessage, ai)'), 'Chat loop should fall back to a bounded observation answer when the forced retry still returns actions');
    assert(chatContent.includes('using a bounded fallback answer instead of continuing the screenshot loop'), 'Chat loop should warn that it is using a bounded fallback answer instead of dead-ending');
  });

  await testAsync('drawing assessment requests keep bounded capability framing for screenshot-only evidence', async () => {
    const messageBuilderPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js');
    const messageBuilderContent = fs.readFileSync(messageBuilderPath, 'utf8');

    assert(messageBuilderContent.includes('## Drawing Capability Bounds'), 'Message builder should inject explicit drawing capability bounds');
    assert(messageBuilderContent.includes('Distinguish TradingView drawing surface access from precise chart-object placement'), 'Drawing bounds should distinguish tool access from precise placement claims');
    assert(messageBuilderContent.includes('safe surface workflow or explicitly refuse precise-placement claims'), 'Drawing bounds should require safe workflow fallback or bounded refusal under degraded evidence');
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

  await testAsync('pine confirmation resume re-establishes editor state before destructive edit', async () => {
    aiService.clearPendingAction();
    const executed = [];
    const originalExecuteAction = aiService.systemAutomation.executeAction;
    const originalGetForegroundWindowInfo = aiService.systemAutomation.getForegroundWindowInfo;
    const originalResolveWindowHandle = aiService.systemAutomation.resolveWindowHandle;
    const originalFocusWindow = aiService.systemAutomation.focusWindow;

    try {
      aiService.systemAutomation.executeAction = async (action) => ({ success: true, action: action.type, message: 'ok' });
      aiService.systemAutomation.getForegroundWindowInfo = async () => ({
        success: true,
        hwnd: 777,
        title: 'Pine Editor - TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      });
      aiService.systemAutomation.resolveWindowHandle = async (action) => action?.processName === 'tradingview' ? 777 : 0;
      aiService.systemAutomation.focusWindow = async (hwnd) => ({
        success: true,
        requestedWindowHandle: hwnd,
        actualForegroundHandle: 777,
        actualForeground: {
          success: true,
          hwnd: 777,
          title: 'Pine Editor - TradingView',
          processName: 'tradingview',
          windowKind: 'main'
        },
        exactMatch: true,
        outcome: 'exact'
      });

      const initial = await aiService.executeActions({
        thought: 'Overwrite the current Pine script',
        verification: 'TradingView should keep the Pine Editor active before the overwrite continues',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'ctrl+e',
            reason: 'Open TradingView Pine Editor',
            verify: {
              kind: 'editor-active',
              appName: 'TradingView',
              target: 'pine-editor',
              keywords: ['pine', 'pine editor', 'script'],
              requiresObservedChange: true
            }
          },
          { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
          { type: 'key', key: 'backspace', reason: 'Clear editor for replacement script' },
          { type: 'type', text: 'indicator("Replacement")', reason: 'Type replacement Pine script' }
        ]
      }, null, null, {
        userMessage: 'overwrite the current pine script in tradingview with a replacement version',
        onRequireConfirmation: () => {},
        actionExecutor: async (action) => {
          executed.push(action.type === 'key' ? `${action.type}:${action.key}` : action.type);
          if (action.type === 'focus_window') {
            return {
              success: true,
              action: action.type,
              message: 'focused',
              requestedWindowHandle: 777,
              actualForegroundHandle: 777,
              actualForeground: {
                success: true,
                hwnd: 777,
                title: 'TradingView',
                processName: 'tradingview',
                windowKind: 'main'
              },
              focusTarget: {
                requestedWindowHandle: 777,
                requestedTarget: { title: 'TradingView', processName: 'tradingview', className: null },
                actualForegroundHandle: 777,
                actualForeground: {
                  success: true,
                  hwnd: 777,
                  title: 'TradingView',
                  processName: 'tradingview',
                  windowKind: 'main'
                },
                exactMatch: true,
                outcome: 'exact'
              }
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(initial.pendingConfirmation, true, 'Destructive Pine overwrite should pause for confirmation');
      const pending = aiService.getPendingAction();
      assert(pending, 'Pending Pine overwrite should be stored');
      assert(Array.isArray(pending.resumePrerequisites), 'Pending Pine overwrite should store resume prerequisites');
      assert.strictEqual(pending.resumePrerequisites[2].key, 'ctrl+k');
      assert.strictEqual(pending.resumePrerequisites[8].key, 'ctrl+a');

      aiService.confirmPendingAction(pending.actionId);
      executed.length = 0;

      const resumed = await aiService.resumeAfterConfirmation(null, null, {
        userMessage: 'yes, continue overwriting the current pine script',
        actionExecutor: async (action) => {
          executed.push(action.type === 'key' ? `${action.type}:${action.key}` : action.type);
          if (action.type === 'bring_window_to_front') {
            return {
              success: true,
              action: action.type,
              message: 'focused',
              requestedWindowHandle: 777,
              actualForegroundHandle: 777,
              actualForeground: {
                success: true,
                hwnd: 777,
                title: 'Pine Editor - TradingView',
                processName: 'tradingview',
                windowKind: 'main'
              },
              focusTarget: {
                requestedWindowHandle: 777,
                requestedTarget: { title: action.title, processName: 'tradingview', className: null },
                actualForegroundHandle: 777,
                actualForeground: {
                  success: true,
                  hwnd: 777,
                  title: 'Pine Editor - TradingView',
                  processName: 'tradingview',
                  windowKind: 'main'
                },
                exactMatch: true,
                outcome: 'exact'
              }
            };
          }
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(resumed.success, true, 'Pine resume should succeed after editor prerequisites are re-established');
      assert.deepStrictEqual(
        executed,
        ['bring_window_to_front', 'wait', 'key:ctrl+k', 'wait', 'type', 'wait', 'click_element', 'wait', 'key:ctrl+a', 'wait', 'key:backspace', 'type'],
        'Pine resume should re-open the editor through TradingView quick search and re-select contents before destructive overwrite continues'
      );
      assert.strictEqual(resumed.observationCheckpoints.length, 1, 'Resume should verify the Pine Editor activation checkpoint');
      assert.strictEqual(resumed.observationCheckpoints[0].classification, 'editor-active');
      assert.strictEqual(resumed.observationCheckpoints[0].verified, true);
    } finally {
      aiService.systemAutomation.executeAction = originalExecuteAction;
      aiService.systemAutomation.getForegroundWindowInfo = originalGetForegroundWindowInfo;
      aiService.systemAutomation.resolveWindowHandle = originalResolveWindowHandle;
      aiService.systemAutomation.focusWindow = originalFocusWindow;
      aiService.clearPendingAction();
    }
  });

  await testAsync('pending confirmation triggers approval-pause non-disruptive recapture when target window is known', async () => {
    aiService.clearPendingAction();
    const captureRequests = [];

    try {
      const execResult = await aiService.executeActions({
        thought: 'Run a destructive command only after confirmation',
        verification: 'Command should not execute before explicit confirmation',
        actions: [
          {
            type: 'run_command',
            command: 'Remove-Item -LiteralPath C:\\temp\\dangerous -Recurse -Force',
            reason: 'Delete a directory recursively',
            windowHandle: 777,
            processName: 'tradingview',
            className: 'Chrome_WidgetWin_1'
          }
        ]
      }, null, async (captureOptions = {}) => {
        captureRequests.push(captureOptions);
      }, {
        userMessage: 'delete the dangerous directory now',
        onRequireConfirmation: () => {}
      });

      assert.strictEqual(execResult.pendingConfirmation, true, 'Execution should pause for confirmation');
      assert.strictEqual(captureRequests.length, 1, 'Approval pause should request exactly one refresh capture');
      assert.strictEqual(captureRequests[0].scope, 'window', 'Approval pause capture should target the window scope');
      assert.strictEqual(captureRequests[0].windowHandle, 777, 'Approval pause capture should target the known window handle');
      assert.strictEqual(captureRequests[0].approvalPauseRefresh, true, 'Approval pause capture should mark refresh metadata');
      assert.strictEqual(captureRequests[0].capturePurpose, 'approval-pause-refresh', 'Approval pause capture should include capture purpose metadata');
      assert.strictEqual(captureRequests[0].processName, 'tradingview', 'Approval pause capture should carry target process metadata');
      assert.strictEqual(captureRequests[0].className, 'Chrome_WidgetWin_1', 'Approval pause capture should carry target class metadata');

      const pending = aiService.getPendingAction();
      assert(pending && pending.approvalPauseCapture, 'Pending action should retain approval-pause capture metadata');
      assert.strictEqual(pending.approvalPauseCapture.requested, true, 'Pending action should record that recapture was requested');
      assert.strictEqual(pending.approvalPauseCapture.windowHandle, 777, 'Pending action should record the capture target window handle');
    } finally {
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

  await testAsync('explicit TradingView timeframe contracts allow bounded chart-state continuation', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView - 1m', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView - 5m', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView - 5m', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 777, title: 'TradingView - 5m', processName: 'tradingview', windowKind: 'main' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Switch TradingView timeframe to 5m',
        verification: 'TradingView should show 5m timeframe',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'type', text: '5m', reason: 'Type the requested timeframe into the active timeframe surface' },
          {
            type: 'key',
            key: 'enter',
            reason: 'Confirm 5m timeframe',
            verify: {
              kind: 'timeframe-updated',
              appName: 'TradingView',
              target: 'timeframe-updated',
              keywords: ['timeframe', 'interval', '5m']
            }
          }
        ]
      }, null, null, {
        userMessage: 'change the timeframe selector from 1m to 5m in tradingview',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the timeframe change is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'type', 'key'], 'Timeframe workflow should continue after bounded chart-state verification');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A timeframe checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'chart-state', 'Timeframe verification should map to chart-state');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Timeframe chart-state verification should pass after the updated chart title is observed');
    });
  });

  await testAsync('explicit TradingView symbol contracts allow bounded chart-state continuation', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView - AAPL', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView - NVDA', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView - NVDA', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 777, title: 'TradingView - NVDA', processName: 'tradingview', windowKind: 'main' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Switch TradingView symbol to NVDA',
        verification: 'TradingView should show NVDA chart state',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'type', text: 'NVDA', reason: 'Type the requested symbol into the active symbol surface' },
          {
            type: 'key',
            key: 'enter',
            reason: 'Confirm TradingView symbol NVDA',
            verify: {
              kind: 'symbol-updated',
              appName: 'TradingView',
              target: 'symbol-updated',
              keywords: ['symbol', 'ticker', 'NVDA']
            }
          }
        ]
      }, null, null, {
        userMessage: 'change the symbol to NVDA in tradingview',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the symbol change is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'type', 'key'], 'Symbol workflow should continue after bounded chart-state verification');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A symbol checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'chart-state', 'Symbol verification should map to chart-state');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Symbol chart-state verification should pass after the updated chart title is observed');
    });
  });

  await testAsync('explicit TradingView watchlist contracts allow bounded chart-state continuation', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView - Watchlist AAPL', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView - Watchlist NVDA', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView - Watchlist NVDA', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 777, title: 'TradingView - Watchlist NVDA', processName: 'tradingview', windowKind: 'main' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Switch TradingView watchlist symbol to NVDA',
        verification: 'TradingView should show watchlist NVDA chart state',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          { type: 'type', text: 'NVDA', reason: 'Type the requested watchlist symbol into the active watchlist surface' },
          {
            type: 'key',
            key: 'enter',
            reason: 'Confirm TradingView watchlist symbol NVDA',
            verify: {
              kind: 'watchlist-updated',
              appName: 'TradingView',
              target: 'watchlist-updated',
              keywords: ['watchlist', 'symbol', 'NVDA']
            }
          }
        ]
      }, null, null, {
        userMessage: 'select the watchlist symbol NVDA in tradingview',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the watchlist change is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'type', 'key'], 'Watchlist workflow should continue after bounded chart-state verification');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A watchlist checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'chart-state', 'Watchlist verification should map to chart-state');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Watchlist chart-state verification should pass after the updated chart title is observed');
    });
  });

  await testAsync('explicit TradingView object tree contracts allow bounded panel verification', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView - LUNR', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 778, title: 'Object Tree - TradingView', processName: 'tradingview', windowKind: 'palette' },
      { success: true, hwnd: 778, title: 'Object Tree - TradingView', processName: 'tradingview', windowKind: 'palette' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 778, title: 'Object Tree - TradingView', processName: 'tradingview', windowKind: 'palette' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView Object Tree',
        verification: 'TradingView should show the Object Tree panel',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'ctrl+shift+o',
            reason: 'Open TradingView Object Tree',
            verify: {
              kind: 'panel-visible',
              appName: 'TradingView',
              target: 'object-tree',
              keywords: ['object tree', 'drawing']
            }
          }
        ]
      }, null, null, {
        userMessage: 'open object tree in tradingview',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the object tree panel is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key'], 'Object tree workflow should stop at the verified opener in this bounded test');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'An object tree checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'panel-open', 'Object tree verification should map to panel-open');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Object tree verification should pass after the panel title is observed');
    });
  });

  await testAsync('explicit TradingView drawing search contracts gate typing on observed surface change', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView - LUNR', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 778, title: 'Drawing Tools - TradingView', processName: 'tradingview', windowKind: 'palette' },
      { success: true, hwnd: 778, title: 'Drawing Tools - TradingView', processName: 'tradingview', windowKind: 'palette' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 778, title: 'Drawing Tools - TradingView', processName: 'tradingview', windowKind: 'palette' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView drawing search for trend line',
        verification: 'TradingView should show the drawing tools surface before typing',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: '/',
            reason: 'Open TradingView drawing search',
            verify: {
              kind: 'input-surface-open',
              appName: 'TradingView',
              target: 'drawing-search',
              keywords: ['drawing tools', 'trend line', 'drawing']
            }
          },
          { type: 'type', text: 'trend line', reason: 'Search for TradingView drawing trend line' }
        ]
      }, null, null, {
        userMessage: 'search for trend line in tradingview drawing tools',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should continue after the drawing surface change is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key', 'type'], 'Typing should continue only after the drawing search surface is verified');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A drawing search checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'input-surface-open', 'Drawing search verification should map to input-surface-open');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Drawing search verification should pass after the surface title is observed');
    });
  });

  await testAsync('explicit TradingView Pine Editor contracts gate typing on observed panel change', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 777, title: 'Pine Editor - TradingView', processName: 'tradingview', windowKind: 'main' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView Pine Editor and type a script',
        verification: 'TradingView should show the Pine Editor before typing',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'ctrl+e',
            reason: 'Open TradingView Pine Editor',
            verify: {
              kind: 'editor-active',
              appName: 'TradingView',
              target: 'pine-editor',
              keywords: ['pine', 'pine editor', 'script'],
              requiresObservedChange: true
            }
          },
          { type: 'type', text: 'plot(close)', reason: 'Type Pine script' }
        ]
      }, null, null, {
        userMessage: 'open pine editor in tradingview and type plot(close)',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the Pine Editor surface is observed');
      assert.deepStrictEqual(executed, ['bring_window_to_front', 'wait', 'key', 'wait', 'type', 'wait', 'click_element', 'wait', 'type'], 'Typing should continue only after the legacy Pine opener is rewritten into the TradingView quick-search route and verified');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A post-key observation checkpoint should be returned');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'The Pine checkpoint should pass after panel observation');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'editor-active', 'Pine Editor should verify as an editor-active checkpoint');
      assert.strictEqual(execResult.observationCheckpoints[0].editorActiveMatched, true, 'Pine Editor checkpoint should record editor-active matching');
      assert.strictEqual(execResult.observationCheckpoints[0].foreground.hwnd, 777, 'Checkpoint should preserve the TradingView main window handle');
    });
  });

  await testAsync('pine editor typing waits for editor-active verification', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView Pine Editor and type a script',
        verification: 'TradingView should show an active Pine Editor before typing',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'ctrl+e',
            reason: 'Open TradingView Pine Editor',
            verify: {
              kind: 'editor-active',
              appName: 'TradingView',
              target: 'pine-editor',
              keywords: ['pine', 'pine editor', 'script'],
              requiresObservedChange: true
            }
          },
          { type: 'type', text: 'plot(close)', reason: 'Type Pine script' }
        ]
      }, null, null, {
        userMessage: 'open pine editor in tradingview and type plot(close)',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, false, 'Typing should not continue when Pine Editor activation is not observed');
      assert.deepStrictEqual(executed, ['bring_window_to_front', 'wait', 'key', 'wait', 'type', 'wait', 'click_element'], 'Typing should stop after the rewritten Pine opener route fails its editor-active checkpoint');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'An editor-active checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'editor-active', 'Pine authoring should classify the checkpoint as editor-active');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, false, 'Editor-active checkpoint should fail without a visible Pine Editor activation');
      assert(/active Pine Editor surface/i.test(execResult.observationCheckpoints[0].error || ''), 'Failure should explain that an active Pine Editor surface was not confirmed');
    });
  });

  await testAsync('explicit TradingView DOM contracts allow bounded panel verification', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 778, title: 'Paper Trading - Depth of Market - TradingView', processName: 'tradingview', windowKind: 'palette' },
      { success: true, hwnd: 778, title: 'Paper Trading - Depth of Market - TradingView', processName: 'tradingview', windowKind: 'palette' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 778, title: 'Paper Trading - Depth of Market - TradingView', processName: 'tradingview', windowKind: 'palette' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView Depth of Market',
        verification: 'TradingView should show the DOM panel',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'ctrl+d',
            reason: 'Open TradingView Depth of Market',
            verify: {
              kind: 'panel-visible',
              appName: 'TradingView',
              target: 'dom-panel',
              keywords: ['dom', 'depth of market', 'order book']
            }
          }
        ]
      }, null, null, {
        userMessage: 'open depth of market in tradingview',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the DOM panel is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key'], 'DOM workflow should stop at the verified opener in this bounded test');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A DOM checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'panel-open', 'DOM verification should map to panel-open');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'DOM verification should pass after the panel title is observed');
      assert.strictEqual(execResult.observationCheckpoints[0].tradingMode.mode, 'paper', 'DOM verification metadata should detect Paper Trading mode from the observed panel');
    });
  });

  await testAsync('explicit TradingView Paper Trading contracts allow bounded paper-assist verification', async () => {
    const executed = [];
    const foregroundSequence = [
      { success: true, hwnd: 777, title: 'TradingView', processName: 'tradingview', windowKind: 'main' },
      { success: true, hwnd: 779, title: 'Paper Trading - TradingView', processName: 'tradingview', windowKind: 'palette' },
      { success: true, hwnd: 779, title: 'Paper Trading - TradingView', processName: 'tradingview', windowKind: 'palette' }
    ];

    await withPatchedSystemAutomation({
      resolveWindowHandle: async (action) => action?.processName === 'tradingview' ? 777 : 0,
      getForegroundWindowInfo: async () => foregroundSequence.shift() || { success: true, hwnd: 779, title: 'Paper Trading - TradingView', processName: 'tradingview', windowKind: 'palette' },
      focusWindow: async () => ({ success: true }),
      getRunningProcessesByNames: async () => ([{ pid: 4242, processName: 'tradingview', mainWindowTitle: 'TradingView', startTime: '2026-03-23T00:00:00Z' }])
    }, async () => {
      const execResult = await aiService.executeActions({
        thought: 'Open TradingView Paper Trading',
        verification: 'TradingView should show the Paper Trading panel',
        actions: [
          { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
          {
            type: 'key',
            key: 'alt+t',
            reason: 'Open TradingView Paper Trading',
            verify: {
              kind: 'panel-visible',
              appName: 'TradingView',
              target: 'paper-trading-panel',
              keywords: ['paper trading', 'paper account', 'trading panel']
            }
          }
        ]
      }, null, null, {
        userMessage: 'open paper trading in tradingview',
        actionExecutor: async (action) => {
          executed.push(action.type);
          return { success: true, action: action.type, message: 'executed' };
        }
      });

      assert.strictEqual(execResult.success, true, 'Execution should proceed after the Paper Trading panel is observed');
      assert.deepStrictEqual(executed, ['focus_window', 'key'], 'Paper-assist workflow should stop at the verified opener in this bounded test');
      assert.strictEqual(execResult.observationCheckpoints.length, 1, 'A Paper Trading checkpoint should be recorded');
      assert.strictEqual(execResult.observationCheckpoints[0].classification, 'panel-open', 'Paper Trading verification should map to panel-open');
      assert.strictEqual(execResult.observationCheckpoints[0].verified, true, 'Paper Trading verification should pass after the panel title is observed');
      assert.strictEqual(execResult.observationCheckpoints[0].tradingMode.mode, 'paper', 'Paper Trading verification metadata should detect paper mode from the observed panel');
    });
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
        { type: 'click', reason: 'Place a limit order in the Paper Trading Depth of Market order book' }
      ]
    }, null, null, {
      userMessage: 'place a limit order in the TradingView paper trading DOM',
      actionExecutor: async (action) => {
        executed++;
        return { success: true, action: action.type, message: 'executed' };
      }
    });

    assert.strictEqual(executed, 0, 'Advisory-only DOM order-entry actions should be blocked before execution');
    assert.strictEqual(execResult.success, false, 'Advisory-only DOM order-entry actions should fail closed');
    assert.strictEqual(execResult.results[0].blockedByPolicy, true, 'Blocked DOM order-entry should be marked as policy-blocked');
    assert(/advisory-only/i.test(execResult.results[0].error || ''), 'Blocked DOM order-entry should explain the advisory-only safety rail');
    assert(/paper trading/i.test(execResult.results[0].error || ''), 'Blocked DOM order-entry should mention Paper Trading guidance when paper mode is referenced');
    assert.strictEqual(execResult.results[0].safety.tradingMode.mode, 'paper', 'Blocked DOM order-entry should expose paper-trading metadata');
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
