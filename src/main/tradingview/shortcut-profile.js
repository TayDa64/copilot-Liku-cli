const TRADINGVIEW_SHORTCUTS_OFFICIAL_URL = 'https://www.tradingview.com/support/shortcuts/';
const TRADINGVIEW_SHORTCUTS_SECONDARY_URL = 'https://pineify.app/resources/blog/tradingview-hotkeys-the-complete-2025-guide-to-faster-charting-and-execution';

function cloneShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  return {
    ...shortcut,
    aliases: Array.isArray(shortcut.aliases) ? [...shortcut.aliases] : [],
    notes: Array.isArray(shortcut.notes) ? [...shortcut.notes] : [],
    platforms: Array.isArray(shortcut.platforms) ? [...shortcut.platforms] : [],
    sourceUrls: Array.isArray(shortcut.sourceUrls) ? [...shortcut.sourceUrls] : []
  };
}

function createShortcut(definition) {
  return Object.freeze({
    ...definition,
    aliases: Object.freeze(Array.isArray(definition.aliases) ? definition.aliases : []),
    notes: Object.freeze(Array.isArray(definition.notes) ? definition.notes : []),
    platforms: Object.freeze(Array.isArray(definition.platforms) ? definition.platforms : ['windows', 'linux', 'mac']),
    sourceUrls: Object.freeze(Array.isArray(definition.sourceUrls) ? definition.sourceUrls : []),
    sourceConfidence: definition.sourceConfidence || 'internal-profile'
  });
}

const OFFICIAL_AND_SECONDARY_SOURCES = Object.freeze([
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL,
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL
]);

const SECONDARY_REFERENCE_ONLY_SOURCES = Object.freeze([
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL
]);

const TRADINGVIEW_SHORTCUTS = Object.freeze({
  'indicator-search': createShortcut({
    id: 'indicator-search',
    key: '/',
    category: 'stable-default',
    surface: 'indicator-search',
    safety: 'safe',
    aliases: ['indicator search', 'study search', 'indicators menu', 'open indicators'],
    notes: ['Stable default TradingView search opener for indicators and studies when the chart surface is verified.'],
    sourceConfidence: 'official-and-secondary',
    sourceUrls: OFFICIAL_AND_SECONDARY_SOURCES
  }),
  'create-alert': createShortcut({
    id: 'create-alert',
    key: 'alt+a',
    category: 'stable-default',
    surface: 'create-alert',
    safety: 'safe',
    aliases: ['alert dialog', 'create alert', 'new alert'],
    notes: ['Stable default TradingView shortcut for opening the Create Alert dialog.'],
    sourceConfidence: 'official-and-secondary',
    sourceUrls: OFFICIAL_AND_SECONDARY_SOURCES
  }),
  'symbol-search': createShortcut({
    id: 'symbol-search',
    key: 'ctrl+k',
    category: 'stable-default',
    surface: 'quick-search',
    safety: 'safe',
    aliases: ['symbol search', 'quick search', 'command palette', 'search symbols'],
    notes: ['Treat as TradingView-specific tool knowledge rather than a generic desktop shortcut.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'dismiss-surface': createShortcut({
    id: 'dismiss-surface',
    key: 'esc',
    category: 'stable-default',
    surface: 'dismiss-surface',
    safety: 'safe',
    aliases: ['dismiss', 'close popup', 'close dialog'],
    notes: ['Useful for dismissing dialogs or search surfaces when TradingView focus is verified.'],
    sourceConfidence: 'official-page-family',
    sourceUrls: [TRADINGVIEW_SHORTCUTS_OFFICIAL_URL]
  }),
  'open-pine-editor': createShortcut({
    id: 'open-pine-editor',
    key: 'ctrl+e',
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    aliases: ['pine editor', 'open pine editor', 'pine script editor'],
    notes: ['Requires verified TradingView focus and should not be treated as a universal desktop shortcut.'],
    sourceConfidence: 'internal-profile',
    sourceUrls: [TRADINGVIEW_SHORTCUTS_OFFICIAL_URL]
  }),
  'open-object-tree': createShortcut({
    id: 'open-object-tree',
    key: 'ctrl+shift+o',
    category: 'context-dependent',
    surface: 'object-tree',
    safety: 'safe',
    aliases: ['object tree'],
    notes: ['Treat as TradingView-specific and verify the resulting surface before typing.'],
    sourceConfidence: 'internal-profile',
    sourceUrls: [TRADINGVIEW_SHORTCUTS_OFFICIAL_URL]
  }),
  'drawing-tool-binding': createShortcut({
    id: 'drawing-tool-binding',
    key: null,
    category: 'customizable',
    surface: 'drawing-tool',
    safety: 'safe',
    aliases: ['trend line shortcut', 'drawing shortcut', 'drawing tool shortcut'],
    notes: ['Drawing tool bindings may be user-customized and should be treated as unknown until confirmed.'],
    sourceConfidence: 'official-page-family',
    sourceUrls: [TRADINGVIEW_SHORTCUTS_OFFICIAL_URL]
  }),
  'open-dom-panel': createShortcut({
    id: 'open-dom-panel',
    key: 'ctrl+d',
    category: 'context-dependent',
    surface: 'dom-panel',
    safety: 'paper-test-only',
    aliases: ['depth of market', 'dom'],
    notes: ['Treat Trading Panel and DOM shortcuts as app-specific and advisory-safe only.'],
    sourceConfidence: 'internal-profile',
    sourceUrls: [TRADINGVIEW_SHORTCUTS_OFFICIAL_URL]
  }),
  'open-paper-trading': createShortcut({
    id: 'open-paper-trading',
    key: 'alt+t',
    category: 'context-dependent',
    surface: 'paper-trading-panel',
    safety: 'paper-test-only',
    aliases: ['paper trading', 'paper account'],
    notes: ['Paper Trading shortcuts should remain bounded to verified paper-assist flows.'],
    sourceConfidence: 'internal-profile',
    sourceUrls: [TRADINGVIEW_SHORTCUTS_OFFICIAL_URL]
  }),
  'save-layout': createShortcut({
    id: 'save-layout',
    key: 'ctrl+s',
    category: 'reference-only',
    surface: 'layout',
    safety: 'safe',
    aliases: ['save your layout', 'save layout'],
    notes: ['Useful reference shortcut for layout management, but not currently routed into automated workflows.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'load-layout': createShortcut({
    id: 'load-layout',
    key: '.',
    category: 'reference-only',
    surface: 'layout',
    safety: 'safe',
    aliases: ['load layout', 'open saved layout', 'saved layout'],
    notes: ['Reference-only layout shortcut from secondary guidance; keep automation usage explicit and verified.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'take-snapshot': createShortcut({
    id: 'take-snapshot',
    key: 'alt+s',
    category: 'reference-only',
    surface: 'chart-capture',
    safety: 'safe',
    aliases: ['snapshot', 'take snapshot', 'chart snapshot'],
    notes: ['Reference-only chart capture shortcut; prefer existing bounded screenshot flows for automation.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'reset-chart-zoom': createShortcut({
    id: 'reset-chart-zoom',
    key: 'alt+r',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['reset chart zoom', 'reset zoom'],
    notes: ['Reference-only chart view shortcut from secondary guidance.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'add-symbol-to-watchlist': createShortcut({
    id: 'add-symbol-to-watchlist',
    key: 'alt+w',
    category: 'reference-only',
    surface: 'watchlist',
    safety: 'safe',
    aliases: ['add to watchlist', 'watchlist shortcut', 'watchlist'],
    notes: ['Reference-only watchlist shortcut from secondary guidance; explicit verification should precede any automated follow-up typing.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'invert-chart': createShortcut({
    id: 'invert-chart',
    key: 'alt+i',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['invert chart'],
    notes: ['Reference-only chart view shortcut from secondary guidance.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  }),
  'enter-full-screen': createShortcut({
    id: 'enter-full-screen',
    key: 'f11',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['full screen', 'fullscreen'],
    notes: ['Reference-only view shortcut; use only when fullscreen transitions are explicitly requested and safe.'],
    sourceConfidence: 'secondary-reference',
    sourceUrls: SECONDARY_REFERENCE_ONLY_SOURCES
  })
});

function listTradingViewShortcuts() {
  return Object.values(TRADINGVIEW_SHORTCUTS).map(cloneShortcut);
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeShortcutPhrase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveTradingViewShortcutId(value) {
  const normalized = normalizeKey(value);
  if (!normalized) return null;
  if (TRADINGVIEW_SHORTCUTS[normalized]) return normalized;

  const match = Object.values(TRADINGVIEW_SHORTCUTS).find((shortcut) =>
    normalizeKey(shortcut.id) === normalized
    || normalizeKey(shortcut.surface) === normalized
    || (Array.isArray(shortcut.aliases) && shortcut.aliases.some((alias) => normalizeKey(alias) === normalized))
  );

  return match?.id || null;
}

function getTradingViewShortcut(id) {
  const resolvedId = resolveTradingViewShortcutId(id);
  return cloneShortcut(resolvedId ? TRADINGVIEW_SHORTCUTS[resolvedId] : null);
}

function getTradingViewShortcutMatchTerms(id) {
  const shortcut = getTradingViewShortcut(id);
  return Array.from(new Set([
    shortcut?.id,
    shortcut?.surface,
    ...(Array.isArray(shortcut?.aliases) ? shortcut.aliases : [])
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function messageMentionsTradingViewShortcut(value, id) {
  const normalizedMessage = normalizeShortcutPhrase(value);
  const resolvedId = resolveTradingViewShortcutId(id);
  if (!normalizedMessage || !resolvedId) return false;

  return getTradingViewShortcutMatchTerms(resolvedId)
    .map((term) => normalizeShortcutPhrase(term))
    .some((term) => term && normalizedMessage.includes(term));
}

function getTradingViewShortcutKey(id) {
  return getTradingViewShortcut(id)?.key || null;
}

function matchesTradingViewShortcutAction(action, id) {
  if (!action || typeof action !== 'object') return false;
  if (String(action.type || '').trim().toLowerCase() !== 'key') return false;
  const key = getTradingViewShortcutKey(id);
  if (!key) return false;
  return normalizeKey(action.key) === normalizeKey(key);
}

function buildTradingViewShortcutAction(id, overrides = {}) {
  const shortcut = getTradingViewShortcut(id);
  if (!shortcut || !shortcut.key) return null;
  return {
    type: 'key',
    key: shortcut.key,
    tradingViewShortcut: {
      id: shortcut.id,
      category: shortcut.category,
      surface: shortcut.surface,
      safety: shortcut.safety,
      sourceConfidence: shortcut.sourceConfidence
    },
    ...overrides
  };
}

module.exports = {
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL,
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL,
  buildTradingViewShortcutAction,
  getTradingViewShortcut,
  getTradingViewShortcutKey,
  getTradingViewShortcutMatchTerms,
  listTradingViewShortcuts,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction,
  resolveTradingViewShortcutId
};
