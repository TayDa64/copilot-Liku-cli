#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  detectTruncation,
  shouldAutoContinueResponse
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'response-heuristics.js'));

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

test('closed action block is not treated as truncated', () => {
  const response = [
    'To complete this request, I will execute the following steps:',
    '```json',
    '{',
    '  "thought": "Open Edge and search Google.",',
    '  "actions": [',
    '    { "type": "run_command", "command": "start msedge", "shell": "powershell" },',
    '    { "type": "wait", "ms": 3000 },',
    '    { "type": "key", "key": "ctrl+l" },',
    '    { "type": "type", "text": "https://www.google.com" },',
    '    { "type": "key", "key": "enter" }',
    '  ],',
    '  "verification": "Edge should open and navigate to Google."',
    '}',
    '```'
  ].join('\n');

  assert.strictEqual(detectTruncation(response), false);
  assert.strictEqual(shouldAutoContinueResponse(response, true), false);
});

test('unfinished json block is treated as truncated', () => {
  const response = '```json\n{\n  "thought": "Launching browser",\n  "actions": [';
  assert.strictEqual(detectTruncation(response), true);
  assert.strictEqual(shouldAutoContinueResponse(response, false), true);
});