#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inferTradingViewDomIntent,
  buildTradingViewDomWorkflowActions,
  maybeRewriteTradingViewDomWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'dom-workflows.js'));

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

test('inferTradingViewDomIntent recognizes Depth of Market surface requests', () => {
  const intent = inferTradingViewDomIntent('open depth of market in tradingview', [
    { type: 'key', key: 'ctrl+d' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.surfaceTarget, 'dom-panel');
  assert.strictEqual(intent.verifyKind, 'panel-visible');
});

test('buildTradingViewDomWorkflowActions wraps the opener with DOM panel verification', () => {
  const actions = buildTradingViewDomWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'dom-panel',
    verifyKind: 'panel-visible',
    openerIndex: 0
  }, [
    { type: 'key', key: 'ctrl+d', reason: 'Open DOM' }
  ]);

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].verify.kind, 'panel-visible');
  assert.strictEqual(actions[2].verify.target, 'dom-panel');
});

test('maybeRewriteTradingViewDomWorkflow rewrites low-signal DOM opener plans', () => {
  const rewritten = maybeRewriteTradingViewDomWorkflow([
    { type: 'key', key: 'ctrl+d' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'open depth of market in tradingview'
  });

  assert(Array.isArray(rewritten), 'dom rewrite should return an action array');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'dom-panel');
});

test('TradingView DOM workflow does not hijack risky trading requests', () => {
  const rewritten = maybeRewriteTradingViewDomWorkflow([
    { type: 'key', key: 'ctrl+d' }
  ], {
    userMessage: 'open depth of market in tradingview and place a limit order'
  });

  assert.strictEqual(rewritten, null, 'risky DOM trading prompts should not be auto-rewritten into a safe opener flow');
});