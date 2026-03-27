const DEFAULT_VERIFY_POPUP_KEYWORDS = [
  'license', 'activation', 'signin', 'login', 'update', 'setup', 'installer', 'warning', 'permission', 'eula', 'project', 'new project', 'open project', 'workspace'
];

const APP_NAME_PROFILES = [
  {
    displayName: 'TradingView',
    launchQuery: 'TradingView',
    aliases: ['tradingview', 'trading view', 'tradeingview', 'tradeing view'],
    processNames: ['tradingview'],
    titleHints: ['TradingView', 'TradingView Desktop', 'Create Alert - TradingView', 'Alerts - TradingView', 'Pine Editor', 'Depth of Market', 'Object Tree', 'Paper Trading', 'Trading Panel'],
    popupKeywords: ['signin', 'login', 'update', 'workspace', 'chart', 'alert', 'create alert', 'time interval', 'interval', 'symbol search', 'indicator', 'pine editor', 'depth of market', 'dom', 'order book', 'drawing tools', 'object tree', 'paper trading', 'paper account', 'trading panel'],
    dialogTitleHints: ['Create Alert', 'Alerts', 'Alert', 'Time Interval', 'Interval', 'Indicators', 'Symbol Search', 'Pine Editor', 'Depth of Market', 'DOM', 'Object Tree', 'Paper Trading', 'Trading Panel'],
    chartKeywords: ['chart', 'timeframe', 'time frame', 'interval', 'symbol', 'watchlist', 'indicator', '5m', '15m', '1h', '4h', '1d', 'drawing', 'drawings', 'trend line', 'anchored vwap', 'volume profile', 'dom', 'order book', 'pine editor', 'paper trading', 'trading panel'],
    dialogKeywords: ['alert', 'create alert', 'alerts', 'interval', 'time interval', 'indicator', 'symbol', 'pine editor', 'dom', 'depth of market', 'order book', 'object tree', 'paper trading', 'paper account', 'trading panel'],
    drawingKeywords: ['drawing', 'drawings', 'trend line', 'ray', 'extended line', 'pitchfork', 'fibonacci', 'fib', 'brush', 'rectangle', 'ellipse', 'path', 'polyline', 'measure', 'anchored text', 'note', 'anchored vwap', 'anchored volume profile', 'fixed range volume profile', 'object tree'],
    indicatorKeywords: ['indicator', 'indicators', 'study', 'studies', 'overlay', 'oscillator', 'anchored vwap', 'volume profile', 'fixed range volume profile', 'strategy tester'],
    pineKeywords: ['pine', 'pine editor', 'script', 'scripts', 'add to chart', 'publish script', 'version history', 'pine logs', 'profiler', 'strategy tester'],
    domKeywords: ['dom', 'depth of market', 'order book', 'trading panel', 'tier 2', 'level 2', 'buy mkt', 'sell mkt', 'limit order', 'stop order', 'flatten', 'reverse', 'cxl all'],
    paperKeywords: ['paper trading', 'paper account', 'demo trading', 'simulated', 'practice', 'trading panel'],
    preferredWindowKinds: ['main', 'owned', 'palette'],
    dialogWindowKinds: ['owned', 'palette', 'main']
  },
  {
    displayName: 'Visual Studio Code',
    launchQuery: 'Visual Studio Code',
    aliases: ['visual studio code', 'vs code', 'vscode', 'code'],
    processNames: ['code'],
    titleHints: ['Visual Studio Code', 'VS Code']
  },
  {
    displayName: 'Microsoft Edge',
    launchQuery: 'Microsoft Edge',
    aliases: ['microsoft edge', 'edge'],
    processNames: ['msedge'],
    titleHints: ['Microsoft Edge', 'Edge']
  },
  {
    displayName: 'Google Chrome',
    launchQuery: 'Google Chrome',
    aliases: ['google chrome', 'chrome'],
    processNames: ['chrome'],
    titleHints: ['Google Chrome', 'Chrome']
  },
  {
    displayName: 'Mozilla Firefox',
    launchQuery: 'Firefox',
    aliases: ['mozilla firefox', 'firefox'],
    processNames: ['firefox'],
    titleHints: ['Mozilla Firefox', 'Firefox']
  },
  {
    displayName: 'Microsoft Teams',
    launchQuery: 'Microsoft Teams',
    aliases: ['microsoft teams', 'teams', 'ms teams'],
    processNames: ['ms-teams', 'teams'],
    titleHints: ['Microsoft Teams', 'Teams']
  }
];

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeAppIdentityText(value) {
  return normalizeTextForMatch(value).replace(/\s+/g, '');
}

function boundedEditDistance(left, right, maxDistance = 2) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    let rowMin = current[0];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      const value = Math.min(
        previous[j + 1] + 1,
        current[j] + 1,
        previous[j] + cost
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length];
}

function buildBasicProcessCandidates(appName) {
  const raw = String(appName || '').trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, '');
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const candidates = new Set();

  if (compact.length >= 2) candidates.add(compact);
  if (tokens.length) {
    tokens.forEach((token) => {
      if (token.length >= 2) candidates.add(token);
    });
    if (tokens.length >= 2) {
      candidates.add(tokens.join(''));
    }
  }

  return Array.from(candidates).slice(0, 6);
}

function buildBasicTitleHints(appName) {
  const raw = String(appName || '').trim();
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, '');
  return Array.from(new Set([raw, compact].filter(Boolean)));
}

function resolveNormalizedAppIdentity(appName) {
  const requestedName = String(appName || '').trim();
  if (!requestedName) return null;

  const requestedCompact = normalizeAppIdentityText(requestedName);
  let bestProfile = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let matchedBy = 'raw';

  for (const profile of APP_NAME_PROFILES) {
    const aliases = [profile.displayName, profile.launchQuery, ...(profile.aliases || []), ...(profile.processNames || []), ...(profile.titleHints || [])]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    for (const alias of aliases) {
      const aliasCompact = normalizeAppIdentityText(alias);
      if (!aliasCompact) continue;

      let score = Number.NEGATIVE_INFINITY;
      let localMatchedBy = 'none';
      if (requestedCompact === aliasCompact) {
        score = 100;
        localMatchedBy = 'exact';
      } else if (requestedCompact.length >= 5 && aliasCompact.includes(requestedCompact)) {
        score = 90;
        localMatchedBy = 'substring';
      } else if (aliasCompact.length >= 5 && requestedCompact.includes(aliasCompact)) {
        score = 88;
        localMatchedBy = 'superstring';
      } else if (requestedCompact.length >= 6 && Math.abs(requestedCompact.length - aliasCompact.length) <= 2) {
        const distance = boundedEditDistance(requestedCompact, aliasCompact, 2);
        if (distance <= 2) {
          score = 70 - distance;
          localMatchedBy = 'fuzzy';
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestProfile = profile;
        matchedBy = localMatchedBy;
      }
    }
  }

  const displayName = bestProfile?.displayName || requestedName;
  const launchQuery = bestProfile?.launchQuery || displayName;
  const processNames = Array.from(new Set([
    ...(bestProfile?.processNames || []),
    ...buildBasicProcessCandidates(displayName),
    ...buildBasicProcessCandidates(requestedName)
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const titleHints = Array.from(new Set([
    ...(bestProfile?.titleHints || []),
    ...buildBasicTitleHints(displayName),
    ...buildBasicTitleHints(requestedName)
  ].map((value) => String(value || '').trim()).filter(Boolean)));
  const popupKeywords = Array.from(new Set([
    ...DEFAULT_VERIFY_POPUP_KEYWORDS,
    ...(bestProfile?.popupKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const dialogTitleHints = Array.from(new Set([
    ...(bestProfile?.dialogTitleHints || [])
  ].map((value) => String(value || '').trim()).filter(Boolean)));
  const chartKeywords = Array.from(new Set([
    ...(bestProfile?.chartKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const dialogKeywords = Array.from(new Set([
    ...(bestProfile?.dialogKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const drawingKeywords = Array.from(new Set([
    ...(bestProfile?.drawingKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const indicatorKeywords = Array.from(new Set([
    ...(bestProfile?.indicatorKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const pineKeywords = Array.from(new Set([
    ...(bestProfile?.pineKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const domKeywords = Array.from(new Set([
    ...(bestProfile?.domKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const paperKeywords = Array.from(new Set([
    ...(bestProfile?.paperKeywords || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const preferredWindowKinds = Array.from(new Set([
    ...(bestProfile?.preferredWindowKinds || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const dialogWindowKinds = Array.from(new Set([
    ...(bestProfile?.dialogWindowKinds || [])
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));

  return {
    requestedName,
    appName: displayName,
    launchQuery,
    matchedBy,
    processNames,
    titleHints,
    popupKeywords,
    dialogTitleHints,
    chartKeywords,
    dialogKeywords,
    drawingKeywords,
    indicatorKeywords,
    pineKeywords,
    domKeywords,
    paperKeywords,
    preferredWindowKinds,
    dialogWindowKinds
  };
}

function buildProcessCandidatesFromAppName(appName) {
  return resolveNormalizedAppIdentity(appName)?.processNames || [];
}

function buildTitleHintsFromAppName(appName) {
  return resolveNormalizedAppIdentity(appName)?.titleHints || [];
}

function buildVerifyTargetHintFromAppName(appName) {
  const identity = resolveNormalizedAppIdentity(appName);
  return {
    appName: identity?.appName || String(appName || '').trim(),
    requestedAppName: identity?.requestedName || String(appName || '').trim(),
    normalizedAppName: identity?.appName || String(appName || '').trim(),
    launchQuery: identity?.launchQuery || String(appName || '').trim(),
    processNames: identity?.processNames || [],
    titleHints: identity?.titleHints || [],
    popupKeywords: identity?.popupKeywords || [...DEFAULT_VERIFY_POPUP_KEYWORDS],
    dialogTitleHints: identity?.dialogTitleHints || [],
    chartKeywords: identity?.chartKeywords || [],
    dialogKeywords: identity?.dialogKeywords || [],
    drawingKeywords: identity?.drawingKeywords || [],
    indicatorKeywords: identity?.indicatorKeywords || [],
    pineKeywords: identity?.pineKeywords || [],
    domKeywords: identity?.domKeywords || [],
    paperKeywords: identity?.paperKeywords || [],
    preferredWindowKinds: identity?.preferredWindowKinds || [],
    dialogWindowKinds: identity?.dialogWindowKinds || []
  };
}

function buildOpenApplicationActions(appName) {
  const verifyTarget = buildVerifyTargetHintFromAppName(appName);
  const launchQuery = verifyTarget.launchQuery || verifyTarget.appName || String(appName || '').trim();
  return [
    { type: 'key', key: 'win', reason: 'Open Start menu', verifyTarget },
    { type: 'wait', ms: 220 },
    { type: 'type', text: launchQuery, reason: `Search for ${launchQuery}` },
    { type: 'wait', ms: 140 },
    { type: 'key', key: 'enter', reason: `Launch ${launchQuery}`, verifyTarget },
    { type: 'wait', ms: 2200 }
  ];
}

module.exports = {
  APP_NAME_PROFILES,
  DEFAULT_VERIFY_POPUP_KEYWORDS,
  resolveNormalizedAppIdentity,
  buildProcessCandidatesFromAppName,
  buildTitleHintsFromAppName,
  buildVerifyTargetHintFromAppName,
  buildOpenApplicationActions
};
