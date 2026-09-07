#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  createProviderRegistry
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'registry.js'));
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

test('optional providers stay hidden until configured', () => {
  const isolated = createProviderRegistry({});
  assert.deepStrictEqual(Object.keys(isolated.AI_PROVIDERS), ['copilot', 'openai', 'anthropic', 'ollama']);
  assert.strictEqual(isolated.setProvider('cerebras'), false);
  assert.strictEqual(isolated.setProvider('xai'), false);
});

test('env keys register Cerebras and xAI providers', () => {
  const configured = createProviderRegistry({
    CEREBRAS_API_KEY: 'cerebras-key',
    XAI_API_KEY: 'xai-key'
  });
  assert.ok(configured.AI_PROVIDERS.cerebras);
  assert.ok(configured.AI_PROVIDERS.xai);
  assert.strictEqual(configured.AI_PROVIDERS.cerebras.model, 'gpt-oss-120b');
  assert.strictEqual(configured.AI_PROVIDERS.xai.model, 'grok-4.6');
  assert.strictEqual(configured.setProvider('cerebras'), true);
  assert.strictEqual(configured.setProvider('xai'), true);
});

test('setApiKey activates optional providers for the session', () => {
  const isolated = createProviderRegistry({});
  assert.strictEqual(isolated.setApiKey('cerebras', 'session-cerebras'), true);
  assert.strictEqual(isolated.setApiKey('xai', 'session-xai'), true);
  assert.ok(isolated.AI_PROVIDERS.cerebras);
  assert.ok(isolated.AI_PROVIDERS.xai);
  assert.strictEqual(isolated.setProvider('cerebras'), true);
  assert.strictEqual(isolated.setProvider('xai'), true);
});

test('setApiKey rejects the managed copilotSession token (allowlist)', () => {
  const isolated = createProviderRegistry({ GH_TOKEN: 'gh' });
  assert.strictEqual(isolated.apiKeys.copilotSession, '');
  assert.strictEqual(isolated.setApiKey('copilotSession', 'stolen'), false);
  assert.strictEqual(isolated.apiKeys.copilotSession, '');
});

test('setApiKey rejects unknown / non-user provider names', () => {
  const isolated = createProviderRegistry({});
  assert.strictEqual(isolated.setApiKey('ollama', 'x'), false);
  assert.strictEqual(isolated.setApiKey('nonexistent', 'x'), false);
});

test('setProvider marks explicit provider selection', () => {
  const isolated = createProviderRegistry({ OPENAI_API_KEY: 'k' });
  assert.strictEqual(isolated.isProviderExplicit(), false);
  assert.strictEqual(isolated.setProvider('openai'), true);
  assert.strictEqual(isolated.isProviderExplicit(), true);
});
