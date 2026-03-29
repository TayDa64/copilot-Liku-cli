#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  formatChatContinuityContext,
  formatChatContinuitySummary,
  createSessionIntentStateStore,
  formatSessionIntentContext,
  formatSessionIntentSummary
} = require(path.join(__dirname, '..', 'src', 'main', 'session-intent-state.js'));

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

test('session intent store records repo correction and forgone feature', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const state = store.ingestUserMessage('MUSE is a different repo, this is copilot-liku-cli. I have forgone the implementation of: terminal-liku ui.', {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(state.currentRepo.normalizedRepoName, 'copilot-liku-cli');
  assert.strictEqual(state.downstreamRepoIntent.normalizedRepoName, 'muse');
  assert.strictEqual(state.forgoneFeatures[0].normalizedFeature, 'terminal-liku-ui');
  assert.ok(state.explicitCorrections.some((entry) => entry.kind === 'repo-correction'));

  const reloaded = createSessionIntentStateStore({ stateFile }).getState({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(reloaded.forgoneFeatures.length, 1);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent store re-enables forgone feature on explicit resume', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  store.ingestUserMessage('Do not implement terminal-liku ui.', { cwd: path.join(__dirname, '..') });
  const resumed = store.ingestUserMessage("Let's implement terminal-liku ui again.", { cwd: path.join(__dirname, '..') });

  assert.strictEqual(resumed.forgoneFeatures.length, 0);
  assert.ok(resumed.explicitCorrections.some((entry) => entry.kind === 'feature-reenabled'));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent formatters emit compact system and summary views', () => {
  const state = {
    currentRepo: { repoName: 'copilot-liku-cli', projectRoot: 'C:/dev/copilot-Liku-cli' },
    downstreamRepoIntent: { repoName: 'muse-ai' },
    forgoneFeatures: [{ feature: 'terminal-liku ui' }],
    explicitCorrections: [{ text: 'MUSE is a different repo, this is copilot-liku-cli.' }],
    chatContinuity: {
      activeGoal: 'Produce a confident synthesis of ticker LUNR in TradingView',
      currentSubgoal: 'Inspect the current chart state',
      continuationReady: true,
      degradedReason: null,
      lastTurn: {
        actionSummary: 'focus_window -> screenshot',
        executionStatus: 'succeeded',
        verificationStatus: 'verified',
        nextRecommendedStep: 'Continue from the latest chart evidence.'
      }
    }
  };

  const context = formatSessionIntentContext(state);
  assert.ok(context.includes('currentRepo: copilot-liku-cli'));
  assert.ok(context.includes('forgoneFeatures: terminal-liku ui'));
  assert.ok(context.includes('Do not propose or act on forgone features'));

  const summary = formatSessionIntentSummary(state);
  assert.ok(summary.includes('Current repo: copilot-liku-cli'));
  assert.ok(summary.includes('Forgone features: terminal-liku ui'));

  const continuityContext = formatChatContinuityContext(state);
  assert.ok(continuityContext.includes('activeGoal: Produce a confident synthesis'));
  assert.ok(continuityContext.includes('lastExecutedActions: focus_window -> screenshot'));
  assert.ok(continuityContext.includes('continuationReady: yes'));

  const continuitySummary = formatChatContinuitySummary(state);
  assert.ok(continuitySummary.includes('Active goal: Produce a confident synthesis'));
  assert.ok(continuitySummary.includes('Continuation ready: yes'));
});

test('session intent store records and clears chat continuity state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'help me make a confident synthesis of ticker LUNR in tradingview',
    executionIntent: 'help me make a confident synthesis of ticker LUNR in tradingview',
    committedSubgoal: 'Inspect the active TradingView chart',
    actionPlan: [{ type: 'focus_window' }, { type: 'screenshot' }],
    success: true,
    screenshotCaptured: true,
    observationEvidence: { captureMode: 'window', captureTrusted: true },
    verification: { status: 'verified' },
    nextRecommendedStep: 'Continue from the latest chart evidence.'
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(recorded.chatContinuity.activeGoal, 'help me make a confident synthesis of ticker LUNR in tradingview');
  assert.strictEqual(recorded.chatContinuity.lastTurn.actionSummary, 'focus_window -> screenshot');
  assert.strictEqual(recorded.chatContinuity.continuationReady, true);
  assert.strictEqual(recorded.chatContinuity.lastTurn.observationEvidence.captureMode, 'window');

  const reloaded = createSessionIntentStateStore({ stateFile }).getChatContinuity({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(reloaded.currentSubgoal, 'Inspect the active TradingView chart');
  assert.strictEqual(reloaded.lastTurn.captureMode, 'window');

  const cleared = store.clearChatContinuity({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(cleared.chatContinuity.activeGoal, null);
  assert.strictEqual(cleared.chatContinuity.continuationReady, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent store persists and clears pending requested task state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.setPendingRequestedTask({
    userMessage: 'yes, lets apply the volume profile',
    executionIntent: 'yes, lets apply the volume profile',
    taskSummary: 'Apply Volume Profile in TradingView',
    targetApp: 'tradingview'
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(recorded.pendingRequestedTask.taskSummary, 'Apply Volume Profile in TradingView');
  assert.strictEqual(recorded.pendingRequestedTask.targetApp, 'tradingview');

  const reloaded = createSessionIntentStateStore({ stateFile }).getPendingRequestedTask({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(reloaded.executionIntent, 'yes, lets apply the volume profile');

  const cleared = store.clearPendingRequestedTask({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(cleared.pendingRequestedTask, null);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('screen-like fallback evidence degrades continuity readiness', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Continue from the current TradingView chart state.',
    committedSubgoal: 'Inspect the active TradingView chart',
    actionPlan: [{ type: 'screenshot' }],
    success: true,
    screenshotCaptured: true,
    observationEvidence: { captureMode: 'screen-copyfromscreen', captureTrusted: false },
    verification: { status: 'verified' },
    nextRecommendedStep: 'Continue from the latest visual evidence.'
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(recorded.chatContinuity.lastTurn.captureMode, 'screen-copyfromscreen');
  assert.strictEqual(recorded.chatContinuity.lastTurn.captureTrusted, false);
  assert.strictEqual(recorded.chatContinuity.continuationReady, false);
  assert(/full-screen capture/i.test(recorded.chatContinuity.degradedReason));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('background capture degraded reason is persisted and blocks continuation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Continue from background capture evidence.',
    committedSubgoal: 'Inspect target app in background',
    actionPlan: [{ type: 'screenshot', scope: 'window' }],
    success: true,
    observationEvidence: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: false,
      captureProvider: 'copyfromscreen',
      captureCapability: 'degraded',
      captureDegradedReason: 'Background capture degraded to CopyFromScreen while target was not foreground; content may be occluded or stale.'
    },
    verification: { status: 'verified' },
    nextRecommendedStep: 'Recapture with trusted background provider or focus target app.'
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(recorded.chatContinuity.continuationReady, false);
  assert(/Background capture degraded/i.test(recorded.chatContinuity.degradedReason));
  assert.strictEqual(recorded.chatContinuity.lastTurn.observationEvidence.captureProvider, 'copyfromscreen');
  assert.strictEqual(recorded.chatContinuity.lastTurn.observationEvidence.captureCapability, 'degraded');

  const continuityContext = formatChatContinuityContext(recorded);
  assert(continuityContext.includes('lastCaptureProvider: copyfromscreen'));
  assert(continuityContext.includes('lastCaptureCapability: degraded'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('contradicted verification blocks continuity readiness', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Continue indicator verification.',
    committedSubgoal: 'Verify that the requested indicator appears on the chart',
    actionPlan: [{ type: 'screenshot', scope: 'active-window' }],
    results: [{ type: 'screenshot', success: true, message: 'captured' }],
    success: true,
    observationEvidence: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      visualContextRef: 'window-copyfromscreen@456'
    },
    verification: {
      status: 'contradicted',
      checks: [{ name: 'indicator-present', status: 'contradicted', detail: 'requested indicator not visible on chart' }]
    },
    nextRecommendedStep: 'Retry indicator search before claiming success.'
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(recorded.chatContinuity.continuationReady, false);
  assert.strictEqual(recorded.chatContinuity.degradedReason, 'The latest evidence contradicts the claimed result.');

  const continuityContext = formatChatContinuityContext(recorded);
  assert.ok(continuityContext.includes('lastVerificationStatus: contradicted'));
  assert.ok(continuityContext.includes('Rule: Do not claim the requested UI change is complete unless the latest evidence verifies it.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent store persists richer execution facts for chat continuity', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Continue from the chart inspection step.',
    committedSubgoal: 'Inspect the active TradingView chart',
    actionPlan: [
      { index: 0, type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
      { index: 1, type: 'key', key: 'alt+a', verifyKind: 'dialog-visible', verifyTarget: 'create-alert' }
    ],
    results: [
      { index: 0, type: 'focus_window', success: true, message: 'focused' },
      { index: 1, type: 'key', success: false, error: 'dialog not observed' }
    ],
    success: false,
    executionResult: {
      executedCount: 2,
      successCount: 1,
      failureCount: 1,
      failedActions: [{ type: 'key', error: 'dialog not observed' }],
      popupFollowUp: { attempted: true, completed: false, steps: 1, recipeId: 'generic-fallback' }
    },
    observationEvidence: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      visualContextRef: 'window-copyfromscreen@123',
      uiWatcherFresh: true,
      uiWatcherAgeMs: 420
    },
    verification: {
      status: 'unverified',
      checks: [
        { name: 'target-window-focused', status: 'verified' },
        { name: 'dialog-open', status: 'unverified', detail: 'dialog not observed' }
      ]
    },
    targetWindowHandle: 777,
    windowTitle: 'TradingView - LUNR',
    nextRecommendedStep: 'Retry the dialog-opening step with fresh evidence.'
  }, {
    cwd: path.join(__dirname, '..')
  });

  const turn = recorded.chatContinuity.lastTurn;
  assert.strictEqual(turn.actionPlan.length, 2);
  assert.strictEqual(turn.actionResults.length, 2);
  assert.strictEqual(turn.executionResult.failureCount, 1);
  assert.strictEqual(turn.executionResult.popupFollowUp.recipeId, 'generic-fallback');
  assert.strictEqual(turn.observationEvidence.visualContextRef, 'window-copyfromscreen@123');
  assert.strictEqual(turn.verificationChecks.length, 2);
  assert.strictEqual(turn.targetWindowHandle, 777);
  assert.strictEqual(recorded.chatContinuity.continuationReady, false);

  const continuitySummary = formatChatContinuitySummary(recorded);
  assert.ok(continuitySummary.includes('Failed actions: 1'));
  assert.ok(continuitySummary.includes('Target window: 777'));

  const continuityContext = formatChatContinuityContext(recorded);
  assert.ok(continuityContext.includes('verificationChecks: target-window-focused=verified | dialog-open=unverified'));
  assert.ok(continuityContext.includes('actionOutcomes: focus_window:ok | key:fail'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent continuity surfaces Pine authoring state when existing script content is visible', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'write a pine script for me',
    executionIntent: 'Inspect Pine Editor state before authoring.',
    committedSubgoal: 'Inspect the visible Pine Editor state',
    actionPlan: [
      { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'ctrl+i', verifyKind: 'editor-active', verifyTarget: 'pine-editor' },
      { type: 'get_text', text: 'Pine Editor' }
    ],
    results: [
      { type: 'bring_window_to_front', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'editor opened' },
      {
        type: 'get_text',
        success: true,
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
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert.strictEqual(recorded.chatContinuity.lastTurn.actionResults[2].pineStructuredSummary.editorVisibleState, 'existing-script-visible');
  assert(/avoid overwriting/i.test(recorded.chatContinuity.lastTurn.nextRecommendedStep));

  const continuityContext = formatChatContinuityContext(recorded);
  assert(continuityContext.includes('pineAuthoringState: existing-script-visible'));
  assert(continuityContext.includes('pineVisibleScriptKind: indicator'));
  assert(continuityContext.includes('pineVisibleLineCountEstimate: 9'));
  assert(continuityContext.includes('pineVisibleSignals: pine-version-directive | indicator-declaration | script-body-visible'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent continuity recommends bounded new-script drafting for empty or starter Pine state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'create a new pine indicator',
    executionIntent: 'Inspect Pine Editor state before authoring.',
    committedSubgoal: 'Inspect the visible Pine Editor state',
    actionPlan: [
      { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'ctrl+i', verifyKind: 'editor-active', verifyTarget: 'pine-editor' },
      { type: 'get_text', text: 'Pine Editor' }
    ],
    results: [
      { type: 'bring_window_to_front', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'editor opened' },
      {
        type: 'get_text',
        success: true,
        message: 'editor inspected',
        pineStructuredSummary: {
          evidenceMode: 'safe-authoring-inspect',
          editorVisibleState: 'empty-or-starter',
          visibleScriptKind: 'indicator',
          visibleLineCountEstimate: 3,
          visibleSignals: ['pine-version-directive', 'indicator-declaration', 'starter-plot-close'],
          compactSummary: 'state=empty-or-starter | kind=indicator | lines=3'
        }
      }
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert(/bounded new-script draft/i.test(recorded.chatContinuity.lastTurn.nextRecommendedStep));

  fs.rmSync(tempDir, { recursive: true, force: true });
});
