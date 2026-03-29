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
  assert(continuityContext.includes('Rule: Pine authoring continuity is limited to the visible editor state; do not overwrite unseen script content implicitly.'));
  assert(continuityContext.includes('Rule: Existing visible Pine script content is already present; prefer a new-script path or ask before editing in place.'));

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

test('session intent continuity surfaces Pine diagnostics state and recovery guidance', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'open pine editor in tradingview and check diagnostics',
    executionIntent: 'Inspect visible Pine diagnostics.',
    committedSubgoal: 'Inspect the visible Pine diagnostics state',
    actionPlan: [
      { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'ctrl+e', verifyKind: 'panel-visible', verifyTarget: 'pine-editor' },
      { type: 'get_text', text: 'Pine Editor' }
    ],
    results: [
      { type: 'focus_window', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'editor opened' },
      {
        type: 'get_text',
        success: true,
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
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert(/fix the visible errors/i.test(recorded.chatContinuity.lastTurn.nextRecommendedStep));

  const continuityContext = formatChatContinuityContext(recorded);
  assert(continuityContext.includes('pineCompileStatus: errors-visible'));
  assert(continuityContext.includes('pineErrorCountEstimate: 1'));
  assert(continuityContext.includes('pineWarningCountEstimate: 1'));
  assert(continuityContext.includes('pineTopVisibleDiagnostics: Compiler error at line 42: mismatched input. | Warning: script has unused variable.'));
  assert(continuityContext.includes('Rule: Pine diagnostics continuity is limited to the visible compiler status, warnings, errors, and line-budget hints.'));
  assert(continuityContext.includes('Rule: Fix or summarize only the visible Pine diagnostics before inferring runtime behavior or broader chart effects.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent continuity recommends targeted edits under Pine line-budget pressure', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'open pine editor in tradingview and check the line budget',
    executionIntent: 'Inspect visible Pine line-budget hints.',
    committedSubgoal: 'Inspect visible Pine line-budget hints',
    actionPlan: [
      { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'ctrl+e', verifyKind: 'panel-visible', verifyTarget: 'pine-editor' },
      { type: 'get_text', text: 'Pine Editor' }
    ],
    results: [
      { type: 'focus_window', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'editor opened' },
      {
        type: 'get_text',
        success: true,
        message: 'line budget inspected',
        pineStructuredSummary: {
          evidenceMode: 'line-budget',
          compileStatus: 'status-only',
          errorCountEstimate: 0,
          warningCountEstimate: 1,
          visibleLineCountEstimate: 487,
          lineBudgetSignal: 'near-limit-visible',
          statusSignals: ['line-budget-hint-visible', 'near-limit-visible'],
          topVisibleDiagnostics: ['Line count: 487 / 500 lines.', 'Warning: script is close to the Pine limit.'],
          compactSummary: 'status=status-only | errors=0 | warnings=1 | lines=487 | budget=near-limit-visible'
        }
      }
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert(/targeted edits/i.test(recorded.chatContinuity.lastTurn.nextRecommendedStep));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent continuity surfaces Pine provenance summaries for continuation context', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'open pine version history in tradingview and summarize the top visible revision metadata',
    executionIntent: 'Inspect visible Pine Version History provenance.',
    committedSubgoal: 'Inspect top visible Pine Version History metadata',
    actionPlan: [
      { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'alt+h', verifyKind: 'panel-visible', verifyTarget: 'pine-version-history' },
      { type: 'get_text', text: 'Pine Version History' }
    ],
    results: [
      { type: 'focus_window', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'version history opened' },
      {
        type: 'get_text',
        success: true,
        message: 'provenance inspected',
        pineStructuredSummary: {
          evidenceMode: 'provenance-summary',
          compactSummary: 'latest=Revision 12 | revisions=3 | recency=recent-visible',
          latestVisibleRevisionLabel: 'Revision 12',
          latestVisibleRevisionNumber: 12,
          latestVisibleRelativeTime: '5 minutes ago',
          visibleRevisionCount: 3,
          visibleRecencySignal: 'recent-visible',
          topVisibleRevisions: [
            { label: 'Revision 12', relativeTime: '5 minutes ago', revisionNumber: 12 },
            { label: 'Revision 11', relativeTime: '1 hour ago', revisionNumber: 11 }
          ]
        }
      }
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  const continuityContext = formatChatContinuityContext(recorded);
  assert(continuityContext.includes('pineEvidenceMode: provenance-summary'));
  assert(continuityContext.includes('pineCompactSummary: latest=Revision 12 | revisions=3 | recency=recent-visible'));
  assert(continuityContext.includes('pineLatestVisibleRevisionLabel: Revision 12'));
  assert(continuityContext.includes('pineLatestVisibleRevisionNumber: 12'));
  assert(continuityContext.includes('pineLatestVisibleRelativeTime: 5 minutes ago'));
  assert(continuityContext.includes('pineVisibleRevisionCount: 3'));
  assert(continuityContext.includes('pineVisibleRecencySignal: recent-visible'));
  assert(continuityContext.includes('pineTopVisibleRevisions: Revision 12 5 minutes ago #12 | Revision 11 1 hour ago #11'));
  assert(continuityContext.includes('Rule: Pine Version History continuity is provenance-only; use only the visible revision metadata.'));
  assert(continuityContext.includes('Rule: Do not infer hidden revisions, full script content, or runtime/chart behavior from Version History alone.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent continuity surfaces Pine Logs summaries for continuation context', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'open pine logs in tradingview and read output',
    executionIntent: 'Inspect visible Pine Logs output.',
    committedSubgoal: 'Inspect visible Pine Logs output',
    actionPlan: [
      { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'ctrl+shift+l', verifyKind: 'panel-visible', verifyTarget: 'pine-logs' },
      { type: 'get_text', text: 'Pine Logs' }
    ],
    results: [
      { type: 'focus_window', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'logs opened' },
      {
        type: 'get_text',
        success: true,
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
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert(/log errors/i.test(recorded.chatContinuity.lastTurn.nextRecommendedStep));

  const continuityContext = formatChatContinuityContext(recorded);
  assert(continuityContext.includes('pineEvidenceMode: logs-summary'));
  assert(continuityContext.includes('pineOutputSurface: pine-logs'));
  assert(continuityContext.includes('pineOutputSignal: errors-visible'));
  assert(continuityContext.includes('pineVisibleOutputEntryCount: 2'));
  assert(continuityContext.includes('pineTopVisibleOutputs: Runtime error at bar 12: division by zero. | Warning: fallback branch used.'));
  assert(continuityContext.includes('Rule: Pine Logs continuity is limited to the visible log output and visible error or warning lines only.'));
  assert(continuityContext.includes('Rule: Do not infer hidden stack traces, hidden runtime state, or broader chart behavior from Pine Logs alone.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session intent continuity surfaces Pine Profiler summaries for continuation context', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-session-intent-'));
  const stateFile = path.join(tempDir, 'session-intent-state.json');
  const store = createSessionIntentStateStore({ stateFile });

  const recorded = store.recordExecutedTurn({
    userMessage: 'open pine profiler in tradingview and summarize the visible metrics',
    executionIntent: 'Inspect visible Pine Profiler metrics.',
    committedSubgoal: 'Inspect visible Pine Profiler metrics',
    actionPlan: [
      { type: 'focus_window', title: 'TradingView', processName: 'tradingview' },
      { type: 'key', key: 'ctrl+shift+p', verifyKind: 'panel-visible', verifyTarget: 'pine-profiler' },
      { type: 'get_text', text: 'Pine Profiler' }
    ],
    results: [
      { type: 'focus_window', success: true, message: 'focused' },
      { type: 'key', success: true, message: 'profiler opened' },
      {
        type: 'get_text',
        success: true,
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
    ],
    success: true,
    verification: { status: 'verified' }
  }, {
    cwd: path.join(__dirname, '..')
  });

  assert(/performance evidence only/i.test(recorded.chatContinuity.lastTurn.nextRecommendedStep));

  const continuityContext = formatChatContinuityContext(recorded);
  assert(continuityContext.includes('pineEvidenceMode: profiler-summary'));
  assert(continuityContext.includes('pineOutputSurface: pine-profiler'));
  assert(continuityContext.includes('pineOutputSignal: metrics-visible'));
  assert(continuityContext.includes('pineFunctionCallCountEstimate: 12'));
  assert(continuityContext.includes('pineAvgTimeMs: 1.3'));
  assert(continuityContext.includes('pineMaxTimeMs: 3.8'));
  assert(continuityContext.includes('pineTopVisibleOutputs: Profiler: 12 calls, avg 1.3ms, max 3.8ms. | Slowest block: request.security'));
  assert(continuityContext.includes('Rule: Pine Profiler continuity is limited to the visible performance metrics and hotspots only.'));
  assert(continuityContext.includes('Rule: Treat profiler output as performance evidence, not proof of runtime correctness or chart behavior.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});
