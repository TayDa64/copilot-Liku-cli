#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { parseCopilotChatResponse } = require(path.join(
  __dirname,
  '..',
  'src',
  'main',
  'ai-service',
  'providers',
  'copilot',
  'chat-response.js'
));

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

test('parses streamed text deltas into a single message', () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const parsed = parseCopilotChatResponse(body, { 'content-type': 'text/event-stream' });
  assert.strictEqual(parsed.content, 'Hello world');
  assert.deepStrictEqual(parsed.toolCalls, []);
});

test('parses streamed tool call chunks', () => {
  const body = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"press_key","arguments":"{\\"key"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":\\"ctrl+s\\"}"}}]}}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const parsed = parseCopilotChatResponse(body, { 'content-type': 'text/event-stream' });
  assert.strictEqual(parsed.toolCalls.length, 1);
  assert.strictEqual(parsed.toolCalls[0].function.name, 'press_key');
  assert.strictEqual(parsed.toolCalls[0].function.arguments, '{"key":"ctrl+s"}');
});

test('parses standard JSON fallback payloads', () => {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          content: 'ok',
          tool_calls: []
        }
      }
    ]
  });

  const parsed = parseCopilotChatResponse(body, { 'content-type': 'application/json' });
  assert.strictEqual(parsed.content, 'ok');
});