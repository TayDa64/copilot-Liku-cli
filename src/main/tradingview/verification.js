const { buildVerifyTargetHintFromAppName } = require('./app-profile');

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeUniqueKeywords(...groups) {
  return Array.from(new Set(groups
    .flat()
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)));
}

function inferTradingViewTradingMode(input = {}) {
  const payload = typeof input === 'string'
    ? { textSignals: input }
    : (input && typeof input === 'object' ? input : {});

  const combined = [
    payload.textSignals,
    payload.title,
    payload.text,
    payload.userMessage,
    payload.reason,
    payload.popupHint,
    ...(Array.isArray(payload.keywords) ? payload.keywords : []),
    ...(Array.isArray(payload.nearbyText) ? payload.nearbyText : [])
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  const normalized = normalizeTextForMatch(combined);
  if (!normalized) {
    return {
      mode: 'unknown',
      confidence: 'low',
      evidence: []
    };
  }

  const evidence = [];
  if (/\bpaper trading\b/.test(normalized)) evidence.push('paper trading');
  if (/\bpaper account\b/.test(normalized)) evidence.push('paper account');
  if (/\bdemo trading\b/.test(normalized)) evidence.push('demo trading');
  if (/\bsimulated\b/.test(normalized)) evidence.push('simulated');
  if (/\bpractice\b/.test(normalized)) evidence.push('practice');

  if (evidence.length > 0) {
    return {
      mode: 'paper',
      confidence: evidence.includes('paper trading') || evidence.includes('paper account') ? 'high' : 'medium',
      evidence
    };
  }

  const liveEvidence = [];
  if (/\blive trading\b/.test(normalized)) liveEvidence.push('live trading');
  if (/\blive account\b/.test(normalized)) liveEvidence.push('live account');
  if (/\breal money\b/.test(normalized)) liveEvidence.push('real money');
  if (/\bconnected broker\b/.test(normalized)) liveEvidence.push('connected broker');

  if (liveEvidence.length > 0) {
    return {
      mode: 'live',
      confidence: 'medium',
      evidence: liveEvidence
    };
  }

  return {
    mode: 'unknown',
    confidence: 'low',
    evidence: []
  };
}

function extractTradingViewObservationKeywords(text = '') {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return [];

  const keywords = [];
  if (/\b(alert|create alert|price alert|alerts)\b/i.test(normalized)) {
    keywords.push('alert', 'create alert', 'alerts');
  }
  if (/\b(time\s*frame|timeframe|time interval|interval)\b/i.test(normalized)) {
    keywords.push('time interval', 'interval', 'timeframe');
  }
  if (/\b(symbol|ticker|search)\b/i.test(normalized)) {
    keywords.push('symbol', 'symbol search', 'search');
  }
  if (/\b(indicator|study|studies)\b/i.test(normalized)) {
    keywords.push('indicator', 'indicators');
  }
  if (/\b(draw|drawing|drawings|trend\s*line|ray|pitchfork|fibonacci|fib|brush|rectangle|ellipse|path|polyline|measure|object tree|anchored text|note)\b/i.test(normalized)) {
    keywords.push('drawing', 'drawings', 'trend line', 'object tree');
  }
  if (/\b(anchored\s*vwap|vwap|volume profile|fixed range volume profile|anchored volume profile)\b/i.test(normalized)) {
    keywords.push('anchored vwap', 'volume profile', 'fixed range volume profile');
  }
  if (/\b(pine|pine editor|script|add to chart|publish script|version history|pine logs|profiler)\b/i.test(normalized)) {
    keywords.push('pine', 'pine editor', 'script', 'add to chart', 'pine logs', 'profiler');
  }
  if (/\b(dom|depth of market|order book|trading panel|tier\s*2|level\s*2)\b/i.test(normalized)) {
    keywords.push('dom', 'depth of market', 'order book', 'trading panel');
  }
  return mergeUniqueKeywords(keywords);
}

function detectTradingViewDomainActionRisk(text = '', ActionRiskLevel) {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return null;

  const tradingMode = inferTradingViewTradingMode(text);

  const domContext = /\b(dom|depth of market|order book|trading panel|tier\s*2|level\s*2|buy mkt|sell mkt|limit buy|limit sell|stop buy|stop sell|cxl all|placed order|modify order|flatten|reverse)\b/i.test(normalized);
  if (!domContext) return null;

  const paperModeGuidance = tradingMode.mode === 'paper'
    ? ' Paper Trading was detected, but Liku still blocks order execution; it can help open or verify Paper Trading surfaces and guide the steps instead.'
    : ' If you are using Paper Trading, Liku can help open or verify the Paper Trading surface and guide the steps instead.';

  if (/\b(flatten|reverse|cxl all|cancel all orders|cancel all|close position|reverse position)\b/i.test(normalized)) {
    return {
      riskLevel: ActionRiskLevel?.CRITICAL || 'critical',
      warning: 'TradingView DOM position/order-management action detected',
      requiresConfirmation: true,
      blockExecution: true,
      blockReason: `Advisory-only safety rail blocked a TradingView DOM position/order-management action.${paperModeGuidance}`,
      tradingMode
    };
  }

  if (/\b(buy mkt|sell mkt|market order|limit order|stop order|limit buy|limit sell|stop buy|stop sell|modify order|place order|qty|quantity)\b/i.test(normalized)) {
    return {
      riskLevel: ActionRiskLevel?.HIGH || 'high',
      warning: 'TradingView DOM order-entry action detected',
      requiresConfirmation: true,
      blockExecution: true,
      blockReason: `Advisory-only safety rail blocked a TradingView DOM order-entry action.${paperModeGuidance}`,
      tradingMode
    };
  }

  return null;
}

function isTradingViewTargetHint(target) {
  if (!target || typeof target !== 'object') return false;
  const haystack = [
    target.appName,
    target.requestedAppName,
    target.normalizedAppName,
    ...(Array.isArray(target.processNames) ? target.processNames : []),
    ...(Array.isArray(target.titleHints) ? target.titleHints : [])
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  return /tradingview|trading\s+view/.test(haystack);
}

function inferTradingViewObservationSpec({ textSignals = '', nextAction = null } = {}) {
  const normalizedSignals = normalizeTextForMatch(textSignals);

  const alertIntent = /\b(alert|create alert|price alert|alerts)\b/i.test(normalizedSignals);
  const timeframeIntent = /\b(time\s*frame|timeframe|time interval|interval|chart|5m|15m|30m|1h|4h|1d)\b/i.test(normalizedSignals);
  const drawingIntent = /\b(draw|drawing|drawings|trend\s*line|ray|pitchfork|fibonacci|fib|brush|rectangle|ellipse|path|polyline|measure|object tree|anchored text|note)\b/i.test(normalizedSignals);
  const indicatorIntent = /\b(indicator|study|studies|overlay|oscillator|anchored\s*vwap|vwap|volume profile|fixed range volume profile|anchored volume profile|strategy tester)\b/i.test(normalizedSignals);
  const pineIntent = /\b(pine|pine editor|script|scripts|add to chart|publish script|version history|pine logs|profiler)\b/i.test(normalizedSignals);
  const domIntent = /\b(dom|depth of market|order book|trading panel|tier\s*2|level\s*2)\b/i.test(normalizedSignals);
  const inputSurfaceIntent = nextAction?.type === 'type';

  if (!alertIntent && !timeframeIntent && !drawingIntent && !indicatorIntent && !pineIntent && !domIntent && !inputSurfaceIntent) {
    return null;
  }

  const tradingViewTarget = buildVerifyTargetHintFromAppName('TradingView');
  const expectedKeywords = mergeUniqueKeywords(
    extractTradingViewObservationKeywords(textSignals),
    alertIntent ? tradingViewTarget.dialogKeywords : [],
    (timeframeIntent || drawingIntent) ? tradingViewTarget.chartKeywords : [],
    drawingIntent ? tradingViewTarget.drawingKeywords : [],
    indicatorIntent ? tradingViewTarget.indicatorKeywords : [],
    pineIntent ? tradingViewTarget.pineKeywords : [],
    domIntent ? tradingViewTarget.domKeywords : []
  );
  const expectedTitleHints = Array.from(new Set([
    ...(Array.isArray(tradingViewTarget.dialogTitleHints) ? tradingViewTarget.dialogTitleHints : []),
    ...(Array.isArray(tradingViewTarget.titleHints) ? tradingViewTarget.titleHints : [])
  ]));

  const classification = alertIntent
    ? 'dialog-open'
    : (pineIntent || domIntent)
      ? 'panel-open'
      : inputSurfaceIntent
        ? 'input-surface-open'
        : 'chart-state';

  return {
    classification,
    requiresObservedChange: nextAction?.type === 'type' && !pineIntent && !domIntent,
    allowWindowHandleChange: classification === 'dialog-open' || classification === 'input-surface-open',
    tradingModeHint: inferTradingViewTradingMode({
      textSignals,
      keywords: expectedKeywords
    }),
    verifyTarget: {
      ...tradingViewTarget,
      popupKeywords: mergeUniqueKeywords(tradingViewTarget.popupKeywords, expectedKeywords),
      titleHints: Array.from(new Set([...(tradingViewTarget.titleHints || []), ...expectedTitleHints]))
    },
    expectedKeywords,
    expectedWindowKinds: (classification === 'chart-state' || classification === 'panel-open')
      ? (tradingViewTarget.preferredWindowKinds || ['main'])
      : (tradingViewTarget.dialogWindowKinds || ['owned', 'palette', 'main'])
  };
}

module.exports = {
  detectTradingViewDomainActionRisk,
  extractTradingViewObservationKeywords,
  inferTradingViewTradingMode,
  inferTradingViewObservationSpec,
  isTradingViewTargetHint
};
