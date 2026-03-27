#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PAPER_AWARE_CONTINUITY_FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'tradingview', 'paper-aware-continuity.json'), 'utf8')
);

function buildHarnessScript(chatModulePath) {
  return `
const Module = require('module');
const originalLoad = Module._load;

let executeCount = 0;
let seenMessages = [];
let continuityState = process.env.__CHAT_CONTINUITY__ ? JSON.parse(process.env.__CHAT_CONTINUITY__) : null;
const scriptedVisualStates = process.env.__LATEST_VISUAL_SEQUENCE__ ? JSON.parse(process.env.__LATEST_VISUAL_SEQUENCE__) : [];
let lastRecordedTurn = null;

function isScreenLikeCaptureMode(captureMode) {
  const normalized = String(captureMode || '').trim().toLowerCase();
  return normalized === 'screen'
    || normalized === 'fullscreen-fallback'
    || normalized.startsWith('screen-')
    || normalized.includes('fullscreen');
}

function deriveContinuityState(turnRecord) {
  const actionSummary = Array.isArray(turnRecord?.actionPlan)
    ? turnRecord.actionPlan.map((action) => action?.type).filter(Boolean).join(' -> ')
    : null;
  const verificationStatus = String(turnRecord?.verification?.status || '').trim() || null;
  const captureMode = String(turnRecord?.observationEvidence?.captureMode || '').trim() || null;
  const captureTrusted = typeof turnRecord?.observationEvidence?.captureTrusted === 'boolean'
    ? turnRecord.observationEvidence.captureTrusted
    : null;

  let degradedReason = null;
  if (turnRecord?.cancelled || turnRecord?.executionResult?.cancelled) {
    degradedReason = 'The last action batch was cancelled before completion.';
  } else if (verificationStatus === 'contradicted') {
    degradedReason = 'The latest evidence contradicts the claimed result.';
  } else if (verificationStatus === 'unverified') {
    degradedReason = 'The latest result is not fully verified yet.';
  } else if (isScreenLikeCaptureMode(captureMode) && captureTrusted === false) {
    degradedReason = 'Visual evidence fell back to full-screen capture instead of a trusted target-window capture.';
  }

  return {
    activeGoal: turnRecord?.activeGoal || turnRecord?.executionIntent || turnRecord?.userMessage || null,
    currentSubgoal: turnRecord?.currentSubgoal || turnRecord?.committedSubgoal || turnRecord?.thought || null,
    continuationReady: !degradedReason && !(turnRecord?.cancelled || turnRecord?.executionResult?.cancelled) && turnRecord?.executionStatus !== 'failed',
    degradedReason,
    lastTurn: {
      actionSummary,
      nextRecommendedStep: turnRecord?.nextRecommendedStep || null,
      verificationStatus,
      captureMode,
      captureTrusted
    }
  };
}

const actionResponse = JSON.stringify({
  thought: 'Set alert in TradingView',
  actions: [
    { type: 'focus_window', windowHandle: 458868 },
    { type: 'key', key: 'alt+a', reason: 'Open the Create Alert dialog' },
    { type: 'type', text: '20.02' },
    { type: 'key', key: 'enter', reason: 'Save the alert' }
  ],
  verification: 'TradingView should show the alert configured at 20.02'
}, null, 2);

const aiStub = {
  sendMessage: async (line) => {
    seenMessages.push(line);
    return { success: true, provider: 'stub', model: 'stub-model', message: line ? actionResponse : 'stub response', requestedModel: 'stub-model' };
  },
  handleCommand: async () => ({ type: 'info', message: 'stub command' }),
  parseActions: (message) => JSON.parse(String(message || 'null')),
  saveSessionNote: () => null,
  setUIWatcher: () => {},
  getUIWatcher: () => null,
  preflightActions: (value) => value,
  analyzeActionSafety: () => ({ requiresConfirmation: false }),
  executeActions: async () => {
    executeCount++;
    return { success: true, results: [], screenshotCaptured: false, postVerification: { verified: true } };
  },
  getLatestVisualContext: () => {
    if (!Array.isArray(scriptedVisualStates) || scriptedVisualStates.length === 0) return null;
    return scriptedVisualStates[Math.max(0, executeCount - 1)] || scriptedVisualStates[scriptedVisualStates.length - 1] || null;
  },
  parsePreferenceCorrection: async () => ({ success: false, error: 'not needed' })
};

const watcherStub = {
  getUIWatcher: () => ({ isPolling: false, start() {}, stop() {} })
};

const systemAutomationStub = {
  getForegroundWindowInfo: async () => ({ success: true, processName: 'tradingview', title: 'TradingView' })
};

const preferencesStub = {
  resolveTargetProcessNameFromActions: () => 'tradingview',
  getAppPolicy: () => null,
  EXECUTION_MODE: { AUTO: 'auto', PROMPT: 'prompt' },
  recordAutoRunOutcome: () => ({ demoted: false }),
  setAppExecutionMode: () => ({ success: true }),
  mergeAppPolicy: () => ({ success: true })
};

const sessionIntentStateStub = {
  getChatContinuityState: () => continuityState,
  recordChatContinuityTurn: (turnRecord) => {
    lastRecordedTurn = turnRecord;
    continuityState = deriveContinuityState(turnRecord);
    return continuityState;
  }
};

Module._load = function(request, parent, isMain) {
  if (request === '../../main/ai-service') return aiStub;
  if (request === '../../main/ui-watcher') return watcherStub;
  if (request === '../../main/system-automation') return systemAutomationStub;
  if (request === '../../main/preferences') return preferencesStub;
  if (request === '../../main/session-intent-state') return sessionIntentStateStub;
  return originalLoad.apply(this, arguments);
};

(async () => {
  const chat = require('${chatModulePath}');
  const result = await chat.run([], { execute: 'auto', quiet: true });
  console.log('EXECUTE_COUNT:' + executeCount);
  console.log('SEEN_MESSAGES:' + JSON.stringify(seenMessages));
  console.log('RECORDED_CONTINUITY:' + JSON.stringify(continuityState));
  console.log('LAST_TURN:' + JSON.stringify(lastRecordedTurn));
  process.exit(result && result.success === false ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});`;
}

async function runScenario(inputs) {
  return runScenarioWithContinuity(inputs, null, null);
}

async function runScenarioWithContinuity(inputs, continuityState, latestVisualSequence) {
  const repoRoot = path.join(__dirname, '..');
  const chatModulePath = path.join(repoRoot, 'src', 'cli', 'commands', 'chat.js').replace(/\\/g, '\\\\');
  const child = spawn(process.execPath, ['-e', buildHarnessScript(chatModulePath)], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      __CHAT_CONTINUITY__: continuityState ? JSON.stringify(continuityState) : '',
      __LATEST_VISUAL_SEQUENCE__: latestVisualSequence ? JSON.stringify(latestVisualSequence) : ''
    }
  });

  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });

  for (const input of inputs) {
    child.stdin.write(`${input}\n`);
  }
  child.stdin.write('exit\n');
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  return { exitCode, output };
}

async function main() {
  const direct = await runScenario(['yes, set an alert for a price target of $20.02 in tradingview']);
  assert.strictEqual(direct.exitCode, 0, 'direct alert-setting scenario should exit successfully');
  assert(direct.output.includes('EXECUTE_COUNT:1'), 'direct alert-setting scenario should execute the emitted actions once');
  assert(!direct.output.includes('Non-action message detected'), 'direct alert-setting scenario should not be skipped as non-action');

  const synthesis = await runScenario(['help me make a confident synthesis of ticker LUNR in tradingview']);
  assert.strictEqual(synthesis.exitCode, 0, 'TradingView synthesis scenario should exit successfully');
  assert(synthesis.output.includes('EXECUTE_COUNT:1'), 'TradingView synthesis scenario should execute the emitted actions once');
  assert(!synthesis.output.includes('Non-action message detected'), 'TradingView synthesis scenario should not be skipped as non-action');
  assert(!synthesis.output.includes('Parsed action plan withheld'), 'TradingView synthesis scenario should not be withheld as acknowledgement-only text');

  const approval = await runScenario(['yes']);
  assert.strictEqual(approval.exitCode, 0, 'approval-style scenario should exit successfully');
  assert(approval.output.includes('EXECUTE_COUNT:1'), 'approval-style scenario should execute the emitted actions once');
  assert(!approval.output.includes('Non-action message detected'), 'approval-style scenario should not be skipped as non-action');

  const continuity = await runScenario(['lets continue with next steps, maintain continuity']);
  assert.strictEqual(continuity.exitCode, 0, 'continuity-style scenario should exit successfully');
  assert(continuity.output.includes('EXECUTE_COUNT:1'), 'continuity-style scenario should execute the emitted actions once');
  assert(!continuity.output.includes('Parsed action plan withheld'), 'continuity-style scenario should not be withheld as non-executable text');

  const stateBackedContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Produce a confident synthesis of ticker LUNR in TradingView',
    currentSubgoal: 'Inspect the active TradingView chart',
    continuationReady: true,
    degradedReason: null,
    lastTurn: {
      actionSummary: 'focus_window -> screenshot',
      nextRecommendedStep: 'Continue from the latest chart evidence.'
    }
  });
  assert.strictEqual(stateBackedContinuation.exitCode, 0, 'state-backed continuation scenario should exit successfully');
  assert(stateBackedContinuation.output.includes('EXECUTE_COUNT:1'), 'state-backed continuation should execute emitted actions');
  assert(stateBackedContinuation.output.includes('SEEN_MESSAGES:["continue"]'), 'state-backed continuation should still send the minimal prompt while execution routing relies on saved continuity');

  const persistedContinuation = await runScenarioWithContinuity([
    'help me make a confident synthesis of ticker LUNR in tradingview',
    'continue'
  ], null, [{
    captureMode: 'window-copyfromscreen',
    captureTrusted: true,
    timestamp: 111,
    windowHandle: 458868,
    windowTitle: 'TradingView - LUNR'
  }]);
  assert.strictEqual(persistedContinuation.exitCode, 0, 'persisted continuation scenario should exit successfully');
  assert(persistedContinuation.output.includes('EXECUTE_COUNT:2'), 'persisted continuation should execute both the original and follow-up turn');
  assert(persistedContinuation.output.includes('SEEN_MESSAGES:["help me make a confident synthesis of ticker LUNR in tradingview","continue"]'), 'persisted continuation should keep the second user turn minimal while relying on recorded state');
  assert(/RECORDED_CONTINUITY:.*"continuationReady":true/i.test(persistedContinuation.output), 'persisted continuation should record usable continuity between turns');

  const persistedDegradedContinuation = await runScenarioWithContinuity([
    'help me make a confident synthesis of ticker LUNR in tradingview',
    'continue'
  ], null, [{
    captureMode: 'screen-copyfromscreen',
    captureTrusted: false,
    timestamp: 222,
    windowTitle: 'Desktop'
  }]);
  assert.strictEqual(persistedDegradedContinuation.exitCode, 0, 'persisted degraded continuation should exit successfully');
  assert(persistedDegradedContinuation.output.includes('EXECUTE_COUNT:1'), 'persisted degraded continuation should block the second execution');
  assert(/Continuity is currently degraded/i.test(persistedDegradedContinuation.output), 'persisted degraded continuation should explain degraded recovery requirements');
  assert(/RECORDED_CONTINUITY:.*"continuationReady":false/i.test(persistedDegradedContinuation.output), 'persisted degraded continuation should record degraded continuity after the first turn');

  const degradedContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Produce a confident synthesis of ticker LUNR in TradingView',
    currentSubgoal: 'Inspect the active TradingView chart',
    continuationReady: false,
    degradedReason: 'Visual evidence fell back to full-screen capture instead of a trusted target-window capture.',
    lastTurn: {
      verificationStatus: 'verified',
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false,
      nextRecommendedStep: 'Continue from the latest chart evidence.'
    }
  });
  assert.strictEqual(degradedContinuation.exitCode, 0, 'degraded continuation scenario should exit successfully');
  assert(degradedContinuation.output.includes('EXECUTE_COUNT:0'), 'degraded continuation should not execute emitted actions');
  assert(/Continuity is currently degraded/i.test(degradedContinuation.output), 'degraded continuation should explain recovery-oriented continuity blocking');

  const paperStateBackedContinuation = await runScenarioWithContinuity(['continue'], PAPER_AWARE_CONTINUITY_FIXTURES.verifiedPaperAssistContinuation);
  assert.strictEqual(paperStateBackedContinuation.exitCode, 0, 'paper-aware continuation scenario should exit successfully');
  assert(paperStateBackedContinuation.output.includes('EXECUTE_COUNT:1'), 'paper-aware continuation should execute emitted actions when verified continuity says it is safe');
  assert(paperStateBackedContinuation.output.includes('SEEN_MESSAGES:["continue"]'), 'paper-aware continuation should keep the follow-up prompt minimal while relying on stored continuity');

  const degradedPaperContinuation = await runScenarioWithContinuity(['continue'], PAPER_AWARE_CONTINUITY_FIXTURES.degradedPaperAssistContinuation);
  assert.strictEqual(degradedPaperContinuation.exitCode, 0, 'degraded paper continuation scenario should exit successfully');
  assert(degradedPaperContinuation.output.includes('EXECUTE_COUNT:0'), 'degraded paper continuation should not execute emitted actions');
  assert(/Continuity is currently degraded/i.test(degradedPaperContinuation.output), 'degraded paper continuation should explain recovery requirements before continuing');

  const contradictedContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Add a TradingView indicator and verify it on chart',
    currentSubgoal: 'Verify the indicator is present',
    continuationReady: false,
    degradedReason: 'The latest evidence contradicts the claimed result.',
    lastTurn: {
      verificationStatus: 'contradicted',
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      nextRecommendedStep: 'Retry indicator search before claiming success.'
    }
  });
  assert.strictEqual(contradictedContinuation.exitCode, 0, 'contradicted continuation scenario should exit successfully');
  assert(contradictedContinuation.output.includes('EXECUTE_COUNT:0'), 'contradicted continuation should not execute emitted actions');
  assert(/contradicted by the latest evidence/i.test(contradictedContinuation.output), 'contradicted continuation should explain why blind continuation is blocked');

  const contradictedPaperContinuation = await runScenarioWithContinuity(['continue'], PAPER_AWARE_CONTINUITY_FIXTURES.contradictedPaperAssistContinuation);
  assert.strictEqual(contradictedPaperContinuation.exitCode, 0, 'contradicted paper continuation scenario should exit successfully');
  assert(contradictedPaperContinuation.output.includes('EXECUTE_COUNT:0'), 'contradicted paper continuation should not execute emitted actions');
  assert(/contradicted by the latest evidence/i.test(contradictedPaperContinuation.output), 'contradicted paper continuation should explain why blind continuation is blocked');

  const acknowledgement = await runScenario(['thanks']);
  assert.strictEqual(acknowledgement.exitCode, 0, 'acknowledgement-style scenario should exit successfully');
  assert(acknowledgement.output.includes('EXECUTE_COUNT:0'), 'acknowledgement-style scenario should not execute emitted actions');
  assert(acknowledgement.output.includes('Parsed action plan withheld'), 'acknowledgement-style scenario should be withheld as acknowledgement-only text');

  console.log('PASS chat actionability');
}

main().catch((error) => {
  console.error('FAIL chat actionability');
  console.error(error.stack || error.message);
  process.exit(1);
});