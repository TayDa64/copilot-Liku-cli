#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMessageBuilder } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'message-builder.js'));
const {
  createSessionIntentStateStore,
  formatChatContinuityContext
} = require(path.join(__dirname, '..', 'src', 'main', 'session-intent-state.js'));

const PAPER_AWARE_CONTINUITY_FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'tradingview', 'paper-aware-continuity.json'), 'utf8')
);

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

async function buildContinuitySystemMessage(chatContinuityContext) {
  const builder = createMessageBuilder({
    getBrowserSessionState: () => ({ lastUpdated: null }),
    getCurrentProvider: () => 'copilot',
    getForegroundWindowInfo: async () => null,
    getInspectService: () => ({ isInspectModeActive: () => false }),
    getLatestVisualContext: () => null,
    getPreferencesSystemContext: () => '',
    getPreferencesSystemContextForApp: () => '',
    getRecentConversationHistory: () => [],
    getSemanticDOMContextText: () => '',
    getUIWatcher: () => null,
    maxHistory: 0,
    systemPrompt: 'base system prompt'
  });

  const messages = await builder.buildMessages('continue', false, {
    chatContinuityContext
  });

  return messages.find((entry) => entry.role === 'system' && entry.content.includes('## Recent Action Continuity'));
}

function createTempStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-continuity-prompt-'));
  return {
    tempDir,
    stateFile: path.join(tempDir, 'session-intent-state.json'),
    cwd: path.join(__dirname, '..')
  };
}

async function main() {
await test('prompting includes verified multi-turn execution facts', async () => {
  const { tempDir, stateFile, cwd } = createTempStore();
  const store = createSessionIntentStateStore({ stateFile });

  const state = store.recordExecutedTurn({
    userMessage: 'help me make a confident synthesis of ticker LUNR in tradingview',
    executionIntent: 'Inspect the active TradingView chart and gather evidence for synthesis',
    committedSubgoal: 'Inspect the active TradingView chart',
    actionPlan: [
      { type: 'focus_window', title: 'TradingView', processName: 'tradingview', windowHandle: 777 },
      { type: 'screenshot', scope: 'active-window' }
    ],
    results: [
      { type: 'focus_window', success: true, message: 'focused' },
      { type: 'screenshot', success: true, message: 'captured chart' }
    ],
    success: true,
    executionResult: {
      executedCount: 2,
      successCount: 2,
      failureCount: 0
    },
    observationEvidence: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      visualContextRef: 'window-copyfromscreen@123',
      uiWatcherFresh: true,
      uiWatcherAgeMs: 320
    },
    verification: {
      status: 'verified',
      checks: [{ name: 'target-window-focused', status: 'verified' }]
    },
    targetWindowHandle: 777,
    windowTitle: 'TradingView - LUNR',
    nextRecommendedStep: 'Summarize the visible chart state before modifying indicators.'
  }, { cwd });

  const context = formatChatContinuityContext(state);
  const continuityMessage = await buildContinuitySystemMessage(context);

  assert(continuityMessage, 'continuity section is injected');
  assert(continuityMessage.content.includes('lastExecutionCounts: success=2, failed=0'));
  assert(continuityMessage.content.includes('targetWindow: TradingView - LUNR [777]'));
  assert(continuityMessage.content.includes('actionOutcomes: focus_window:ok | screenshot:ok'));
  assert(continuityMessage.content.includes('continuationReady: yes'));
  assert(continuityMessage.content.includes('nextRecommendedStep: Summarize the visible chart state before modifying indicators.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

await test('prompting surfaces paper trading continuity facts and assist-only rules', async () => {
  const continuityMessage = await buildContinuitySystemMessage(
    formatChatContinuityContext(PAPER_AWARE_CONTINUITY_FIXTURES.verifiedPaperAssistContinuation)
  );

  assert(continuityMessage, 'continuity section is injected');
  assert(continuityMessage.content.includes('tradingMode: paper (high)'));
  assert(continuityMessage.content.includes('tradingModeEvidence: paper trading | paper account'));
  assert(continuityMessage.content.includes('continuationReady: yes'));
  assert(continuityMessage.content.includes('Rule: Paper Trading was observed; continue with assist-only verification and guidance, not order execution.'));
});

await test('prompting surfaces cancelled paper continuity recovery requirements', async () => {
  const continuityMessage = await buildContinuitySystemMessage(
    formatChatContinuityContext(PAPER_AWARE_CONTINUITY_FIXTURES.cancelledPaperAssistContinuation)
  );

  assert(continuityMessage, 'continuity section is injected');
  assert(continuityMessage.content.includes('tradingMode: paper (high)'));
  assert(continuityMessage.content.includes('lastExecutionStatus: cancelled'));
  assert(continuityMessage.content.includes('continuationReady: no'));
  assert(continuityMessage.content.includes('degradedReason: The last action batch was cancelled before completion.'));
  assert(continuityMessage.content.includes('nextRecommendedStep: Ask whether to retry the interrupted paper-trading setup step before continuing.'));
});

await test('prompting surfaces degraded screenshot trust for recovery-oriented continuation', async () => {
  const { tempDir, stateFile, cwd } = createTempStore();
  const store = createSessionIntentStateStore({ stateFile });

  const state = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Continue chart inspection after fallback capture.',
    committedSubgoal: 'Inspect the active TradingView chart',
    actionPlan: [{ type: 'screenshot', scope: 'screen' }],
    results: [{ type: 'screenshot', success: true, message: 'fullscreen fallback captured' }],
    success: true,
    observationEvidence: {
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false,
      visualContextRef: 'screen-copyfromscreen@222',
      uiWatcherFresh: false,
      uiWatcherAgeMs: 2600
    },
    verification: {
      status: 'verified',
      checks: [{ name: 'target-window-focused', status: 'verified' }]
    },
    nextRecommendedStep: 'Recapture the target window before continuing with chart-specific claims.'
  }, { cwd });

  const context = formatChatContinuityContext(state);
  const continuityMessage = await buildContinuitySystemMessage(context);

  assert(continuityMessage, 'continuity section is injected');
  assert(continuityMessage.content.includes('lastCaptureMode: screen-copyfromscreen'));
  assert(continuityMessage.content.includes('lastCaptureTrusted: no'));
  assert(continuityMessage.content.includes('uiWatcherFresh: no'));
  assert(continuityMessage.content.includes('continuationReady: no'));
  assert(continuityMessage.content.includes('degradedReason: Visual evidence fell back to full-screen capture instead of a trusted target-window capture.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

await test('prompting blocks overclaiming on contradicted and cancelled turns', async () => {
  const { tempDir, stateFile, cwd } = createTempStore();
  const store = createSessionIntentStateStore({ stateFile });

  let state = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Verify the indicator was added.',
    committedSubgoal: 'Verify indicator presence on chart',
    actionPlan: [{ type: 'screenshot', scope: 'active-window' }],
    results: [{ type: 'screenshot', success: true, message: 'captured chart' }],
    success: true,
    observationEvidence: {
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      visualContextRef: 'window-copyfromscreen@333'
    },
    verification: {
      status: 'contradicted',
      checks: [{ name: 'indicator-present', status: 'contradicted', detail: 'indicator not visible on chart' }]
    },
    nextRecommendedStep: 'Retry indicator search before claiming success.'
  }, { cwd });

  let continuityMessage = await buildContinuitySystemMessage(formatChatContinuityContext(state));
  assert(continuityMessage.content.includes('lastVerificationStatus: contradicted'));
  assert(continuityMessage.content.includes('continuationReady: no'));
  assert(continuityMessage.content.includes('Rule: Do not claim the requested UI change is complete unless the latest evidence verifies it.'));

  state = store.recordExecutedTurn({
    userMessage: 'continue',
    executionIntent: 'Resume alert setup.',
    committedSubgoal: 'Open and complete the alert dialog',
    actionPlan: [{ type: 'key', key: 'alt+a' }],
    results: [{ type: 'key', success: false, error: 'cancelled by user' }],
    cancelled: true,
    success: false,
    verification: {
      status: 'not-applicable',
      checks: []
    },
    nextRecommendedStep: 'Ask whether to retry the interrupted step or choose a different path.'
  }, { cwd });

  continuityMessage = await buildContinuitySystemMessage(formatChatContinuityContext(state));
  assert(continuityMessage.content.includes('lastExecutionStatus: cancelled'));
  assert(continuityMessage.content.includes('continuationReady: no'));
  assert(continuityMessage.content.includes('nextRecommendedStep: Ask whether to retry the interrupted step or choose a different path.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});
}

main().catch((error) => {
  console.error('FAIL chat continuity prompting');
  console.error(error.stack || error.message);
  process.exit(1);
});
