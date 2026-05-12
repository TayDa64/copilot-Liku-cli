#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));
const {
  getTradingViewPineEditorAutomationPolicy
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'shortcut-profile.js'));
const {
  createTradingViewPineAuthoringHelpers
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-authoring.js'));
const {
  TRADINGVIEW_PINE_PROMPT_OVERLAY
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js'));
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const {
  writeFailureArtifactBundleSync
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));

const pineAuthoringHelpers = createTradingViewPineAuthoringHelpers({
  rewriteActionsForReliability: (actions) => actions
});

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    try {
      const artifact = writeFailureArtifactBundleSync({
        suiteName: 'test-tradingview-pine-workflows',
        failureName: name,
        phase: 'test',
        error,
        aiService,
        extra: {
          testName: name
        }
      });
      if (artifact?.filePath) {
        console.error(`Artifact: ${artifact.filePath}`);
      }
    } catch (artifactError) {
      console.error(`Artifact capture failed: ${artifactError.message}`);
    }
    process.exitCode = 1;
  }
}

function findVerifiedPineEditorOpener(actions = []) {
  return (Array.isArray(actions) ? actions : []).find((action) =>
    action?.verify?.target === 'pine-editor'
  );
}

function collectWorkflowActions(actions = [], visited = new Set()) {
  const collected = [];
  const visit = (items) => {
    if (!Array.isArray(items)) return;
    for (const action of items) {
      if (!action || typeof action !== 'object' || visited.has(action)) continue;
      visited.add(action);
      collected.push(action);
      visit(action.continueActions);
      if (action.continueActionsByPineEditorState && typeof action.continueActionsByPineEditorState === 'object') {
        Object.values(action.continueActionsByPineEditorState).forEach(visit);
      }
      if (action.continueActionsByPineLifecycleState && typeof action.continueActionsByPineLifecycleState === 'object') {
        Object.values(action.continueActionsByPineLifecycleState).forEach(visit);
      }
    }
  };
  visit(actions);
  return collected;
}

function assertChartFocusBeforeCtrlE(actions = []) {
  const chartFocusIndex = (Array.isArray(actions) ? actions : []).findIndex((action) =>
    action?.type === 'click' && action?.tradingViewChartFocusClick === true
  );
  const openIndex = (Array.isArray(actions) ? actions : []).findIndex((action) =>
    action?.type === 'key'
    && String(action?.key || '').toLowerCase() === 'ctrl+e'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
  );

  assert(chartFocusIndex >= 0, 'direct Ctrl+E workflow should prove chart focus before opening Pine Editor');
  assert(openIndex > chartFocusIndex, 'verified Ctrl+E opener should occur after the chart-focus step');
}

function assertSemanticPineIconRoute(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  const iconIndex = source.findIndex((action) =>
    action?.type === 'click_element'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
    && String(action?.searchSurfaceContract?.route || action?.tradingViewShortcut?.route || '').toLowerCase() === 'semantic-icon'
  );

  assert(iconIndex >= 0, 'semantic Pine workflow should invoke the bounded Pine toolbar icon');
  assert.strictEqual(
    source.some((action) => action?.tradingViewChartFocusClick === true),
    false,
    'semantic Pine route should not require the chart-focus Ctrl+E prelude'
  );

  return {
    iconAction: source[iconIndex]
  };
}

function assertPineCreateNewMenuRoute(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  const createNewIndex = source.findIndex((action) =>
    action?.type === 'click_element'
    && String(action?.text || '').trim() === 'Create new'
    && String(action?.tradingViewRendererInvoke?.kind || '').trim().toLowerCase() === 'pine-current-script-menu-item'
  );

  assert(createNewIndex >= 0, 'existing-script branch should route through the Pine title-menu Create new action');
  return {
    createNewAction: source[createNewIndex]
  };
}

function assertQuickSearchPineEditorRoute(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  const ctrlKIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+k');
  const ctrlAIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+a');
  const backspaceIndex = source.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'backspace');
  const typeIndex = source.findIndex((action) => action?.type === 'type' && action?.text === 'Pine Editor');
  const openerIndex = source.findIndex((action) =>
    action?.type === 'key'
    && String(action?.key || '').toLowerCase() === 'enter'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
  );
  const quickSearchOpener = ctrlKIndex >= 0 ? source[ctrlKIndex] : null;

  assert(ctrlKIndex >= 0, 'default Pine opener should begin with TradingView quick search');
  assert(quickSearchOpener?.verify?.target === 'quick-search', 'quick-search opener should verify the TradingView search surface first');
  assert(ctrlAIndex > ctrlKIndex, 'quick-search route should select any stale query after the search surface opens');
  assert(backspaceIndex > ctrlAIndex, 'quick-search route should clear any stale query after selecting it');
  assert(typeIndex > backspaceIndex, 'quick-search route should type Pine Editor after clearing stale query text');
  assert(openerIndex > typeIndex, 'quick-search route should confirm the Pine Editor selection after typing it');
  assert.strictEqual(
    source.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+e' && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'),
    false,
    'default quick-search Pine opener should not keep a verified Ctrl+E opener in the rewritten route'
  );
}

test('inferTradingViewPineIntent recognizes Pine Editor surface requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.appName, 'TradingView');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.verifyKind, 'panel-visible');
});

test('inferTradingViewPineIntent treats explicit in-Pine-Editor prompts as already-active surface state', () => {
  const intent = inferTradingViewPineIntent(
    'TradingView is already open on the LUNR chart. In Pine Editor, create a new Pine script that shows confidence in volume and momentum, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.',
    [
      {
        type: 'run_command',
        shell: 'powershell',
        command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Momentum Confidence\", overlay=false)\nplot(close)\n'@",
        reason: 'Copy the prepared Pine script to the clipboard'
      }
    ]
  );

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.surfaceAlreadyActive, true);
  assert.strictEqual(intent.syntheticOpener, false, 'already-active Pine Editor prompts should not synthesize a redundant opener');
  assert.strictEqual(intent.openerIndex, -1, 'already-active Pine Editor prompts should not require an opener action');
  assert.strictEqual(intent.safeAuthoringDefault, true);
});

test('TradingView Pine route guidance aligns shortcut policy, authoring contract, and system prompt', () => {
  const policy = getTradingViewPineEditorAutomationPolicy();
  const contract = pineAuthoringHelpers.buildTradingViewPineAuthoringSystemContract('write a pine script for tradingview');

  assert.strictEqual(policy.preferredRoute, 'semantic-icon');
  assert.strictEqual(policy.requiresChartFocus, false);
  assert.strictEqual(policy.directShortcutRoute?.route, 'official-direct');
  assert.strictEqual(policy.directShortcutRoute?.requiresChartFocus, true);
  assert.strictEqual(policy.quickSearchFallback?.route, 'quick-search');
  assert.strictEqual(policy.quickSearchFallback?.requiresCommandSurface, true);
  assert.strictEqual(policy.quickSearchFallback?.typedQuery, 'Pine Editor');
  assert.strictEqual(policy.semanticIconRoute?.route, 'semantic-icon');
  assert.strictEqual(policy.semanticIconRoute?.allowImplicitSubstitution, true);
  assert(contract.includes('semantic Pine toolbar icon route'), 'authoring contract should prefer the semantic Pine icon opener');
  assert(contract.includes('bounded chart-focus Ctrl+E path'), 'authoring contract should retain the bounded direct fallback');
  assert(contract.includes('verified recovery path'), 'authoring contract should keep command quick-search as guarded recovery only');
  assert(TRADINGVIEW_PINE_PROMPT_OVERLAY.includes('semantic Pine toolbar icon route'), 'system prompt should advertise the semantic Pine opener');
  assert(TRADINGVIEW_PINE_PROMPT_OVERLAY.includes('Literal "Pine Editor" text is only valid inside verified TradingView command quick-search'), 'system prompt should forbid blind Pine Editor text entry');
});

test('inferTradingViewPineIntent preserves explicit Pine requests outside TradingView foreground', () => {
  const intent = inferTradingViewPineIntent('open pine editor and summarize the compile result', [
    { type: 'key', key: 'ctrl+e' }
  ], {
    foreground: {
      success: true,
      processName: 'code',
      title: 'README.md - Visual Studio Code'
    }
  });

  assert(intent, 'explicit Pine requests should stay eligible even outside TradingView foreground');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
});

test('buildTradingViewPineWorkflowActions keeps explicit direct-override Pine openers chart-focused and verified', () => {
  const actions = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    forceDirectChartPineShortcut: true,
    requiresObservedChange: true
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'type', text: 'strategy("test")', reason: 'Type script' }
  ]);

  const opener = findVerifiedPineEditorOpener(actions);
  const typed = actions.find((action) => action?.type === 'type' && action?.text === 'strategy("test")');

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assertChartFocusBeforeCtrlE(actions);
  assert.strictEqual(opener.type, 'key');
  assert.strictEqual(opener.key, 'ctrl+e');
  assert.strictEqual(opener.verify.kind, 'panel-visible');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
  assert(typed, 'typing should remain after the Pine Editor opener route');
});

test('buildTradingViewPineWorkflowActions routes synthetic Pine openers through the semantic Pine icon path', () => {
  const actions = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    syntheticOpener: true,
    requiresObservedChange: true
  }, [
    { type: 'type', text: 'strategy("test")', reason: 'Type script' }
  ]);

  const opener = findVerifiedPineEditorOpener(actions);
  const typed = actions.find((action) => action?.type === 'type' && action?.text === 'strategy("test")');

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  const { iconAction } = assertSemanticPineIconRoute(actions);
  assert.strictEqual(opener.type, 'click_element');
  assert.strictEqual(iconAction.text, 'Pine');
  assert.strictEqual(opener.verify.kind, 'panel-visible');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
  assert(typed, 'synthetic workflows should keep their trailing Pine action after the semantic Pine opener route');
});

test('buildTradingViewPineWorkflowActions preserves an explicit semantic Pine icon opener when the caller already chose that route', () => {
  const actions = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'editor-active',
    openerIndex: 0,
    requiresEditorActivation: true,
    requiresObservedChange: true
  }, [
    {
      type: 'click_element',
      text: 'Pine',
      reason: 'Open Pine Editor through the semantic icon route',
      tradingViewShortcut: {
        id: 'open-pine-editor',
        route: 'semantic-icon'
      },
      searchSurfaceContract: {
        id: 'open-pine-editor',
        route: 'semantic-icon'
      }
    }
  ]);

  const opener = findVerifiedPineEditorOpener(actions);

  assert.strictEqual(actions[0].type, 'bring_window_to_front');
  assert.strictEqual(opener?.type, 'click_element');
  assert.strictEqual(opener?.text, 'Pine');
  assert.strictEqual(String(opener?.tradingViewShortcut?.route || '').toLowerCase(), 'semantic-icon');
});

test('rewriteActionsForReliability preserves already-canonical strict Pine opener workflows', () => {
  const actions = buildTradingViewPineWorkflowActions({
    syntheticOpener: true,
    surfaceTarget: 'pine-editor',
    appName: 'TradingView',
    reason: 'Open TradingView Pine Editor through the official Pine shortcut route',
    verifyKind: 'editor-active',
    requiresEditorActivation: true,
    requiresObservedChange: true,
    safeAuthoringDefault: true,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'safe-authoring-inspect'
  }, []);

  const originalOpener = findVerifiedPineEditorOpener(actions);
  const rewritten = aiService.rewriteActionsForReliability(actions, {
    userMessage: 'Open TradingView Pine Editor through the verified official Pine shortcut route and inspect the visible Pine Editor state.'
  });
  const rewrittenOpener = findVerifiedPineEditorOpener(rewritten);
  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');

  assert.strictEqual(originalOpener?.verify?.kind, 'editor-active');
  assert.strictEqual(originalOpener?.verify?.requiresObservedChange, true);
  assert.strictEqual(rewritten, actions, 'Preflight should preserve a canonical strict Pine opener route instead of rebuilding it');
  assert.strictEqual(rewrittenOpener?.verify?.kind, 'editor-active');
  assert.strictEqual(rewrittenOpener?.verify?.requiresObservedChange, true);
  assert(inspectStep, 'The bounded safe-authoring inspect step should remain intact');
});

test('maybeRewriteTradingViewPineWorkflow rewrites low-signal Pine Editor opener plans', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' },
    { type: 'type', text: 'plot(close)' }
  ], {
    userMessage: 'open pine editor in tradingview and type plot(close)'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const typed = rewritten.find((action) => action?.type === 'type' && action?.text === 'plot(close)');

  assert(Array.isArray(rewritten), 'pine rewrite should return an action array');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  const { iconAction } = assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(iconAction.text, 'Pine');
  assert.strictEqual(opener?.type, 'click_element');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
  assert(typed, 'typing should remain after the Pine Editor opener route');
});

test('maybeRewriteTradingViewPineWorkflow canonicalizes quick-search Pine opener plans onto the semantic icon route', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+k', reason: 'Open TradingView quick search before selecting Pine Editor' },
    { type: 'wait', ms: 220 },
    { type: 'type', text: 'Pine Editor', reason: 'Search for Pine Editor in TradingView quick search' },
    { type: 'wait', ms: 260 },
    { type: 'key', key: 'enter', reason: 'Open TradingView command palette / quick search so we can navigate directly to Pine Editor' }
  ], {
    userMessage: 'Open the Pine Editor in TradingView.'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const pineSearchActions = rewritten.filter((action) => action?.type === 'type' && action?.text === 'Pine Editor');
  const enterActions = rewritten.filter((action) => action?.type === 'key' && action?.key === 'enter');

  assert(Array.isArray(rewritten), 'control prompt should rewrite into a canonical route');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(pineSearchActions.length, 0, 'Canonical semantic Pine routing should not keep a typed Pine Editor quick-search query');
  assert.strictEqual(enterActions.length, 0, 'Canonical semantic Pine routing should not keep a quick-search Enter selection step');
  assert(opener, 'canonicalized route should retain a verified Pine Editor opener');
});

test('maybeRewriteTradingViewPineWorkflow synthesizes a Pine Editor opener from a focus-only control plan', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'bring_window_to_front', title: 'TradingView' }
  ], {
    userMessage: 'Open the Pine Editor in TradingView.'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const pineSearchActions = rewritten.filter((action) => action?.type === 'type' && action?.text === 'Pine Editor');

  assert(Array.isArray(rewritten), 'focus-only control prompt should synthesize a canonical Pine route');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener?.type, 'click_element');
  assert.strictEqual(pineSearchActions.length, 0, 'semantic Pine route should not type Pine Editor into quick search when the host-backed icon route is available');
  assert(opener, 'synthetic Pine route should retain a verified Pine Editor opener');
});

test('maybeRewriteTradingViewPineWorkflow does not hijack shell-only plans when Pine prose mentions Pine Editor', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'run_command', command: 'cd c:\\dev\\copilot-Liku-cli && dir', reason: 'Inspect the workspace contents' }
  ], {
    userMessage: 'Open Pine Editor in TradingView and clear the selected quick-search text before typing Pine Editor.'
  });

  assert.strictEqual(rewritten, null, 'run_command-only plans should stay shell-only unless the plan itself is Pine-targeted');
});

test('maybeRewriteTradingViewPineWorkflow suppresses Pine rewrites for unrelated repo/editor prompts', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' },
    { type: 'type', text: 'plot(close)' }
  ], {
    userMessage: 'help me inspect this VS Code workspace',
    foreground: {
      success: true,
      processName: 'code',
      title: 'README.md - Visual Studio Code'
    }
  });

  assert.strictEqual(rewritten, null, 'Pine rewrites should stay disabled when the shared execution context is unrelated repo/editor work');
});

test('TradingView Pine workflow rewrites generic authoring prompts into safe inspect-first flow', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' }
  ], {
    userMessage: 'write a pine script for tradingview'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');

  assert(Array.isArray(rewritten), 'authoring prompts should rewrite into a bounded safe authoring flow');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener?.type, 'click_element');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert(inspectStep, 'safe authoring should inspect Pine Editor state after opening through the semantic Pine icon route');
});

test('maybeRewriteTradingViewPineWorkflow skips redundant openers when the request already starts in Pine Editor', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Momentum Confidence\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ], {
    userMessage: 'TradingView is already open on the LUNR chart. In Pine Editor, create a new Pine script that shows confidence in volume and momentum, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.'
  });

  const flattened = collectWorkflowActions(rewritten);
  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'];
  const existingScriptContinuation = inspectStep?.continueActionsByPineEditorState?.['existing-script-visible'];

  assert(Array.isArray(rewritten), 'rewrite should return an action array');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(
    flattened.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+e'),
    false,
    'already-active Pine Editor prompts should not inject a redundant Ctrl+E opener'
  );
  assert.strictEqual(
    flattened.some((action) => action?.type === 'type' && String(action?.text || '') === 'Pine Editor'),
    false,
    'already-active Pine Editor prompts should not type Pine Editor into quick search'
  );
  assert(inspectStep, 'rewrite should still verify the active Pine Editor state before authoring continues');
  assert.strictEqual(rewritten.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+k'), false, 'already-active Pine Editor prompts should not jump directly into a command-surface shortcut route before inspection');
  assert.strictEqual(rewritten.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i'), false, 'already-active Pine Editor prompts should not jump directly into fresh-indicator creation before inspection');
  assert(Array.isArray(starterContinuation) && starterContinuation.some((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || ''))), 'empty/starter Pine buffers should continue directly into validated payload preparation after inspection');
  assertPineCreateNewMenuRoute(existingScriptContinuation);
  const freshInspect = Array.isArray(existingScriptContinuation)
    ? existingScriptContinuation.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect')
    : null;
  assert.strictEqual(freshInspect?.acceptGenericSavedSurfaceAsStarter, true, 'the post-Create-new proof should narrowly tolerate generic saved Pine chrome after a verified Create new route');
  const guardedSaveAction = flattened.find((action) =>
    action?.type === 'key'
    && String(action?.key || '').toLowerCase() === 'ctrl+s'
    && String(action?.inputSurfaceContract?.route || '').toLowerCase() === 'pine-editor-authoring'
  );
  assert(guardedSaveAction, 'safe authoring should include a guarded Pine save action');
  assert(/\/\/\s*@version\s*=\s*6/i.test(String(guardedSaveAction?.pinePreparedScriptText || '')), 'guarded Pine save should carry the prepared script text for runtime verification');
  assert.strictEqual(guardedSaveAction?.pinePreparedScriptName, 'Momentum Confidence', 'guarded Pine save should carry the derived script name');
});
