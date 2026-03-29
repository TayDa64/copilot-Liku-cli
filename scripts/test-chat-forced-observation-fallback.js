#!/usr/bin/env node

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

function buildHarnessScript(chatModulePath) {
  return `
const Module = require('module');
const originalLoad = Module._load;

let sendCount = 0;
let executeCount = 0;
let lastActionTypes = [];
let latestVisual = {
  captureMode: 'screen-copyfromscreen',
  captureTrusted: false,
  windowTitle: 'TradingView - LUNR',
  scope: 'screen',
  dataURL: 'data:image/png;base64,AAAA'
};

const initialActionResponse = JSON.stringify({
  thought: 'Focus TradingView and capture the chart',
  actions: [
    { type: 'focus_window', windowHandle: 264274 },
    { type: 'wait', ms: 1000 },
    { type: 'screenshot' }
  ],
  verification: 'TradingView should be focused and captured.'
}, null, 2);

const screenshotOnlyResponse = JSON.stringify({
  thought: 'Use the screenshot to continue analysis',
  actions: [
    { type: 'screenshot' }
  ],
  verification: 'A screenshot will refresh the visual context.'
}, null, 2);

const forcedActionResponse = JSON.stringify({
  thought: 'Try another screenshot anyway',
  actions: [
    { type: 'screenshot' }
  ],
  verification: 'A screenshot will refresh the visual context.'
}, null, 2);

const aiStub = {
  sendMessage: async (line) => {
    sendCount++;
    if (sendCount === 1) {
      return { success: true, provider: 'stub', model: 'stub-model', message: initialActionResponse, requestedModel: 'stub-model' };
    }
    if (String(line || '').includes('You already have fresh visual context')) {
      return { success: true, provider: 'stub', model: 'stub-model', message: forcedActionResponse, requestedModel: 'stub-model' };
    }
    return { success: true, provider: 'stub', model: 'stub-model', message: screenshotOnlyResponse, requestedModel: 'stub-model' };
  },
  handleCommand: async () => ({ type: 'info', message: 'stub command' }),
  parseActions: (message) => {
    try { return JSON.parse(String(message || 'null')); } catch { return null; }
  },
  saveSessionNote: () => null,
  setUIWatcher: () => {},
  getUIWatcher: () => ({ isPolling: false, start() {}, stop() {} }),
  preflightActions: (value) => value,
  analyzeActionSafety: () => ({ requiresConfirmation: false }),
  executeActions: async (actionData, onProgress, onCapture) => {
    executeCount++;
    lastActionTypes = Array.isArray(actionData?.actions) ? actionData.actions.map((action) => action?.type) : [];
    if (typeof onCapture === 'function' && lastActionTypes.includes('screenshot')) {
      await onCapture({ scope: 'window', windowHandle: 264274 });
    }
    return {
      success: true,
      results: lastActionTypes.map((type) => ({ success: true, action: type, message: 'ok' })),
      screenshotCaptured: true,
      focusVerification: { applicable: true, verified: true, expectedWindowHandle: 264274 },
      postVerification: { verified: true }
    };
  },
  getLatestVisualContext: () => latestVisual,
  addVisualContext: (frame) => { latestVisual = { ...latestVisual, ...frame }; return latestVisual; },
  parsePreferenceCorrection: async () => ({ success: false, error: 'not needed' })
};

const watcherStub = {
  getUIWatcher: () => ({ isPolling: false, start() {}, stop() {} })
};

const systemAutomationStub = {
  getForegroundWindowInfo: async () => ({ success: true, processName: 'tradingview', title: 'TradingView - LUNR' })
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
  clearPendingRequestedTask: () => null,
  getChatContinuityState: () => ({
    activeGoal: 'Provide TradingView analysis',
    currentSubgoal: 'Analyze the latest TradingView chart capture',
    continuationReady: false,
    degradedReason: 'Visual evidence fell back to full-screen capture instead of a trusted target-window capture.',
    lastTurn: {
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false,
      windowTitle: 'TradingView - LUNR'
    }
  }),
  getPendingRequestedTask: () => null,
  recordChatContinuityTurn: () => null,
  setPendingRequestedTask: () => null
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
  console.log('SEND_COUNT:' + sendCount);
  console.log('EXECUTE_COUNT:' + executeCount);
  console.log('LAST_ACTION_TYPES:' + JSON.stringify(lastActionTypes));
  process.exit(result && result.success === false ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});`;
}

async function runScenario(inputs) {
  const repoRoot = path.join(__dirname, '..');
  const chatModulePath = path.join(repoRoot, 'src', 'cli', 'commands', 'chat.js').replace(/\\/g, '\\\\');
  const child = spawn(process.execPath, ['-e', buildHarnessScript(chatModulePath)], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env
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
  const scenario = await runScenario(['provide more detailed chart analysis and use the drawing tools to visualize your assessment.']);
  if (!scenario.output.includes('bounded-observation-fallback')) {
    console.error('HARNESS OUTPUT:\n' + scenario.output);
  }
  assert.strictEqual(scenario.exitCode, 0, 'forced observation fallback scenario should exit successfully');
  assert(scenario.output.includes('EXECUTE_COUNT:1'), 'only the initial action batch should execute before the bounded fallback answer');
  assert(scenario.output.includes('using a bounded fallback answer instead of continuing the screenshot loop'), 'scenario should warn that it is using the bounded fallback answer');
  assert(scenario.output.includes('bounded-observation-fallback'), 'scenario should print the bounded fallback assistant block');
  assert(scenario.output.includes('Verified result:'), 'bounded fallback should emit proof-carrying verified-result section');
  assert(scenario.output.includes('Bounded inference:'), 'bounded fallback should emit proof-carrying bounded-inference section');
  assert(scenario.output.includes('Degraded evidence:'), 'bounded fallback should emit proof-carrying degraded-evidence section');
  assert(scenario.output.includes('Unverified next step:'), 'bounded fallback should emit proof-carrying unverified-next-step section');
  assert(scenario.output.includes('exact indicator values, exact drawing placement, hidden dialog state, or unseen controls'), 'bounded fallback should explain the unsafe claims it is avoiding');
  assert(!scenario.output.includes('stopping to avoid screenshot-only loops'), 'scenario should no longer dead-end after the forced answer still returns actions');

  console.log('PASS chat forced observation fallback');
}

main().catch((error) => {
  console.error('FAIL chat forced observation fallback');
  console.error(error.stack || error.message);
  process.exit(1);
});