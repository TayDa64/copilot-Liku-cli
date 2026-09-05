#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildProviderDiagnostics
} = require(path.join(__dirname, '..', 'src', 'cli', 'commands', 'doctor.js'));

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

test('doctor provider diagnostics keep optional providers hidden by default', () => {
  const providers = buildProviderDiagnostics({});
  assert.deepStrictEqual(providers.map((entry) => entry.provider), ['copilot', 'openai', 'anthropic', 'ollama']);
});

test('doctor provider diagnostics show optional configured keys', () => {
  const providers = buildProviderDiagnostics({
    CEREBRAS_API_KEY: 'cerebras-key',
    XAI_API_KEY: 'xai-key'
  });
  const cerebras = providers.find((entry) => entry.provider === 'cerebras');
  const xai = providers.find((entry) => entry.provider === 'xai');
  assert.strictEqual(cerebras.configured, 'set');
  assert.strictEqual(xai.configured, 'set');
});

test('doctor provider diagnostics show enabled optional providers as unset without keys', () => {
  const providers = buildProviderDiagnostics({
    LIKU_ENABLE_CEREBRAS: '1',
    LIKU_ENABLE_XAI: 'true'
  });
  const cerebras = providers.find((entry) => entry.provider === 'cerebras');
  const xai = providers.find((entry) => entry.provider === 'xai');
  assert.strictEqual(cerebras.configured, 'unset');
  assert.strictEqual(xai.configured, 'unset');
});
