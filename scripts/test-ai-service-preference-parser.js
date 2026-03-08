#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  createPreferenceParser,
  extractJsonObjectFromText,
  sanitizePreferencePatch,
  validatePreferenceParserPayload
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'preference-parser.js'));

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

test('extractJsonObjectFromText reads fenced JSON', () => {
  const parsed = extractJsonObjectFromText('```json\n{"newRules":[{"type":"negative","forbiddenMethod":"click_coordinates"}]}\n```');
  assert.strictEqual(parsed.newRules[0].type, 'negative');
});

test('sanitizePreferencePatch normalizes array form', () => {
  const patch = sanitizePreferencePatch({
    newRules: [
      { type: 'negative', forbiddenMethod: 'click_coordinates', reason: 'Use UIA' },
      { type: 'action', intent: 'click_element', preferredMethod: 'click_element', matchPreference: 'exact_text' }
    ]
  });

  assert.strictEqual(patch.negativePolicies[0].forbiddenMethod, 'click_coordinates');
  assert.strictEqual(patch.actionPolicies[0].matchPreference, 'exact_text');
});

test('validatePreferenceParserPayload rejects incomplete action rule', () => {
  const error = validatePreferenceParserPayload({ newRules: [{ type: 'action', intent: 'click_element' }] });
  assert.ok(error.includes('preferredMethod'));
});

testAsync('configured parser returns usable patch', async () => {
  const parser = createPreferenceParser({
    apiKeys: { copilot: 'token', openai: '', anthropic: '' },
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    callCopilot: async () => JSON.stringify({
      newRules: [
        {
          type: 'negative',
          forbiddenMethod: 'click_coordinates',
          reason: 'Do not use coordinates in this app'
        }
      ]
    }),
    callOpenAI: async () => '',
    callAnthropic: async () => '',
    callOllama: async () => ''
  });

  const result = await parser.parsePreferenceCorrection('Do not use coordinate clicks here', { processName: 'Code.exe' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.patch.negativePolicies[0].forbiddenMethod, 'click_coordinates');
});
