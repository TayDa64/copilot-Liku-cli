#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createCommandHandler } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'commands.js'));
const { createSlashCommandHelpers } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'slash-command-helpers.js'));

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

const historyStore = {
  cleared: false,
  saved: false,
  clearConversationHistory() {
    this.cleared = true;
  },
  saveConversationHistory() {
    this.saved = true;
  }
};

let currentProvider = 'copilot';
let clearedVisual = false;
let resetBrowser = false;

const handler = createCommandHandler({
  aiProviders: { copilot: {}, openai: {}, anthropic: {}, ollama: {} },
  captureVisualContext: () => Promise.resolve({ type: 'system', message: 'captured' }),
  clearVisualContext: () => {
    clearedVisual = true;
  },
  exchangeForCopilotSession: () => Promise.resolve(),
  getCurrentCopilotModel: () => 'gpt-4o',
  getCurrentProvider: () => currentProvider,
  getStatus: () => ({
    provider: currentProvider,
    hasCopilotKey: true,
    hasOpenAIKey: false,
    hasAnthropicKey: false,
    historyLength: 7,
    visualContextCount: 2
  }),
  getVisualContextCount: () => 2,
  historyStore,
  isOAuthInProgress: () => false,
  loadCopilotTokenIfNeeded: () => true,
  logoutCopilot: () => {},
  modelRegistry: () => ({
    'gpt-4o': { name: 'GPT-4o', vision: true },
    'gpt-5.4': { name: 'GPT-5.4', vision: false }
  }),
  resetBrowserSessionState: () => {
    resetBrowser = true;
  },
  setApiKey: () => true,
  setCopilotModel: (model) => model === 'gpt-5.4',
  setProvider: (provider) => {
    if (!['copilot', 'openai', 'anthropic', 'ollama'].includes(provider)) {
      return false;
    }
    currentProvider = provider;
    return true;
  },
  slashCommandHelpers: createSlashCommandHelpers({
    modelRegistry: () => ({
      'gpt-4o': { id: 'gpt-4o' },
      'gpt-5.4': { id: 'gpt-5.4' }
    })
  }),
  startCopilotOAuth: () => Promise.resolve({ user_code: 'ABCD-EFGH' })
});

test('provider command reports current provider', () => {
  const result = handler.handleCommand('/provider');
  assert.strictEqual(result.type, 'info');
  assert.ok(result.message.includes('Current provider: copilot'));
});

test('provider command switches provider', () => {
  const result = handler.handleCommand('/provider openai');
  assert.strictEqual(result.type, 'system');
  assert.ok(result.message.includes('Switched to openai provider.'));
});

test('clear command resets history and visual state', () => {
  const result = handler.handleCommand('/clear');
  assert.strictEqual(result.type, 'system');
  assert.strictEqual(historyStore.cleared, true);
  assert.strictEqual(historyStore.saved, true);
  assert.strictEqual(clearedVisual, true);
  assert.strictEqual(resetBrowser, true);
});

test('model command uses normalized model keys', () => {
  const result = handler.handleCommand('/model gpt-5.4 - GPT-5.4');
  assert.strictEqual(result.type, 'system');
  assert.ok(result.message.includes('Switched to GPT-5.4'));
});

test('status command preserves status text shape', () => {
  const result = handler.handleCommand('/status');
  assert.strictEqual(result.type, 'info');
  assert.ok(result.message.includes('Provider: openai'));
  assert.ok(result.message.includes('History: 7 messages'));
  assert.ok(result.message.includes('Visual: 2 captures'));
});