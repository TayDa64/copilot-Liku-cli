const { buildVerifyTargetHintFromAppName } = require('./app-profile');

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeUnique(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .flat()
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function stripIndicatorSuffix(value) {
  return String(value || '')
    .replace(/\b(?:indicator|indicators|study|studies|overlay|oscillator)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQuotedIndicatorName(userMessage = '') {
  const match = String(userMessage || '').match(/["“”'`]{1}([^"“”'`]{2,80})["“”'`]{1}/);
  return stripIndicatorSuffix(match?.[1] || '');
}

function extractPatternIndicatorName(userMessage = '') {
  const text = String(userMessage || '');
  const patterns = [
    /\b(?:add|apply|insert|use|enable)\s+([a-z0-9][a-z0-9 +\-./()]{2,80}?)(?=\s+(?:indicator|study|overlay|oscillator)\b|\s+(?:in|on)\s+tradingview\b|\s+to\s+(?:the\s+)?chart\b|\s*$)/i,
    /\b(?:indicator|study|overlay|oscillator)\s+(?:named\s+)?([a-z0-9][a-z0-9 +\-./()]{2,80}?)(?=\s+(?:in|on)\s+tradingview\b|\s+to\s+(?:the\s+)?chart\b|\s*$)/i,
    /\bsearch\s+for\s+([a-z0-9][a-z0-9 +\-./()]{2,80}?)(?=\s+(?:in|on)\s+tradingview\b|\s+indicator\b|\s*$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const cleaned = stripIndicatorSuffix(match?.[1] || '');
    if (cleaned) return cleaned;
  }

  return null;
}

function extractIndicatorName(userMessage = '') {
  return extractQuotedIndicatorName(userMessage)
    || extractPatternIndicatorName(userMessage)
    || null;
}

function inferTradingViewIndicatorIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const normalized = normalizeTextForMatch(raw);
  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsIndicatorWorkflow = /\bindicator|indicators|study|studies|overlay|oscillator|anchored vwap|volume profile|strategy tester|bollinger bands\b/i.test(raw);
  if (!mentionsTradingView || !mentionsIndicatorWorkflow) return null;

  const indicatorName = extractIndicatorName(raw);
  const openSearchOnly = !/\b(add|apply|insert|use|enable)\b/i.test(raw) || !indicatorName;
  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => {
    const key = String(action?.key || '').trim().toLowerCase();
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    return key === '/' || /indicator/.test(verifyTarget);
  });

  return {
    appName: 'TradingView',
    indicatorName,
    openSearchOnly,
    existingWorkflowSignal,
    reason: openSearchOnly
      ? 'Open TradingView indicator search'
      : `Add TradingView indicator ${indicatorName}`,
    normalizedUserMessage: normalized
  };
}

function buildTradingViewIndicatorWorkflowActions(intent = {}) {
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const indicatorName = String(intent.indicatorName || '').trim();
  const searchKeywords = mergeUnique([
    'indicator',
    'indicators',
    'indicator search',
    'study',
    indicatorName
  ]);

  const actions = [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the indicator workflow',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    {
      type: 'key',
      key: '/',
      reason: indicatorName
        ? `Open TradingView indicator search for ${indicatorName}`
        : 'Open TradingView indicator search',
      verify: {
        kind: 'dialog-visible',
        appName: 'TradingView',
        target: 'indicator-search',
        keywords: searchKeywords
      },
      verifyTarget
    },
    { type: 'wait', ms: 220 }
  ];

  if (!indicatorName || intent.openSearchOnly) {
    return actions;
  }

  actions.push(
    {
      type: 'type',
      text: indicatorName,
      reason: `Search for TradingView indicator ${indicatorName}`
    },
    { type: 'wait', ms: 180 },
    {
      type: 'key',
      key: 'enter',
      reason: `Add TradingView indicator ${indicatorName}`,
      verify: {
        kind: 'indicator-present',
        appName: 'TradingView',
        target: 'indicator-present',
        keywords: mergeUnique([indicatorName])
      },
      verifyTarget
    },
    { type: 'wait', ms: 900 }
  );

  return actions;
}

function maybeRewriteTradingViewIndicatorWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewIndicatorIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksSearchSurface = !actions.some((action) => String(action?.key || '').trim() === '/' || /indicator/i.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksSearchSurface)) {
    return null;
  }

  return buildTradingViewIndicatorWorkflowActions(intent);
}

module.exports = {
  extractIndicatorName,
  inferTradingViewIndicatorIntent,
  buildTradingViewIndicatorWorkflowActions,
  maybeRewriteTradingViewIndicatorWorkflow
};
