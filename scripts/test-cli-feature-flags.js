#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  DEFAULT_APPROVAL_MODE,
  normalizeApprovalMode,
  parseBooleanEnvFlag,
  readCliFeatureFlags,
} = require(path.join(__dirname, '..', 'src', 'cli', 'feature-flags.js'));

let pass = 0;

function test(name, fn) {
  fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

test('parseBooleanEnvFlag recognizes enabled and disabled values', () => {
  assert.strictEqual(parseBooleanEnvFlag('1', false), true);
  assert.strictEqual(parseBooleanEnvFlag('true', false), true);
  assert.strictEqual(parseBooleanEnvFlag('enabled', false), true);
  assert.strictEqual(parseBooleanEnvFlag('0', true), false);
  assert.strictEqual(parseBooleanEnvFlag('false', true), false);
  assert.strictEqual(parseBooleanEnvFlag('disabled', true), false);
});

test('parseBooleanEnvFlag falls back to default for unrecognized values', () => {
  assert.strictEqual(parseBooleanEnvFlag('sometimes', true), true);
  assert.strictEqual(parseBooleanEnvFlag('sometimes', false), false);
  assert.strictEqual(parseBooleanEnvFlag(undefined, true), true);
});

test('normalizeApprovalMode preserves known modes and aliases', () => {
  assert.strictEqual(normalizeApprovalMode('prompt', 'never'), 'prompt');
  assert.strictEqual(normalizeApprovalMode('manual', 'never'), 'prompt');
  assert.strictEqual(normalizeApprovalMode('always', DEFAULT_APPROVAL_MODE), 'auto');
  assert.strictEqual(normalizeApprovalMode('off', DEFAULT_APPROVAL_MODE), 'never');
  assert.strictEqual(normalizeApprovalMode('mystery', DEFAULT_APPROVAL_MODE), DEFAULT_APPROVAL_MODE);
});

test('readCliFeatureFlags returns safe defaults', () => {
  const flags = readCliFeatureFlags({});
  assert.deepStrictEqual(flags, {
    enableGitHub: false,
    enableGitHubWrites: false,
    enableAgents: true,
    enableDynamicTools: true,
    approvalMode: 'prompt',
    dryRunDefault: false,
  });
});

test('readCliFeatureFlags honors explicit environment overrides', () => {
  const flags = readCliFeatureFlags({
    LIKU_ENABLE_GITHUB: '1',
    LIKU_ENABLE_GITHUB_WRITES: 'yes',
    LIKU_ENABLE_AGENTS: '0',
    LIKU_ENABLE_DYNAMIC_TOOLS: 'false',
    LIKU_APPROVAL_MODE: 'always',
    LIKU_DRY_RUN_DEFAULT: 'yes',
  });

  assert.deepStrictEqual(flags, {
    enableGitHub: true,
    enableGitHubWrites: true,
    enableAgents: false,
    enableDynamicTools: false,
    approvalMode: 'auto',
    dryRunDefault: true,
  });
});

console.log(`PASS cli feature flags (${pass} assertions)`);
