#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow,
  inferPineVersionHistoryEvidenceMode
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

test('pine workflow recognizes pine logs evidence-gathering requests', () => {
  const intent = inferTradingViewPineIntent('open pine logs in tradingview and read the output', [
    { type: 'key', key: 'ctrl+shift+l' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-logs');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine editor status-output requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and read the visible compiler status', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes compile-result requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and summarize the compile result', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
  assert.strictEqual(intent.pineEvidenceMode, 'compile-result');
});

test('pine workflow recognizes diagnostics requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and check diagnostics', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
  assert.strictEqual(intent.pineEvidenceMode, 'diagnostics');
});

test('pine workflow recognizes pine editor line-budget requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and check whether the script is close to the 500 line limit', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine profiler evidence-gathering requests', () => {
  const intent = inferTradingViewPineIntent('open pine profiler in tradingview and summarize the metrics', [
    { type: 'key', key: 'ctrl+shift+p' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-profiler');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine version history provenance requests', () => {
  const intent = inferTradingViewPineIntent('open pine version history in tradingview and read the latest visible revisions', [
    { type: 'key', key: 'alt+h' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-version-history');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow classifies version history metadata summary requests', () => {
  const mode = inferPineVersionHistoryEvidenceMode('open pine version history in tradingview and summarize the top visible revision metadata');

  assert.strictEqual(mode, 'provenance-summary');
});

test('pine workflow recognizes visible revision metadata requests', () => {
  const intent = inferTradingViewPineIntent('open pine version history in tradingview and summarize the top visible revision metadata', [
    { type: 'key', key: 'alt+h' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-version-history');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
  assert.strictEqual(intent.pineEvidenceMode, 'provenance-summary');
});

test('open pine logs and read output stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-logs',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+shift+l', reason: 'Open Pine Logs' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-logs');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Logs');
});

test('open pine editor and read visible status stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-editor');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Editor');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'generic-status');
});

test('pine editor authoring workflow demands editor-active verification before typing', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    requiresObservedChange: true,
    requiresEditorActivation: true,
    wantsEvidenceReadback: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 1000 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor' },
    { type: 'type', text: 'plot(close)' }
  ]);

  assert.strictEqual(rewritten[2].verify.kind, 'editor-active');
  assert.strictEqual(rewritten[2].verify.target, 'pine-editor');
  assert.strictEqual(rewritten[2].verify.requiresObservedChange, true);
});

test('generic pine script creation prefers safe new-script workflow', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 1000 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor for new script' },
    { type: 'type', text: 'indicator("LUNR Confidence")' },
    { type: 'key', key: 'ctrl+enter', reason: 'Add to chart' }
  ], {
    userMessage: 'in tradingview, create a pine script that builds my confidence level when making decisions'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].verify.kind, 'editor-active');
  assert(rewritten.some((action) => action?.type === 'get_text' && action?.text === 'Pine Editor'), 'safe authoring should inspect visible Pine Editor state first');
  assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'safe authoring should avoid select-all by default');
  assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'backspace'), 'safe authoring should avoid destructive clear-first behavior');
});

test('destructive clear remains reserved for explicit overwrite intent', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 1000 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor for replacement script' },
    { type: 'type', text: 'indicator("Replacement")' }
  ], {
    userMessage: 'in tradingview, overwrite the current pine script with a replacement version'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert(rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'explicit overwrite should preserve select-all');
  assert(rewritten.some((action) => String(action?.key || '').toLowerCase() === 'backspace'), 'explicit overwrite should preserve destructive clear');
  assert(rewritten.some((action) => action?.type === 'type'), 'explicit overwrite should preserve typing after the clear');
});

test('open pine editor and summarize compile result stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'compile-result',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Editor');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'compile-result');
  assert(/compile-result text/i.test(rewritten[4].reason), 'compile-result readback should use diagnostics-specific wording');
});

test('open pine editor and summarize diagnostics preserves bounded get_text readback', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'diagnostics',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Editor');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'diagnostics');
  assert(/diagnostics and warnings/i.test(rewritten[4].reason), 'diagnostics readback should use diagnostics-specific wording');
});

test('open pine editor and check 500-line budget stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'line-budget',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-editor');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Editor');
  assert(/line-budget hints/i.test(rewritten[4].reason), 'pine editor line-budget readback should mention line-budget hints');
});

test('open pine profiler and summarize metrics stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-profiler',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+shift+p', reason: 'Open Pine Profiler' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-profiler');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Profiler');
});

test('open pine version history and read revisions stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-version-history',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'alt+h', reason: 'Open Pine Version History' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Version History');
});

test('open pine version history and summarize visible revision metadata stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-version-history',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'provenance-summary',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'alt+h', reason: 'Open Pine Version History' }
  ]);

  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Version History');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'provenance-summary');
  assert.deepStrictEqual(rewritten[4].pineSummaryFields, [
    'latest-revision-label',
    'latest-relative-time',
    'visible-revision-count',
    'visible-recency-signal',
    'top-visible-revisions'
  ]);
  assert(/top visible Pine Version History revision metadata/i.test(rewritten[4].reason), 'version-history metadata readback should use provenance-summary wording');
});

test('pine evidence-gathering workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+shift+l' },
    { type: 'get_text', text: 'Pine Logs', reason: 'Read visible Pine Logs output' }
  ], {
    userMessage: 'open pine logs in tradingview and read output'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Logs');
  assert.strictEqual(rewritten[2].verify.target, 'pine-logs');
});

test('pine editor evidence workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' },
    { type: 'get_text', text: 'Pine Editor', reason: 'Read visible Pine Editor status text' }
  ], {
    userMessage: 'open pine editor in tradingview and summarize the visible compiler status'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit pine editor readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Editor');
  assert.strictEqual(rewritten[2].verify.target, 'pine-editor');
});

test('pine profiler evidence workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+shift+p' },
    { type: 'get_text', text: 'Pine Profiler', reason: 'Read visible Pine Profiler output' }
  ], {
    userMessage: 'open pine profiler in tradingview and summarize what it says'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit profiler readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Profiler');
  assert.strictEqual(rewritten[2].verify.target, 'pine-profiler');
});

test('pine version history workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'alt+h' },
    { type: 'get_text', text: 'Pine Version History', reason: 'Read visible Pine Version History entries' }
  ], {
    userMessage: 'open pine version history in tradingview and summarize the latest visible revisions'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit version-history readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Version History');
  assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
});

test('pine version history metadata workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'alt+h' },
    { type: 'get_text', text: 'Pine Version History', reason: 'Read top visible Pine Version History revision metadata', pineEvidenceMode: 'provenance-summary' }
  ], {
    userMessage: 'open pine version history in tradingview and summarize the top visible revision metadata'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit version-history metadata readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Version History');
  assert.strictEqual(readSteps[0].pineEvidenceMode, 'provenance-summary');
  assert.deepStrictEqual(readSteps[0].pineSummaryFields, [
    'latest-revision-label',
    'latest-relative-time',
    'visible-revision-count',
    'visible-recency-signal',
    'top-visible-revisions'
  ]);
  assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
});

test('pine workflow does not hijack speculative chart-analysis prompts', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'screenshot' }
  ], {
    userMessage: 'use pine in tradingview to gather data for lunr and tell me what you think'
  });

  assert.strictEqual(rewritten, null, 'speculative chart-analysis prompts should not be auto-rewritten into Pine surface flows without an explicit safe open/read request');
});