const { buildVerifyTargetHintFromAppName } = require('./app-profile');
const { extractTradingViewObservationKeywords } = require('./verification');
const {
  getTradingViewShortcutMatchTerms,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction,
} = require('./shortcut-profile');

const TIMEFRAME_UNIT_MAP = new Map([
  ['s', 's'],
  ['sec', 's'],
  ['secs', 's'],
  ['second', 's'],
  ['seconds', 's'],
  ['m', 'm'],
  ['min', 'm'],
  ['mins', 'm'],
  ['minute', 'm'],
  ['minutes', 'm'],
  ['h', 'h'],
  ['hr', 'h'],
  ['hrs', 'h'],
  ['hour', 'h'],
  ['hours', 'h'],
  ['d', 'd'],
  ['day', 'd'],
  ['days', 'd'],
  ['w', 'w'],
  ['wk', 'w'],
  ['wks', 'w'],
  ['week', 'w'],
  ['weeks', 'w'],
  ['mo', 'M'],
  ['mos', 'M'],
  ['month', 'M'],
  ['months', 'M']
]);

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SYMBOL_STOPWORDS = new Set([
  'A',
  'AN',
  'THE',
  'CHART',
  'TRADINGVIEW',
  'PINE',
  'EDITOR',
  'SCRIPT',
  'SCRIPTS'
]);

function mergeUnique(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .flat()
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function normalizeSymbolToken(value = '') {
  const compact = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9._-]+/g, '');
  if (!compact) return null;
  if (compact.length < 1 || compact.length > 15) return null;
  if (SYMBOL_STOPWORDS.has(compact)) return null;
  return compact;
}

function normalizeTimeframeToken(value = '') {
  const compact = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) return null;

  const direct = compact.match(/^([1-9][0-9]{0,2})(s|m|h|d|w|mo)$/i);
  if (direct) {
    const amount = direct[1];
    const unit = direct[2].toLowerCase();
    return `${amount}${unit === 'mo' ? 'M' : unit}`;
  }

  const verbose = String(value || '').trim().toLowerCase().match(/^([1-9][0-9]{0,2})\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|wk|wks|week|weeks|month|months|mo|mos)$/i);
  if (verbose) {
    const amount = verbose[1];
    const mapped = TIMEFRAME_UNIT_MAP.get(verbose[2].toLowerCase());
    return mapped ? `${amount}${mapped}` : null;
  }

  return null;
}

function collectMatches(text = '', pattern) {
  if (!(pattern instanceof RegExp)) return [];
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return Array.from(String(text || '').matchAll(new RegExp(pattern.source, flags)));
}

function extractRequestedTimeframe(userMessage = '') {
  const text = String(userMessage || '');

  const explicitTo = collectMatches(text, /\bto\s+([1-9][0-9]{0,2}\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months))\b/gi);
  if (explicitTo.length) {
    const normalized = normalizeTimeframeToken(explicitTo[explicitTo.length - 1]?.[1] || '');
    if (normalized) return normalized;
  }

  const directPatterns = [
    /\b(?:time\s*frame|timeframe|time\s*interval|interval)\s+(?:to\s+)?([1-9][0-9]{0,2}\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months))\b/i,
    /\b([1-9][0-9]{0,2}\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months))\s+(?:time\s*frame|timeframe|chart)\b/i,
    /\b([1-9][0-9]{0,2}\s*(?:s|m|h|d|w|mo))\b/gi
  ];

  for (const pattern of directPatterns) {
    const matches = collectMatches(text, pattern);
    for (let index = matches.length - 1; index >= 0; index--) {
      const normalized = normalizeTimeframeToken(matches[index]?.[1] || '');
      if (normalized) return normalized;
    }
  }

  return null;
}

function extractRequestedSymbol(userMessage = '') {
  const text = String(userMessage || '');
  const patterns = [
    /\b(?:change|switch|set)\s+(?:the\s+)?(?:symbol|ticker)\s+(?:to\s+)?\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b/i,
    /\b(?:open|search\s+for|find)\s+(?:the\s+)?(?:symbol|ticker)\s+\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b/i,
    /\b(?:symbol|ticker)\s+(?:search\s+for\s+)?\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b/i,
    /\b(?:to|for)\s+(?:the\s+)?\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b(?=[^\n]{0,40}\b(?:in\s+tradingview|on\s+tradingview|chart|ticker|symbol))?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const normalized = normalizeSymbolToken(match?.[1] || '');
    if (normalized) return normalized;
  }

  return null;
}

function extractRequestedWatchlistSymbol(userMessage = '') {
  const text = String(userMessage || '');
  const patterns = [
    /\b(?:select|open|change|switch|set|add)\s+(?:the\s+)?(?:watchlist|watch list)\s+(?:symbol\s+|ticker\s+)?(?:to\s+)?\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b/i,
    /\b(?:watchlist|watch list)\s+(?:symbol\s+|ticker\s+)?(?:for\s+|to\s+)?\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b/i,
    /\b(?:from\s+the\s+watchlist|in\s+the\s+watchlist)\s+\$?([A-Za-z][A-Za-z0-9._-]{0,14})\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const normalized = normalizeSymbolToken(match?.[1] || '');
    if (normalized) return normalized;
  }

  return null;
}

function inferTradingViewTimeframeIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const normalized = normalizeTextForMatch(raw);
  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsTimeframe = /\btime\s*frame|timeframe|time\s*interval|interval|chart\b/i.test(raw);
  if (!mentionsTradingView || !mentionsTimeframe) return null;

  const timeframe = extractRequestedTimeframe(raw);
  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => {
    const key = String(action?.key || '').trim().toLowerCase();
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    return key === 'enter' && /timeframe|chart-state|interval/.test(verifyTarget);
  });

  return {
    appName: 'TradingView',
    timeframe,
    existingWorkflowSignal,
    selectorContext: /\bselector|time\s*interval|interval\b/i.test(raw),
    normalizedUserMessage: normalized,
    reason: timeframe
      ? `Apply TradingView timeframe ${timeframe} with verification`
      : 'Advance the TradingView timeframe workflow with verification'
  };
}

function inferTradingViewSymbolIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const normalized = normalizeTextForMatch(raw);
  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsQuickSearchSurface = messageMentionsTradingViewShortcut(raw, 'symbol-search');
  const mentionsPineWorkflow = /\bpine\b|\bpine editor\b|\bpine script\b|\bscript\b|\bctrl\s*\+\s*enter\b|\badd to chart\b|\bapply to (?:the\s+)?[a-z0-9._-]+\s+chart\b/i.test(raw);
  if (mentionsPineWorkflow) return null;
  const mentionsSymbolFlow = (/\b(symbol|ticker)\b/i.test(raw) && /\b(change|switch|set|open|search|find)\b/i.test(raw))
    || (mentionsQuickSearchSurface && /\b(change|switch|set|open|search|find|use|focus)\b/i.test(raw));
  if (!mentionsTradingView || !mentionsSymbolFlow) return null;

  const symbol = extractRequestedSymbol(raw);
  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => {
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    return matchesTradingViewShortcutAction(action, 'symbol-search') || /symbol|ticker|chart-state/.test(verifyTarget);
  });

  return {
    appName: 'TradingView',
    symbol,
    existingWorkflowSignal,
    searchContext: /\bsearch|find|open\b/i.test(raw) || mentionsQuickSearchSurface,
    normalizedUserMessage: normalized,
    reason: symbol
      ? `Apply TradingView symbol ${symbol} with verification`
      : 'Advance the TradingView symbol workflow with verification'
  };
}

function inferTradingViewWatchlistIntent(userMessage = '', actions = []) {
  const raw = String(userMessage || '').trim();
  if (!raw) return null;

  const normalized = normalizeTextForMatch(raw);
  const mentionsTradingView = /\btradingview|trading view\b/i.test(raw)
    || (Array.isArray(actions) && actions.some((action) => /tradingview/i.test(String(action?.title || '')) || /tradingview/i.test(String(action?.processName || ''))));
  const mentionsWatchlistFlow = /\bwatch\s*list|watchlist\b/i.test(raw) && /\b(select|open|change|switch|set|add)\b/i.test(raw);
  if (!mentionsTradingView || !mentionsWatchlistFlow) return null;

  const symbol = extractRequestedWatchlistSymbol(raw);
  const existingWorkflowSignal = Array.isArray(actions) && actions.some((action) => {
    const verifyTarget = String(action?.verify?.target || '').trim().toLowerCase();
    return /watchlist|symbol|ticker|chart-state/.test(verifyTarget);
  });

  return {
    appName: 'TradingView',
    symbol,
    existingWorkflowSignal,
    normalizedUserMessage: normalized,
    reason: symbol
      ? `Apply TradingView watchlist symbol ${symbol} with verification`
      : 'Advance the TradingView watchlist workflow with verification'
  };
}

function buildTradingViewTimeframeWorkflowActions(intent = {}) {
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const timeframe = String(intent.timeframe || '').trim();
  const expectedKeywords = mergeUnique([
    'timeframe',
    'time interval',
    'interval',
    timeframe,
    extractTradingViewObservationKeywords(`change tradingview timeframe to ${timeframe}`),
    verifyTarget.chartKeywords
  ]);

  return [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the timeframe workflow',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    {
      type: 'type',
      text: timeframe,
      reason: timeframe
        ? `Type TradingView timeframe ${timeframe} into the active timeframe surface`
        : 'Type the requested TradingView timeframe into the active timeframe surface'
    },
    { type: 'wait', ms: 180 },
    {
      type: 'key',
      key: 'enter',
      reason: timeframe
        ? `Confirm TradingView timeframe ${timeframe}`
        : 'Confirm the requested TradingView timeframe',
      verify: {
        kind: 'timeframe-updated',
        appName: 'TradingView',
        target: 'timeframe-updated',
        keywords: expectedKeywords
      },
      verifyTarget
    },
    { type: 'wait', ms: 900 }
  ];
}

function buildTradingViewSymbolWorkflowActions(intent = {}) {
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const symbol = String(intent.symbol || '').trim().toUpperCase();
  const symbolSearchTerms = getTradingViewShortcutMatchTerms('symbol-search');
  const expectedKeywords = mergeUnique([
    'symbol',
    'symbol search',
    'ticker',
    symbol,
    symbolSearchTerms,
    extractTradingViewObservationKeywords(`change tradingview symbol to ${symbol}`),
    verifyTarget.chartKeywords,
    verifyTarget.dialogKeywords
  ]);

  return [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the symbol workflow',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    {
      type: 'type',
      text: symbol,
      reason: symbol
        ? `Type TradingView symbol ${symbol} into the active symbol surface`
        : 'Type the requested TradingView symbol into the active symbol surface'
    },
    { type: 'wait', ms: 180 },
    {
      type: 'key',
      key: 'enter',
      reason: symbol
        ? `Confirm TradingView symbol ${symbol}`
        : 'Confirm the requested TradingView symbol',
      verify: {
        kind: 'symbol-updated',
        appName: 'TradingView',
        target: 'symbol-updated',
        keywords: expectedKeywords
      },
      verifyTarget
    },
    { type: 'wait', ms: 900 }
  ];
}

function buildTradingViewWatchlistWorkflowActions(intent = {}) {
  const verifyTarget = buildVerifyTargetHintFromAppName(intent.appName || 'TradingView');
  const symbol = String(intent.symbol || '').trim().toUpperCase();
  const expectedKeywords = mergeUnique([
    'watchlist',
    'watch list',
    'symbol',
    'ticker',
    symbol,
    extractTradingViewObservationKeywords(`change tradingview watchlist to ${symbol}`),
    verifyTarget.chartKeywords,
    verifyTarget.dialogKeywords
  ]);

  return [
    {
      type: 'bring_window_to_front',
      title: 'TradingView',
      processName: 'tradingview',
      reason: 'Focus TradingView before the watchlist workflow',
      verifyTarget
    },
    { type: 'wait', ms: 650 },
    {
      type: 'type',
      text: symbol,
      reason: symbol
        ? `Type TradingView watchlist symbol ${symbol} into the active watchlist surface`
        : 'Type the requested TradingView watchlist symbol into the active watchlist surface'
    },
    { type: 'wait', ms: 180 },
    {
      type: 'key',
      key: 'enter',
      reason: symbol
        ? `Confirm TradingView watchlist symbol ${symbol}`
        : 'Confirm the requested TradingView watchlist symbol',
      verify: {
        kind: 'watchlist-updated',
        appName: 'TradingView',
        target: 'watchlist-updated',
        keywords: expectedKeywords
      },
      verifyTarget
    },
    { type: 'wait', ms: 900 }
  ];
}

function maybeRewriteTradingViewTimeframeWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewTimeframeIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || !intent.timeframe) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksTimeframeVerification = !actions.some((action) => /timeframe|chart-state|interval/.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksTimeframeVerification)) {
    return null;
  }

  return buildTradingViewTimeframeWorkflowActions(intent);
}

function maybeRewriteTradingViewSymbolWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewSymbolIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || !intent.symbol) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksSymbolVerification = !actions.some((action) =>
    matchesTradingViewShortcutAction(action, 'symbol-search')
    || /symbol|ticker|chart-state/.test(String(action?.verify?.target || ''))
  );

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksSymbolVerification)) {
    return null;
  }

  return buildTradingViewSymbolWorkflowActions(intent);
}

function maybeRewriteTradingViewWatchlistWorkflow(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  const intent = inferTradingViewWatchlistIntent(context.userMessage || '', actions);
  if (!intent || intent.existingWorkflowSignal || !intent.symbol) return null;

  const lowSignalTypes = new Set(['bring_window_to_front', 'focus_window', 'key', 'type', 'wait', 'screenshot']);
  const lowSignal = actions.every((action) => lowSignalTypes.has(action?.type));
  const tinyOrFragmented = actions.length <= 4;
  const screenshotFirst = actions[0]?.type === 'screenshot';
  const lacksWatchlistVerification = !actions.some((action) => /watchlist|symbol|ticker|chart-state/.test(String(action?.verify?.target || '')));

  if (!lowSignal || (!tinyOrFragmented && !screenshotFirst && !lacksWatchlistVerification)) {
    return null;
  }

  return buildTradingViewWatchlistWorkflowActions(intent);
}

module.exports = {
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
};
