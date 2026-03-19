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
let currentCopilotModel = 'gpt-4o';
let clearedVisual = false;
let resetBrowser = false;

const handler = createCommandHandler({
  aiProviders: { copilot: {}, openai: {}, anthropic: {}, ollama: {} },
  captureVisualContext: () => Promise.resolve({ type: 'system', message: 'captured' }),
  clearVisualContext: () => {
    clearedVisual = true;
  },
  exchangeForCopilotSession: () => Promise.resolve(),
  getCopilotModels: () => ([
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      categoryLabel: 'Agentic Vision',
      capabilityList: ['tools', 'vision'],
      premiumMultiplier: 1,
      recommendationTags: ['budget', 'default'],
      current: true,
      selectable: true
    },
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      categoryLabel: 'Standard Chat',
      capabilityList: ['chat'],
      premiumMultiplier: 1,
      recommendationTags: [],
      current: false,
      selectable: true
    },
    {
      id: 'gpt-5.2',
      name: 'GPT-5.2',
      categoryLabel: 'Agentic Vision',
      capabilityList: ['tools', 'vision'],
      premiumMultiplier: 1,
      recommendationTags: ['latest-gpt'],
      current: false,
      selectable: true
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      categoryLabel: 'Agentic Vision',
      capabilityList: ['tools', 'vision'],
      premiumMultiplier: 1,
      recommendationTags: ['budget'],
      current: false,
      selectable: true
    }
  ]),
  getCurrentCopilotModel: () => currentCopilotModel,
  getCurrentProvider: () => currentProvider,
  getStatus: () => ({
    provider: currentProvider,
    configuredModel: 'gpt-4o',
    configuredModelName: 'GPT-4o',
    requestedModel: 'gpt-5.4',
    runtimeModel: 'gpt-4o',
    runtimeModelName: 'GPT-4o',
    runtimeEndpointHost: 'api.githubcopilot.com',
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
    'gpt-4.1': { name: 'GPT-4.1', vision: false },
    'gpt-5.2': { name: 'GPT-5.2', vision: true },
    'gpt-4o-mini': { name: 'GPT-4o Mini', vision: true }
  }),
  resetBrowserSessionState: () => {
    resetBrowser = true;
  },
  setApiKey: () => true,
  setCopilotModel: (model) => {
    if (!['gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-5.2'].includes(model)) {
      return false;
    }
    currentCopilotModel = model;
    return true;
  },
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
      'gpt-4.1': { id: 'gpt-4.1' },
      'gpt-5.2': { id: 'gpt-5.2' },
      'gpt-4o-mini': { id: 'gpt-4o-mini' }
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
  const result = handler.handleCommand('/model gpt-4.1 - GPT-4.1');
  assert.strictEqual(result.type, 'system');
  assert.ok(result.message.includes('Switched to GPT-4.1'));
});

test('model command supports budget alias', () => {
  const result = handler.handleCommand('/model cheap');
  assert.strictEqual(result.type, 'system');
  assert.ok(result.message.includes('via cheap alias'));
  assert.strictEqual(currentCopilotModel, 'gpt-4o');
});

test('model command supports latest-gpt alias', () => {
  const result = handler.handleCommand('/model latest-gpt');
  assert.strictEqual(result.type, 'system');
  assert.ok(result.message.includes('GPT-5.2'));
  assert.ok(result.message.includes('via latest-gpt alias'));
  assert.strictEqual(currentCopilotModel, 'gpt-5.2');
});

test('model inventory includes multiplier and shortcuts', () => {
  const result = handler.handleCommand('/model');
  assert.strictEqual(result.type, 'info');
  assert.ok(result.message.includes('[1x]'));
  assert.ok(result.message.includes('Shortcuts: /model cheap, /model latest-gpt'));
});

test('status command preserves status text shape', () => {
  const result = handler.handleCommand('/status');
  assert.strictEqual(result.type, 'info');
  assert.ok(result.message.includes('Provider: openai'));
  assert.ok(result.message.includes('Configured model: GPT-4o (gpt-4o)'));
  assert.ok(result.message.includes('Requested model: gpt-5.4'));
  assert.ok(result.message.includes('Runtime model: GPT-4o (gpt-4o)'));
  assert.ok(result.message.includes('Runtime endpoint: api.githubcopilot.com'));
  assert.ok(result.message.includes('History: 7 messages'));
  assert.ok(result.message.includes('Visual: 2 captures'));
});