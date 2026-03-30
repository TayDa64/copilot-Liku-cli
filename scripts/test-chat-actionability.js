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
let pendingRequestedTask = process.env.__PENDING_REQUESTED_TASK__ ? JSON.parse(process.env.__PENDING_REQUESTED_TASK__) : null;
const scriptedVisualStates = process.env.__LATEST_VISUAL_SEQUENCE__ ? JSON.parse(process.env.__LATEST_VISUAL_SEQUENCE__) : [];
const allowRecoveryCapture = process.env.__ALLOW_CAPTURE_RECOVERY__ === '1';
let visualContexts = [];
let latestVisualContext = null;
let lastRecordedTurn = null;
let preflightUserMessages = [];
const failFirstPineExecution = process.env.__FAIL_FIRST_PINE_EXECUTION__ === '1';
let failedFirstPineExecution = false;

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
    freshnessState: degradedReason ? null : 'fresh',
    freshnessAgeMs: 0,
    freshnessBudgetMs: 90000,
    freshnessRecoverableBudgetMs: 900000,
    freshnessReason: null,
    requiresReobserve: false,
    lastTurn: {
      recordedAt: turnRecord?.recordedAt || new Date().toISOString(),
      actionSummary,
      nextRecommendedStep: turnRecord?.nextRecommendedStep || null,
      verificationStatus,
      executionStatus: turnRecord?.executionStatus || (turnRecord?.cancelled ? 'cancelled' : (turnRecord?.success === false ? 'failed' : 'succeeded')),
      captureMode,
      captureTrusted,
      targetWindowHandle: turnRecord?.targetWindowHandle || null,
      observationEvidence: {
        windowHandle: turnRecord?.observationEvidence?.windowHandle || turnRecord?.targetWindowHandle || null
      }
    }
  };
}

function buildActionResponse(line) {
  const lower = String(line || '').toLowerCase();

  if (/retry the blocked tradingview pine authoring task/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      message: JSON.stringify({
        thought: 'Create and apply the requested TradingView Pine script',
        actions: [
          { type: 'focus_window', windowHandle: 458868 },
          { type: 'run_command', shell: 'powershell', command: "Set-Clipboard -Value @'\\n//@version=6\\nindicator(\\\"Volume Momentum Confidence\\\", overlay=false)\\nplot(close)\\n'@" },
          { type: 'key', key: 'ctrl+v', reason: 'Paste the Pine script' },
          { type: 'key', key: 'ctrl+enter', reason: 'Apply the Pine script to the chart' }
        ],
        verification: 'TradingView should show the Pine script applied and visible compile/apply status.'
      }, null, 2)
    };
  }

  if (/retry the failed tradingview pine authoring workflow/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      message: JSON.stringify({
        thought: 'Retry the TradingView Pine workflow from the start',
        actions: [
          { type: 'focus_window', windowHandle: 458868 },
          { type: 'run_command', shell: 'powershell', command: "Set-Clipboard -Value @'\\n//@version=6\\nindicator(\\\"Volume Momentum Confidence\\\", overlay=false)\\nplot(close)\\n'@" },
          { type: 'key', key: 'ctrl+v', reason: 'Paste the Pine script' },
          { type: 'key', key: 'ctrl+enter', reason: 'Apply the Pine script to the chart' }
        ],
        verification: 'TradingView should show the Pine script applied and visible compile/apply status.'
      }, null, 2)
    };
  }

  if (/tradingview application is in the background, create a pine script that shows confidence in volume and momentum/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      routing: { mode: 'blocked-incomplete-tradingview-pine-plan' },
      routingNote: 'blocked incomplete TradingView Pine authoring plan',
      message: [
        'Verified result: only a partial TradingView window-activation plan was produced.',
        'Bounded inference: no Pine script insertion payload or Ctrl+Enter add-to-chart step was generated, so Liku did not execute Pine edits or apply a script to the chart.',
        'Unverified next step: retry with a full TradingView Pine authoring plan that opens the Pine Editor, inserts the script, and verifies the compile/apply result.'
      ].join('\\n')
    };
  }

  if (/confidence about investing|what would help me have confidence/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      message: 'To build confidence in LUNR, combine chart structure, indicators, and catalyst data.'
    };
  }

  if (/volume profile|vpvr/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      message: JSON.stringify({
        thought: 'Apply Volume Profile in TradingView',
        actions: [
          { type: 'focus_window', windowHandle: 458868 },
          { type: 'key', key: '/', reason: 'Open Indicators search in TradingView' },
          { type: 'type', text: 'Volume Profile Visible Range' },
          { type: 'key', key: 'enter', reason: 'Add Volume Profile Visible Range' }
        ],
        verification: 'TradingView should show Volume Profile Visible Range on the chart.'
      }, null, 2)
    };
  }

  if (/add rsi/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      message: JSON.stringify({
        thought: 'Add RSI in TradingView',
        actions: [
          { type: 'focus_window', windowHandle: 458868 },
          { type: 'key', key: '/', reason: 'Open Indicators search in TradingView' },
          { type: 'type', text: 'RSI' },
          { type: 'key', key: 'enter', reason: 'Add RSI indicator' }
        ],
        verification: 'TradingView should show RSI on the chart.'
      }, null, 2)
    };
  }

  if (/pine logs/.test(lower)) {
    return {
      success: true,
      provider: 'stub',
      model: 'stub-model',
      requestedModel: 'stub-model',
      message: JSON.stringify({
        thought: 'Open Pine Logs in TradingView',
        actions: [
          { type: 'focus_window', windowHandle: 458868 },
          { type: 'key', key: 'alt+l', reason: 'Open Pine Logs' }
        ],
        verification: 'TradingView should show the Pine Logs panel.'
      }, null, 2)
    };
  }

  return {
    success: true,
    provider: 'stub',
    model: 'stub-model',
    requestedModel: 'stub-model',
    message: JSON.stringify({
      thought: 'Set alert in TradingView',
      actions: [
        { type: 'focus_window', windowHandle: 458868 },
        { type: 'key', key: 'alt+a', reason: 'Open the Create Alert dialog' },
        { type: 'type', text: '20.02' },
        { type: 'key', key: 'enter', reason: 'Save the alert' }
      ],
      verification: 'TradingView should show the alert configured at 20.02'
    }, null, 2)
  };
}

const aiStub = {
  sendMessage: async (line) => {
    seenMessages.push(line);
    return line
      ? buildActionResponse(line)
      : { success: true, provider: 'stub', model: 'stub-model', message: 'stub response', requestedModel: 'stub-model' };
  },
  handleCommand: async () => ({ type: 'info', message: 'stub command' }),
  parseActions: (message) => {
    try {
      return JSON.parse(String(message || 'null'));
    } catch {
      return null;
    }
  },
  saveSessionNote: () => null,
  setUIWatcher: () => {},
  getUIWatcher: () => null,
  preflightActions: (value, options = {}) => {
    preflightUserMessages.push(options?.userMessage || null);
    return value;
  },
  analyzeActionSafety: () => ({ requiresConfirmation: false }),
  executeActions: async (actionData) => {
    executeCount++;
    const actions = Array.isArray(actionData?.actions) ? actionData.actions : [];
    const isTradingViewPineWorkflow = actions.some((action) =>
      String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
      || String(action?.tradingViewShortcut?.id || '').toLowerCase() === 'open-pine-editor'
      || String(action?.searchSurfaceContract?.id || '').toLowerCase() === 'open-pine-editor'
      || String(action?.key || '').toLowerCase() === 'ctrl+enter'
    );
    if (failFirstPineExecution && !failedFirstPineExecution && isTradingViewPineWorkflow) {
      failedFirstPineExecution = true;
      return {
        success: false,
        error: 'Element not found',
        results: [
          { index: 6, action: 'key', success: false, error: 'Element not found' }
        ],
        screenshotCaptured: false,
        postVerification: { verified: false }
      };
    }
    return { success: true, results: [], screenshotCaptured: false, postVerification: { verified: true } };
  },
  getLatestVisualContext: () => {
    if (!Array.isArray(scriptedVisualStates) || scriptedVisualStates.length === 0) return null;
    return scriptedVisualStates[Math.max(0, executeCount - 1)] || scriptedVisualStates[scriptedVisualStates.length - 1] || null;
  },
  parsePreferenceCorrection: async () => ({ success: false, error: 'not needed' })
};

aiStub.addVisualContext = (entry) => {
  latestVisualContext = entry;
  visualContexts.push(entry);
};

aiStub.getLatestVisualContext = () => {
  if (Array.isArray(scriptedVisualStates) && scriptedVisualStates.length > 0) {
    return scriptedVisualStates[Math.max(0, executeCount - 1)] || scriptedVisualStates[scriptedVisualStates.length - 1] || null;
  }
  return latestVisualContext;
};

const watcherStub = {
  getUIWatcher: () => ({ isPolling: false, start() {}, stop() {} })
};

const screenshotStub = {
  screenshot: async (options = {}) => {
    if (!(allowRecoveryCapture && executeCount === 0)) return { success: false };
    return {
      success: true,
      base64: 'stub-image',
      captureMode: options.windowHwnd ? 'window-copyfromscreen' : 'screen-copyfromscreen'
    };
  },
  screenshotActiveWindow: async () => {
    if (!(allowRecoveryCapture && executeCount === 0)) return { success: false };
    return {
      success: true,
      base64: 'stub-image',
      captureMode: 'window-copyfromscreen'
    };
  }
};

const backgroundCaptureStub = {
  captureBackgroundWindow: async () => ({
    success: false,
    degradedReason: 'background capture unavailable in harness'
  })
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
  getPendingRequestedTask: () => pendingRequestedTask,
  recordChatContinuityTurn: (turnRecord) => {
    lastRecordedTurn = turnRecord;
    continuityState = deriveContinuityState(turnRecord);
    return continuityState;
  },
  setPendingRequestedTask: (taskRecord) => {
    pendingRequestedTask = taskRecord;
    return { pendingRequestedTask };
  },
  clearPendingRequestedTask: () => {
    pendingRequestedTask = null;
    return { pendingRequestedTask };
  }
};

Module._load = function(request, parent, isMain) {
  if (request === '../../main/ai-service') return aiStub;
  if (request === '../../main/ui-watcher') return watcherStub;
  if (request === '../../main/system-automation') return systemAutomationStub;
  if (request === '../../main/preferences') return preferencesStub;
  if (request === '../../main/session-intent-state') return sessionIntentStateStub;
  if (request === '../../main/ui-automation/screenshot') return screenshotStub;
  if (request === '../../main/background-capture') return backgroundCaptureStub;
  return originalLoad.apply(this, arguments);
};

(async () => {
  const chat = require('${chatModulePath}');
  const result = await chat.run([], { execute: 'auto', quiet: true });
  console.log('EXECUTE_COUNT:' + executeCount);
  console.log('SEEN_MESSAGES:' + JSON.stringify(seenMessages));
  console.log('PREFLIGHT_USER_MESSAGES:' + JSON.stringify(preflightUserMessages));
  console.log('PENDING_REQUESTED_TASK:' + JSON.stringify(pendingRequestedTask));
  console.log('RECORDED_CONTINUITY:' + JSON.stringify(continuityState));
  console.log('LAST_TURN:' + JSON.stringify(lastRecordedTurn));
  console.log('VISUAL_CONTEXTS:' + JSON.stringify(visualContexts));
  process.exit(result && result.success === false ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});`;
}

async function runScenario(inputs) {
  return runScenarioWithContinuity(inputs, null, null);
}

async function runScenarioWithContinuity(inputs, continuityState, latestVisualSequence, pendingTask = null, options = {}) {
  const repoRoot = path.join(__dirname, '..');
  const chatModulePath = path.join(repoRoot, 'src', 'cli', 'commands', 'chat.js').replace(/\\/g, '\\\\');
  const child = spawn(process.execPath, ['-e', buildHarnessScript(chatModulePath)], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      __CHAT_CONTINUITY__: continuityState ? JSON.stringify(continuityState) : '',
      __PENDING_REQUESTED_TASK__: pendingTask ? JSON.stringify(pendingTask) : '',
      __LATEST_VISUAL_SEQUENCE__: latestVisualSequence ? JSON.stringify(latestVisualSequence) : '',
      __ALLOW_CAPTURE_RECOVERY__: options.allowRecoveryCapture ? '1' : '',
      __FAIL_FIRST_PINE_EXECUTION__: options.failFirstPineExecution ? '1' : ''
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

  const explicitIndicatorFollowThrough = await runScenario(['yes, lets apply the volume profile']);
  assert.strictEqual(explicitIndicatorFollowThrough.exitCode, 0, 'affirmative explicit indicator follow-through should exit successfully');
  assert(explicitIndicatorFollowThrough.output.includes('EXECUTE_COUNT:1'), 'affirmative explicit indicator follow-through should execute emitted actions');
  assert(!explicitIndicatorFollowThrough.output.includes('Parsed action plan withheld'), 'affirmative explicit indicator follow-through should not be withheld as acknowledgement-only text');
  assert(explicitIndicatorFollowThrough.output.includes('PREFLIGHT_USER_MESSAGES:["yes, lets apply the volume profile"]'), 'affirmative explicit indicator follow-through should preserve the current operation as execution intent');

  const explicitPineFollowThrough = await runScenario(['yes, open Pine Logs']);
  assert.strictEqual(explicitPineFollowThrough.exitCode, 0, 'affirmative explicit Pine follow-through should exit successfully');
  assert(explicitPineFollowThrough.output.includes('EXECUTE_COUNT:1'), 'affirmative explicit Pine follow-through should execute emitted actions');
  assert(explicitPineFollowThrough.output.includes('PREFLIGHT_USER_MESSAGES:["yes, open Pine Logs"]'), 'affirmative explicit Pine follow-through should preserve the current operation as execution intent');

  const recommendationFollowThrough = await runScenario([
    'what would help me have confidence about investing in LUNR? visualizations, indicators, data?',
    'yes, lets apply the volume profile'
  ]);
  assert.strictEqual(recommendationFollowThrough.exitCode, 0, 'recommendation follow-through scenario should exit successfully');
  assert(recommendationFollowThrough.output.includes('EXECUTE_COUNT:1'), 'recommendation follow-through should execute the explicit indicator request on the second turn');
  assert(recommendationFollowThrough.output.includes('SEEN_MESSAGES:["what would help me have confidence about investing in LUNR? visualizations, indicators, data?","yes, lets apply the volume profile"]'), 'recommendation follow-through should keep the explicit second-turn request intact');
  assert(recommendationFollowThrough.output.includes('PREFLIGHT_USER_MESSAGES:["yes, lets apply the volume profile"]'), 'recommendation follow-through should not collapse the explicit follow-through intent back to the prior advisory question');

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

  const pineDiagnosticsContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Diagnose the visible Pine script errors in TradingView',
    currentSubgoal: 'Inspect the visible Pine diagnostics state',
    continuationReady: true,
    degradedReason: null,
    lastTurn: {
      actionSummary: 'focus_window -> key -> get_text',
      verificationStatus: 'verified',
      actionResults: [{
        type: 'get_text',
        success: true,
        pineStructuredSummary: {
          evidenceMode: 'diagnostics',
          compileStatus: 'errors-visible',
          errorCountEstimate: 1,
          warningCountEstimate: 1,
          topVisibleDiagnostics: [
            'Compiler error at line 42: mismatched input.',
            'Warning: script has unused variable.'
          ]
        }
      }]
    }
  });
  assert.strictEqual(pineDiagnosticsContinuation.exitCode, 0, 'pine diagnostics continuation should exit successfully');
  assert(pineDiagnosticsContinuation.output.includes('EXECUTE_COUNT:1'), 'pine diagnostics continuation should execute emitted actions');
  assert(pineDiagnosticsContinuation.output.includes('SEEN_MESSAGES:["continue"]'), 'pine diagnostics continuation should keep the user turn minimal');
  assert(
    pineDiagnosticsContinuation.output.includes('PREFLIGHT_USER_MESSAGES:["Continue the Pine diagnostics workflow by fixing the visible compiler errors before inferring runtime or chart behavior.'),
    'pine diagnostics continuation should route through Pine-specific execution intent'
  );
  assert(
    pineDiagnosticsContinuation.output.includes('Compiler error at line 42: mismatched input. | Warning: script has unused variable.'),
    'pine diagnostics continuation should preserve the visible diagnostics inside the execution intent'
  );
  assert(
    pineDiagnosticsContinuation.output.includes('"executionIntent":"Continue the Pine diagnostics workflow by fixing the visible compiler errors before inferring runtime or chart behavior.'),
    'pine diagnostics continuation should persist the Pine-specific execution intent'
  );

  const pineProvenanceContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Summarize recent Pine revisions in TradingView',
    currentSubgoal: 'Inspect top visible Pine Version History metadata',
    continuationReady: true,
    degradedReason: null,
    lastTurn: {
      actionSummary: 'focus_window -> key -> get_text',
      verificationStatus: 'verified',
      actionResults: [{
        type: 'get_text',
        success: true,
        pineStructuredSummary: {
          evidenceMode: 'provenance-summary',
          latestVisibleRevisionLabel: 'Revision 12',
          latestVisibleRevisionNumber: 12,
          latestVisibleRelativeTime: '5 minutes ago',
          visibleRevisionCount: 3
        }
      }]
    }
  });
  assert.strictEqual(pineProvenanceContinuation.exitCode, 0, 'pine provenance continuation should exit successfully');
  assert(pineProvenanceContinuation.output.includes('EXECUTE_COUNT:1'), 'pine provenance continuation should execute emitted actions');
  assert(pineProvenanceContinuation.output.includes('SEEN_MESSAGES:["continue"]'), 'pine provenance continuation should keep the user turn minimal');
  assert(
    pineProvenanceContinuation.output.includes('PREFLIGHT_USER_MESSAGES:["Continue the Pine version-history workflow by summarizing or comparing only the visible revision metadata; do not infer hidden revisions, script content, or runtime behavior.'),
    'pine provenance continuation should route through provenance-only execution intent'
  );
  assert(
    pineProvenanceContinuation.output.includes('Latest visible revision: Revision 12 5 minutes ago.'),
    'pine provenance continuation should preserve the visible revision metadata inside the execution intent'
  );
  assert(
    pineProvenanceContinuation.output.includes('"executionIntent":"Continue the Pine version-history workflow by summarizing or comparing only the visible revision metadata; do not infer hidden revisions, script content, or runtime behavior.'),
    'pine provenance continuation should persist the provenance-specific execution intent'
  );

  const pineLogsContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Diagnose Pine runtime output in TradingView',
    currentSubgoal: 'Inspect visible Pine Logs output',
    continuationReady: true,
    degradedReason: null,
    lastTurn: {
      actionSummary: 'focus_window -> key -> get_text',
      verificationStatus: 'verified',
      actionResults: [{
        type: 'get_text',
        success: true,
        pineStructuredSummary: {
          evidenceMode: 'logs-summary',
          outputSurface: 'pine-logs',
          outputSignal: 'errors-visible',
          topVisibleOutputs: [
            'Runtime error at bar 12: division by zero.',
            'Warning: fallback branch used.'
          ]
        }
      }]
    }
  });
  assert.strictEqual(pineLogsContinuation.exitCode, 0, 'pine logs continuation should exit successfully');
  assert(pineLogsContinuation.output.includes('EXECUTE_COUNT:1'), 'pine logs continuation should execute emitted actions');
  assert(pineLogsContinuation.output.includes('SEEN_MESSAGES:["continue"]'), 'pine logs continuation should keep the user turn minimal');
  assert(
    pineLogsContinuation.output.includes('PREFLIGHT_USER_MESSAGES:["Continue the Pine logs workflow by addressing only the visible log errors before inferring runtime or chart behavior.'),
    'pine logs continuation should route through logs-specific execution intent'
  );
  assert(
    pineLogsContinuation.output.includes('Runtime error at bar 12: division by zero. | Warning: fallback branch used.'),
    'pine logs continuation should preserve the visible log output inside the execution intent'
  );

  const pineProfilerContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Review Pine profiler output in TradingView',
    currentSubgoal: 'Inspect visible Pine Profiler metrics',
    continuationReady: true,
    degradedReason: null,
    lastTurn: {
      actionSummary: 'focus_window -> key -> get_text',
      verificationStatus: 'verified',
      actionResults: [{
        type: 'get_text',
        success: true,
        pineStructuredSummary: {
          evidenceMode: 'profiler-summary',
          outputSurface: 'pine-profiler',
          outputSignal: 'metrics-visible',
          functionCallCountEstimate: 12,
          avgTimeMs: 1.3,
          maxTimeMs: 3.8,
          topVisibleOutputs: [
            'Profiler: 12 calls, avg 1.3ms, max 3.8ms.',
            'Slowest block: request.security'
          ]
        }
      }]
    }
  });
  assert.strictEqual(pineProfilerContinuation.exitCode, 0, 'pine profiler continuation should exit successfully');
  assert(pineProfilerContinuation.output.includes('EXECUTE_COUNT:1'), 'pine profiler continuation should execute emitted actions');
  assert(pineProfilerContinuation.output.includes('SEEN_MESSAGES:["continue"]'), 'pine profiler continuation should keep the user turn minimal');
  assert(
    pineProfilerContinuation.output.includes('PREFLIGHT_USER_MESSAGES:["Continue the Pine profiler workflow by summarizing only the visible performance metrics and hotspots; do not infer runtime correctness or chart behavior from profiler output alone.'),
    'pine profiler continuation should route through profiler-specific execution intent'
  );
  assert(
    pineProfilerContinuation.output.includes('Profiler: 12 calls, avg 1.3ms, max 3.8ms. | Slowest block: request.security'),
    'pine profiler continuation should preserve the visible profiler output inside the execution intent'
  );

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

  const persistedThreeTurnContinuation = await runScenarioWithContinuity([
    'help me make a confident synthesis of ticker LUNR in tradingview',
    'continue',
    'keep going'
  ], null, [{
    captureMode: 'window-copyfromscreen',
    captureTrusted: true,
    timestamp: 123,
    windowHandle: 458868,
    windowTitle: 'TradingView - LUNR'
  }, {
    captureMode: 'window-copyfromscreen',
    captureTrusted: true,
    timestamp: 124,
    windowHandle: 458868,
    windowTitle: 'TradingView - LUNR'
  }, {
    captureMode: 'window-copyfromscreen',
    captureTrusted: true,
    timestamp: 125,
    windowHandle: 458868,
    windowTitle: 'TradingView - LUNR'
  }]);
  assert.strictEqual(persistedThreeTurnContinuation.exitCode, 0, 'persisted three-turn continuation scenario should exit successfully');
  assert(persistedThreeTurnContinuation.output.includes('EXECUTE_COUNT:3'), 'persisted three-turn continuation should execute each turn while continuity stays verified');
  assert(
    persistedThreeTurnContinuation.output.includes('SEEN_MESSAGES:["help me make a confident synthesis of ticker LUNR in tradingview","continue","keep going"]'),
    'persisted three-turn continuation should preserve minimal follow-up prompts while using recorded continuity'
  );

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

  const taskAwareDegradedContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Assess LUNR in TradingView',
    currentSubgoal: 'Inspect the active TradingView chart',
    continuationReady: false,
    degradedReason: 'Background/non-disruptive capture was unavailable; fell back to full-screen capture.',
    lastTurn: {
      verificationStatus: 'verified',
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false,
      nextRecommendedStep: 'Continue from the latest chart evidence.'
    }
  }, null, {
    taskSummary: 'Apply Volume Profile in TradingView',
    executionIntent: 'yes, lets apply the volume profile',
    userMessage: 'yes, lets apply the volume profile'
  });
  assert.strictEqual(taskAwareDegradedContinuation.exitCode, 0, 'task-aware degraded continuation scenario should exit successfully');
  assert(taskAwareDegradedContinuation.output.includes('EXECUTE_COUNT:0'), 'task-aware degraded continuation should not execute emitted actions');
  assert(/The last requested task was: Apply Volume Profile in TradingView/i.test(taskAwareDegradedContinuation.output), 'task-aware degraded continuation should reference the pending requested task');

  const staleRecoverableContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Produce a confident synthesis of ticker LUNR in TradingView',
    currentSubgoal: 'Inspect the active TradingView chart',
    continuationReady: false,
    degradedReason: 'Stored continuity is stale (4m) and should be re-observed before continuing.',
    freshnessState: 'stale-recoverable',
    freshnessAgeMs: 240000,
    freshnessBudgetMs: 90000,
    freshnessRecoverableBudgetMs: 900000,
    freshnessReason: 'Stored continuity is stale (4m) and should be re-observed before continuing.',
    requiresReobserve: true,
    lastTurn: {
      recordedAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
      verificationStatus: 'verified',
      executionStatus: 'succeeded',
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      targetWindowHandle: 458868,
      observationEvidence: {
        windowHandle: 458868
      },
      nextRecommendedStep: 'Continue from the latest chart evidence.'
    }
  }, null, null, { allowRecoveryCapture: true });
  assert.strictEqual(staleRecoverableContinuation.exitCode, 0, 'stale-recoverable continuation scenario should exit successfully');
  assert(staleRecoverableContinuation.output.includes('EXECUTE_COUNT:1'), 'stale-recoverable continuation should reobserve and then execute emitted actions');
  assert(/Continuity is stale but recoverable; recapturing the target window before continuing/i.test(staleRecoverableContinuation.output), 'stale-recoverable continuation should announce the recovery capture');
  assert(/Auto-captured target window 458868 for visual context/i.test(staleRecoverableContinuation.output), 'stale-recoverable continuation should recapture the target window before continuing');
  assert(/VISUAL_CONTEXTS:\[\{/i.test(staleRecoverableContinuation.output), 'stale-recoverable continuation should populate fresh visual context before sending the turn');

  const expiredContinuation = await runScenarioWithContinuity(['continue'], {
    activeGoal: 'Produce a confident synthesis of ticker LUNR in TradingView',
    currentSubgoal: 'Inspect the active TradingView chart',
    continuationReady: false,
    degradedReason: 'Stored continuity is expired (20m) and must be rebuilt from fresh evidence before continuing.',
    freshnessState: 'expired',
    freshnessAgeMs: 1200000,
    freshnessBudgetMs: 90000,
    freshnessRecoverableBudgetMs: 900000,
    freshnessReason: 'Stored continuity is expired (20m) and must be rebuilt from fresh evidence before continuing.',
    requiresReobserve: true,
    lastTurn: {
      recordedAt: new Date(Date.now() - (20 * 60 * 1000)).toISOString(),
      verificationStatus: 'verified',
      executionStatus: 'succeeded',
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      targetWindowHandle: 458868,
      nextRecommendedStep: 'Continue from the latest chart evidence.'
    }
  });
  assert.strictEqual(expiredContinuation.exitCode, 0, 'expired continuation scenario should exit successfully');
  assert(expiredContinuation.output.includes('EXECUTE_COUNT:0'), 'expired continuity should block emitted actions until fresh evidence is gathered');
  assert(/Stored continuity is expired/i.test(expiredContinuation.output), 'expired continuity should explain the expiry reason instead of continuing blindly');

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

  const cancelledPaperContinuation = await runScenarioWithContinuity(['continue'], PAPER_AWARE_CONTINUITY_FIXTURES.cancelledPaperAssistContinuation);
  assert.strictEqual(cancelledPaperContinuation.exitCode, 0, 'cancelled paper continuation scenario should exit successfully');
  assert(cancelledPaperContinuation.output.includes('EXECUTE_COUNT:0'), 'cancelled paper continuation should not execute emitted actions');
  assert(/Continuity is currently degraded: The last action batch was cancelled before completion/i.test(cancelledPaperContinuation.output), 'cancelled paper continuation should direct recovery instead of blind continuation');

  const acknowledgement = await runScenario(['thanks']);
  assert.strictEqual(acknowledgement.exitCode, 0, 'acknowledgement-style scenario should exit successfully');
  assert(acknowledgement.output.includes('EXECUTE_COUNT:0'), 'acknowledgement-style scenario should not execute emitted actions');
  assert(acknowledgement.output.includes('Parsed action plan withheld'), 'acknowledgement-style scenario should be withheld as acknowledgement-only text');

  const pendingTaskWithoutContinuity = await runScenarioWithContinuity(['continue'], null, null, {
    taskSummary: 'Open Pine Logs in TradingView',
    executionIntent: 'yes, open Pine Logs',
    userMessage: 'yes, open Pine Logs'
  });
  assert.strictEqual(pendingTaskWithoutContinuity.exitCode, 0, 'pending-task-only continuation scenario should exit successfully');
  assert(pendingTaskWithoutContinuity.output.includes('EXECUTE_COUNT:0'), 'pending-task-only continuation should not execute emitted actions');
  assert(/The last requested task was: Open Pine Logs in TradingView/i.test(pendingTaskWithoutContinuity.output), 'pending-task-only continuation should still guide recovery toward the pending task');

  const blockedPineTaskPersists = await runScenario([
    'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.'
  ]);
  assert.strictEqual(blockedPineTaskPersists.exitCode, 0, 'blocked Pine authoring scenario should exit successfully');
  assert(blockedPineTaskPersists.output.includes('EXECUTE_COUNT:0'), 'blocked Pine authoring scenario should not execute actions');
  assert(/Stored blocked TradingView Pine authoring task for bounded retry/i.test(blockedPineTaskPersists.output), 'blocked Pine authoring scenario should persist a bounded retry task');
  assert(/PENDING_REQUESTED_TASK:.*"taskKind":"tradingview-pine-authoring"/i.test(blockedPineTaskPersists.output), 'blocked Pine authoring scenario should persist the Pine task kind');
  assert(/PENDING_REQUESTED_TASK:.*"targetSymbol":"LUNR"/i.test(blockedPineTaskPersists.output), 'blocked Pine authoring scenario should persist the target symbol');

  const blockedPineContinuation = await runScenario([
    'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.',
    'continue'
  ]);
  assert.strictEqual(blockedPineContinuation.exitCode, 0, 'blocked Pine continuation scenario should exit successfully');
  assert(blockedPineContinuation.output.includes('EXECUTE_COUNT:1'), 'blocked Pine continuation should execute after replaying the saved retry intent');
  assert(
    blockedPineContinuation.output.includes('PREFLIGHT_USER_MESSAGES:["Retry the blocked TradingView Pine authoring task.'),
    'blocked Pine continuation should route through the saved bounded retry intent instead of raw continue text'
  );
  assert(
    blockedPineContinuation.output.includes('PENDING_REQUESTED_TASK:null'),
    'blocked Pine continuation should clear the saved pending task once actionable steps are emitted'
  );

  const blockedPineContinuationBeatsExpiredContinuity = await runScenarioWithContinuity([
    'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.',
    'continue'
  ], {
    activeGoal: 'Inspect the active TradingView chart',
    currentSubgoal: 'Continue from prior TradingView chart state',
    continuationReady: false,
    degradedReason: 'Stored continuity is expired (45m) and must be rebuilt from fresh evidence before continuing.',
    freshnessState: 'expired',
    freshnessAgeMs: 2700000,
    freshnessBudgetMs: 90000,
    freshnessRecoverableBudgetMs: 900000,
    freshnessReason: 'Stored continuity is expired (45m) and must be rebuilt from fresh evidence before continuing.',
    requiresReobserve: true,
    lastTurn: {
      recordedAt: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
      verificationStatus: 'verified',
      executionStatus: 'succeeded',
      captureMode: 'window-copyfromscreen',
      captureTrusted: true,
      targetWindowHandle: 458868,
      nextRecommendedStep: 'Continue from the latest chart evidence.'
    }
  });
  assert.strictEqual(blockedPineContinuationBeatsExpiredContinuity.exitCode, 0, 'blocked Pine continuation with expired continuity should exit successfully');
  assert(blockedPineContinuationBeatsExpiredContinuity.output.includes('EXECUTE_COUNT:1'), 'blocked Pine continuation should recover through the saved Pine task even when older continuity is expired');
  assert(
    !/Stored continuity is expired \(45m\) and must be rebuilt from fresh evidence before continuing/i.test(blockedPineContinuationBeatsExpiredContinuity.output),
    'blocked Pine continuation should not be re-blocked by unrelated expired continuity once a fresh bounded retry task is saved'
  );

  const failedPineContinuationRetry = await runScenarioWithContinuity([
    'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.',
    'continue',
    'continue'
  ], null, null, null, {
    failFirstPineExecution: true
  });
  assert.strictEqual(failedPineContinuationRetry.exitCode, 0, 'failed Pine retry continuation scenario should exit successfully');
  assert(failedPineContinuationRetry.output.includes('EXECUTE_COUNT:2'), 'failed Pine retry scenario should attempt the recovered Pine workflow again after the first execution failure');
  assert(/Stored failed TradingView Pine workflow for bounded retry/i.test(failedPineContinuationRetry.output), 'failed Pine execution should persist a bounded retry task instead of dead-ending continuity');
  assert(
    failedPineContinuationRetry.output.includes('PREFLIGHT_USER_MESSAGES:["Retry the blocked TradingView Pine authoring task.'),
    'failed Pine retry scenario should first execute the saved blocked-task intent'
  );
  assert(
    !/There is not enough verified continuity state to continue safely/i.test(failedPineContinuationRetry.output),
    'failed Pine retry scenario should not fall back to the continuity dead-end after the first Pine execution fails'
  );
  assert(
    failedPineContinuationRetry.output.includes('PENDING_REQUESTED_TASK:null'),
    'failed Pine retry scenario should clear the retry task once the follow-up execution succeeds'
  );

  console.log('PASS chat actionability');
}

main().catch((error) => {
  console.error('FAIL chat actionability');
  console.error(error.stack || error.message);
  process.exit(1);
});
