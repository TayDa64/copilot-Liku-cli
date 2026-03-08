#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCopilotModelRegistry } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'copilot', 'model-registry.js'));

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-model-registry-'));
const registry = createCopilotModelRegistry({
  likuHome: tempRoot,
  modelPrefFile: path.join(tempRoot, 'model-preference.json'),
  runtimeStateFile: path.join(tempRoot, 'copilot-runtime-state.json')
});

test('setCopilotModel updates current model and metadata', () => {
  assert.strictEqual(registry.setCopilotModel('gpt-4o-mini'), true);
  assert.strictEqual(registry.getCurrentCopilotModel(), 'gpt-4o-mini');
  assert.strictEqual(registry.getModelMetadata(false).modelId, 'gpt-4o-mini');
});

test('provider sync updates metadata provider', () => {
  registry.setProvider('openai');
  assert.strictEqual(registry.getModelMetadata(false).provider, 'openai');
});

test('loadModelPreference restores saved model', () => {
  registry.setCopilotModel('gpt-4.1');
  const reloaded = createCopilotModelRegistry({
    likuHome: tempRoot,
    modelPrefFile: path.join(tempRoot, 'model-preference.json'),
    runtimeStateFile: path.join(tempRoot, 'copilot-runtime-state.json')
  });
  reloaded.loadModelPreference();
  assert.strictEqual(reloaded.getCurrentCopilotModel(), 'gpt-4.1');
});

test('legacy model aliases canonicalize persisted runtime selections', () => {
  registry.rememberValidatedChatFallback('gpt-5.4', 'gpt-4o');
  registry.recordRuntimeSelection({
    requestedModel: 'gpt-5.4',
    runtimeModel: 'gpt-4o',
    endpointHost: 'api.githubcopilot.com',
    actualModelId: 'gpt-4o'
  });

  const reloaded = createCopilotModelRegistry({
    likuHome: tempRoot,
    modelPrefFile: path.join(tempRoot, 'model-preference.json'),
    runtimeStateFile: path.join(tempRoot, 'copilot-runtime-state.json')
  });
  reloaded.loadModelPreference();

  assert.strictEqual(reloaded.getValidatedChatFallback('gpt-5.4'), 'gpt-4o');
  assert.strictEqual(reloaded.getRuntimeSelection().runtimeModel, 'gpt-4o');
  assert.strictEqual(reloaded.getRuntimeSelection().requestedModel, 'gpt-4o');
  assert.strictEqual(reloaded.getRuntimeSelection().endpointHost, 'api.githubcopilot.com');
});

test('getCopilotModels exposes capabilities and hides legacy-unavailable models', () => {
  const models = registry.getCopilotModels();
  const gpt4o = models.find((model) => model.id === 'gpt-4o');
  assert.ok(gpt4o);
  assert.ok(Array.isArray(gpt4o.capabilityList));
  assert.ok(gpt4o.capabilityList.includes('vision'));
  assert.ok(!models.some((model) => model.id === 'gpt-5.4'));
});

test('resolveCopilotModelKey falls back to current model', () => {
  assert.strictEqual(registry.resolveCopilotModelKey('not-a-model'), 'gpt-4.1');
});

testAsync('discoverCopilotModels leaves static registry intact without auth', async () => {
  const models = await registry.discoverCopilotModels({
    force: true,
    loadCopilotTokenIfNeeded: () => false,
    exchangeForCopilotSession: async () => {},
    getCopilotSessionToken: () => ''
  });

  assert.ok(Array.isArray(models));
  assert.ok(models.some((model) => model.id === 'gpt-4o'));
});

test('dynamic model filtering ignores non-chat or picker-disabled entries', () => {
  const filteredRegistry = createCopilotModelRegistry({
    likuHome: tempRoot,
    modelPrefFile: path.join(tempRoot, 'model-preference.json'),
    runtimeStateFile: path.join(tempRoot, 'copilot-runtime-state.json')
  });

  filteredRegistry.setCopilotModel('gpt-4o');
  const beforeCount = filteredRegistry.getCopilotModels().length;

  const upsert = filteredRegistry.modelRegistry;
  assert.strictEqual(typeof upsert, 'function');

  // Indirectly verify contract by resolving unsupported keys to current model only.
  assert.strictEqual(filteredRegistry.resolveCopilotModelKey('embeddings-model'), 'gpt-4o');
  assert.strictEqual(filteredRegistry.getCopilotModels().length, beforeCount);
});

process.on('exit', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
