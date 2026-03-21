#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const automationHelpers = require('../src/main/ui-automation/core/helpers');
const { createConversationHistoryStore } = require('../src/main/ai-service/conversation-history');

function captureConsole(methodName, fn) {
  const original = console[methodName];
  const calls = [];
  console[methodName] = (...args) => {
    calls.push(args.map((value) => String(value)).join(' '));
  };
  try {
    fn(calls);
  } finally {
    console[methodName] = original;
  }
  return calls;
}

function testUiAutomationLogFiltering() {
  const originalLevel = automationHelpers.getLogLevel();
  automationHelpers.resetLogSettings();

  const logCalls = captureConsole('log', () => {
    automationHelpers.setLogLevel('warn');
    automationHelpers.log('Found 2 windows matching criteria');
  });

  const warnCalls = captureConsole('warn', () => {
    automationHelpers.log('focusWindow: No window found for target', 'warn');
  });

  const errorCalls = captureConsole('error', () => {
    automationHelpers.log('findWindows error: boom', 'error');
  });

  automationHelpers.setLogLevel(originalLevel);
  automationHelpers.resetLogSettings();

  assert.strictEqual(logCalls.length, 0, 'info-level UI automation chatter is suppressed at warn level');
  assert.strictEqual(warnCalls.length, 1, 'warnings still surface at warn level');
  assert.strictEqual(errorCalls.length, 1, 'errors still surface at warn level');
}

function testHistoryRestoreQuietMode() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-chat-quiet-'));
  const historyFile = path.join(tempDir, 'history.json');
  fs.writeFileSync(historyFile, JSON.stringify([{ role: 'user', content: 'hello' }]));

  const previousQuiet = process.env.LIKU_CHAT_TRANSCRIPT_QUIET;
  process.env.LIKU_CHAT_TRANSCRIPT_QUIET = '1';

  const logCalls = captureConsole('log', () => {
    const historyStore = createConversationHistoryStore({
      historyFile,
      likuHome: tempDir,
      maxHistory: 20
    });
    historyStore.loadConversationHistory();
    assert.strictEqual(historyStore.getHistoryLength(), 1, 'history still restores in quiet transcript mode');
  });

  if (previousQuiet === undefined) {
    delete process.env.LIKU_CHAT_TRANSCRIPT_QUIET;
  } else {
    process.env.LIKU_CHAT_TRANSCRIPT_QUIET = previousQuiet;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.strictEqual(logCalls.length, 0, 'history restore log is suppressed in quiet transcript mode');
}

function main() {
  testUiAutomationLogFiltering();
  testHistoryRestoreQuietMode();
  console.log('PASS chat transcript quiet mode');
}

try {
  main();
} catch (error) {
  console.error('FAIL chat transcript quiet mode');
  console.error(error.stack || error.message);
  process.exit(1);
}