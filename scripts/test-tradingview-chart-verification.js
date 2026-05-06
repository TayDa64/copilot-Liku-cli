#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { getTradingViewShortcutKey } = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js'));

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

function assertQuickSearchSymbolRoute(actions = [], symbol = '') {
  const source = Array.isArray(actions) ? actions : [];
  const ctrlKIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+k');
  const ctrlAIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+a');
  const backspaceIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'backspace');
  const typeIndex = source.findIndex((action) => action?.type === 'type' && String(action?.text || '').toUpperCase() === String(symbol || '').toUpperCase());
  const enterIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'enter');

  assert(ctrlKIndex >= 0, 'symbol workflow should begin by opening TradingView quick search');
  assert(ctrlAIndex > ctrlKIndex, 'symbol workflow should select any stale quick-search query after quick search opens');
  assert(backspaceIndex > ctrlAIndex, 'symbol workflow should clear the selected quick-search query before typing the symbol');
  assert(typeIndex > backspaceIndex, 'symbol workflow should type the requested symbol after the quick-search field is cleared');
  assert(enterIndex > typeIndex, 'symbol workflow should confirm the selected quick-search symbol after typing it');
}

test('extractRequestedTimeframe normalizes common TradingView timeframe phrases', () => {
  assert.strictEqual(extractRequestedTimeframe('change the timeframe selector from 1m to 5m in tradingview'), '5m');
  assert.strictEqual(extractRequestedTimeframe('switch tradingview to 1 hour timeframe'), '1h');
  assert.strictEqual(extractRequestedTimeframe('set the chart interval to 4 hours'), '4h');
});

test('extractRequestedTimeframe does not throw on Pine authoring prompts with no timeframe intent', () => {
  assert.doesNotThrow(() => {
    const timeframe = extractRequestedTimeframe('tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.');
    assert.strictEqual(timeframe, null);
  });
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
  assert.strictEqual(extractRequestedSymbol('change the chart symbol to BTCUSD and confirm it changed in tradingview'), 'BTCUSD');
  assert.strictEqual(extractRequestedSymbol('search for ticker msft in tradingview'), 'MSFT');
  assert.strictEqual(extractRequestedSymbol('set the ticker to spy on tradingview'), 'SPY');
  assert.strictEqual(extractRequestedSymbol('open Pine Editor for the LUNR chart in tradingview'), 'LUNR');
});

test('inferTradingViewSymbolIntent recognizes symbol-change workflows', () => {
  const intent = inferTradingViewSymbolIntent('change the symbol to NVDA in tradingview');
  assert(intent, 'symbol intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.symbol, 'NVDA');
});

test('inferTradingViewSymbolIntent preserves explicit chart symbol targets from natural phrasing', () => {
  const intent = inferTradingViewSymbolIntent('In TradingView, change the chart symbol to BTCUSD and confirm it changed.');
  assert(intent, 'symbol intent should be inferred for chart-symbol phrasing');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.symbol, 'BTCUSD');
});

test('inferTradingViewSymbolIntent recognizes shortcut-alias quick-search phrasing', () => {
  const intent = inferTradingViewSymbolIntent('open the command palette for NVDA in tradingview');
  assert(intent, 'quick-search alias intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.symbol, 'NVDA');
  assert.strictEqual(intent.searchContext, true);
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
  assertQuickSearchSymbolRoute(actions, 'NVDA');
  const enterAction = actions.find((action) => action?.type === 'key' && action?.key === 'enter');
  const trailingWait = actions[actions.length - 1];
  assert(enterAction, 'symbol workflow should confirm via Enter after quick-search replacement');
  assert.strictEqual(enterAction.verify.kind, 'symbol-updated');
  assert(enterAction.verify.keywords.includes('NVDA'));
  assert.strictEqual(enterAction.reason, 'Apply TradingView symbol NVDA from the verified quick-search selection');
  assert.strictEqual(trailingWait?.type, 'wait');
  assert.strictEqual(trailingWait?.ms, 180, 'verified symbol quick-search workflows should use only a light post-confirm settle');
});

test('maybeRewriteTradingViewSymbolWorkflow rewrites low-signal symbol plans', () => {
  const rewritten = maybeRewriteTradingViewSymbolWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'change the symbol to NVDA in tradingview'
  });

  assert(Array.isArray(rewritten), 'low-signal symbol request should rewrite');
  assertQuickSearchSymbolRoute(rewritten, 'NVDA');
  const enterAction = rewritten.find((action) => action?.type === 'key' && action?.key === 'enter');
  assert.strictEqual(enterAction?.verify?.target, 'symbol-updated');
});

test('maybeRewriteTradingViewSymbolWorkflow rewrites low-signal quick-search alias plans', () => {
  const rewritten = maybeRewriteTradingViewSymbolWorkflow([
    { type: 'screenshot' },
    { type: 'wait', ms: 250 }
  ], {
    userMessage: 'open the quick search for MSFT in tradingview'
  });

  assert(Array.isArray(rewritten), 'quick-search alias request should rewrite');
  assertQuickSearchSymbolRoute(rewritten, 'MSFT');
  const enterAction = rewritten.find((action) => action?.type === 'key' && action?.key === 'enter');
  assert(enterAction?.verify?.keywords.includes('quick-search'));
  assert(enterAction?.verify?.keywords.includes('command palette'));
});

test('maybeRewriteTradingViewSymbolWorkflow does not replace plans already using symbol-search shortcut', () => {
  const rewritten = maybeRewriteTradingViewSymbolWorkflow([
    { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' },
    { type: 'key', key: getTradingViewShortcutKey('symbol-search') },
    { type: 'type', text: 'MSFT' },
    { type: 'key', key: 'enter' }
  ], {
    userMessage: 'open the command palette for MSFT in tradingview'
  });

  assert.strictEqual(rewritten, null);
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

test('symbol workflow does not hijack TradingView Pine authoring prompts that mention a chart symbol', () => {
  const rewritten = maybeRewriteTradingViewSymbolWorkflow([
    { type: 'focus_window', windowHandle: 459522 }
  ], {
    userMessage: 'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.'
  });

  assert.strictEqual(rewritten, null);
});
