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
