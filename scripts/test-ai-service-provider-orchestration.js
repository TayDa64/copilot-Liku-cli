#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createProviderOrchestrator } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'orchestration.js'));

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

test('fallback advances from copilot to openai when copilot fails', async () => {
  const calls = [];
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o' } },
    apiKeys: { copilot: 'token', openai: 'openai-key', anthropic: '' },
    callAnthropic: async () => 'anthropic',
    callCopilot: async () => {
      calls.push('copilot');
      throw new Error('copilot down');
    },
    callOllama: async () => {
      calls.push('ollama');
      return 'ollama';
    },
    callOpenAI: async () => {
      calls.push('openai');
      return 'openai';
    },
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true } }),
    providerFallbackOrder: ['copilot', 'openai', 'anthropic', 'ollama'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, false);
  assert.strictEqual(result.response, 'openai');
  assert.strictEqual(result.usedProvider, 'openai');
  assert.deepStrictEqual(calls, ['copilot', 'openai']);
});

test('visual request upgrades non-vision copilot model', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o' } },
    apiKeys: { copilot: 'token', openai: '', anthropic: '' },
    callAnthropic: async () => '',
    callCopilot: async (_messages, effectiveModel) => effectiveModel,
    callOllama: async () => '',
    callOpenAI: async () => '',
    getCurrentCopilotModel: () => 'gpt-5.4',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({
      'gpt-5.4': { id: 'gpt-5.4', vision: false },
      'gpt-4o': { id: 'gpt-4o', vision: true }
    }),
    providerFallbackOrder: ['copilot'],
    resolveCopilotModelKey: (value) => value || 'gpt-5.4'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: [] }], 'gpt-5.4', true);
  assert.strictEqual(result.effectiveModel, 'gpt-4o');
  assert.strictEqual(result.response, 'gpt-4o');
});

test('callCurrentProvider dispatches using current provider', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o' } },
    apiKeys: { copilot: '', openai: 'openai-key', anthropic: '' },
    callAnthropic: async () => '',
    callCopilot: async () => '',
    callOllama: async () => '',
    callOpenAI: async () => 'openai-current',
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'openai',
    loadCopilotToken: () => false,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true } }),
    providerFallbackOrder: ['openai'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  const result = await orchestrator.callCurrentProvider([{ role: 'user', content: 'hi' }], 'gpt-4o');
  assert.strictEqual(result, 'openai-current');
});