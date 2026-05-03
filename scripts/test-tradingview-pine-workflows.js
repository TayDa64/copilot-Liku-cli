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

test('inferTradingViewPineIntent preserves explicit Pine requests outside TradingView foreground', () => {
  const intent = inferTradingViewPineIntent('open pine editor and summarize the compile result', [
    { type: 'key', key: 'ctrl+e' }
  ], {
    foreground: {
      success: true,
      processName: 'code',
      title: 'README.md - Visual Studio Code'
    }
  });

  assert(intent, 'explicit Pine requests should stay eligible even outside TradingView foreground');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
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
  const ctrlKIndex = actions.findIndex((action) => action?.type === 'key' && action?.key === 'ctrl+k');
  const typeIndex = actions.findIndex((action) => action?.type === 'type' && action?.text === 'Pine Editor');
  const enterIndex = actions.findIndex((action) => action?.type === 'key' && action?.key === 'enter');

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'key');
  assert.strictEqual(actions[2].key, 'ctrl+k');
  assert.strictEqual(quickSearchOpener.verify.kind, 'dialog-visible');
  assert.strictEqual(quickSearchOpener.verify.target, 'quick-search');
  assert(typeIndex > ctrlKIndex, 'the Pine Editor query should be typed after quick-search opens');
  assert(enterIndex > typeIndex, 'the route should commit the Pine Editor query after typing it');
  assert.strictEqual(actions[typeIndex + 1]?.type, 'key', 'Pine Editor enter should immediately follow typed query so runtime clipboard verification is the only gate');
  assert.strictEqual(actions[typeIndex + 1]?.key, 'enter', 'Pine Editor enter should immediately follow typed query');
  assert(!actions.some((action) => action?.type === 'key' && action?.key === 'ctrl+a'), 'inspect-first Pine workflows should not inject static quick-search selection clears');
  assert(!actions.some((action) => action?.type === 'key' && action?.key === 'backspace'), 'inspect-first Pine workflows should defer stale-query handling to runtime proof and recovery');
  assert.strictEqual(opener.verify.kind, 'panel-visible');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
  assert(typed, 'typing should remain after the Pine Editor opener route');
});

test('maybeRewriteTradingViewPineWorkflow preserves a UIA-discovered TradingView HWND on action 0', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    {
      type: 'bring_window_to_front',
      title: 'INTC ? 94.48 -0.28% / Unnamed',
      processName: 'TradingView',
      windowHandle: 986022,
      hwnd: 986022
    },
    { type: 'key', key: 'ctrl+k' },
    { type: 'type', text: 'Pine Editor' },
    { type: 'key', key: 'enter' }
  ], {
    userMessage: 'Create and save a fresh Pine script in TradingView.'
  });

  assert(Array.isArray(rewritten), 'pine rewrite should return an action array');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[0].windowHandle, 986022, 'rewrite should preserve the UIA/window-manager discovered hwnd');
  assert.strictEqual(rewritten[0].hwnd, 986022, 'rewrite should preserve hwnd alias for direct focus');
  assert.strictEqual(rewritten[0].openIfMissing, true, 'focus action should document open-if-missing behavior for focus recovery');
  assert(/already-open TradingView/.test(rewritten[0].reason), 'focus action should prefer an already-open TradingView window');
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

test('maybeRewriteTradingViewPineWorkflow does not hijack shell-only plans when Pine prose mentions Pine Editor', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'run_command', command: 'cd c:\\dev\\copilot-Liku-cli && dir', reason: 'Inspect the workspace contents' }
  ], {
    userMessage: 'Open Pine Editor in TradingView and clear the selected quick-search text before typing Pine Editor.'
  });

  assert.strictEqual(rewritten, null, 'run_command-only plans should stay shell-only unless the plan itself is Pine-targeted');
});

test('maybeRewriteTradingViewPineWorkflow suppresses Pine rewrites for unrelated repo/editor prompts', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' },
    { type: 'type', text: 'plot(close)' }
  ], {
    userMessage: 'help me inspect this VS Code workspace',
    foreground: {
      success: true,
      processName: 'code',
      title: 'README.md - Visual Studio Code'
    }
  });

  assert.strictEqual(rewritten, null, 'Pine rewrites should stay disabled when the shared execution context is unrelated repo/editor work');
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
