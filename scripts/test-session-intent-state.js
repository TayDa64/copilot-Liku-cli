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

  const reloaded = createSessionIntentStateStore({ stateFile }).getChatContinuity({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(reloaded.currentSubgoal, 'Inspect the active TradingView chart');
  assert.strictEqual(reloaded.lastTurn.captureMode, 'window');

  const cleared = store.clearChatContinuity({ cwd: path.join(__dirname, '..') });
  assert.strictEqual(cleared.chatContinuity.activeGoal, null);
  assert.strictEqual(cleared.chatContinuity.continuationReady, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});