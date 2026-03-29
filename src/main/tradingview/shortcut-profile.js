function cloneShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  return {
    ...shortcut,
    aliases: Array.isArray(shortcut.aliases) ? [...shortcut.aliases] : [],
    notes: Array.isArray(shortcut.notes) ? [...shortcut.notes] : []
  };
}

const TRADINGVIEW_SHORTCUTS = Object.freeze({
  'indicator-search': Object.freeze({
    id: 'indicator-search',
    key: '/',
    category: 'stable-default',
    surface: 'indicator-search',
    safety: 'safe',
    aliases: Object.freeze(['indicator search', 'study search']),
    notes: Object.freeze(['Stable default TradingView search opener for indicators and studies when the chart surface is verified.'])
  }),
  'create-alert': Object.freeze({
    id: 'create-alert',
    key: 'alt+a',
    category: 'stable-default',
    surface: 'create-alert',
    safety: 'safe',
    aliases: Object.freeze(['alert dialog', 'create alert']),
    notes: Object.freeze(['Stable default TradingView shortcut for opening the Create Alert dialog.'])
  }),
  'symbol-search': Object.freeze({
    id: 'symbol-search',
    key: 'ctrl+k',
    category: 'stable-default',
    surface: 'symbol-search',
    safety: 'safe',
    aliases: Object.freeze(['symbol search']),
    notes: Object.freeze(['Treat as TradingView-specific tool knowledge rather than a generic desktop shortcut.'])
  }),
  'dismiss-surface': Object.freeze({
    id: 'dismiss-surface',
    key: 'esc',
    category: 'stable-default',
    surface: 'dismiss-surface',
    safety: 'safe',
    aliases: Object.freeze(['dismiss', 'close popup']),
    notes: Object.freeze(['Useful for dismissing dialogs or search surfaces when TradingView focus is verified.'])
  }),
  'open-pine-editor': Object.freeze({
    id: 'open-pine-editor',
    key: 'ctrl+e',
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    aliases: Object.freeze(['pine editor', 'open pine editor']),
    notes: Object.freeze(['Requires verified TradingView focus and should not be treated as a universal desktop shortcut.'])
  }),
  'open-object-tree': Object.freeze({
    id: 'open-object-tree',
    key: 'ctrl+shift+o',
    category: 'context-dependent',
    surface: 'object-tree',
    safety: 'safe',
    aliases: Object.freeze(['object tree']),
    notes: Object.freeze(['Treat as TradingView-specific and verify the resulting surface before typing.'])
  }),
  'drawing-tool-binding': Object.freeze({
    id: 'drawing-tool-binding',
    key: null,
    category: 'customizable',
    surface: 'drawing-tool',
    safety: 'safe',
    aliases: Object.freeze(['trend line shortcut', 'drawing shortcut']),
    notes: Object.freeze(['Drawing tool bindings may be user-customized and should be treated as unknown until confirmed.'])
  }),
  'open-dom-panel': Object.freeze({
    id: 'open-dom-panel',
    key: 'ctrl+d',
    category: 'context-dependent',
    surface: 'dom-panel',
    safety: 'paper-test-only',
    aliases: Object.freeze(['depth of market', 'dom']),
    notes: Object.freeze(['Treat Trading Panel and DOM shortcuts as app-specific and advisory-safe only.'])
  }),
  'open-paper-trading': Object.freeze({
    id: 'open-paper-trading',
    key: 'alt+t',
    category: 'context-dependent',
    surface: 'paper-trading-panel',
    safety: 'paper-test-only',
    aliases: Object.freeze(['paper trading']),
    notes: Object.freeze(['Paper Trading shortcuts should remain bounded to verified paper-assist flows.'])
  })
});

function listTradingViewShortcuts() {
  return Object.values(TRADINGVIEW_SHORTCUTS).map(cloneShortcut);
}

function getTradingViewShortcut(id) {
  return cloneShortcut(TRADINGVIEW_SHORTCUTS[String(id || '').trim().toLowerCase()] || null);
}

function getTradingViewShortcutKey(id) {
  return getTradingViewShortcut(id)?.key || null;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
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
      safety: shortcut.safety
    },
    ...overrides
  };
}

module.exports = {
  buildTradingViewShortcutAction,
  getTradingViewShortcut,
  getTradingViewShortcutKey,
  listTradingViewShortcuts,
  matchesTradingViewShortcutAction
};
