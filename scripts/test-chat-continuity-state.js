#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { buildChatContinuityTurnRecord } = require(path.join(__dirname, '..', 'src', 'main', 'chat-continuity-state.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('continuity mapper captures richer execution facts', () => {
  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Inspect the active TradingView chart',
      actions: [
        { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
        { type: 'key', key: 'alt+a', reason: 'Open alert dialog', verify: { kind: 'dialog-visible', target: 'create-alert' } },
        { type: 'type', text: '20.02', reason: 'Enter alert price' }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'focus_window', message: 'focused' },
        {
          success: true,
          action: 'key',
          message: 'executed',
          userConfirmed: true,
          observationCheckpoint: {
            classification: 'dialog-open',
            verified: true,
            reason: 'Create Alert dialog observed'
          }
        },
        { success: true, action: 'type', message: 'typed alert price' }
      ],
      observationCheckpoints: [
        { applicable: true, classification: 'dialog-open', verified: true, reason: 'Create Alert dialog observed' }
      ],
      focusVerification: { applicable: true, verified: true, reason: 'focused' },
      postVerification: {
        applicable: true,
        verified: true,
        matchReason: 'title-hint',
        popupRecipe: { attempted: true, completed: true, steps: 2, recipeId: 'generic-update-setup' }
      },
      reflectionApplied: { action: 'skill-quarantine', applied: true, detail: 'stale skill removed' }
    },
    latestVisual: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      timestamp: 123456789,
      windowHandle: 777,
      windowTitle: 'TradingView - LUNR'
    },
    watcherSnapshot: {
      ageMs: 420,
      activeWindow: { hwnd: 777, title: 'TradingView - LUNR' }
    },
    details: {
      userMessage: 'continue',
      executionIntent: 'Continue from the chart inspection step.',
      targetWindowHandle: 777,
      nextRecommendedStep: 'Summarize the visible chart state before modifying indicators.'
    }
  });

  assert.strictEqual(turnRecord.committedSubgoal, 'Inspect the active TradingView chart');
  assert.strictEqual(turnRecord.actionPlan.length, 3);
  assert.strictEqual(turnRecord.actionPlan[1].verifyKind, 'dialog-visible');
  assert.strictEqual(turnRecord.results.length, 3);
  assert.strictEqual(turnRecord.executionResult.failureCount, 0);
  assert.strictEqual(turnRecord.executionResult.userConfirmed, true);
  assert.strictEqual(turnRecord.executionResult.popupFollowUp.recipeId, 'generic-update-setup');
  assert.strictEqual(turnRecord.executionResult.reflectionApplied.action, 'skill-quarantine');
  assert.strictEqual(turnRecord.observationEvidence.captureMode, 'window-copyfromscreen');
  assert.strictEqual(turnRecord.observationEvidence.uiWatcherFresh, true);
  assert.strictEqual(turnRecord.verification.status, 'verified');
  assert.ok(turnRecord.verification.checks.some((check) => check.name === 'dialog-open'));
});

test('continuity mapper preserves observed paper trading mode facts', () => {
  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Verify the TradingView Paper Trading panel is open',
      actions: [
        { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
        { type: 'key', key: 'shift+p', reason: 'Open the Paper Trading panel', verify: { kind: 'panel-open', target: 'paper-trading-panel' } }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'focus_window', message: 'focused' },
        {
          success: true,
          action: 'key',
          message: 'panel opened',
          observationCheckpoint: {
            classification: 'paper-trading-panel',
            verified: true,
            reason: 'Paper Trading panel observed',
            tradingMode: {
              mode: 'paper',
              confidence: 'high',
              evidence: ['paper trading', 'paper account']
            }
          }
        }
      ],
      observationCheckpoints: [
        {
          applicable: true,
          classification: 'paper-trading-panel',
          verified: true,
          reason: 'Paper Trading panel observed',
          tradingMode: {
            mode: 'paper',
            confidence: 'high',
            evidence: ['paper trading', 'paper account']
          }
        }
      ]
    },
    latestVisual: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      timestamp: 123456999,
      windowHandle: 778,
      windowTitle: 'TradingView - Paper Trading'
    },
    watcherSnapshot: {
      ageMs: 320,
      activeWindow: { hwnd: 778, title: 'TradingView - Paper Trading' }
    },
    details: {
      userMessage: 'show paper trading in tradingview',
      executionIntent: 'Open and verify the TradingView Paper Trading panel.',
      targetWindowHandle: 778,
      nextRecommendedStep: 'Continue with assist-only Paper Trading guidance without placing orders.'
    }
  });

  assert.strictEqual(turnRecord.tradingMode.mode, 'paper');
  assert.strictEqual(turnRecord.tradingMode.confidence, 'high');
  assert.deepStrictEqual(turnRecord.tradingMode.evidence, ['paper trading', 'paper account']);
  assert.strictEqual(turnRecord.results[1].observationCheckpoint.tradingMode.mode, 'paper');
  assert.strictEqual(turnRecord.nextRecommendedStep, 'Continue with assist-only Paper Trading guidance without placing orders.');
});

test('continuity mapper preserves Pine safe-authoring structured summary facts', () => {
  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Inspect the current Pine Editor state before authoring',
      actions: [
        { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' },
        { type: 'key', key: 'ctrl+i', reason: 'Open Pine Editor', verify: { kind: 'editor-active', target: 'pine-editor' } },
        { type: 'get_text', text: 'Pine Editor', reason: 'Inspect current visible Pine Editor state' }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'bring_window_to_front', message: 'focused' },
        { success: true, action: 'key', message: 'editor opened' },
        {
          success: true,
          action: 'get_text',
          message: 'editor inspected',
          pineStructuredSummary: {
            evidenceMode: 'safe-authoring-inspect',
            editorVisibleState: 'existing-script-visible',
            visibleScriptKind: 'indicator',
            visibleLineCountEstimate: 9,
            visibleSignals: ['pine-version-directive', 'indicator-declaration', 'script-body-visible'],
            compactSummary: 'state=existing-script-visible | kind=indicator | lines=9'
          }
        }
      ]
    },
    details: {
      userMessage: 'write a pine script for me',
      executionIntent: 'Inspect Pine Editor state before authoring.',
      nextRecommendedStep: 'Choose a safe authoring path from the inspected editor state.'
    }
  });

  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.editorVisibleState, 'existing-script-visible');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.visibleScriptKind, 'indicator');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.visibleLineCountEstimate, 9);
  assert.deepStrictEqual(turnRecord.results[2].pineStructuredSummary.visibleSignals, [
    'pine-version-directive',
    'indicator-declaration',
    'script-body-visible'
  ]);
});

test('continuity mapper preserves Pine diagnostics structured summary facts', () => {
  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Inspect Pine diagnostics',
      actions: [
        { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
        { type: 'key', key: 'ctrl+k', reason: 'Open TradingView quick search' },
        { type: 'type', text: 'Pine Editor', reason: 'Search for Pine Editor' },
        { type: 'key', key: 'enter', reason: 'Open Pine Editor from quick search', verify: { kind: 'panel-visible', target: 'pine-editor' } },
        { type: 'get_text', text: 'Pine Editor', reason: 'Read visible diagnostics' }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'focus_window', message: 'focused' },
        { success: true, action: 'key', message: 'editor opened' },
        {
          success: true,
          action: 'get_text',
          message: 'diagnostics inspected',
          pineStructuredSummary: {
            evidenceMode: 'diagnostics',
            compileStatus: 'errors-visible',
            errorCountEstimate: 1,
            warningCountEstimate: 1,
            lineBudgetSignal: 'unknown-line-budget',
            statusSignals: ['compile-errors-visible', 'warnings-visible'],
            topVisibleDiagnostics: ['Compiler error at line 42: mismatched input.', 'Warning: script has unused variable.'],
            compactSummary: 'status=errors-visible | errors=1 | warnings=1'
          }
        }
      ]
    },
    details: {
      userMessage: 'open pine editor in tradingview and check diagnostics',
      executionIntent: 'Inspect Pine diagnostics.',
      nextRecommendedStep: 'Fix the visible compiler errors before continuing.'
    }
  });

  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.compileStatus, 'errors-visible');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.errorCountEstimate, 1);
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.warningCountEstimate, 1);
  assert.deepStrictEqual(turnRecord.results[2].pineStructuredSummary.statusSignals, ['compile-errors-visible', 'warnings-visible']);
  assert.deepStrictEqual(turnRecord.results[2].pineStructuredSummary.topVisibleDiagnostics, [
    'Compiler error at line 42: mismatched input.',
    'Warning: script has unused variable.'
  ]);
});

test('continuity mapper preserves Pine Logs structured summary facts', () => {
  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Inspect Pine Logs output',
      actions: [
        { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
        { type: 'key', key: 'ctrl+shift+l', reason: 'Open Pine Logs', verify: { kind: 'panel-visible', target: 'pine-logs' } },
        { type: 'get_text', text: 'Pine Logs', reason: 'Read visible logs' }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'focus_window', message: 'focused' },
        { success: true, action: 'key', message: 'logs opened' },
        {
          success: true,
          action: 'get_text',
          message: 'logs inspected',
          pineStructuredSummary: {
            evidenceMode: 'logs-summary',
            outputSurface: 'pine-logs',
            outputSignal: 'errors-visible',
            visibleOutputEntryCount: 2,
            topVisibleOutputs: ['Runtime error at bar 12: division by zero.', 'Warning: fallback branch used.'],
            compactSummary: 'signal=errors-visible | entries=2 | errors=1 | warnings=1'
          }
        }
      ]
    },
    details: {
      userMessage: 'open pine logs in tradingview and read output',
      executionIntent: 'Inspect Pine Logs output.',
      nextRecommendedStep: 'Review the visible Pine Logs errors before continuing.'
    }
  });

  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.evidenceMode, 'logs-summary');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.outputSurface, 'pine-logs');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.outputSignal, 'errors-visible');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.visibleOutputEntryCount, 2);
  assert.deepStrictEqual(turnRecord.results[2].pineStructuredSummary.topVisibleOutputs, [
    'Runtime error at bar 12: division by zero.',
    'Warning: fallback branch used.'
  ]);
});

test('continuity mapper preserves Pine Profiler structured summary facts', () => {
  const turnRecord = buildChatContinuityTurnRecord({
    actionData: {
      thought: 'Inspect Pine Profiler metrics',
      actions: [
        { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
        { type: 'key', key: 'ctrl+shift+p', reason: 'Open Pine Profiler', verify: { kind: 'panel-visible', target: 'pine-profiler' } },
        { type: 'get_text', text: 'Pine Profiler', reason: 'Read visible profiler metrics' }
      ]
    },
    execResult: {
      success: true,
      results: [
        { success: true, action: 'focus_window', message: 'focused' },
        { success: true, action: 'key', message: 'profiler opened' },
        {
          success: true,
          action: 'get_text',
          message: 'profiler inspected',
          pineStructuredSummary: {
            evidenceMode: 'profiler-summary',
            outputSurface: 'pine-profiler',
            outputSignal: 'metrics-visible',
            visibleOutputEntryCount: 2,
            functionCallCountEstimate: 12,
            avgTimeMs: 1.3,
            maxTimeMs: 3.8,
            topVisibleOutputs: ['Profiler: 12 calls, avg 1.3ms, max 3.8ms.', 'Slowest block: request.security'],
            compactSummary: 'signal=metrics-visible | calls=12 | avgMs=1.3 | maxMs=3.8 | entries=2'
          }
        }
      ]
    },
    details: {
      userMessage: 'open pine profiler in tradingview and summarize the visible metrics',
      executionIntent: 'Inspect Pine Profiler metrics.',
      nextRecommendedStep: 'Use the visible metrics to target performance bottlenecks only.'
    }
  });

  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.evidenceMode, 'profiler-summary');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.outputSurface, 'pine-profiler');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.outputSignal, 'metrics-visible');
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.functionCallCountEstimate, 12);
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.avgTimeMs, 1.3);
  assert.strictEqual(turnRecord.results[2].pineStructuredSummary.maxTimeMs, 3.8);
});
