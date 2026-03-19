#!/usr/bin/env node

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const chatModulePath = path.join(repoRoot, 'src', 'cli', 'commands', 'chat.js').replace(/\\/g, '\\\\');

  const inlineScript = `
const Module = require('module');
const originalLoad = Module._load;

const aiStub = {
  sendMessage: async () => ({ success: true, provider: 'stub', model: 'stub-model', message: 'stub response', requestedModel: 'stub-model' }),
  handleCommand: async (line) => {
    if (line === '/status') {
      return { type: 'info', message: 'Provider: stub\\nCopilot: Authenticated' };
    }
    return { type: 'info', message: 'stub command' };
  },
  parseActions: () => null,
  saveSessionNote: () => null,
  setUIWatcher: () => {},
  preflightActions: (value) => value,
  analyzeActionSafety: () => ({ requiresConfirmation: false })
};

const watcherStub = {
  getUIWatcher: () => ({ isPolling: false, start() {}, stop() {} })
};

const systemAutomationStub = {
  getForegroundWindowInfo: async () => ({ success: true, processName: 'Code', title: 'VS Code' })
};

const preferencesStub = {
  resolveTargetProcessNameFromActions: () => null,
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
  const result = await chat.run([], { execute: 'false', quiet: true });
  process.exit(result && result.success === false ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});`;

  const child = spawn(process.execPath, ['-e', inlineScript], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });

  child.stdin.write('/status\n');
  child.stdin.write('exit\n');
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('close', resolve));

  assert.strictEqual(exitCode, 0, 'chat exits successfully in non-interactive mode');
  assert(output.includes('Liku Chat'), 'chat banner is shown in non-interactive mode');
  assert(output.includes('Provider:'), 'status output is shown in non-interactive mode');
  assert(output.includes('Copilot:'), 'authentication status is shown in non-interactive mode');

  console.log('PASS chat noninteractive mode');
}

main().catch((error) => {
  console.error('FAIL chat noninteractive mode');
  console.error(error.stack || error.message);
  process.exit(1);
});
