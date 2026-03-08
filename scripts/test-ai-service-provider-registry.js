#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { createProviderRegistry } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'registry.js'));

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

const registry = createProviderRegistry({
  GH_TOKEN: 'gh-token',
  OPENAI_API_KEY: 'openai-key',
  ANTHROPIC_API_KEY: 'anthropic-key'
});

test('provider registry exposes default provider', () => {
  assert.strictEqual(registry.getCurrentProvider(), 'copilot');
});

test('setProvider accepts known providers only', () => {
  assert.strictEqual(registry.setProvider('openai'), true);
  assert.strictEqual(registry.getCurrentProvider(), 'openai');
  assert.strictEqual(registry.setProvider('unknown'), false);
  assert.strictEqual(registry.getCurrentProvider(), 'openai');
});

test('setApiKey mutates shared api key store', () => {
  assert.strictEqual(registry.apiKeys.openai, 'openai-key');
  assert.strictEqual(registry.setApiKey('openai', 'new-key'), true);
  assert.strictEqual(registry.apiKeys.openai, 'new-key');
  assert.strictEqual(registry.setApiKey('missing', 'x'), false);
});
