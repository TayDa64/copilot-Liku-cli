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
    aiProviders: { copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o' } },
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
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot', 'openai', 'anthropic', 'ollama'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, false);
  assert.strictEqual(result.response, 'openai');
  assert.strictEqual(result.usedProvider, 'openai');
  assert.deepStrictEqual(calls, ['copilot', 'openai']);
});

test('visual request reroutes unsupported chat model to agentic vision default', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4.1' } },
    apiKeys: { copilot: 'token', openai: '', anthropic: '' },
    callAnthropic: async () => '',
    callCopilot: async (_messages, effectiveModel) => effectiveModel,
    callOllama: async () => '',
    callOpenAI: async () => '',
    getCurrentCopilotModel: () => 'gpt-4.1',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({
      'gpt-4.1': { id: 'gpt-4.1', vision: false, capabilities: { chat: true, tools: false, vision: false } },
      'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } }
    }),
    providerFallbackOrder: ['copilot'],
    resolveCopilotModelKey: (value) => value || 'gpt-4.1'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: [] }], 'gpt-4.1', { includeVisualContext: true });
  assert.strictEqual(result.effectiveModel, 'gpt-4o');
  assert.strictEqual(result.response, 'gpt-4o');
  assert.ok(result.providerMetadata.routing.message.includes('visual context'));
});

test('callCurrentProvider dispatches using current provider', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o' } },
    apiKeys: { copilot: '', openai: 'openai-key', anthropic: '' },
    callAnthropic: async () => '',
    callCopilot: async () => '',
    callOllama: async () => '',
    callOpenAI: async () => 'openai-current',
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'openai',
    loadCopilotToken: () => false,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['openai'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  const result = await orchestrator.callCurrentProvider([{ role: 'user', content: 'hi' }], 'gpt-4o');
  assert.strictEqual(result, 'openai-current');
});

test('exhausted fallback preserves the selected provider error', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o' } },
    apiKeys: { copilot: 'token', openai: '', anthropic: '' },
    callAnthropic: async () => {
      throw new Error('anthropic down');
    },
    callCopilot: async () => {
      throw new Error('Session exchange failed (404)');
    },
    callOllama: async () => {
      throw new Error('Ollama not running');
    },
    callOpenAI: async () => {
      throw new Error('OpenAI API key not set.');
    },
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot', 'openai', 'anthropic', 'ollama'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  await assert.rejects(
    () => orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, false),
    /Session exchange failed \(404\)/
  );
});

test('structured copilot responses preserve actual runtime model metadata', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o' } },
    apiKeys: { copilot: 'token', openai: '', anthropic: '' },
    callAnthropic: async () => '',
    callCopilot: async () => ({
      content: 'ok',
      effectiveModel: 'gpt-4o',
      requestedModel: 'gpt-5.4',
      endpointHost: 'api.githubcopilot.com',
      actualModelId: 'gpt-4o'
    }),
    callOllama: async () => '',
    callOpenAI: async () => '',
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({
      'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } }
    }),
    providerFallbackOrder: ['copilot'],
    resolveCopilotModelKey: (_value) => 'gpt-4o'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], 'gpt-5.4', false);
  assert.strictEqual(result.response, 'ok');
  assert.strictEqual(result.effectiveModel, 'gpt-4o');
  assert.strictEqual(result.requestedModel, 'gpt-5.4');
  assert.strictEqual(result.providerMetadata.endpointHost, 'api.githubcopilot.com');
});

test('callProvider rejects unknown providers', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o' } },
    apiKeys: { copilot: '', openai: '', anthropic: '', cerebras: '', xai: '' },
    callAnthropic: async () => '',
    callCerebras: async () => '',
    callCopilot: async () => '',
    callOllama: async () => '',
    callOpenAI: async () => '',
    callXai: async () => '',
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => false,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  await assert.rejects(
    () => orchestrator.callProvider('spacex', [{ role: 'user', content: 'hi' }], 'gpt-4o'),
    /Unknown provider: spacex/
  );
});

test('missing Cerebras key fails closed before network dispatch', async () => {
  let dispatched = false;
  const orchestrator = createProviderOrchestrator({
    aiProviders: { cerebras: { model: 'gpt-oss-120b' } },
    apiKeys: { copilot: '', openai: '', anthropic: '', cerebras: '', xai: '' },
    callAnthropic: async () => '',
    callCerebras: async () => {
      dispatched = true;
      return '';
    },
    callCopilot: async () => '',
    callOllama: async () => '',
    callOpenAI: async () => '',
    callXai: async () => '',
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'cerebras',
    loadCopilotToken: () => false,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['cerebras'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  await assert.rejects(
    () => orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, false),
    /Cerebras API key not set/
  );
  assert.strictEqual(dispatched, false);
});

test('OpenAI-compatible provider results normalize usage and latency metadata', async () => {
  const orchestrator = createProviderOrchestrator({
    aiProviders: { xai: { model: 'grok-4.6' } },
    apiKeys: { copilot: '', openai: '', anthropic: '', cerebras: '', xai: 'xai-key' },
    callAnthropic: async () => '',
    callCerebras: async () => '',
    callCopilot: async () => '',
    callOllama: async () => '',
    callOpenAI: async () => '',
    callXai: async () => ({
      content: 'xai ok',
      effectiveModel: 'grok-4.6',
      requestedModel: 'grok-4.6',
      endpointHost: 'api.x.ai',
      actualModelId: 'grok-4.6',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      latencyMs: 42
    }),
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'xai',
    loadCopilotToken: () => false,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['xai'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, false);
  assert.strictEqual(result.response, 'xai ok');
  assert.strictEqual(result.effectiveModel, 'grok-4.6');
  assert.strictEqual(result.requestedModel, 'grok-4.6');
  assert.strictEqual(result.providerMetadata.endpointHost, 'api.x.ai');
  assert.deepStrictEqual(result.providerMetadata.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.strictEqual(result.providerMetadata.latencyMs, 42);
});

test('copilot remains first choice when current provider is copilot', async () => {
  const calls = [];
  const orchestrator = createProviderOrchestrator({
    aiProviders: {
      copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o' },
      cerebras: { model: 'gpt-oss-120b' },
      xai: { model: 'grok-4.6' }
    },
    apiKeys: { copilot: 'token', openai: 'openai-key', anthropic: 'anthropic-key', cerebras: 'cerebras-key', xai: 'xai-key' },
    callAnthropic: async () => {
      calls.push('anthropic');
      throw new Error('anthropic should not be called');
    },
    callCerebras: async () => {
      calls.push('cerebras');
      throw new Error('cerebras should not be called');
    },
    callCopilot: async () => {
      calls.push('copilot');
      return 'copilot ok';
    },
    callOllama: async () => {
      calls.push('ollama');
      throw new Error('ollama should not be called');
    },
    callOpenAI: async () => {
      calls.push('openai');
      throw new Error('openai should not be called');
    },
    callXai: async () => {
      calls.push('xai');
      throw new Error('xai should not be called');
    },
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot', 'openai', 'anthropic', 'ollama', 'cerebras', 'xai'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o'
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, false);
  assert.strictEqual(result.response, 'copilot ok');
  assert.strictEqual(result.usedProvider, 'copilot');
  assert.deepStrictEqual(calls, ['copilot']);
});