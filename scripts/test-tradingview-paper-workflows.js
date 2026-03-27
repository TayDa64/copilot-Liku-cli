#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inferTradingViewPaperIntent,
  buildTradingViewPaperWorkflowActions,
  maybeRewriteTradingViewPaperWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'paper-workflows.js'));

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

test('inferTradingViewPaperIntent recognizes Paper Trading surface requests', () => {
  const intent = inferTradingViewPaperIntent('open paper trading in tradingview', [
    { type: 'key', key: 'alt+t' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.surfaceTarget, 'paper-trading-panel');
  assert.strictEqual(intent.verifyKind, 'panel-visible');
});

test('buildTradingViewPaperWorkflowActions wraps the opener with paper-trading verification', () => {
  const actions = buildTradingViewPaperWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'paper-trading-panel',
    verifyKind: 'panel-visible',
    openerIndex: 0
  }, [
    { type: 'key', key: 'alt+t', reason: 'Open Paper Trading' }
  ]);

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].verify.kind, 'panel-visible');
  assert.strictEqual(actions[2].verify.target, 'paper-trading-panel');
  assert(actions[2].verify.keywords.includes('paper trading'));
});

test('maybeRewriteTradingViewPaperWorkflow rewrites low-signal paper-trading opener plans', () => {
  const rewritten = maybeRewriteTradingViewPaperWorkflow([
    { type: 'key', key: 'alt+t' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'open paper trading in tradingview'
  });

  assert(Array.isArray(rewritten), 'paper rewrite should return an action array');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'paper-trading-panel');
});

test('TradingView paper workflow does not hijack risky paper-trading order requests', () => {
  const rewritten = maybeRewriteTradingViewPaperWorkflow([
    { type: 'key', key: 'alt+t' }
  ], {
    userMessage: 'open paper trading in tradingview and place a limit order'
  });

  assert.strictEqual(rewritten, null, 'risky paper-trading order prompts should not be auto-rewritten into an assist workflow');
});