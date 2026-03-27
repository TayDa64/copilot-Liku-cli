#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  detectTradingViewDomainActionRisk,
  extractTradingViewObservationKeywords,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'verification.js'));

const ActionRiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

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

test('TradingView observation keywords cover alert and indicator workflows', () => {
  const keywords = extractTradingViewObservationKeywords('open indicator search in tradingview and add anchored vwap, then inspect pine editor');
  assert(keywords.includes('indicator'));
  assert(keywords.includes('anchored vwap'));
  assert(keywords.includes('pine editor'));
  assert(!keywords.includes('alert'));
});

test('TradingView DOM safety rail detects critical and high-risk actions', () => {
  const critical = detectTradingViewDomainActionRisk('flatten the position from the tradingview dom now', ActionRiskLevel);
  assert(critical, 'critical DOM action should be detected');
  assert.strictEqual(critical.riskLevel, ActionRiskLevel.CRITICAL);
  assert.strictEqual(critical.blockExecution, true);

  const high = detectTradingViewDomainActionRisk('place a buy mkt order in the tradingview dom', ActionRiskLevel);
  assert(high, 'high-risk DOM action should be detected');
  assert.strictEqual(high.riskLevel, ActionRiskLevel.HIGH);
  assert.strictEqual(high.blockExecution, true);
});

test('TradingView target hint detection recognizes canonical app metadata', () => {
  assert.strictEqual(isTradingViewTargetHint({ appName: 'TradingView', processNames: ['tradingview'] }), true);
  assert.strictEqual(isTradingViewTargetHint({ appName: 'Visual Studio Code', processNames: ['code'] }), false);
});

test('TradingView implicit observation spec distinguishes dialog and chart-state flows', () => {
  const dialogSpec = inferTradingViewObservationSpec({
    textSignals: 'Open create alert dialog in TradingView and type 20.02',
    nextAction: { type: 'type', text: '20.02' }
  });
  assert(dialogSpec, 'dialog spec should be inferred');
  assert.strictEqual(dialogSpec.classification, 'dialog-open');
  assert.strictEqual(dialogSpec.requiresObservedChange, true);
  assert(dialogSpec.expectedKeywords.includes('create alert'));

  const chartSpec = inferTradingViewObservationSpec({
    textSignals: 'Change the TradingView timeframe to 1h and verify chart state',
    nextAction: { type: 'key', key: 'enter' }
  });
  assert(chartSpec, 'chart-state spec should be inferred');
  assert.strictEqual(chartSpec.classification, 'chart-state');
  assert(chartSpec.expectedKeywords.includes('timeframe'));
});
