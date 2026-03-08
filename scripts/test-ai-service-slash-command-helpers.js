#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  createSlashCommandHelpers,
  tokenize
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'slash-command-helpers.js'));

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

test('tokenize preserves quoted segments', () => {
  const parts = tokenize('/teach "do not click coordinates" app.exe');
  assert.deepStrictEqual(parts, ['/teach', 'do not click coordinates', 'app.exe']);
});

test('normalizeModelKey resolves display labels and ids', () => {
  const helpers = createSlashCommandHelpers({
    modelRegistry: () => ({
      'claude-sonnet-4.5': { id: 'claude-sonnet-4.5-20250929' },
      'gpt-4o': { id: 'gpt-4o' }
    })
  });

  assert.strictEqual(helpers.normalizeModelKey('claude-sonnet-4.5 - Claude Sonnet 4.5'), 'claude-sonnet-4.5');
  assert.strictEqual(helpers.normalizeModelKey('claude-sonnet-4.5-20250929'), 'claude-sonnet-4.5');
  assert.strictEqual(helpers.normalizeModelKey('→ gpt-4o'), 'gpt-4o');
});
