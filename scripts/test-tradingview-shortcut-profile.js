#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL,
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL,
  buildTradingViewShortcutAction,
  getTradingViewShortcut,
  getTradingViewShortcutKey,
  listTradingViewShortcuts,
  matchesTradingViewShortcutAction,
  resolveTradingViewShortcutId
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
  const quickSearch = getTradingViewShortcut('command palette');

  assert(indicatorSearch, 'indicator-search shortcut should exist');
  assert.strictEqual(indicatorSearch.key, '/');
  assert.strictEqual(indicatorSearch.category, 'stable-default');
  assert(createAlert, 'create-alert shortcut should exist');
  assert.strictEqual(createAlert.key, 'alt+a');
  assert.strictEqual(createAlert.category, 'stable-default');
  assert.strictEqual(getTradingViewShortcutKey('symbol-search'), 'ctrl+k');
  assert(quickSearch, 'symbol-search alias should resolve through the profile helper');
  assert.strictEqual(quickSearch.id, 'symbol-search');
  assert.strictEqual(quickSearch.surface, 'quick-search');
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
  assert.strictEqual(action.tradingViewShortcut.surface, 'indicator-search');
  assert(matchesTradingViewShortcutAction(action, 'indicator-search'));
});

test('listTradingViewShortcuts returns the categorized TradingView profile inventory', () => {
  const shortcuts = listTradingViewShortcuts();
  assert(Array.isArray(shortcuts), 'shortcut inventory should be an array');
  assert(shortcuts.length >= 12, 'shortcut inventory should include the grounded TradingView shortcut inventory');
});

test('shortcut profile exposes reference-only chart shortcuts with source provenance', () => {
  const snapshot = getTradingViewShortcut('take snapshot');
  const watchlist = getTradingViewShortcut('add-symbol-to-watchlist');

  assert(snapshot, 'snapshot shortcut should resolve by alias');
  assert.strictEqual(snapshot.key, 'alt+s');
  assert.strictEqual(snapshot.category, 'reference-only');
  assert.strictEqual(snapshot.sourceConfidence, 'secondary-reference');
  assert(snapshot.sourceUrls.includes(TRADINGVIEW_SHORTCUTS_SECONDARY_URL));
  assert(watchlist, 'watchlist shortcut should exist');
  assert.strictEqual(watchlist.key, 'alt+w');
  assert.strictEqual(watchlist.surface, 'watchlist');
});

test('shortcut profile resolves aliases and documents official shortcut references', () => {
  assert.strictEqual(resolveTradingViewShortcutId('command palette'), 'symbol-search');
  assert.strictEqual(resolveTradingViewShortcutId('quick search'), 'symbol-search');
  assert.strictEqual(resolveTradingViewShortcutId('new alert'), 'create-alert');

  const indicatorSearch = getTradingViewShortcut('indicator-search');
  assert(indicatorSearch.sourceUrls.includes(TRADINGVIEW_SHORTCUTS_OFFICIAL_URL));
  assert(indicatorSearch.sourceUrls.includes(TRADINGVIEW_SHORTCUTS_SECONDARY_URL));
});
