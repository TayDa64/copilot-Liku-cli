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
  const quickSearchOpener = actions.find((action) => action?.type === 'key' && action?.key === 'ctrl+k');
  const selectExistingQuery = actions.find((action) => action?.type === 'key' && action?.key === 'ctrl+a');
  const clearExistingQuery = actions.find((action) => action?.type === 'key' && action?.key === 'backspace');
  const ctrlKIndex = actions.findIndex((action) => action?.type === 'key' && action?.key === 'ctrl+k');
  const ctrlAIndex = actions.findIndex((action) => action?.type === 'key' && action?.key === 'ctrl+a');
  const backspaceIndex = actions.findIndex((action) => action?.type === 'key' && action?.key === 'backspace');
  const typeIndex = actions.findIndex((action) => action?.type === 'type' && action?.text === 'Pine Editor');

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].key, 'ctrl+k');
  assert.strictEqual(quickSearchOpener.verify.kind, 'dialog-visible');
  assert.strictEqual(quickSearchOpener.verify.target, 'quick-search');
  assert(selectExistingQuery, 'quick-search route should select any stale query text before typing');
  assert(clearExistingQuery, 'quick-search route should explicitly clear the selected stale query before typing');
  assert(ctrlAIndex > ctrlKIndex && ctrlAIndex < backspaceIndex, 'query selection should occur after quick-search opens and before the stale query is cleared');
  assert(backspaceIndex > ctrlAIndex && backspaceIndex < typeIndex, 'stale query clearing should occur after selection and before Pine Editor is typed');
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

test('maybeRewriteTradingViewPineWorkflow canonicalizes quick-search Pine opener plans without duplicating the route', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+k', reason: 'Open TradingView quick search before selecting Pine Editor' },
    { type: 'wait', ms: 220 },
    { type: 'type', text: 'Pine Editor', reason: 'Search for Pine Editor in TradingView quick search' },
    { type: 'wait', ms: 260 },
    { type: 'key', key: 'enter', reason: 'Open TradingView command palette / quick search so we can navigate directly to Pine Editor' }
  ], {
    userMessage: 'Open the Pine Editor in TradingView.'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const pineSearchActions = rewritten.filter((action) => action?.type === 'type' && action?.text === 'Pine Editor');
  const enterActions = rewritten.filter((action) => action?.type === 'key' && action?.key === 'enter');

  assert(Array.isArray(rewritten), 'control prompt should rewrite into a canonical route');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(pineSearchActions.length, 1, 'Pine Editor quick-search text should only appear once after canonicalization');
  assert.strictEqual(enterActions.length, 1, 'Pine Editor selection enter should only appear once after canonicalization');
  assert(opener, 'canonicalized route should retain a verified Pine Editor opener');
});

test('maybeRewriteTradingViewPineWorkflow synthesizes a Pine Editor opener from a focus-only control plan', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'bring_window_to_front', title: 'TradingView' }
  ], {
    userMessage: 'Open the Pine Editor in TradingView.'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const pineSearchActions = rewritten.filter((action) => action?.type === 'type' && action?.text === 'Pine Editor');

  assert(Array.isArray(rewritten), 'focus-only control prompt should synthesize a canonical Pine route');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(pineSearchActions.length, 1, 'synthetic Pine route should search for Pine Editor exactly once');
  assert(opener, 'synthetic Pine route should retain a verified Pine Editor opener');
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
