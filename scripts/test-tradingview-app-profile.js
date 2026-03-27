#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildOpenApplicationActions,
  buildVerifyTargetHintFromAppName,
  resolveNormalizedAppIdentity
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'app-profile.js'));

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

test('TradingView typo aliases normalize to canonical app identity', () => {
  const identity = resolveNormalizedAppIdentity('tradeing view');
  assert(identity, 'identity should resolve');
  assert.strictEqual(identity.appName, 'TradingView');
  assert.strictEqual(identity.launchQuery, 'TradingView');
  assert.strictEqual(identity.matchedBy, 'exact');
  assert(identity.processNames.includes('tradingview'));
  assert(identity.dialogTitleHints.includes('Create Alert'));
  assert(identity.chartKeywords.includes('timeframe'));
  assert(identity.indicatorKeywords.includes('volume profile'));
  assert(identity.pineKeywords.includes('pine editor'));
  assert(identity.domKeywords.includes('depth of market'));
});

test('verify target hint preserves TradingView domain metadata', () => {
  const hint = buildVerifyTargetHintFromAppName('TradingView');
  assert.strictEqual(hint.appName, 'TradingView');
  assert(hint.processNames.includes('tradingview'));
  assert(hint.titleHints.includes('TradingView Desktop'));
  assert(hint.dialogTitleHints.includes('Create Alert'));
  assert(hint.dialogKeywords.includes('create alert'));
  assert(hint.drawingKeywords.includes('trend line'));
  assert(hint.indicatorKeywords.includes('strategy tester'));
  assert(hint.popupKeywords.includes('workspace'));
});

test('open application actions use canonical launch query and verify target', () => {
  const actions = buildOpenApplicationActions('tradeing view');
  assert.strictEqual(actions.length, 6);
  assert.strictEqual(actions[2].type, 'type');
  assert.strictEqual(actions[2].text, 'TradingView');
  assert.strictEqual(actions[4].type, 'key');
  assert.strictEqual(actions[4].key, 'enter');
  assert.strictEqual(actions[4].verifyTarget.appName, 'TradingView');
  assert(actions[4].verifyTarget.processNames.includes('tradingview'));
});
