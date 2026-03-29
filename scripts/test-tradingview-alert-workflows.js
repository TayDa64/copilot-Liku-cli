#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  extractAlertPrice,
  inferTradingViewAlertIntent,
  buildTradingViewAlertWorkflowActions,
  maybeRewriteTradingViewAlertWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'alert-workflows.js'));
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

test('extractAlertPrice captures explicit TradingView alert prices', () => {
  assert.strictEqual(extractAlertPrice('set an alert for a price target of $20.02 in tradingview'), '20.02');
  assert.strictEqual(extractAlertPrice('open create alert dialog in tradingview and type 25.5'), '25.5');
});

test('inferTradingViewAlertIntent recognizes create-alert workflows', () => {
  const intent = inferTradingViewAlertIntent('set an alert for a price target of $20.02 in tradingview');
  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.price, '20.02');
});

test('buildTradingViewAlertWorkflowActions emits deterministic alt+a flow', () => {
  const actions = buildTradingViewAlertWorkflowActions({ appName: 'TradingView', price: '20.02' });
  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].key, 'alt+a');
  assert.strictEqual(actions[2].verify.kind, 'dialog-visible');
  assert.strictEqual(actions[4].type, 'type');
  assert.strictEqual(actions[4].text, '20.02');
});

test('alert workflow uses the TradingView shortcut profile for create-alert access', () => {
  const actions = buildTradingViewAlertWorkflowActions({ appName: 'TradingView', price: '20.02' });
  assert.strictEqual(actions[2].key, getTradingViewShortcutKey('create-alert'));
  assert.strictEqual(actions[2].tradingViewShortcut.id, 'create-alert');
});

test('maybeRewriteTradingViewAlertWorkflow rewrites low-signal alert plans', () => {
  const rewritten = maybeRewriteTradingViewAlertWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'set an alert for a price target of $20.02 in tradingview'
  });

  assert(Array.isArray(rewritten), 'low-signal alert request should rewrite');
  assert.strictEqual(rewritten[2].key, 'alt+a');
  assert.strictEqual(rewritten[4].text, '20.02');
});
