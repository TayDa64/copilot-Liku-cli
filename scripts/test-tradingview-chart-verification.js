#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  extractRequestedTimeframe,
  extractRequestedSymbol,
  extractRequestedWatchlistSymbol,
  inferTradingViewTimeframeIntent,
  inferTradingViewSymbolIntent,
  inferTradingViewWatchlistIntent,
  buildTradingViewTimeframeWorkflowActions,
  buildTradingViewSymbolWorkflowActions,
  buildTradingViewWatchlistWorkflowActions,
  maybeRewriteTradingViewTimeframeWorkflow,
  maybeRewriteTradingViewSymbolWorkflow,
  maybeRewriteTradingViewWatchlistWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'chart-verification.js'));

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

test('extractRequestedTimeframe normalizes common TradingView timeframe phrases', () => {
  assert.strictEqual(extractRequestedTimeframe('change the timeframe selector from 1m to 5m in tradingview'), '5m');
  assert.strictEqual(extractRequestedTimeframe('switch tradingview to 1 hour timeframe'), '1h');
  assert.strictEqual(extractRequestedTimeframe('set the chart interval to 4 hours'), '4h');
});

test('inferTradingViewTimeframeIntent recognizes selector-style timeframe workflows', () => {
  const intent = inferTradingViewTimeframeIntent('change the timeframe selector from 1m to 5m in tradingview');
  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.timeframe, '5m');
  assert.strictEqual(intent.selectorContext, true);
});

test('extractRequestedSymbol normalizes common TradingView symbol phrases', () => {
  assert.strictEqual(extractRequestedSymbol('change the symbol to NVDA in tradingview'), 'NVDA');
  assert.strictEqual(extractRequestedSymbol('search for ticker msft in tradingview'), 'MSFT');
  assert.strictEqual(extractRequestedSymbol('set the ticker to spy on tradingview'), 'SPY');
});

test('inferTradingViewSymbolIntent recognizes symbol-change workflows', () => {
  const intent = inferTradingViewSymbolIntent('change the symbol to NVDA in tradingview');
  assert(intent, 'symbol intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.symbol, 'NVDA');
});

test('extractRequestedWatchlistSymbol normalizes common TradingView watchlist phrases', () => {
  assert.strictEqual(extractRequestedWatchlistSymbol('select the watchlist symbol NVDA in tradingview'), 'NVDA');
  assert.strictEqual(extractRequestedWatchlistSymbol('switch the watch list to msft in tradingview'), 'MSFT');
});

test('inferTradingViewWatchlistIntent recognizes watchlist workflows', () => {
  const intent = inferTradingViewWatchlistIntent('select the watchlist symbol NVDA in tradingview');
  assert(intent, 'watchlist intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.symbol, 'NVDA');
});

test('buildTradingViewTimeframeWorkflowActions emits bounded timeframe confirmation flow', () => {
  const actions = buildTradingViewTimeframeWorkflowActions({ appName: 'TradingView', timeframe: '5m' });
  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'type');
  assert.strictEqual(actions[2].text, '5m');
  assert.strictEqual(actions[4].type, 'key');
  assert.strictEqual(actions[4].key, 'enter');
  assert.strictEqual(actions[4].verify.kind, 'timeframe-updated');
  assert(actions[4].verify.keywords.includes('5m'));
});

test('maybeRewriteTradingViewTimeframeWorkflow rewrites low-signal timeframe plans', () => {
  const rewritten = maybeRewriteTradingViewTimeframeWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'change the timeframe selector from 1m to 5m in tradingview'
  });

  assert(Array.isArray(rewritten), 'low-signal timeframe request should rewrite');
  assert.strictEqual(rewritten[2].text, '5m');
  assert.strictEqual(rewritten[4].key, 'enter');
  assert.strictEqual(rewritten[4].verify.target, 'timeframe-updated');
});

test('buildTradingViewSymbolWorkflowActions emits bounded symbol confirmation flow', () => {
  const actions = buildTradingViewSymbolWorkflowActions({ appName: 'TradingView', symbol: 'NVDA' });
  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'type');
  assert.strictEqual(actions[2].text, 'NVDA');
  assert.strictEqual(actions[4].type, 'key');
  assert.strictEqual(actions[4].key, 'enter');
  assert.strictEqual(actions[4].verify.kind, 'symbol-updated');
  assert(actions[4].verify.keywords.includes('NVDA'));
});

test('maybeRewriteTradingViewSymbolWorkflow rewrites low-signal symbol plans', () => {
  const rewritten = maybeRewriteTradingViewSymbolWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'change the symbol to NVDA in tradingview'
  });

  assert(Array.isArray(rewritten), 'low-signal symbol request should rewrite');
  assert.strictEqual(rewritten[2].text, 'NVDA');
  assert.strictEqual(rewritten[4].key, 'enter');
  assert.strictEqual(rewritten[4].verify.target, 'symbol-updated');
});

test('buildTradingViewWatchlistWorkflowActions emits bounded watchlist confirmation flow', () => {
  const actions = buildTradingViewWatchlistWorkflowActions({ appName: 'TradingView', symbol: 'NVDA' });
  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(actions[2].type, 'type');
  assert.strictEqual(actions[2].text, 'NVDA');
  assert.strictEqual(actions[4].type, 'key');
  assert.strictEqual(actions[4].key, 'enter');
  assert.strictEqual(actions[4].verify.kind, 'watchlist-updated');
  assert(actions[4].verify.keywords.includes('watchlist'));
});

test('maybeRewriteTradingViewWatchlistWorkflow rewrites low-signal watchlist plans', () => {
  const rewritten = maybeRewriteTradingViewWatchlistWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'select the watchlist symbol NVDA in tradingview'
  });

  assert(Array.isArray(rewritten), 'low-signal watchlist request should rewrite');
  assert.strictEqual(rewritten[2].text, 'NVDA');
  assert.strictEqual(rewritten[4].key, 'enter');
  assert.strictEqual(rewritten[4].verify.target, 'watchlist-updated');
});

test('symbol workflow does not hijack passive TradingView analysis prompts', () => {
  const rewritten = maybeRewriteTradingViewSymbolWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'help me make a confident synthesis of ticker LUNR in tradingview'
  });

  assert.strictEqual(rewritten, null);
});