#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));

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

test('inferTradingViewPineIntent recognizes Pine Editor surface requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.verifyKind, 'panel-visible');
});

test('buildTradingViewPineWorkflowActions wraps the opener with panel verification', () => {
  const actions = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    requiresObservedChange: true
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'type', text: 'strategy("test")', reason: 'Type script' }
  ]);

  const opener = actions.find((action) => action?.verify?.target === 'pine-editor');
  const typed = actions.find((action) => action?.type === 'type' && action?.text === 'strategy("test")');

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].key, 'ctrl+k');
  assert.strictEqual(opener.verify.kind, 'panel-visible');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
  assert(typed, 'typing should remain after the Pine Editor opener route');
});

test('maybeRewriteTradingViewPineWorkflow rewrites low-signal Pine Editor opener plans', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' },
    { type: 'type', text: 'plot(close)' }
  ], {
    userMessage: 'open pine editor in tradingview and type plot(close)'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const typed = rewritten.find((action) => action?.type === 'type' && action?.text === 'plot(close)');

  assert(Array.isArray(rewritten), 'pine rewrite should return an action array');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
  assert(typed, 'typing should remain after the Pine Editor opener route');
});

test('TradingView Pine workflow rewrites generic authoring prompts into safe inspect-first flow', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' }
  ], {
    userMessage: 'write a pine script for tradingview'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');

  assert(Array.isArray(rewritten), 'authoring prompts should rewrite into a bounded safe authoring flow');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert(inspectStep, 'safe authoring should inspect Pine Editor state after opening via quick search');
});
