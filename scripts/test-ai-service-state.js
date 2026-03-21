#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getBrowserSessionState, resetBrowserSessionState, updateBrowserSessionState } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'browser-session-state.js'));
const { createConversationHistoryStore } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'conversation-history.js'));

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

test('browser session state updates and resets', () => {
  updateBrowserSessionState({
    url: 'https://example.com',
    goalStatus: 'achieved',
    attemptedUrls: ['https://example.com', 'https://example.org'],
    navigationAttemptCount: 2,
    recoveryMode: 'search',
    recoveryQuery: 'example official status'
  });
  let state = getBrowserSessionState();
  assert.strictEqual(state.url, 'https://example.com');
  assert.strictEqual(state.goalStatus, 'achieved');
  assert.deepStrictEqual(state.attemptedUrls, ['https://example.com', 'https://example.org']);
  assert.strictEqual(state.navigationAttemptCount, 2);
  assert.strictEqual(state.recoveryMode, 'search');
  assert.strictEqual(state.recoveryQuery, 'example official status');
  assert.ok(state.lastUpdated);

  resetBrowserSessionState();
  state = getBrowserSessionState();
  assert.strictEqual(state.url, null);
  assert.strictEqual(state.goalStatus, 'unknown');
  assert.deepStrictEqual(state.attemptedUrls, []);
  assert.strictEqual(state.navigationAttemptCount, 0);
  assert.strictEqual(state.recoveryMode, 'direct');
  assert.strictEqual(state.recoveryQuery, null);
  assert.ok(state.lastUpdated);
});

test('conversation history store persists bounded entries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-history-'));
  const historyFile = path.join(tempRoot, 'conversation-history.json');
  const store = createConversationHistoryStore({
    historyFile,
    likuHome: tempRoot,
    maxHistory: 2
  });

  store.pushConversationEntry({ role: 'user', content: 'one' });
  store.pushConversationEntry({ role: 'assistant', content: 'two' });
  store.pushConversationEntry({ role: 'user', content: 'three' });
  store.pushConversationEntry({ role: 'assistant', content: 'four' });
  store.pushConversationEntry({ role: 'user', content: 'five' });
  store.trimConversationHistory();
  store.saveConversationHistory();

  const reloaded = createConversationHistoryStore({
    historyFile,
    likuHome: tempRoot,
    maxHistory: 2
  });
  reloaded.loadConversationHistory();

  assert.strictEqual(reloaded.getHistoryLength(), 4);
  assert.deepStrictEqual(
    reloaded.getConversationHistory().map((entry) => entry.content),
    ['two', 'three', 'four', 'five']
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
