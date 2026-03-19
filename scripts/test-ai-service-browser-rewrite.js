#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

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

test('explicit Edge request rewrites Simple Browser flow to browser address bar flow', () => {
  const actions = [
    { type: 'key', key: 'ctrl+shift+p', reason: 'Open Command Palette' },
    { type: 'type', text: 'Simple Browser: Show', reason: 'Open VS Code integrated Simple Browser' },
    { type: 'key', key: 'enter', reason: 'Run Simple Browser: Show' },
    { type: 'type', text: 'https://www.apple.com', reason: 'Enter URL' },
    { type: 'key', key: 'enter', reason: 'Navigate' }
  ];

  const rewritten = aiService.rewriteActionsForReliability(actions, {
    userMessage: 'Open https://www.apple.com in Edge without using search or intermediate pages.'
  });

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[0].processName, 'msedge');
  assert(rewritten.some((action) => action.type === 'type' && action.text === 'https://www.apple.com'), 'URL remains intact');
  assert(!rewritten.some((action) => action.type === 'type' && /simple browser\s*:\s*show/i.test(String(action.text || ''))), 'Simple Browser flow removed');
});
