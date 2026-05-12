#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  TRADINGVIEW_SHORTCUTS_OFFICIAL_URL,
  TRADINGVIEW_SHORTCUTS_SECONDARY_URL,
  buildTradingViewPineEditorAutomationGuidanceLines,
  buildTradingViewShortcutAction,
  buildTradingViewShortcutRoute,
  getTradingViewShortcut,
  getTradingViewShortcutKey,
  getTradingViewShortcutMatchTerms,
  getTradingViewPineEditorAutomationPolicy,
  listTradingViewShortcuts,
  messageMentionsTradingViewShortcut,
  matchesTradingViewShortcutAction,
  resolveTradingViewShortcutId
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js'));
const {
  TRADINGVIEW_PINE_PROMPT_OVERLAY
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js'));

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

test('stable default TradingView shortcuts are exposed through the profile helper', () => {
  const indicatorSearch = getTradingViewShortcut('indicator-search');
  const createAlert = getTradingViewShortcut('create-alert');
  const quickSearch = getTradingViewShortcut('command palette');
  const dataWindow = getTradingViewShortcut('open-data-window');

  assert(indicatorSearch, 'indicator-search shortcut should exist');
  assert.strictEqual(indicatorSearch.key, '/');
  assert.strictEqual(indicatorSearch.category, 'stable-default');
  assert.deepStrictEqual(indicatorSearch.keySequence, ['/']);
  assert.strictEqual(indicatorSearch.automationRoutable, true);
  assert(createAlert, 'create-alert shortcut should exist');
  assert.strictEqual(createAlert.key, 'alt+a');
  assert.strictEqual(createAlert.category, 'stable-default');
  assert.strictEqual(getTradingViewShortcutKey('symbol-search'), 'ctrl+k');
  assert(quickSearch, 'symbol-search alias should resolve through the profile helper');
  assert.strictEqual(quickSearch.id, 'symbol-search');
  assert.strictEqual(quickSearch.surface, 'quick-search');
  assert(dataWindow, 'data window shortcut should exist');
  assert.strictEqual(dataWindow.key, 'alt+d');
});

test('drawing shortcuts are marked customizable rather than universal', () => {
  const drawingShortcut = getTradingViewShortcut('drawing-tool-binding');
  assert(drawingShortcut, 'drawing shortcut profile should exist');
  assert.strictEqual(drawingShortcut.category, 'customizable');
  assert.strictEqual(drawingShortcut.key, null);
  assert(/customized/i.test(drawingShortcut.notes.join(' ')));
});

test('trading panel shortcuts are context-dependent and paper-test only', () => {
  const domShortcut = getTradingViewShortcut('open-dom-panel');
  const paperShortcut = getTradingViewShortcut('open-paper-trading');

  assert(domShortcut, 'DOM shortcut should exist');
  assert.strictEqual(domShortcut.category, 'context-dependent');
  assert.strictEqual(domShortcut.safety, 'paper-test-only');
  assert(paperShortcut, 'paper trading shortcut should exist');
  assert.strictEqual(paperShortcut.safety, 'paper-test-only');
});

test('buildTradingViewShortcutAction preserves shortcut metadata for workflow actions', () => {
  const action = buildTradingViewShortcutAction('indicator-search', {
    reason: 'Open indicator search'
  });

  assert(action, 'shortcut action should be created');
  assert.strictEqual(action.type, 'key');
  assert.strictEqual(action.key, '/');
  assert.strictEqual(action.tradingViewShortcut.id, 'indicator-search');
  assert.strictEqual(action.tradingViewShortcut.category, 'stable-default');
  assert.strictEqual(action.tradingViewShortcut.surface, 'indicator-search');
  assert(matchesTradingViewShortcutAction(action, 'indicator-search'));
});

test('listTradingViewShortcuts returns the categorized TradingView profile inventory', () => {
  const shortcuts = listTradingViewShortcuts();
  assert(Array.isArray(shortcuts), 'shortcut inventory should be an array');
  assert(shortcuts.length >= 20, 'shortcut inventory should include the expanded TradingView shortcut inventory');
});

test('shortcut profile exposes official chart shortcuts with source provenance', () => {
  const snapshot = getTradingViewShortcut('take snapshot');
  const watchlist = getTradingViewShortcut('add-symbol-to-watchlist');

  assert(snapshot, 'snapshot shortcut should resolve by alias');
  assert.strictEqual(snapshot.key, 'alt+s');
  assert.strictEqual(snapshot.category, 'reference-only');
  assert.strictEqual(snapshot.sourceConfidence, 'official-pdf');
  assert(snapshot.sourceUrls.includes(TRADINGVIEW_SHORTCUTS_OFFICIAL_URL));
  assert(watchlist, 'watchlist shortcut should exist');
  assert.strictEqual(watchlist.key, 'alt+w');
  assert.strictEqual(watchlist.surface, 'watchlist');
});

test('shortcut profile resolves aliases and documents official shortcut references', () => {
  assert.strictEqual(resolveTradingViewShortcutId('command palette'), 'symbol-search');
  assert.strictEqual(resolveTradingViewShortcutId('quick search'), 'symbol-search');
  assert.strictEqual(resolveTradingViewShortcutId('new alert'), 'create-alert');

  const indicatorSearch = getTradingViewShortcut('indicator-search');
  assert(indicatorSearch.sourceUrls.includes(TRADINGVIEW_SHORTCUTS_OFFICIAL_URL));
  assert.strictEqual(indicatorSearch.sourceConfidence, 'official-pdf');
});

test('shortcut profile exposes reusable phrase matching helpers for workflow inference', () => {
  const indicatorTerms = getTradingViewShortcutMatchTerms('indicator-search');
  const alertTerms = getTradingViewShortcutMatchTerms('create-alert');
  const pineEditorTerms = getTradingViewShortcutMatchTerms('open-pine-editor');

  assert(indicatorTerms.includes('study search'));
  assert(indicatorTerms.includes('indicators menu'));
  assert(alertTerms.includes('new alert'));
  assert(pineEditorTerms.includes('pine script editor'));
  assert(messageMentionsTradingViewShortcut('open the study search in tradingview', 'indicator-search'));
  assert(messageMentionsTradingViewShortcut('open a new alert in tradingview', 'create-alert'));
  assert(messageMentionsTradingViewShortcut('open the pine script editor in tradingview', 'open-pine-editor'));
});

test('pine editor shortcut profile exposes semantic icon primary plus explicit direct and quick-search routes', () => {
  const pineEditor = getTradingViewShortcut('open-pine-editor');
  const directAction = buildTradingViewShortcutAction('open-pine-editor');
  const defaultRouteActions = buildTradingViewShortcutRoute('open-pine-editor');
  const directRouteActions = buildTradingViewShortcutRoute('open-pine-editor', { routeStrategy: 'official-direct' });
  const quickSearchRouteActions = buildTradingViewShortcutRoute('open-pine-editor', { routeStrategy: 'quick-search' });

  assert(pineEditor, 'pine editor shortcut profile should exist');
  assert.strictEqual(pineEditor.key, 'ctrl+e', 'chart-focused Pine Editor opener should be Ctrl+E');
  assert(/Ctrl\+E opens the Pine Script editor/i.test(pineEditor.notes.join(' ')), 'pine editor notes should document the chart-focused opener');
  assert.strictEqual(directAction.key, 'ctrl+e', 'pine editor direct action should use the chart-focused opener');
  assert(Array.isArray(defaultRouteActions) && defaultRouteActions[0]?.type === 'click_element', 'default Pine route should use the semantic icon path');
  assert.strictEqual(defaultRouteActions[0]?.text, 'Pine');
  assert.strictEqual(defaultRouteActions[0]?.allowCoordinateFallback, false);
  assert(Array.isArray(directRouteActions) && directRouteActions[0]?.key === 'ctrl+e', 'official-direct route should use Ctrl+E');
  assert(Array.isArray(quickSearchRouteActions) && quickSearchRouteActions.length >= 5, 'pine editor should keep a TradingView quick-search fallback route sequence');
  assert.strictEqual(quickSearchRouteActions[0].key, 'ctrl+k');
  assert.strictEqual(quickSearchRouteActions[6].type, 'type');
  assert.strictEqual(quickSearchRouteActions[6].text, 'Pine Editor');
  assert.strictEqual(quickSearchRouteActions[8].type, 'key');
  assert.strictEqual(quickSearchRouteActions[8].key, 'enter');
});

test('pine editor semantic icon route targets the invokable Pine toolbar button without coordinates', () => {
  const routeActions = buildTradingViewShortcutRoute('open-pine-editor', { routeStrategy: 'semantic-icon' });

  assert(Array.isArray(routeActions) && routeActions.length >= 1, 'semantic icon route should emit an action');
  assert.strictEqual(routeActions[0].type, 'click_element');
  assert.strictEqual(routeActions[0].text, 'Pine');
  assert.strictEqual(routeActions[0].controlType, 'Button');
  assert.strictEqual(routeActions[0].exact, true);
  assert.strictEqual(routeActions[0].allowCoordinateFallback, false);
});

test('pine prompt overlay matches the shortcut policy guidance contract', () => {
  const policy = getTradingViewPineEditorAutomationPolicy();
  const guidanceLines = buildTradingViewPineEditorAutomationGuidanceLines();

  assert.strictEqual(policy.preferredRoute, 'semantic-icon');
  assert.strictEqual(policy.directShortcutRoute?.route, 'official-direct');
  assert.strictEqual(policy.quickSearchFallback?.route, 'quick-search');
  assert.strictEqual(policy.quickSearchFallback?.requiresCommandSurface, true);
  assert.strictEqual(policy.semanticIconRoute?.requiresHostProbe, true);
  assert(TRADINGVIEW_PINE_PROMPT_OVERLAY.includes('host-backed semantic Pine toolbar icon route first'), 'system prompt should make the semantic Pine icon the primary opener');
  guidanceLines.forEach((line) => {
    assert(TRADINGVIEW_PINE_PROMPT_OVERLAY.includes(line), `system prompt should include Pine route guidance line: ${line}`);
  });
});

test('pine authoring shortcuts expose normalized capability metadata and chorded sequences', () => {
  const newIndicator = getTradingViewShortcut('new-pine-indicator');
  const saveScript = getTradingViewShortcut('save-pine-script');
  const addToChart = getTradingViewShortcut('add-pine-to-chart');

  assert(newIndicator, 'new pine indicator shortcut should exist');
  assert.deepStrictEqual(newIndicator.keySequence, ['ctrl+k', 'ctrl+i']);
  assert.strictEqual(newIndicator.key, null);
  assert.strictEqual(newIndicator.automationRoutable, true);
  assert.strictEqual(newIndicator.fallbackPolicy, 'none');
  assert.strictEqual(saveScript.key, 'ctrl+s');
  assert.strictEqual(saveScript.verificationContract.kind, 'status-visible');
  assert.strictEqual(saveScript.verificationContract.requiresObservedChange, false);
  assert(saveScript.verificationContract.titleHints.includes('Script name'));
  assert.strictEqual(addToChart.key, 'ctrl+enter');
  assert.strictEqual(addToChart.automationRoutable, true);
});

test('generic shortcut route builder emits a chord sequence with final verification metadata', () => {
  const routeActions = buildTradingViewShortcutRoute('new-pine-indicator');
  const keyActions = routeActions.filter((action) => action?.type === 'key');

  assert(Array.isArray(routeActions) && routeActions.length >= 4, 'new indicator route should emit multiple steps');
  assert.deepStrictEqual(keyActions.map((action) => action.key), ['ctrl+k', 'ctrl+i']);
  assert.strictEqual(keyActions[0].verify.target, 'quick-search');
  assert.strictEqual(keyActions[0].searchSurfaceContract.route, 'quick-search');
  assert.strictEqual(keyActions[1].verify.kind, 'editor-active');
  assert.strictEqual(keyActions[1].verify.pineSurfaceExpectation, 'fresh-script');
  assert.strictEqual(keyActions[1].tradingViewShortcut.id, 'new-pine-indicator');
});
