#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  extractIndicatorName,
  inferTradingViewIndicatorIntent,
  buildTradingViewIndicatorWorkflowActions,
  maybeRewriteTradingViewIndicatorWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'indicator-workflows.js'));
const { getTradingViewShortcutKey } = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js'));

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

test('extractIndicatorName captures named TradingView indicator requests', () => {
  assert.strictEqual(extractIndicatorName('open indicator search in tradingview and add anchored vwap'), 'anchored vwap');
  assert.strictEqual(extractIndicatorName('add "Bollinger Bands" indicator in TradingView'), 'Bollinger Bands');
});

test('inferTradingViewIndicatorIntent recognizes add-indicator workflows', () => {
  const intent = inferTradingViewIndicatorIntent('open indicator search in tradingview and add anchored vwap');
  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.indicatorName, 'anchored vwap');
  assert.strictEqual(intent.openSearchOnly, false);
});

test('buildTradingViewIndicatorWorkflowActions emits deterministic slash-search flow', () => {
  const actions = buildTradingViewIndicatorWorkflowActions({
    appName: 'TradingView',
    indicatorName: 'Anchored VWAP',
    openSearchOnly: false
  });

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].key, '/');
  assert.strictEqual(actions[2].verify.kind, 'dialog-visible');
  assert.strictEqual(actions[4].type, 'type');
  assert.strictEqual(actions[4].text, 'Anchored VWAP');
  assert.strictEqual(actions[6].verify.kind, 'indicator-present');
});

test('indicator workflow uses the TradingView shortcut profile for indicator search', () => {
  const actions = buildTradingViewIndicatorWorkflowActions({
    appName: 'TradingView',
    indicatorName: 'Anchored VWAP',
    openSearchOnly: false
  });

  assert.strictEqual(actions[2].key, getTradingViewShortcutKey('indicator-search'));
  assert.strictEqual(actions[2].tradingViewShortcut.id, 'indicator-search');
});

test('maybeRewriteTradingViewIndicatorWorkflow rewrites low-signal indicator plans', () => {
  const rewritten = maybeRewriteTradingViewIndicatorWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 300 }
  ], {
    userMessage: 'open indicator search in tradingview and add anchored vwap'
  });

  assert(Array.isArray(rewritten), 'low-signal indicator request should rewrite');
  assert.strictEqual(rewritten[2].key, '/');
  assert.strictEqual(rewritten[4].text, 'anchored vwap');
  assert.strictEqual(rewritten[6].verify.target, 'indicator-present');
});
