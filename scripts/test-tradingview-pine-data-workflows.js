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

test('pine workflow recognizes pine logs evidence-gathering requests', () => {
  const intent = inferTradingViewPineIntent('open pine logs in tradingview and read the output', [
    { type: 'key', key: 'ctrl+shift+l' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-logs');
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

test('pine workflow does not hijack speculative chart-analysis prompts', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'screenshot' }
  ], {
    userMessage: 'use pine in tradingview to gather data for lunr and tell me what you think'
  });

  assert.strictEqual(rewritten, null, 'speculative chart-analysis prompts should not be auto-rewritten into Pine surface flows without an explicit safe open/read request');
});