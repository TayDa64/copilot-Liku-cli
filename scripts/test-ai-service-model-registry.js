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
  modelPrefFile: path.join(tempRoot, 'model-preference.json')
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
    modelPrefFile: path.join(tempRoot, 'model-preference.json')
  });
  reloaded.loadModelPreference();
  assert.strictEqual(reloaded.getCurrentCopilotModel(), 'gpt-4.1');
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

process.on('exit', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
