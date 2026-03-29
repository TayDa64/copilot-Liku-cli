#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildTradingViewShortcutAction,
  getTradingViewShortcut,
  getTradingViewShortcutKey,
  listTradingViewShortcuts,
  matchesTradingViewShortcutAction
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js'));

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

test('stable default TradingView shortcuts are exposed through the profile helper', () => {
  const indicatorSearch = getTradingViewShortcut('indicator-search');
  const createAlert = getTradingViewShortcut('create-alert');

  assert(indicatorSearch, 'indicator-search shortcut should exist');
  assert.strictEqual(indicatorSearch.key, '/');
  assert.strictEqual(indicatorSearch.category, 'stable-default');
  assert(createAlert, 'create-alert shortcut should exist');
  assert.strictEqual(createAlert.key, 'alt+a');
  assert.strictEqual(createAlert.category, 'stable-default');
  assert.strictEqual(getTradingViewShortcutKey('symbol-search'), 'ctrl+k');
});

test('drawing shortcuts are marked customizable rather than universal', () => {
  const drawingShortcut = getTradingViewShortcut('drawing-tool-binding');
  assert(drawingShortcut, 'drawing shortcut profile should exist');
  assert.strictEqual(drawingShortcut.category, 'customizable');
  assert.strictEqual(drawingShortcut.key, null);
  assert(/customized/i.test(drawingShortcut.notes.join(' ')));
});

test('trading panel shortcuts are context-dependent and paper-test only', () => {
  const domShortcut = getTradingViewShortcut('open-dom-panel');
  const paperShortcut = getTradingViewShortcut('open-paper-trading');

  assert(domShortcut, 'DOM shortcut should exist');
  assert.strictEqual(domShortcut.category, 'context-dependent');
  assert.strictEqual(domShortcut.safety, 'paper-test-only');
  assert(paperShortcut, 'paper trading shortcut should exist');
  assert.strictEqual(paperShortcut.safety, 'paper-test-only');
});

test('buildTradingViewShortcutAction preserves shortcut metadata for workflow actions', () => {
  const action = buildTradingViewShortcutAction('indicator-search', {
    reason: 'Open indicator search'
  });

  assert(action, 'shortcut action should be created');
  assert.strictEqual(action.type, 'key');
  assert.strictEqual(action.key, '/');
  assert.strictEqual(action.tradingViewShortcut.id, 'indicator-search');
  assert.strictEqual(action.tradingViewShortcut.category, 'stable-default');
  assert(matchesTradingViewShortcutAction(action, 'indicator-search'));
});

test('listTradingViewShortcuts returns the categorized TradingView profile inventory', () => {
  const shortcuts = listTradingViewShortcuts();
  assert(Array.isArray(shortcuts), 'shortcut inventory should be an array');
  assert(shortcuts.length >= 6, 'shortcut inventory should include the core TradingView shortcuts');
});
