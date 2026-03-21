#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PHASE3_POSTFIX_STARTED_AT,
  parseProofEntries,
  resolveEntryCohort,
  resolveEntryModel,
  summarizeProofEntries,
  buildTrend,
  passesFilter
} = require(path.join(__dirname, 'summarize-chat-inline-proof.js'));

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

test('parseProofEntries ignores malformed JSONL lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-proof-summary-'));
  const filePath = path.join(tempDir, 'proof.jsonl');
  fs.writeFileSync(filePath, '{"suite":"a","passed":true}\nnot-json\n{"suite":"b","passed":false}\n', 'utf8');
  const entries = parseProofEntries(filePath);
  assert.strictEqual(entries.length, 2);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('resolveEntryModel prefers requested model bucket', () => {
  assert.strictEqual(resolveEntryModel({ requestedModel: 'cheap', observedRuntimeModels: ['gpt-4o-mini'] }), 'cheap');
  assert.strictEqual(resolveEntryModel({ observedRequestedModels: ['latest-gpt'] }), 'latest-gpt');
  assert.strictEqual(resolveEntryModel({ observedRuntimeModels: ['gpt-4o'] }), 'gpt-4o');
  assert.strictEqual(resolveEntryModel({}), 'default');
});

test('resolveEntryCohort separates pre-fix and post-fix Phase 3 runs', () => {
  assert.strictEqual(resolveEntryCohort({ timestamp: '2026-03-21T05:10:42.757Z' }), 'pre-phase3-postfix');
  assert.strictEqual(resolveEntryCohort({ timestamp: PHASE3_POSTFIX_STARTED_AT }), 'phase3-postfix');
});

test('summarizeProofEntries groups by suite and model with trends', () => {
  const entries = [
    { timestamp: '2026-03-20T00:00:00.000Z', suite: 'direct-navigation', requestedModel: 'cheap', passed: true, observedRuntimeModels: ['gpt-4o-mini'] },
    { timestamp: '2026-03-20T01:00:00.000Z', suite: 'direct-navigation', requestedModel: 'cheap', passed: false, observedRuntimeModels: ['gpt-4o-mini'] },
    { timestamp: '2026-03-20T02:00:00.000Z', suite: 'direct-navigation', requestedModel: 'latest-gpt', passed: true, observedRuntimeModels: ['gpt-5.2'] },
    { timestamp: '2026-03-20T03:00:00.000Z', suite: 'status-basic-chat', requestedModel: 'latest-gpt', passed: true, observedRuntimeModels: ['gpt-5.2'] }
  ];

  const summary = summarizeProofEntries(entries);
  assert.strictEqual(summary.totals.runs, 4);
  assert.strictEqual(summary.totals.passed, 3);
  assert(summary.bySuite.some((row) => row.key === 'direct-navigation' && row.trend === 'PFP'));
  assert(summary.byModel.some((row) => row.key === 'cheap' && row.trend === 'PF'));
  assert(summary.byCohort.some((row) => row.key === 'pre-phase3-postfix'));
  assert(summary.bySuiteModel.some((row) => row.suite === 'direct-navigation' && row.model === 'latest-gpt' && row.passRate === 100));
});

test('passesFilter respects suite model mode and time filters', () => {
  const entry = { timestamp: '2026-03-20T03:00:00.000Z', suite: 'status-basic-chat', requestedModel: 'latest-gpt', mode: 'local' };
  assert.strictEqual(passesFilter(entry, { suite: 'status-basic-chat', model: 'latest-gpt', mode: 'local', since: Date.parse('2026-03-20T00:00:00.000Z') }), true);
  assert.strictEqual(passesFilter(entry, { suite: 'other' }), false);
  assert.strictEqual(passesFilter(entry, { model: 'cheap' }), false);
  assert.strictEqual(passesFilter(entry, { mode: 'global' }), false);
  assert.strictEqual(passesFilter({ timestamp: PHASE3_POSTFIX_STARTED_AT }, { cohort: 'phase3-postfix' }), true);
  assert.strictEqual(passesFilter({ timestamp: '2026-03-21T05:10:42.757Z' }, { cohort: 'phase3-postfix' }), false);
  assert.strictEqual(passesFilter(entry, { since: Date.parse('2026-03-21T00:00:00.000Z') }), false);
});

test('buildTrend produces recent pass fail signature', () => {
  const trend = buildTrend([
    { timestamp: '2026-03-20T00:00:00.000Z', passed: true },
    { timestamp: '2026-03-20T01:00:00.000Z', passed: false },
    { timestamp: '2026-03-20T02:00:00.000Z', passed: true }
  ]);
  assert.strictEqual(trend, 'PFP');
});