#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  extractRequestedDrawingName,
  inferTradingViewDrawingIntent,
  buildTradingViewDrawingWorkflowActions,
  maybeRewriteTradingViewDrawingWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'drawing-workflows.js'));

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

test('extractRequestedDrawingName normalizes common TradingView drawing names', () => {
  assert.strictEqual(extractRequestedDrawingName('search for trend line in tradingview drawing tools'), 'trend line');
  assert.strictEqual(extractRequestedDrawingName('open the "fibonacci" drawing in tradingview'), 'fibonacci');
});

test('inferTradingViewDrawingIntent recognizes object tree requests', () => {
  const intent = inferTradingViewDrawingIntent('open object tree in tradingview', [
    { type: 'key', key: 'ctrl+shift+o' },
    { type: 'wait', ms: 250 }
  ]);

  assert(intent, 'drawing intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'object-tree');
  assert.strictEqual(intent.verifyKind, 'panel-visible');
  assert.strictEqual(intent.openerIndex, 0);
});

test('inferTradingViewDrawingIntent recognizes searchable drawing surfaces', () => {
  const intent = inferTradingViewDrawingIntent('search for trend line in tradingview drawing tools', [
    { type: 'key', key: '/' },
    { type: 'type', text: 'trend line' }
  ]);

  assert(intent, 'searchable drawing intent should be inferred');
  assert.strictEqual(intent.drawingName, 'trend line');
  assert.strictEqual(intent.surfaceTarget, 'drawing-search');
  assert.strictEqual(intent.verifyKind, 'input-surface-open');
});

test('buildTradingViewDrawingWorkflowActions wraps opener actions with TradingView verification', () => {
  const actions = buildTradingViewDrawingWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'object-tree',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    reason: 'Open TradingView Object Tree with verification'
  }, [
    { type: 'key', key: 'ctrl+shift+o' },
    { type: 'wait', ms: 250 }
  ]);

  assert(Array.isArray(actions), 'rewritten drawing workflow should be an array');
  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].verify.kind, 'panel-visible');
  assert.strictEqual(actions[2].verify.target, 'object-tree');
});

test('maybeRewriteTradingViewDrawingWorkflow rewrites low-signal object tree opener plans', () => {
  const rewritten = maybeRewriteTradingViewDrawingWorkflow([
    { type: 'key', key: 'ctrl+shift+o' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'open object tree in tradingview'
  });

  assert(Array.isArray(rewritten), 'object tree opener should be rewritten with verification');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.kind, 'panel-visible');
  assert.strictEqual(rewritten[2].verify.target, 'object-tree');
});

test('maybeRewriteTradingViewDrawingWorkflow rewrites searchable drawing flows without inventing shortcuts', () => {
  const rewritten = maybeRewriteTradingViewDrawingWorkflow([
    { type: 'key', key: '/' },
    { type: 'type', text: 'trend line' }
  ], {
    userMessage: 'search for trend line in tradingview drawing tools'
  });

  assert(Array.isArray(rewritten), 'drawing search opener should be rewritten with verification');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].key, '/');
  assert.strictEqual(rewritten[2].verify.kind, 'input-surface-open');
  assert.strictEqual(rewritten[2].verify.target, 'drawing-search');
  assert.strictEqual(rewritten[4].type, 'type');
  assert.strictEqual(rewritten[4].text, 'trend line');
});

test('drawing workflow does not hijack unsafe placement prompts', () => {
  const rewritten = maybeRewriteTradingViewDrawingWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'draw a trend line on tradingview'
  });

  assert.strictEqual(rewritten, null);
});