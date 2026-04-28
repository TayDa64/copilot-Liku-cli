const {
  maybeRewriteTradingViewIndicatorWorkflow,
  maybeRewriteTradingViewAlertWorkflow,
  maybeRewriteTradingViewTimeframeWorkflow,
  maybeRewriteTradingViewSymbolWorkflow,
  maybeRewriteTradingViewWatchlistWorkflow,
  maybeRewriteTradingViewDrawingWorkflow,
  maybeRewriteTradingViewPineWorkflow,
  maybeRewriteTradingViewPaperWorkflow,
  maybeRewriteTradingViewDomWorkflow
} = require('../tools/tradingview-tool');

function applyTradingViewReliabilityRewrites(actions, context = {}) {
  const userMessage = typeof context.userMessage === 'string' ? context.userMessage : '';
  const registerRewrite = typeof context.registerRewrite === 'function'
    ? context.registerRewrite
    : null;

  const maybeRegister = (rewriter, category, reason, beforeActions, afterActions) => {
    if (!registerRewrite) return;
    registerRewrite(rewriter, category, reason, beforeActions, afterActions);
  };

  const tradingViewTimeframeRewrite = maybeRewriteTradingViewTimeframeWorkflow(actions, { userMessage });
  if (tradingViewTimeframeRewrite) {
    maybeRegister('maybeRewriteTradingViewTimeframeWorkflow', 'tradingview-timeframe', 'matched TradingView timeframe reliability workflow', actions, tradingViewTimeframeRewrite);
    return tradingViewTimeframeRewrite;
  }

  const tradingViewSymbolRewrite = maybeRewriteTradingViewSymbolWorkflow(actions, { userMessage });
  if (tradingViewSymbolRewrite) {
    maybeRegister('maybeRewriteTradingViewSymbolWorkflow', 'tradingview-symbol', 'matched TradingView symbol reliability workflow', actions, tradingViewSymbolRewrite);
    return tradingViewSymbolRewrite;
  }

  const tradingViewWatchlistRewrite = maybeRewriteTradingViewWatchlistWorkflow(actions, { userMessage });
  if (tradingViewWatchlistRewrite) {
    maybeRegister('maybeRewriteTradingViewWatchlistWorkflow', 'tradingview-watchlist', 'matched TradingView watchlist reliability workflow', actions, tradingViewWatchlistRewrite);
    return tradingViewWatchlistRewrite;
  }

  const tradingViewDrawingRewrite = maybeRewriteTradingViewDrawingWorkflow(actions, { userMessage });
  if (tradingViewDrawingRewrite) {
    maybeRegister('maybeRewriteTradingViewDrawingWorkflow', 'tradingview-drawing', 'matched TradingView drawing reliability workflow', actions, tradingViewDrawingRewrite);
    return tradingViewDrawingRewrite;
  }

  const tradingViewPineRewrite = maybeRewriteTradingViewPineWorkflow(actions, {
    ...context,
    userMessage
  });
  if (tradingViewPineRewrite) {
    maybeRegister('maybeRewriteTradingViewPineWorkflow', 'tradingview-pine', 'matched TradingView Pine reliability workflow', actions, tradingViewPineRewrite);
    return tradingViewPineRewrite;
  }

  const tradingViewPaperRewrite = maybeRewriteTradingViewPaperWorkflow(actions, { userMessage });
  if (tradingViewPaperRewrite) {
    maybeRegister('maybeRewriteTradingViewPaperWorkflow', 'tradingview-paper', 'matched TradingView Paper Trading reliability workflow', actions, tradingViewPaperRewrite);
    return tradingViewPaperRewrite;
  }

  const tradingViewDomRewrite = maybeRewriteTradingViewDomWorkflow(actions, { userMessage });
  if (tradingViewDomRewrite) {
    maybeRegister('maybeRewriteTradingViewDomWorkflow', 'tradingview-dom', 'matched TradingView DOM reliability workflow', actions, tradingViewDomRewrite);
    return tradingViewDomRewrite;
  }

  const tradingViewIndicatorRewrite = maybeRewriteTradingViewIndicatorWorkflow(actions, { userMessage });
  if (tradingViewIndicatorRewrite) {
    maybeRegister('maybeRewriteTradingViewIndicatorWorkflow', 'tradingview-indicator', 'matched TradingView indicator reliability workflow', actions, tradingViewIndicatorRewrite);
    return tradingViewIndicatorRewrite;
  }

  const tradingViewAlertRewrite = maybeRewriteTradingViewAlertWorkflow(actions, { userMessage });
  if (tradingViewAlertRewrite) {
    maybeRegister('maybeRewriteTradingViewAlertWorkflow', 'tradingview-alert', 'matched TradingView alert reliability workflow', actions, tradingViewAlertRewrite);
    return tradingViewAlertRewrite;
  }

  return actions;
}

module.exports = {
  applyTradingViewReliabilityRewrites
};
