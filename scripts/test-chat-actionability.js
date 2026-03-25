#!/usr/bin/env node

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

function buildHarnessScript(chatModulePath) {
  return `
const Module = require('module');
const originalLoad = Module._load;

let executeCount = 0;
let seenMessages = [];

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

Module._load = function(request, parent, isMain) {
  if (request === '../../main/ai-service') return aiStub;
  if (request === '../../main/ui-watcher') return watcherStub;
  if (request === '../../main/system-automation') return systemAutomationStub;
  if (request === '../../main/preferences') return preferencesStub;
  return originalLoad.apply(this, arguments);
};

(async () => {
  const chat = require('${chatModulePath}');
  const result = await chat.run([], { execute: 'auto', quiet: true });
  console.log('EXECUTE_COUNT:' + executeCount);
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
    env: process.env
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