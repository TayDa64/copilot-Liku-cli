const TRADINGVIEW_SHORTCUTS_OFFICIAL_URL = 'https://www.tradingview.com/support/shortcuts/';
const TRADINGVIEW_SHORTCUTS_SECONDARY_URL = 'https://pineify.app/resources/blog/tradingview-hotkeys-the-complete-2025-guide-to-faster-charting-and-execution';
const { mergeAction } = require('../search-surface-contracts');

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function cloneShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return null;
  return cloneValue(shortcut);
}

function createShortcut(definition) {
  const keySequence = Array.isArray(definition.keySequence)
    ? definition.keySequence.map((value) => String(value || '').trim()).filter(Boolean)
    : (definition.key ? [String(definition.key).trim()] : []);
  const key = definition.key !== undefined
    ? definition.key
    : (keySequence.length === 1 ? keySequence[0] : null);
  return Object.freeze({
    ...definition,
    key,
    keySequence: Object.freeze(keySequence),
    aliases: Object.freeze(Array.isArray(definition.aliases) ? definition.aliases : []),
    notes: Object.freeze(Array.isArray(definition.notes) ? definition.notes : []),
    platforms: Object.freeze(Array.isArray(definition.platforms) ? definition.platforms : ['windows', 'linux', 'mac']),
    sourceUrls: Object.freeze(Array.isArray(definition.sourceUrls) ? definition.sourceUrls : []),
    verificationContract: definition.verificationContract && typeof definition.verificationContract === 'object'
      ? Object.freeze(cloneValue(definition.verificationContract))
      : null,
    sourceConfidence: definition.sourceConfidence || 'internal-profile',
    requiresChartFocus: definition.requiresChartFocus !== false,
    fallbackPolicy: definition.fallbackPolicy || 'none',
    automationRoutable: definition.automationRoutable === true
  });
}

const OFFICIAL_PDF_SOURCES = Object.freeze([
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL
]);

const OFFICIAL_AND_SECONDARY_SOURCES = Object.freeze([
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL,
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL
]);

function createOfficialShortcut(definition) {
  return createShortcut({
    sourceConfidence: 'official-pdf',
    sourceUrls: OFFICIAL_PDF_SOURCES,
    ...definition
  });
}

const TRADINGVIEW_SHORTCUTS = Object.freeze({
  'indicator-search': createOfficialShortcut({
    id: 'indicator-search',
    key: '/',
    category: 'stable-default',
    surface: 'indicator-search',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['indicator search', 'study search', 'indicators menu', 'open indicators'],
    notes: ['Stable default TradingView shortcut for opening indicator search from the chart surface.'],
    verificationContract: {
      kind: 'dialog-visible',
      appName: 'TradingView',
      target: 'indicator-search',
      keywords: ['indicator', 'indicators', 'study', 'studies']
    },
    fallbackPolicy: 'verified-search-selection'
  }),
  'create-alert': createOfficialShortcut({
    id: 'create-alert',
    key: 'alt+a',
    category: 'stable-default',
    surface: 'create-alert',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['alert dialog', 'create alert', 'new alert', 'add alert'],
    notes: ['Stable default TradingView shortcut for opening the Create Alert dialog.'],
    verificationContract: {
      kind: 'dialog-visible',
      appName: 'TradingView',
      target: 'create-alert',
      keywords: ['alert', 'create alert']
    },
    fallbackPolicy: 'none'
  }),
  'symbol-search': createOfficialShortcut({
    id: 'symbol-search',
    key: 'ctrl+k',
    category: 'stable-default',
    surface: 'quick-search',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['symbol search', 'quick search', 'command palette', 'search symbols'],
    notes: ['TradingView quick search opener.'],
    verificationContract: {
      kind: 'dialog-visible',
      appName: 'TradingView',
      target: 'quick-search',
      keywords: ['quick search', 'symbol search', 'search']
    },
    fallbackPolicy: 'none'
  }),
  'open-data-window': createOfficialShortcut({
    id: 'open-data-window',
    key: 'alt+d',
    category: 'stable-default',
    surface: 'data-window',
    safety: 'safe',
    aliases: ['data window', 'open data window'],
    notes: ['Official chart data window shortcut.']
  }),
  'load-layout': createOfficialShortcut({
    id: 'load-layout',
    key: '.',
    category: 'reference-only',
    surface: 'layout',
    safety: 'safe',
    aliases: ['load layout', 'open saved layout', 'saved layout', 'load chart layout'],
    notes: ['Official layout loading shortcut.']
  }),
  'save-layout': createOfficialShortcut({
    id: 'save-layout',
    key: 'ctrl+s',
    category: 'reference-only',
    surface: 'layout',
    safety: 'safe',
    aliases: ['save your layout', 'save layout', 'save chart layout'],
    notes: ['Official layout save shortcut; do not confuse with Pine script save inside the editor.']
  }),
  'dismiss-surface': createOfficialShortcut({
    id: 'dismiss-surface',
    key: 'esc',
    category: 'stable-default',
    surface: 'dismiss-surface',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['dismiss', 'close popup', 'close dialog'],
    notes: ['Useful for dismissing dialogs or transient surfaces when TradingView focus is verified.']
  }),
  'toggle-maximize-chart': createOfficialShortcut({
    id: 'toggle-maximize-chart',
    key: 'alt+enter',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['toggle maximize chart', 'maximize chart'],
    notes: ['Official chart maximize shortcut.']
  }),
  'go-to-date': createOfficialShortcut({
    id: 'go-to-date',
    key: 'alt+g',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['go to date'],
    notes: ['Official go-to-date shortcut.']
  }),
  'add-text-note': createOfficialShortcut({
    id: 'add-text-note',
    key: 'alt+n',
    category: 'reference-only',
    surface: 'chart-annotation',
    safety: 'safe',
    aliases: ['add text note', 'text note'],
    notes: ['Official chart text note shortcut; not a Pine workflow shortcut.']
  }),
  'take-snapshot': createOfficialShortcut({
    id: 'take-snapshot',
    key: 'alt+s',
    category: 'reference-only',
    surface: 'chart-capture',
    safety: 'safe',
    aliases: ['snapshot', 'take snapshot', 'chart snapshot', 'copy link to the chart image'],
    notes: ['Official chart snapshot link shortcut.']
  }),
  'save-chart-image': createOfficialShortcut({
    id: 'save-chart-image',
    key: 'alt+ctrl+s',
    category: 'reference-only',
    surface: 'chart-capture',
    safety: 'safe',
    aliases: ['save chart image'],
    notes: ['Official chart image save shortcut.']
  }),
  'copy-chart-image': createOfficialShortcut({
    id: 'copy-chart-image',
    key: 'shift+ctrl+s',
    category: 'reference-only',
    surface: 'chart-capture',
    safety: 'safe',
    aliases: ['copy chart image'],
    notes: ['Official chart image copy shortcut.']
  }),
  'reset-chart-zoom': createOfficialShortcut({
    id: 'reset-chart-zoom',
    key: 'alt+r',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['reset chart zoom', 'reset zoom', 'reset chart view'],
    notes: ['Official chart view reset shortcut.']
  }),
  'invert-chart': createOfficialShortcut({
    id: 'invert-chart',
    key: 'alt+i',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['invert chart', 'invert series scale'],
    notes: ['Official invert-series shortcut.']
  }),
  'enter-full-screen': createOfficialShortcut({
    id: 'enter-full-screen',
    key: 'shift+f',
    category: 'reference-only',
    surface: 'chart-view',
    safety: 'safe',
    aliases: ['full screen', 'fullscreen', 'fullscreen mode'],
    notes: ['Official fullscreen shortcut.']
  }),
  'add-symbol-to-watchlist': createOfficialShortcut({
    id: 'add-symbol-to-watchlist',
    key: 'alt+w',
    category: 'reference-only',
    surface: 'watchlist',
    safety: 'safe',
    aliases: ['add to watchlist', 'watchlist shortcut', 'watchlist'],
    notes: ['Official add-to-watchlist shortcut.']
  }),
  'open-pine-editor': createOfficialShortcut({
    id: 'open-pine-editor',
    key: null,
    keySequence: [],
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['pine editor', 'open pine editor', 'pine script editor'],
    notes: ['No dedicated official Pine Editor opener is exposed in the PDF; route through official TradingView quick search and verify the editor before typing.'],
    verificationContract: {
      kind: 'editor-active',
      appName: 'TradingView',
      target: 'pine-editor',
      keywords: ['pine', 'pine editor', 'script'],
      requiresObservedChange: true
    },
    fallbackPolicy: 'bounded-search-selection'
  }),
  'new-pine-indicator': createOfficialShortcut({
    id: 'new-pine-indicator',
    key: null,
    keySequence: ['ctrl+k', 'ctrl+i'],
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['new indicator', 'new pine indicator', 'create fresh indicator'],
    notes: ['Official Pine editor command for creating a fresh indicator.'],
    verificationContract: {
      kind: 'editor-active',
      appName: 'TradingView',
      target: 'pine-editor',
      keywords: ['pine', 'pine editor', 'script'],
      requiresObservedChange: true
    },
    fallbackPolicy: 'none'
  }),
  'new-pine-strategy': createOfficialShortcut({
    id: 'new-pine-strategy',
    key: null,
    keySequence: ['ctrl+k', 'ctrl+s'],
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    aliases: ['new strategy', 'new pine strategy'],
    notes: ['Official Pine editor command for creating a fresh strategy script.']
  }),
  'open-pine-script': createOfficialShortcut({
    id: 'open-pine-script',
    key: 'ctrl+o',
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    aliases: ['open script', 'open pine script'],
    notes: ['Official Pine editor open-script shortcut.']
  }),
  'save-pine-script': createOfficialShortcut({
    id: 'save-pine-script',
    key: 'ctrl+s',
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['save script', 'save pine script'],
    notes: ['Official Pine editor save shortcut.'],
    verificationContract: {
      kind: 'status-visible',
      appName: 'TradingView',
      target: 'pine-editor',
      keywords: ['pine', 'save', 'save script', 'script', 'script name', 'save as', 'rename script'],
      titleHints: ['Save', 'Save script', 'Script name', 'Save As', 'Rename script'],
      windowKinds: ['owned', 'palette', 'main'],
      requiresObservedChange: false
    },
    fallbackPolicy: 'none'
  }),
  'add-pine-to-chart': createOfficialShortcut({
    id: 'add-pine-to-chart',
    key: 'ctrl+enter',
    category: 'context-dependent',
    surface: 'pine-editor',
    safety: 'safe',
    automationRoutable: true,
    aliases: ['add to chart', 'update on chart', 'apply pine to chart', 'apply script'],
    notes: ['Official Pine editor add/update-on-chart shortcut.'],
    verificationContract: {
      kind: 'editor-active',
      appName: 'TradingView',
      target: 'pine-editor',
      keywords: ['pine', 'add to chart', 'publish script', 'strategy tester']
    },
    fallbackPolicy: 'none'
  }),
  'show-command-palette': createOfficialShortcut({
    id: 'show-command-palette',
    key: 'f1',
    category: 'context-dependent',
    surface: 'command-palette',
    safety: 'safe',
    aliases: ['show command palette', 'command palette'],
    notes: ['Official Pine/code editor command palette shortcut.']
  }),
  'show-command-palette-alias': createOfficialShortcut({
    id: 'show-command-palette-alias',
    key: 'ctrl+shift+p',
    category: 'context-dependent',
    surface: 'command-palette',
    safety: 'safe',
    aliases: ['command palette alias'],
    notes: ['Official Pine/code editor command palette alias shortcut.']
  }),
  'toggle-console': createOfficialShortcut({
    id: 'toggle-console',
    key: 'ctrl+`',
    category: 'reference-only',
    surface: 'pine-editor',
    safety: 'safe',
    aliases: ['toggle console'],
    notes: ['Official Pine/code editor console toggle shortcut.']
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
    sourceUrls: OFFICIAL_AND_SECONDARY_SOURCES
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

function buildTradingViewShortcutMetadata(shortcut) {
  if (!shortcut) return null;
  return {
    id: shortcut.id,
    category: shortcut.category,
    surface: shortcut.surface,
    safety: shortcut.safety,
    sourceConfidence: shortcut.sourceConfidence,
    keySequence: Array.isArray(shortcut.keySequence) ? [...shortcut.keySequence] : [],
    automationRoutable: !!shortcut.automationRoutable,
    fallbackPolicy: shortcut.fallbackPolicy || 'none',
    requiresChartFocus: shortcut.requiresChartFocus !== false,
    verificationContract: shortcut.verificationContract ? cloneValue(shortcut.verificationContract) : null
  };
}

function matchesTradingViewShortcutAction(action, id) {
  if (!action || typeof action !== 'object') return false;
  const resolvedId = resolveTradingViewShortcutId(id);
  if (!resolvedId) return false;
  if (String(action?.tradingViewShortcut?.id || '').trim().toLowerCase() === resolvedId) return true;
  if (String(action.type || '').trim().toLowerCase() !== 'key') return false;
  const key = getTradingViewShortcutKey(resolvedId);
  if (!key) return false;
  return normalizeKey(action.key) === normalizeKey(key);
}

function buildTradingViewShortcutAction(id, overrides = {}) {
  const shortcut = getTradingViewShortcut(id);
  if (!shortcut || !shortcut.key || (Array.isArray(shortcut.keySequence) && shortcut.keySequence.length > 1)) return null;
  return {
    type: 'key',
    key: shortcut.key,
    tradingViewShortcut: buildTradingViewShortcutMetadata(shortcut),
    ...overrides
  };
}

function buildTradingViewShortcutSequenceRoute(shortcut, overrides = {}) {
  const keySequence = Array.isArray(shortcut?.keySequence)
    ? shortcut.keySequence.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (keySequence.length === 0) return null;

  const routeMetadata = buildTradingViewShortcutMetadata(shortcut);
  const actions = [];
  const finalActionOverrides = overrides.finalActionOverrides && typeof overrides.finalActionOverrides === 'object'
    ? overrides.finalActionOverrides
    : {};
  const perStepOverrides = Array.isArray(overrides.stepActionOverrides) ? overrides.stepActionOverrides : [];
  const stepReasons = Array.isArray(overrides.stepReasons) ? overrides.stepReasons : [];
  const interStepWaitMs = Number.isFinite(Number(overrides.interStepWaitMs)) ? Number(overrides.interStepWaitMs) : 140;

  keySequence.forEach((key, index) => {
    const isLast = index === keySequence.length - 1;
    const baseAction = {
      type: 'key',
      key,
      reason: stepReasons[index]
        || (isLast
          ? overrides.reason || `Execute TradingView shortcut ${shortcut.id}`
          : `Execute TradingView shortcut step ${index + 1} for ${shortcut.surface}`),
      tradingViewShortcut: routeMetadata
    };
    if (isLast) {
      if (overrides.verify || shortcut.verificationContract) {
        baseAction.verify = cloneValue(overrides.verify || shortcut.verificationContract);
      }
      if (overrides.verifyTarget) {
        baseAction.verifyTarget = cloneValue(overrides.verifyTarget);
      }
    }

    const actionOverrides = isLast ? finalActionOverrides : (perStepOverrides[index] || null);
    actions.push(mergeAction(baseAction, actionOverrides));

    if (!isLast) {
      actions.push({ type: 'wait', ms: interStepWaitMs });
    }
  });

  const finalWaitMs = Number.isFinite(Number(overrides.finalWaitMs)) ? Number(overrides.finalWaitMs) : 220;
  if (finalWaitMs > 0) {
    actions.push({ type: 'wait', ms: finalWaitMs });
  }
  return actions;
}

function buildTradingViewShortcutRoute(id, overrides = {}) {
  const shortcut = getTradingViewShortcut(id);
  if (!shortcut) return null;

  if (shortcut.id === 'open-pine-editor') {
    const quickSearchAction = buildTradingViewShortcutAction('symbol-search', {
      reason: overrides.searchReason || 'Open TradingView quick search before selecting Pine Editor'
    });
    if (!quickSearchAction) return null;

    const routeMetadata = {
      ...buildTradingViewShortcutMetadata(shortcut),
      route: 'quick-search'
    };

    const selectionActionOverrides = overrides.selectionActionOverrides && typeof overrides.selectionActionOverrides === 'object'
      ? overrides.selectionActionOverrides
      : (overrides.enterActionOverrides && typeof overrides.enterActionOverrides === 'object'
        ? overrides.enterActionOverrides
        : {});
    const queryActionOverrides = overrides.queryActionOverrides && typeof overrides.queryActionOverrides === 'object'
      ? overrides.queryActionOverrides
      : (overrides.typeActionOverrides && typeof overrides.typeActionOverrides === 'object'
        ? overrides.typeActionOverrides
        : {});

    return [
      mergeAction(quickSearchAction, { searchSurfaceContract: routeMetadata }),
      { type: 'wait', ms: Number.isFinite(Number(overrides.searchWaitMs)) ? Number(overrides.searchWaitMs) : 220 },
      mergeAction({
        type: 'type',
        text: overrides.searchText || 'Pine Editor',
        reason: overrides.typeReason || 'Search for Pine Editor in TradingView quick search',
        searchSurfaceContract: routeMetadata,
        tradingViewShortcut: routeMetadata
      }, queryActionOverrides),
      { type: 'wait', ms: Number.isFinite(Number(overrides.commitWaitMs)) ? Number(overrides.commitWaitMs) : 260 },
      mergeAction({
        type: 'key',
        key: 'enter',
        reason: overrides.selectionReason || overrides.enterReason || 'Select the highlighted Pine Editor result in TradingView quick search',
        verify: selectionActionOverrides.verify || cloneValue(shortcut.verificationContract) || {
          kind: 'editor-active',
          appName: 'TradingView',
          target: 'pine-editor',
          keywords: ['pine', 'pine editor', 'script'],
          requiresObservedChange: true
        },
        verifyTarget: selectionActionOverrides.verifyTarget,
        searchSurfaceContract: routeMetadata,
        tradingViewShortcut: routeMetadata
      }, selectionActionOverrides),
      { type: 'wait', ms: Number.isFinite(Number(overrides.selectionWaitMs)) ? Number(overrides.selectionWaitMs) : 220 }
    ];
  }

  return buildTradingViewShortcutSequenceRoute(shortcut, overrides);
}

module.exports = {
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL,
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL,
  buildTradingViewShortcutAction,
  buildTradingViewShortcutMetadata,
  buildTradingViewShortcutRoute,
  getTradingViewShortcut,
  getTradingViewShortcutKey,
  getTradingViewShortcutMatchTerms,
  listTradingViewShortcuts,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction,
  resolveTradingViewShortcutId
};
