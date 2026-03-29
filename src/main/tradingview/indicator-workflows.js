const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const {
  buildTradingViewShortcutAction,
  getTradingViewShortcutKey,
  getTradingViewShortcutMatchTerms,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction
} = require('./shortcut-profile');
const { buildSearchSurfaceSelectionContract } = require('../search-surface-contracts');

const INDICATOR_SEARCH_SHORTCUT = getTradingViewShortcutKey('indicator-search') || '/';

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
  const mentionsIndicatorSearchSurface = messageMentionsTradingViewShortcut(raw, 'indicator-search');
  const mentionsIndicatorWorkflow = /\bindicator|indicators|study|studies|overlay|oscillator|anchored vwap|volume profile|strategy tester|bollinger bands\b/i.test(raw)
    || mentionsIndicatorSearchSurface;
  if (!mentionsTradingView || !mentionsIndicatorWorkflow) return null;

  const indicatorName = extractIndicatorName(raw);
  const openSearchOnly = !/\b(add|apply|insert|use|enable)\b/i.test(raw) || !indicatorName;
  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => {
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    return matchesTradingViewShortcutAction(action, 'indicator-search') || /indicator/.test(verifyTarget);
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
  const indicatorSearchTerms = getTradingViewShortcutMatchTerms('indicator-search');
  const searchKeywords = mergeUnique([
    'indicator',
    'indicators',
    'indicator search',
    'study',
    indicatorSearchTerms,
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
    buildTradingViewShortcutAction('indicator-search', {
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
    }),
    { type: 'wait', ms: 220 }
  ];

  if (!indicatorName || intent.openSearchOnly) {
    return actions;
  }

  actions.push(...buildSearchSurfaceSelectionContract({
    query: indicatorName,
    queryReason: `Search for TradingView indicator ${indicatorName}`,
    queryWaitMs: 180,
    selectionText: indicatorName,
    selectionExact: false,
    selectionReason: `Select the visible TradingView indicator result for ${indicatorName}`,
    selectionVerify: {
      kind: 'indicator-present',
      appName: 'TradingView',
      target: 'indicator-present',
      keywords: mergeUnique([indicatorName])
    },
    selectionVerifyTarget: verifyTarget,
    selectionWaitMs: 900,
    metadata: {
      appName: 'TradingView',
      surface: 'indicator-search',
      contractKind: 'search-result-selection'
    }
  }));

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
  const lacksSearchSurface = !actions.some((action) => matchesTradingViewShortcutAction(action, 'indicator-search') || /indicator/i.test(String(action?.verify?.target || '')));

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
