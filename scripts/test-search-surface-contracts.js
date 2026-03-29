#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const { buildSearchSurfaceSelectionContract } = require(path.join(__dirname, '..', 'src', 'main', 'search-surface-contracts.js'));

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

test('search-surface contract builds query then semantic selection flow', () => {
  const actions = buildSearchSurfaceSelectionContract({
    openerAction: { type: 'key', key: '/' },
    openerWaitMs: 220,
    query: 'Anchored VWAP',
    queryWaitMs: 180,
    selectionText: 'Anchored VWAP',
    selectionReason: 'Select Anchored VWAP from visible indicator results',
    selectionVerify: { kind: 'indicator-present', target: 'indicator-present' },
    selectionWaitMs: 900,
    metadata: { surface: 'indicator-search', contractKind: 'search-result-selection' }
  });

  assert.strictEqual(actions[0].type, 'key');
  assert.strictEqual(actions[2].type, 'type');
  assert.strictEqual(actions[4].type, 'click_element');
  assert.strictEqual(actions[4].text, 'Anchored VWAP');
  assert.strictEqual(actions[4].searchSurfaceContract.surface, 'indicator-search');
});