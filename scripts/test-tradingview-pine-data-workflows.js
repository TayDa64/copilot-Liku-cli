#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const {
  writeFailureArtifactBundleSync
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));

const {
  buildTradingViewPineResumePrerequisites,
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow,
  inferPineVersionHistoryEvidenceMode
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));
const {
  buildPineScriptState,
  persistPineScriptState,
  buildPineClipboardPreparationCommandFromCanonicalState,
  validatePineScriptStateSource
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-script-state.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    try {
      const artifact = writeFailureArtifactBundleSync({
        suiteName: 'test-tradingview-pine-data-workflows',
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

function findPineEditorOpenKey(actions = []) {
  return (Array.isArray(actions) ? actions : []).find((action) =>
    action?.type === 'key'
    && String(action?.key || '').toLowerCase() === 'ctrl+e'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
  );
}

function assertChartFocusBeforeCtrlE(actions = []) {
  const chartFocusIndex = (Array.isArray(actions) ? actions : []).findIndex((action) =>
    action?.type === 'click'
    && action?.tradingViewChartFocusClick === true
  );
  const openIndex = (Array.isArray(actions) ? actions : []).findIndex((action) =>
    action?.type === 'key'
    && String(action?.key || '').toLowerCase() === 'ctrl+e'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
  );
  assert(chartFocusIndex >= 0, 'workflow should focus the TradingView chart surface before Ctrl+E');
  assert(openIndex > chartFocusIndex, 'Ctrl+E should run only after the chart surface focus click');
}

function assertSemanticPineIconRoute(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  const iconIndex = source.findIndex((action) =>
    action?.type === 'click_element'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
    && String(action?.searchSurfaceContract?.route || action?.tradingViewShortcut?.route || '').toLowerCase() === 'semantic-icon'
  );

  assert(iconIndex >= 0, 'workflow should use the bounded semantic Pine icon route');
  assert.strictEqual(
    source.some((action) => action?.tradingViewChartFocusClick === true),
    false,
    'semantic Pine routing should not require a chart-focus Ctrl+E prelude'
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
  const enterIndex = source.findIndex((action) =>
    action?.type === 'key'
    && String(action?.key || '').toLowerCase() === 'enter'
    && String(action?.verify?.target || '').toLowerCase() === 'pine-editor'
  );

  assert(ctrlKIndex >= 0, 'workflow should open TradingView quick search before selecting Pine Editor');
  assert(ctrlAIndex > ctrlKIndex, 'workflow should select any stale quick-search text after opening quick search');
  assert(backspaceIndex > ctrlAIndex, 'workflow should clear the selected quick-search text before typing Pine Editor');
  assert(typeIndex > backspaceIndex, 'workflow should type Pine Editor after clearing stale quick-search text');
  assert(enterIndex > typeIndex, 'workflow should confirm the Pine Editor quick-search result after typing it');
}

function assertBoundedConfirmationRecovery(actions = [], {
  evidenceMode = 'safe-authoring-inspect',
  expectedContinueOnPineEditorState = null,
  expectedScriptName = null,
  expectedPineEditorStates = []
} = {}) {
  assert(Array.isArray(actions) && actions.length > 0, `confirmation recovery for ${evidenceMode} should be present`);

  const yesClick = actions.find((action) => action?.type === 'click_element' && String(action?.text || '') === 'Yes');
  assert(yesClick, `confirmation recovery for ${evidenceMode} should click the exact Yes button`);
  assert.strictEqual(yesClick.controlType, 'Button', `confirmation recovery for ${evidenceMode} should target a Button`);
  assert.strictEqual(yesClick.exact, true, `confirmation recovery for ${evidenceMode} should require exact text matching`);
  assert.strictEqual(yesClick.foregroundOnly, true, `confirmation recovery for ${evidenceMode} should stay scoped to the foreground TradingView window`);
  assert.strictEqual(yesClick.allowCoordinateFallback, false, `confirmation recovery for ${evidenceMode} should not allow coordinate fallback`);
  assert.strictEqual(yesClick?.tradingViewRendererInvoke?.buttonText, 'Yes', `confirmation recovery for ${evidenceMode} should carry the exact renderer button label`);
  assert(Array.isArray(yesClick?.tradingViewRendererInvoke?.requiredTexts), `confirmation recovery for ${evidenceMode} should carry exact modal text anchors for renderer fallback`);
  assert(yesClick.tradingViewRendererInvoke.requiredTexts.some((text) => /unsaved changes/i.test(String(text || ''))), `confirmation recovery for ${evidenceMode} should anchor on the unsaved-changes modal text`);

  const reverifyAction = actions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === evidenceMode);
  assert(reverifyAction, `confirmation recovery for ${evidenceMode} should re-verify Pine state after clicking Yes`);

  if (evidenceMode === 'safe-authoring-inspect') {
    assert.strictEqual(reverifyAction.haltOnPineEditorStateMismatch, true, 'safe-authoring confirmation recovery should still fail closed on a second mismatch');
    assert.strictEqual(
      reverifyAction?.continueActionsByPineEditorState?.['confirmation-blocking'],
      undefined,
      'safe-authoring confirmation recovery should remain bounded and must not recursively retry the modal'
    );
    if (expectedContinueOnPineEditorState !== null) {
      assert.strictEqual(
        reverifyAction.continueOnPineEditorState,
        expectedContinueOnPineEditorState,
        'safe-authoring confirmation recovery should preserve the original continuation target state'
      );
    }
    for (const stateKey of expectedPineEditorStates) {
      assert(
        Array.isArray(reverifyAction?.continueActionsByPineEditorState?.[stateKey]),
        `safe-authoring confirmation recovery should preserve the ${stateKey} continuation branch`
      );
    }
  }

  if (evidenceMode === 'save-status') {
    assert.strictEqual(reverifyAction.haltOnPineLifecycleStateMismatch, true, 'save confirmation recovery should still fail closed on a second mismatch');
    assert.strictEqual(
      reverifyAction?.continueActionsByPineLifecycleState?.['save-confirmation-blocking'],
      undefined,
      'save confirmation recovery should remain bounded and must not recursively retry the modal'
    );
    assert.strictEqual(
      reverifyAction.continueOnPineLifecycleState,
      'saved-state-verified',
      'save confirmation recovery should still require verified saved state before continuing'
    );
    if (expectedScriptName !== null) {
      assert.strictEqual(
        reverifyAction.pineExpectedScriptName,
        expectedScriptName,
        'save confirmation recovery should preserve the expected saved Pine title'
      );
    }
  }

  return {
    yesClick,
    reverifyAction
  };
}

function assertBoundedInspectBlockingDialogRecovery(actions = [], {
  stateKey = '',
  expectedButtonText = '',
  expectedRendererKind = '',
  expectedRequiredTexts = [],
  expectedContinueOnPineEditorState = null,
  expectedPineEditorStates = []
} = {}) {
  assert(Array.isArray(actions) && actions.length > 0, `safe-authoring ${stateKey} recovery should be present`);

  const dismissClick = actions.find((action) =>
    action?.type === 'click_element'
    && String(action?.text || '').trim().toLowerCase() === String(expectedButtonText || '').trim().toLowerCase()
  );
  assert(dismissClick, `safe-authoring ${stateKey} recovery should click the exact ${expectedButtonText} button`);
  assert.strictEqual(dismissClick.controlType, 'Button', `safe-authoring ${stateKey} recovery should target a Button`);
  assert.strictEqual(dismissClick.exact, true, `safe-authoring ${stateKey} recovery should require exact text matching`);
  assert.strictEqual(dismissClick.foregroundOnly, true, `safe-authoring ${stateKey} recovery should stay scoped to the foreground TradingView window`);
  assert.strictEqual(dismissClick.allowCoordinateFallback, false, `safe-authoring ${stateKey} recovery should not allow coordinate fallback`);
  assert.strictEqual(String(dismissClick?.tradingViewRendererInvoke?.buttonText || ''), expectedButtonText, `safe-authoring ${stateKey} recovery should carry the exact renderer button label`);
  assert.strictEqual(String(dismissClick?.tradingViewRendererInvoke?.kind || ''), expectedRendererKind, `safe-authoring ${stateKey} recovery should carry the exact renderer modal kind`);
  assert(Array.isArray(dismissClick?.tradingViewRendererInvoke?.requiredTexts), `safe-authoring ${stateKey} recovery should carry exact modal text anchors for renderer fallback`);
  for (const requiredText of expectedRequiredTexts) {
    assert(
      dismissClick.tradingViewRendererInvoke.requiredTexts.some((text) => String(text || '').toLowerCase().includes(String(requiredText || '').toLowerCase())),
      `safe-authoring ${stateKey} recovery should anchor on "${requiredText}"`
    );
  }

  const reverifyAction = actions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  assert(reverifyAction, `safe-authoring ${stateKey} recovery should re-verify Pine state after dismissing the stale modal`);
  assert.strictEqual(reverifyAction.haltOnPineEditorStateMismatch, true, `safe-authoring ${stateKey} recovery should still fail closed if the same stale modal remains visible`);
  assert.strictEqual(
    reverifyAction?.continueActionsByPineEditorState?.[stateKey],
    undefined,
    `safe-authoring ${stateKey} recovery should remain bounded and must not recursively retry the same modal`
  );
  if (expectedContinueOnPineEditorState !== null) {
    assert.strictEqual(
      reverifyAction.continueOnPineEditorState,
      expectedContinueOnPineEditorState,
      `safe-authoring ${stateKey} recovery should preserve the original continuation target state`
    );
  }
  for (const preservedState of expectedPineEditorStates) {
    assert(
      Array.isArray(reverifyAction?.continueActionsByPineEditorState?.[preservedState]),
      `safe-authoring ${stateKey} recovery should preserve the ${preservedState} continuation branch`
    );
  }

  return {
    dismissClick,
    reverifyAction
  };
}

function assertBoundedInspectBlockingDialogRecoveries(inspectAction = null, {
  expectedContinueOnPineEditorState = null,
  expectedPineEditorStates = []
} = {}) {
  assert(inspectAction && typeof inspectAction === 'object', 'safe-authoring inspect action should be present');
  return {
    confirmation: assertBoundedInspectBlockingDialogRecovery(
      inspectAction?.continueActionsByPineEditorState?.['confirmation-blocking'],
      {
        stateKey: 'confirmation-blocking',
        expectedButtonText: 'No',
        expectedRendererKind: 'unsaved-changes-confirmation',
        expectedRequiredTexts: ['unsaved changes', 'save them'],
        expectedContinueOnPineEditorState,
        expectedPineEditorStates
      }
    ),
    replace: assertBoundedInspectBlockingDialogRecovery(
      inspectAction?.continueActionsByPineEditorState?.['replace-confirmation-blocking'],
      {
        stateKey: 'replace-confirmation-blocking',
        expectedButtonText: 'No',
        expectedRendererKind: 'replace-existing-script-confirmation',
        expectedRequiredTexts: ['already exists', 'replace it'],
        expectedContinueOnPineEditorState,
        expectedPineEditorStates
      }
    ),
    saveRequired: assertBoundedInspectBlockingDialogRecovery(
      inspectAction?.continueActionsByPineEditorState?.['save-required-blocking'],
      {
        stateKey: 'save-required-blocking',
        expectedButtonText: 'Cancel',
        expectedRendererKind: 'pine-first-save-confirmation',
        expectedRequiredTexts: ['Save script', 'New script name'],
        expectedContinueOnPineEditorState,
        expectedPineEditorStates
      }
    )
  };
}

function assertBoundedFirstSaveRecovery(actions = [], {
  expectedScriptName = null
} = {}) {
  assert(Array.isArray(actions) && actions.length > 0, 'first-save recovery should be present');

  const staleNameTypeAction = actions.find((action) => action?.type === 'type' && (!expectedScriptName || String(action?.text || '') === expectedScriptName));
  assert.strictEqual(staleNameTypeAction, undefined, 'first-save recovery should not emit a separate name typing action once the renderer Save invoke owns dialog prefill');

  const staleEnterAction = actions.find((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'enter');
  assert.strictEqual(staleEnterAction, undefined, 'first-save recovery should not rely on blind Enter confirmation');

  const saveClick = actions.find((action) => action?.type === 'click_element' && String(action?.text || '') === 'Save');
  assert(saveClick, 'first-save recovery should click the exact Save button');
  assert.strictEqual(saveClick.controlType, 'Button', 'first-save recovery should target the Save button control type');
  assert.strictEqual(saveClick.exact, true, 'first-save recovery should require exact Save button matching');
  assert.strictEqual(saveClick.foregroundOnly, true, 'first-save recovery should remain scoped to the foreground TradingView window');
  assert.strictEqual(saveClick.allowCoordinateFallback, false, 'first-save recovery should not allow coordinate fallback');
  assert.strictEqual(saveClick?.tradingViewRendererInvoke?.buttonText, 'Save', 'first-save recovery should carry the exact renderer button label');
  assert(Array.isArray(saveClick?.tradingViewRendererInvoke?.requiredTexts), 'first-save recovery should carry exact save-dialog text anchors for renderer fallback');
  assert(saveClick.tradingViewRendererInvoke.requiredTexts.includes('Save script'), 'first-save recovery should anchor on the TradingView save dialog title');
  assert(saveClick.tradingViewRendererInvoke.requiredTexts.includes('New script name'), 'first-save recovery should anchor on the TradingView save dialog field label');
  assert.strictEqual(saveClick?.tradingViewRendererInvoke?.deferEffectProofToFollowUpAction, true, 'first-save recovery should let the follow-up save-status proof verify the final effect');
  if (expectedScriptName !== null) {
    assert.strictEqual(saveClick?.pineExpectedScriptName, expectedScriptName, 'first-save recovery should carry the expected Pine title on the Save action');
    assert.strictEqual(saveClick?.tradingViewRendererInvoke?.pineExpectedScriptName, expectedScriptName, 'first-save recovery should carry the expected Pine title into the renderer Save invoke');
  }

  const reverifyAction = actions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status');
  assert(reverifyAction, 'first-save recovery should re-verify the Pine save state after choosing Save');
  if (expectedScriptName !== null) {
    assert.strictEqual(reverifyAction.pineExpectedScriptName, expectedScriptName, 'first-save recovery reverify should preserve the expected Pine title');
  }

  return {
    saveClick,
    reverifyAction
  };
}

test('pine workflow recognizes pine logs evidence-gathering requests', () => {
  const intent = inferTradingViewPineIntent('open pine logs in tradingview and read the output', [
    { type: 'key', key: 'ctrl+shift+l' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-logs');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine editor status-output requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and read the visible compiler status', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine-editor alias phrasing', () => {
  const intent = inferTradingViewPineIntent('open pine script editor in tradingview and read the visible compiler status', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes compile-result requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and summarize the compile result', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
  assert.strictEqual(intent.pineEvidenceMode, 'compile-result');
});

test('pine workflow recognizes diagnostics requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and check diagnostics', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
  assert.strictEqual(intent.pineEvidenceMode, 'diagnostics');
});

test('pine workflow recognizes pine editor line-budget requests', () => {
  const intent = inferTradingViewPineIntent('open pine editor in tradingview and check whether the script is close to the 500 line limit', [
    { type: 'key', key: 'ctrl+e' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-editor');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine profiler evidence-gathering requests', () => {
  const intent = inferTradingViewPineIntent('open pine profiler in tradingview and summarize the metrics', [
    { type: 'key', key: 'ctrl+shift+p' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-profiler');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine profiler alias phrasing', () => {
  const intent = inferTradingViewPineIntent('open performance profiler in tradingview and summarize the metrics', [
    { type: 'key', key: 'ctrl+shift+p' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-profiler');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes pine version history provenance requests', () => {
  const intent = inferTradingViewPineIntent('open pine version history in tradingview and read the latest visible revisions', [
    { type: 'key', key: 'alt+h' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-version-history');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow recognizes revision-history alias phrasing', () => {
  const intent = inferTradingViewPineIntent('open revision history in tradingview and read the latest visible revisions', [
    { type: 'key', key: 'alt+h' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-version-history');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
});

test('pine workflow classifies version history metadata summary requests', () => {
  const mode = inferPineVersionHistoryEvidenceMode('open pine version history in tradingview and summarize the top visible revision metadata');

  assert.strictEqual(mode, 'provenance-summary');
});

test('pine workflow recognizes visible revision metadata requests', () => {
  const intent = inferTradingViewPineIntent('open pine version history in tradingview and summarize the top visible revision metadata', [
    { type: 'key', key: 'alt+h' }
  ]);

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.surfaceTarget, 'pine-version-history');
  assert.strictEqual(intent.wantsEvidenceReadback, true);
  assert.strictEqual(intent.pineEvidenceMode, 'provenance-summary');
});

test('open pine logs and read output stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-logs',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+shift+l', reason: 'Open Pine Logs' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-logs');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Logs');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'logs-summary');
});

test('open pine editor and read visible status stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  const { iconAction } = assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener.type, 'click_element');
  assert.strictEqual(iconAction.text, 'Pine');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert(readback, 'pine editor status workflow should gather Pine Editor text');
  assert.strictEqual(readback.pineEvidenceMode, 'generic-status');
});

test('pine editor opener canonicalizes unknown Pine surface actions onto the semantic icon route', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'click_element', text: 'Pine Editor', reason: 'Open Pine Editor from an unknown TradingView surface' }
  ]);

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener?.type, 'click_element');
  assert.strictEqual(String(opener?.text || ''), 'Pine');
  assert.strictEqual(rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+k'), false, 'canonical semantic Pine routing should not keep a quick-search opener');
});

test('pine editor activation verification stays anchored to pine-surface keywords instead of generic TradingView chrome', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: false,
    requiresObservedChange: true,
    requiresEditorActivation: true
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const keywords = opener?.verify?.keywords || [];

  assert(opener, 'pine editor workflow should include a verified opener');
  assert(keywords.includes('pine editor'), 'pine editor verification should keep Pine Editor anchors');
  assert(keywords.includes('add to chart'), 'pine editor verification should keep pine-surface action anchors');
  assert.strictEqual(keywords.includes('TradingView'), false, 'pine editor verification should not treat generic TradingView title text as proof of editor activation');
  assert.strictEqual(keywords.includes('alert'), false, 'pine editor verification should not inherit alert-dialog keywords');
  assert.strictEqual(keywords.includes('interval'), false, 'pine editor verification should not inherit generic interval-dialog keywords');
});

test('pine editor authoring workflow demands editor-active verification before typing', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    requiresObservedChange: true,
    requiresEditorActivation: true,
    wantsEvidenceReadback: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 1000 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor' },
    { type: 'type', text: 'plot(close)' }
  ]);

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener.verify.kind, 'editor-active');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert.strictEqual(opener.verify.requiresObservedChange, true);
});

test('generic pine script creation prefers safe new-script workflow', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 1000 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor for new script' },
    { type: 'type', text: 'indicator("LUNR Confidence")' },
    { type: 'key', key: 'ctrl+enter', reason: 'Add to chart' }
  ], {
    userMessage: 'in tradingview, create a pine script that builds my confidence level when making decisions'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const postOpenActions = rewritten.slice(rewritten.indexOf(opener) + 1);
  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(String(opener?.type || '').toLowerCase(), 'click_element');
  assert.strictEqual(opener.verify.kind, 'editor-active');
  assert(rewritten.some((action) => action?.type === 'get_text' && action?.text === 'Pine Editor'), 'safe authoring should inspect visible Pine Editor state first');
  assert(!postOpenActions.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'safe authoring should avoid select-all inside Pine Editor by default');
  assert(!postOpenActions.some((action) => String(action?.key || '').toLowerCase() === 'backspace'), 'safe authoring should avoid destructive clear-first behavior inside Pine Editor');
});

test('negated overwrite language keeps TradingView Pine authoring on the safe fresh-script path', () => {
  const sourceActions = [
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"VWAP TPO ATR Confidence Confirmation Suite\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ];
  const prompt = 'TradingView is open. Create a new interactive Pine Script indicator that shows VWAP, TPO, and ATR confirmations. Use the fresh indicator flow and do not overwrite the last cloud script.';
  const intent = inferTradingViewPineIntent(prompt, sourceActions);
  const rewritten = buildTradingViewPineWorkflowActions(intent, sourceActions);
  const allActions = collectWorkflowActions(rewritten);
  const safeInspect = allActions.find((action) =>
    action?.type === 'get_text'
    && action?.pineEvidenceMode === 'safe-authoring-inspect'
    && (
      action?.continueActionsByPineEditorState
      || Array.isArray(action?.continueActions)
    )
  );

  assert(intent, 'intent should be inferred');
  assert.strictEqual(intent.explicitOverwriteAuthoring, false, 'do-not-overwrite language must not become explicit overwrite intent');
  assert.strictEqual(intent.safeAuthoringDefault, true, 'create-new Pine request should keep safe authoring enabled');
  assert(Array.isArray(intent.safeAuthoringContinuationSteps) && intent.safeAuthoringContinuationSteps.length > 0, 'clipboard payload should produce safe paste/save continuation steps');
  assert(safeInspect, 'workflow should include safe-authoring inspection before paste/save');
  assert(allActions.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v'), 'workflow should paste the prepared Pine payload after proof');
});

test('clipboard-only pine authoring plan rewrites into guarded continuation after safe inspection', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Momentum Confidence\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ], {
    userMessage: 'in tradingview, create a pine script that builds confidence and insight from movement and momentum'
  });

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const directContinuation = inspectStep?.continueActions || [];
  const saveInspect = directContinuation.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status');

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(String(opener?.type || '').toLowerCase(), 'click_element');
  assert.strictEqual(opener.verify.kind, 'editor-active');
  assert(inspectStep, 'safe authoring should inspect Pine Editor state first');
  assert.strictEqual(inspectStep.continueOnPineEditorState, 'empty-or-starter');
  assert(Array.isArray(inspectStep.continueActions) && inspectStep.continueActions.length > 0, 'safe authoring inspect step should carry continuation actions');
  const dialogRecoveries = assertBoundedInspectBlockingDialogRecoveries(inspectStep, {
    expectedContinueOnPineEditorState: 'empty-or-starter'
  });
  assert(Array.isArray(dialogRecoveries?.replace?.reverifyAction?.continueActionsByPineEditorState?.['save-required-blocking']), 'replace-modal recovery should still allow bounded save-dialog dismissal when the stale save-name dialog appears next');
  assert(Array.isArray(dialogRecoveries?.replace?.reverifyAction?.continueActionsByPineEditorState?.['confirmation-blocking']), 'replace-modal recovery should still allow bounded unsaved-changes dismissal when that stale modal appears next');
  assert(Array.isArray(dialogRecoveries?.saveRequired?.reverifyAction?.continueActionsByPineEditorState?.['replace-confirmation-blocking']), 'save-dialog recovery should still allow bounded replace-modal dismissal when the replace modal appears next');
  assert(Array.isArray(dialogRecoveries?.saveRequired?.reverifyAction?.continueActionsByPineEditorState?.['confirmation-blocking']), 'save-dialog recovery should still allow bounded unsaved-changes dismissal when that stale modal appears next');
  assert(!inspectStep.continueActions.some((action) => String(action?.tradingViewRendererInvoke?.kind || '').toLowerCase() === 'pine-current-script-menu-item'), 'empty/starter-safe continuation should not force the Pine Create new menu route');
  assert(directContinuation.some((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || ''))), 'direct continuation should preserve clipboard preparation');
  const starterSelectIndex = directContinuation.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+a');
  const starterClearIndex = directContinuation.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'backspace');
  const clipboardIndex = directContinuation.findIndex((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || '')));
  const pasteIndex = directContinuation.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v');
  const pasteAction = directContinuation.find((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v');
  assert(pasteAction, 'direct continuation should paste the prepared script');
  assert(starterSelectIndex >= 0, 'direct continuation should select the verified starter script before replacement');
  assert(starterClearIndex > starterSelectIndex, 'direct continuation should clear the verified starter script before paste');
  assert(clipboardIndex > starterClearIndex, 'clipboard preparation should occur after the starter script is cleared');
  assert(pasteIndex > clipboardIndex, 'paste should occur after the prepared script is loaded into the clipboard');
  assert.strictEqual(String(pasteAction?.inputSurfaceContract?.route || ''), 'pine-editor-authoring', 'paste should declare an explicit Pine authoring surface contract');
  assert.strictEqual(pasteAction?.inputSurfaceContract?.requiresPineEditorSurface, true, 'paste should require a proven Pine surface');
  assert.strictEqual(pasteAction?.inputSurfaceContract?.requiresCommandSurfaceClosed, true, 'paste should refuse to run while TradingView command search is open');
  assert(/Momentum Confidence/.test(String(pasteAction?.pinePreparedScriptText || '')), 'paste should carry the prepared Pine source for bounded post-paste verification');
  assert.strictEqual(String(pasteAction?.pinePreparedScriptName || ''), 'Momentum Confidence', 'paste should carry the expected Pine title for bounded post-paste verification');
  const saveAction = directContinuation.find((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+s');
  assert(saveAction, 'direct continuation should save after insertion');
  assert.strictEqual(String(saveAction?.inputSurfaceContract?.route || ''), 'pine-editor-authoring', 'save should stay on the Pine authoring surface contract');
  assert(saveInspect, 'direct continuation should verify visible save status before applying');
  assert.strictEqual(saveInspect.pineExpectedScriptName, 'Momentum Confidence', 'save verification should carry the expected Pine title');
  assert.strictEqual(saveInspect.continueOnPineLifecycleState, 'saved-state-verified');
  assert(Array.isArray(saveInspect?.continueActionsByPineLifecycleState?.['save-required-before-apply']), 'save verification should branch into a first-save recovery path when TradingView requires a script name');
  const saveConfirmationRecovery = saveInspect?.continueActionsByPineLifecycleState?.['save-confirmation-blocking'];
  const { reverifyAction: saveModalReverify } = assertBoundedConfirmationRecovery(saveConfirmationRecovery, {
    evidenceMode: 'save-status',
    expectedScriptName: 'Momentum Confidence'
  });
  assert(Array.isArray(saveModalReverify?.continueActionsByPineLifecycleState?.['save-required-before-apply']), 'save confirmation recovery should still allow the first-save naming path after the modal is cleared');
  const saveReplaceRecovery = saveInspect?.continueActionsByPineLifecycleState?.['save-replace-confirmation-blocking'] || [];
  const replaceConfirmAction = saveReplaceRecovery.find((action) => action?.type === 'click_element' && String(action?.text || '').toLowerCase() === 'yes');
  const replaceReverify = saveReplaceRecovery.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status');
  assert(replaceConfirmAction, 'save verification should recover through the replace-existing-script confirmation modal');
  assert(/already exists/i.test(String(replaceConfirmAction?.tradingViewRendererInvoke?.requiredTexts?.join(' ') || '')), 'replace confirmation should verify the exact replace-existing modal text');
  assert.strictEqual(replaceReverify?.pineExpectedScriptName, 'Momentum Confidence', 'replace confirmation recovery should preserve the expected saved title');
  const {
    reverifyAction: saveReverify
  } = assertBoundedFirstSaveRecovery(saveInspect.continueActionsByPineLifecycleState['save-required-before-apply'], {
    expectedScriptName: 'Momentum Confidence'
  });
  assert.strictEqual(saveReverify?.continueActionsByPineLifecycleState?.['save-required-before-apply'], undefined, 'reverification after naming should fail closed if TradingView still shows the first-save dialog');
  const postNameReplaceRecovery = saveReverify?.continueActionsByPineLifecycleState?.['save-replace-confirmation-blocking'] || [];
  const postNameReplaceConfirmAction = postNameReplaceRecovery.find((action) => action?.type === 'click_element' && String(action?.text || '').toLowerCase() === 'yes');
  assert(postNameReplaceConfirmAction, 'reverification after naming should still recover through the replace-existing confirmation modal');
  const addToChartAction = saveInspect.continueActions.find((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+enter');
  assert(addToChartAction, 'save-verified continuation should add the script to the chart');
  assert.strictEqual(String(addToChartAction?.inputSurfaceContract?.route || ''), 'pine-editor-authoring', 'apply-to-chart should stay on the Pine authoring surface contract');
  assert(saveInspect.continueActions.some((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'compile-result'), 'save-verified continuation should gather compile-result feedback after add-to-chart');
});

test('save-only pine creation prompt suppresses auto add-to-chart continuation', () => {
  const userMessage = 'TradingView is already open. Create a new Pine script, save the script, and report the visible save status. Do not add it to the chart.';
  const sourceActions = [
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Liku Live Save Probe\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ];

  const intent = inferTradingViewPineIntent(userMessage, sourceActions);
  const rewritten = buildTradingViewPineWorkflowActions(intent, sourceActions);
  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || inspectStep?.continueActions || [];
  const saveInspect = starterContinuation.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status');

  assert(intent, 'save-only prompt should infer a TradingView Pine intent');
  assert(Array.isArray(rewritten) && rewritten.length > 0, 'save-only prompt should still build a rewritten workflow');
  assert(saveInspect, 'safe authoring flow should still verify save status');
  assert.strictEqual(saveInspect.pineExpectedScriptName, 'Liku Live Save Probe', 'save-only flow should also carry the expected saved title');
  assert(!saveInspect.continueActions.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+enter'), 'save-only prompt should not auto-add the script to the chart');
});

test('validated canonical pine state forces the fresh-script route and drives clear-and-paste replacement from the persisted state file', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-pine-canonical-'));
  const pineState = buildPineScriptState({
    source: `//@version=6
indicator("Momentum Confidence", overlay=false)
plot(close)`,
    intent: 'Create a new TradingView indicator'
  });
  const persisted = persistPineScriptState(pineState, { cwd: tempRoot });

  try {
    const rewritten = maybeRewriteTradingViewPineWorkflow([
      {
        type: 'run_command',
        shell: 'powershell',
        command: "Set-Clipboard -Value 'placeholder'",
        reason: 'Copy the prepared Pine script to the clipboard',
        pineCanonicalState: {
          id: pineState.id,
          scriptTitle: pineState.scriptTitle,
          sourceHash: pineState.sourceHash,
          origin: pineState.origin,
          sourcePath: persisted.sourcePath,
          metadataPath: persisted.metadataPath,
          validation: pineState.validation
        }
      }
    ], {
      userMessage: 'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator for volume and momentum confidence, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.'
    });
    const flattened = collectWorkflowActions(rewritten);
    const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
    const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || [];
    const existingScriptContinuation = inspectStep?.continueActionsByPineEditorState?.['existing-script-visible'] || [];
    const freshInspect = existingScriptContinuation.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect' && Array.isArray(action?.continueActions));
    const clearIndex = starterContinuation.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+a');
    const backspaceIndex = starterContinuation.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'backspace');
    const clipboardIndex = starterContinuation.findIndex((action) => action?.type === 'run_command' && /get-content\s+-literalpath/i.test(String(action?.command || '')));
    const pasteIndex = starterContinuation.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v');
    const clipboardStep = clipboardIndex >= 0 ? starterContinuation[clipboardIndex] : null;
    const pasteStep = pasteIndex >= 0 ? starterContinuation[pasteIndex] : null;

    assert(inspectStep, 'canonical-state flow should inspect the current Pine buffer before choosing a starter-safe or fresh-indicator route');
    assertBoundedInspectBlockingDialogRecoveries(inspectStep, {
      expectedPineEditorStates: ['empty-or-starter', 'existing-script-visible']
    });
    assert(Array.isArray(starterContinuation) && starterContinuation.length > 0, 'canonical-state flow should keep a direct starter-safe replacement branch');
    assertPineCreateNewMenuRoute(existingScriptContinuation);
    assert(freshInspect, 'Create new branch should still verify the new Pine surface');
    assertBoundedInspectBlockingDialogRecoveries(freshInspect, {
      expectedContinueOnPineEditorState: 'empty-or-starter'
    });
    assert.strictEqual(rewritten.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i'), false, 'validated canonical-state flow should not trigger the new-indicator shortcut before inspection');
    assert(clearIndex >= 0, 'starter-safe canonical flow should select the starter script before replacement');
    assert(backspaceIndex > clearIndex, 'starter-safe canonical flow should clear the starter script after select-all');
    assert(clipboardIndex > backspaceIndex, 'starter-safe canonical flow should reload the canonical script from disk after clearing');
    assert(pasteIndex > clipboardIndex, 'starter-safe canonical flow should paste after loading the canonical script');
    assert.strictEqual(clipboardStep?.pineCanonicalState?.sourcePath, persisted.sourcePath, 'canonical-state clipboard step should preserve the persisted source path');
    assert.strictEqual(clipboardStep?.pineCanonicalState?.validation?.valid, true, 'canonical-state clipboard step should preserve validation proof');
    assert.strictEqual(pasteStep?.pineCanonicalState?.sourceHash, pineState.sourceHash, 'canonical-state paste step should preserve canonical artifact identity');
    assert(/Momentum Confidence/.test(String(pasteStep?.pinePreparedScriptText || '')), 'canonical-state paste should carry the persisted Pine source for bounded post-paste verification');
    assert.strictEqual(String(pasteStep?.pinePreparedScriptName || ''), 'Momentum Confidence', 'canonical-state paste should carry the persisted Pine title for bounded post-paste verification');
    assert(/Get-Content -LiteralPath/i.test(String(clipboardStep?.command || '')), 'canonical-state clipboard step should source the script from the persisted .pine file');
    assert(String(clipboardStep?.command || '').includes(persisted.sourcePath), 'canonical-state clipboard step should reference the persisted .pine file path');
    assert.strictEqual(flattened.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+e'), false, 'already-active Pine Editor canonical-state flows should not reopen Pine Editor with Ctrl+E');
    assert.strictEqual(flattened.some((action) => action?.type === 'type' && String(action?.text || '') === 'Pine Editor'), false, 'already-active Pine Editor canonical-state flows should not type Pine Editor into quick search');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('explicit fresh-indicator prompts inspect first and branch into new-indicator flow only when an existing script is visible', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Momentum Confidence\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ], {
    userMessage: 'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator script for volume and momentum confidence. Use the new indicator flow so it does not reuse the current script, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.'
  });
  const flattened = collectWorkflowActions(rewritten);

  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || [];
  const existingScriptContinuation = inspectStep?.continueActionsByPineEditorState?.['existing-script-visible'] || [];

  assert(inspectStep, 'fresh-indicator prompts should still inspect the current Pine buffer before choosing a bounded branch');
  assert.strictEqual(rewritten.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i'), false, 'fresh-indicator prompts should not trigger the official new-indicator shortcut before inspection');
  assert(!starterContinuation.some((action) => String(action?.tradingViewRendererInvoke?.kind || '').toLowerCase() === 'pine-current-script-menu-item'), 'starter-safe branch should continue directly without the Pine Create new route');
  assertPineCreateNewMenuRoute(existingScriptContinuation);
  assert.strictEqual(flattened.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+e'), false, 'already-active Pine Editor fresh-indicator flows should not reopen Pine Editor with Ctrl+E');
  assert.strictEqual(flattened.some((action) => action?.type === 'type' && String(action?.text || '') === 'Pine Editor'), false, 'already-active Pine Editor fresh-indicator flows should not type Pine Editor into quick search');
});

test('transcript-style Pine clipboard/edit/apply plans are normalized back onto the safe authoring contract', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'focus_window', windowHandle: 42404660 },
    { type: 'wait', ms: 700 },
    { type: 'key', key: 'ctrl+k', reason: 'Open TradingView quick search' },
    { type: 'wait', ms: 250 },
    { type: 'type', text: 'pine editor' },
    { type: 'wait', ms: 350 },
    { type: 'click_element', text: 'Pine Editor', reason: 'Open Pine Editor by clicking the result' },
    { type: 'wait', ms: 900 },
    { type: 'get_text', text: 'Pine Editor', reason: 'Verify Pine Editor surface is visible' },
    { type: 'wait', ms: 250 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all currently visible editor text for inspection' },
    { type: 'wait', ms: 120 },
    { type: 'key', key: 'ctrl+c', reason: 'Copy current script content for inspection' },
    { type: 'wait', ms: 200 },
    { type: 'run_command', shell: 'powershell', command: "powershell -NoProfile -Command \"$t=Get-Clipboard -Raw\"" },
    { type: 'wait', ms: 250 },
    { type: 'key', key: 'ctrl+a', reason: 'Prepare editor buffer for paste' },
    { type: 'wait', ms: 120 },
    {
      type: 'run_command',
      shell: 'powershell',
      command: "powershell -NoProfile -Command \"$code=@'\n//@version=5\nindicator(\\\"Volume + Momentum Confidence (LUNR) [Liku]\\\", overlay=false)\nplot(close)\n'@; Set-Clipboard -Value $code\""
    },
    { type: 'wait', ms: 120 },
    { type: 'key', key: 'ctrl+v', reason: 'Paste Pine code' },
    { type: 'wait', ms: 250 },
    { type: 'key', key: 'ctrl+enter', reason: 'Compile/apply the script to the chart' }
  ], {
    userMessage: 'TradingView is already open on the LUNR chart. Open Pine Editor, create a new Pine script that shows confidence in volume and momentum, apply it with Ctrl+Enter, and report the visible compile/apply result'
  });

  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || [];
  const existingScriptContinuation = inspectStep?.continueActionsByPineEditorState?.['existing-script-visible'] || [];
  const freshInspect = existingScriptContinuation.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect' && Array.isArray(action?.continueActions));
  assert(Array.isArray(rewritten), 'workflow should rewrite the transcript-style Pine plan');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  assert.strictEqual(String(opener?.type || '').toLowerCase(), 'click_element', 'rewrite should route Pine Editor opening through the semantic icon path before safe authoring resumes');
  assert(inspectStep, 'rewrite should restore the safe Pine inspection contract before any authoring edit resumes');
  assert(starterContinuation.some((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || ''))), 'starter-safe branch should preserve bounded clipboard preparation immediately after inspection');
  assertPineCreateNewMenuRoute(existingScriptContinuation);
  assert(freshInspect && freshInspect.continueActions.some((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || ''))), 'Create new branch should preserve bounded clipboard preparation only after the fresh Pine surface is verified');
  assert(!rewritten.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+c'), 'rewrite should not preserve raw clipboard inspection keystrokes outside the guarded continuation');
});

test('full ai-service rewrite handles the transcript Pine prompt without browser or timeframe derailment', () => {
  const rewritten = aiService.rewriteActionsForReliability([
    { type: 'focus_window', windowHandle: 459522 }
  ], {
    userMessage: 'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.'
  });

  assert(Array.isArray(rewritten), 'full rewrite should return an action list');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front', 'rewrite should focus TradingView rather than keep a raw opaque focus action');
  assert(rewritten.some((action) => action?.verify?.target === 'pine-editor'), 'rewrite should continue into a TradingView Pine workflow');
  assert(!rewritten.some((action) => /google\.com\/search\?q=/i.test(String(action?.text || ''))), 'rewrite should not derail into browser discovery search');
});

test('bare focus-only TradingView Pine authoring plans are flagged as incomplete for retry', () => {
  const incomplete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      { type: 'focus_window', windowHandle: 459522 }
    ]
  }, 'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.');

  const complete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      { type: 'focus_window', windowHandle: 459522 },
      { type: 'run_command', shell: 'powershell', command: "Set-Clipboard -Value 'indicator(\"Confidence\")'" },
      { type: 'key', key: 'ctrl+v' },
      { type: 'key', key: 'ctrl+enter' }
    ]
  }, 'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.');

  assert.strictEqual(incomplete, true, 'focus-only Pine authoring plans should be considered incomplete');
  assert.strictEqual(complete, false, 'plans with substantive Pine authoring payload should not be considered incomplete');
});

test('clipboard inspection does not count as a complete TradingView Pine authoring payload', () => {
  const incomplete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      { type: 'focus_window', windowHandle: 459522 },
      { type: 'run_command', shell: 'powershell', command: 'powershell -NoProfile -Command "$t=Get-Clipboard -Raw"' },
      { type: 'key', key: 'ctrl+v' },
      { type: 'key', key: 'ctrl+enter' },
      { type: 'get_text', text: 'Pine Editor', pineEvidenceMode: 'compile-result' }
    ]
  }, 'TradingView is already open on the LUNR chart. Open Pine Editor, create a new Pine script that shows confidence in volume and momentum, apply it with Ctrl+Enter, and report the visible compile/apply result');

  assert.strictEqual(incomplete, true, 'clipboard inspection without actual Pine payload should remain incomplete');
});

test('TradingView Pine authoring plans that promise a visible result must include compile/apply readback', () => {
  const incomplete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      { type: 'focus_window', windowHandle: 459522 },
      { type: 'run_command', shell: 'powershell', command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Confidence\", overlay=false)\nplot(close)\n'@" },
      { type: 'key', key: 'ctrl+v' },
      { type: 'key', key: 'ctrl+enter' }
    ]
  }, 'TradingView is already open on the LUNR chart. Open Pine Editor, create a new Pine script that shows confidence in volume and momentum, apply it with Ctrl+Enter, and report the visible compile/apply result');

  assert.strictEqual(incomplete, true, 'authoring plans that promise a visible compile/apply result should include a readback step');
});

test('guarded TradingView Pine continuation branches count as substantive authoring steps', () => {
  const incomplete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' },
      {
        type: 'get_text',
        text: 'Pine Editor',
        pineEvidenceMode: 'safe-authoring-inspect',
        continueActions: [
          {
            type: 'get_text',
            text: 'Pine Editor',
            pineEvidenceMode: 'safe-authoring-inspect',
            continueActions: [
              { type: 'run_command', shell: 'powershell', command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Confidence\", overlay=false)\nplot(close)\n'@" },
              { type: 'key', key: 'ctrl+v' },
              {
                type: 'get_text',
                text: 'Pine Editor',
                pineEvidenceMode: 'save-status',
                continueActions: [
                  { type: 'key', key: 'ctrl+enter' },
                  { type: 'get_text', text: 'Pine Editor', pineEvidenceMode: 'compile-result' }
                ]
              }
            ]
          }
        ]
      }
    ]
  }, 'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator script for volume and momentum confidence. Use the new indicator flow so it does not reuse the current script, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.');

  assert.strictEqual(incomplete, false, 'nested safe-authoring continuations should satisfy Pine authoring completeness checks');
});

test('TradingView Pine authoring contract requires fresh-indicator flow for interactive indicator requests', () => {
  const contract = aiService.buildTradingViewPineAuthoringSystemContract(
    'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator script for volume and momentum confidence. Use the new indicator flow so it does not reuse the current script, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.'
  );

  assert(contract.includes('This request requires a fresh TradingView indicator script.'), 'interactive indicator prompts should force the fresh-indicator authoring path');
  assert(contract.includes('The first Pine header line must be exactly `//@version=...`'), 'contract should prevent contaminated Pine headers');
  assert(contract.includes('Read visible compile/apply result text before claiming success.'), 'contract should preserve visible result verification');
});

test('TradingView Pine authoring contract stays inactive for non-authoring TradingView prompts', () => {
  const contract = aiService.buildTradingViewPineAuthoringSystemContract(
    'TradingView is already open on the LUNR chart. Read the visible Pine Editor compile result.'
  );

  assert.strictEqual(contract, '', 'read-only Pine prompts should not receive the authoring contract');
});

test('generated Pine normalization preserves an exact requested-or-existing version header', () => {
  const normalized = aiService.normalizeGeneratedPineScript('Pine editor//@version=5\nindicator("Momentum Confidence", overlay=false)\nplot(close)');

  assert.strictEqual(normalized.split('\n')[0], '//@version=5', 'generated Pine normalization should preserve the clean requested or existing version header on the first line');
  assert(!/^pine\s*editor/i.test(normalized), 'generated Pine normalization should remove UI-label contamination');
});

test('canonical Pine state persists normalized source for later TradingView reconciliation', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-pine-state-'));
  const state = buildPineScriptState({
    source: 'Pine editor//@version=5\nindicator("Momentum Confidence", overlay=false)\nplot(close)',
    intent: 'create a new interactive TradingView indicator',
    origin: 'generated-recovery'
  });
  const persisted = persistPineScriptState(state, { cwd: tempRoot });

  try {
    assert.strictEqual(state.normalizedSource.split('\n')[0], '//@version=5', 'canonical Pine state should preserve the normalized version header from the source or intent');
    assert.strictEqual(state.scriptTitle, 'Momentum Confidence', 'canonical Pine state should infer the indicator title');
    assert(persisted?.sourcePath && persisted?.metadataPath, 'canonical Pine state should persist source and metadata artifacts');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('local Pine state validation rejects editor-text corruption inside strategy conditions', () => {
  const corrupted = validatePineScriptStateSource(`//@version=6
strategy("RSI and MACD Strategy", overlay=true)
rsiLength = input.int(14, title="RSI Length", minval=1)
macdFast = input.int(12, title="MACD Fast Length", minval=1)
macdSlow = input.int(26, title="MACD Slow Length", minval=1)
macdSignal = input.int(9, title="MACD Signal Length", minval=1)
rsi = ta.rsi(close, rsiLength)
[macdLine, macdSignalLine, macdHistogram] = ta.macd(close, macdFast, macdSlow, macdSignal)
longCondition = rsi > 50 and macine Editor
ine Editorine EditordLine > macdSignalLinePineine edito
shortCondition = rsi < 50 and macdLine < macdSignalLine
if longCondition
    strategy.entry("Long", strategy.long)
if shortCondition
    strategy.entry("Short", strategy.short)`);

  assert.strictEqual(corrupted.valid, false, 'editor-contaminated Pine should fail local validation');
  assert(corrupted.issues.some((issue) => issue.code === 'ui-contamination'), 'editor contamination should be surfaced as a validation issue');
  assert(corrupted.issues.some((issue) => issue.code === 'identifier-corruption'), 'identifier corruption should be surfaced as a validation issue');
});

test('buildPineClipboardPreparationCommandFromCanonicalState reads from the persisted local pine artifact', () => {
  const command = buildPineClipboardPreparationCommandFromCanonicalState({
    sourcePath: 'C:\\dev\\copilot-Liku-cli\\.liku\\pine-state\\pine-123456789abc-12345678.pine'
  });

  assert(/Test-Path -LiteralPath \$sourcePath/.test(command), 'clipboard command should verify that the persisted source path exists');
  assert(/Get-Content -LiteralPath \$sourcePath -Raw/.test(command), 'clipboard command should load the canonical Pine source from disk');
  assert(/Set-Clipboard -Value/.test(command), 'clipboard command should populate the clipboard from the persisted artifact');
});

test('buildPineClipboardPreparationCommandFromCanonicalState refuses invalid canonical Pine state', () => {
  const command = buildPineClipboardPreparationCommandFromCanonicalState({
    sourcePath: 'C:\\dev\\copilot-Liku-cli\\.liku\\pine-state\\pine-invalid.pine',
    validation: {
      valid: false,
      issues: [{ code: 'ui-contamination', message: 'Pine source still contains Pine Editor UI text contamination inside the script body.' }]
    }
  });

  assert.strictEqual(command, '', 'invalid canonical Pine state should not produce a clipboard load command');
});

test('canonical-state TradingView Pine recovery is treated as a complete authoring payload', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-pine-recovery-'));
  const prompt = 'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator script for volume and momentum confidence. Use the new indicator flow so it does not reuse the current script, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.';
  const state = buildPineScriptState({
    source: `//@version=6
indicator("Momentum Confidence", overlay=false)
plot(close)`,
    intent: prompt,
    origin: 'generated-recovery'
  });
  const persisted = persistPineScriptState(state, { cwd: tempRoot });

  try {
    const recovered = aiService.maybeBuildRecoveredTradingViewPineActionResponse({
      thought: 'Create and apply the requested TradingView Pine script',
      actions: [
        {
          type: 'run_command',
          shell: 'powershell',
          command: `Set-Clipboard -Value @'\n${state.normalizedSource}\n'@`,
          reason: 'Copy the prepared Pine script to the clipboard',
          pineCanonicalState: {
            id: state.id,
            scriptTitle: state.scriptTitle,
            sourceHash: state.sourceHash,
            origin: state.origin,
            sourcePath: persisted.sourcePath,
            metadataPath: persisted.metadataPath,
            validation: state.validation
          }
        }
      ],
      verification: 'TradingView should show the Pine Editor workflow, fresh indicator path, and visible compile/apply result.'
    }, prompt);

    assert(recovered?.message, 'canonical-state recovery should synthesize a complete TradingView Pine workflow');
    assert(/Get-Content -LiteralPath/.test(recovered.message), 'recovered workflow should reload Pine code from the persisted state file');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('invalid canonical-state TradingView Pine recovery remains incomplete and blocked', () => {
  const incomplete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      {
        type: 'run_command',
        shell: 'powershell',
        command: "Set-Clipboard -Value 'placeholder'",
        pineCanonicalState: {
          sourcePath: 'C:\\dev\\copilot-Liku-cli\\.liku\\pine-state\\pine-invalid.pine',
          validation: {
            valid: false,
            issues: [{ code: 'ui-contamination', message: 'Pine source still contains Pine Editor UI text contamination inside the script body.' }]
          }
        }
      },
      { type: 'key', key: 'ctrl+v' },
      { type: 'key', key: 'ctrl+enter' },
      { type: 'get_text', text: 'Pine Editor', pineEvidenceMode: 'compile-result' }
    ]
  }, 'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator script for volume and momentum confidence. Use the new indicator flow so it does not reuse the current script, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.');

  assert.strictEqual(incomplete, true, 'invalid canonical-state Pine payloads should remain incomplete until local validation passes');
});

test('TradingView Pine code-generation prompt requests code-only version-6 output', () => {
  const prompt = aiService.buildTradingViewPineCodeGenerationPrompt(
    'TradingView is already open on the LUNR chart. In Pine Editor, create a new interactive chart indicator script for volume and momentum confidence. Use the new indicator flow so it does not reuse the current script, add it to the chart with Ctrl+Enter, and report the visible compile/apply result.'
  );

  assert(prompt.includes('Return only Pine Script source code for this TradingView request.'), 'code-generation prompt should request code-only output');
  assert(prompt.includes('No markdown. No prose. No JSON. No tool calls.'), 'code-generation prompt should forbid non-code output');
  assert(prompt.includes('The first line must be exactly `//@version=6`.'), 'code-generation prompt should lock the Pine header format');
  assert(prompt.includes('fresh indicator script for a new interactive chart indicator'), 'code-generation prompt should preserve the fresh-indicator requirement');
});

test('focus-only TradingView Pine authoring plan remains blocked when no script payload was produced', () => {
  const recovered = aiService.maybeBuildRecoveredTradingViewPineActionResponse({
    thought: 'Executing requested actions',
    actions: [
      { type: 'focus_window', windowHandle: 459522 }
    ],
    verification: 'Verify the actions completed successfully'
  }, 'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.');

  assert.strictEqual(recovered, null, 'focus-only Pine authoring plans should stay blocked when no actual script payload was produced');
});

test('overwrite-style TradingView Pine prompts with focus-only plans remain incomplete instead of degrading into status-only playback', () => {
  const incomplete = aiService.isIncompleteTradingViewPineAuthoringPlan({
    actions: [
      { type: 'focus_window', windowHandle: 459522 },
      { type: 'focus_window', windowHandle: 459522 }
    ]
  }, 'TradingView is open in the background. Open Pine Editor for the LUNR chart, replace the current script with a new Pine script that shows confidence in volume and momentum, then press Ctrl+Enter to apply it and read the visible compile/apply result.');

  const recovered = aiService.maybeBuildRecoveredTradingViewPineActionResponse({
    thought: 'Executing requested actions',
    actions: [
      { type: 'focus_window', windowHandle: 459522 },
      { type: 'focus_window', windowHandle: 459522 }
    ],
    verification: 'Verify the actions completed successfully'
  }, 'TradingView is open in the background. Open Pine Editor for the LUNR chart, replace the current script with a new Pine script that shows confidence in volume and momentum, then press Ctrl+Enter to apply it and read the visible compile/apply result.');

  assert.strictEqual(incomplete, true, 'overwrite-style Pine authoring prompts should still be considered incomplete when the model only produced focus actions');
  assert.strictEqual(recovered, null, 'focus-only overwrite-style Pine plans should not be rewritten into misleading status-only workflows');
});

test('safe Pine continuation sanitizes contaminated Pine header text before paste', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\nPine editor//@version=6\nindicator(\"Momentum Confidence\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ], {
    userMessage: 'TradingView is already open on the LUNR chart. Open Pine Editor, create a new Pine script that shows confidence in volume and momentum, apply it with Ctrl+Enter, and report the visible compile/apply result'
  });

  const clipboardStep = collectWorkflowActions(rewritten).find((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || '')));

  assert(clipboardStep, 'safe continuation should preserve a clipboard preparation step');
  assert(!/pine\s*editor\s*(?=\/\/\s*@version\b)/i.test(String(clipboardStep.command || '')), 'clipboard payload should strip Pine Editor contamination before the version header');
  assert(/\/\/@version=6|\/\/\s*@version=6/i.test(String(clipboardStep.command || '')), 'clipboard payload should preserve a clean Pine version header');
});

test('destructive clear remains reserved for explicit overwrite intent', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 1000 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor for replacement script' },
    { type: 'type', text: 'indicator("Replacement")' }
  ], {
    userMessage: 'in tradingview, overwrite the current pine script with a replacement version'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert(rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'explicit overwrite should preserve select-all');
  assert(rewritten.some((action) => String(action?.key || '').toLowerCase() === 'backspace'), 'explicit overwrite should preserve destructive clear');
  assert(rewritten.some((action) => action?.type === 'type'), 'explicit overwrite should preserve typing after the clear');
});

test('pine resume prerequisites re-establish editor activation before destructive overwrite resumes', () => {
  const prerequisites = buildTradingViewPineResumePrerequisites([
    { type: 'bring_window_to_front', title: 'TradingView', processName: 'tradingview' },
    { type: 'wait', ms: 650 },
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' },
    { type: 'wait', ms: 220 },
    { type: 'key', key: 'ctrl+a', reason: 'Select all existing code' },
    { type: 'key', key: 'backspace', reason: 'Clear editor for replacement script' },
    { type: 'type', text: 'indicator("Replacement")' }
  ], 5, {
    lastTargetWindowProfile: {
      title: 'TradingView - LUNR',
      processName: 'tradingview'
    }
  });

  const opener = prerequisites.find((action) => action?.verify?.target === 'pine-editor');
  assert(Array.isArray(prerequisites), 'resume prerequisites should be returned as an action array');
  assert.strictEqual(prerequisites[0].type, 'bring_window_to_front');
  assert.strictEqual(prerequisites[2].type, 'click_element');
  assert.strictEqual(String(prerequisites[2]?.text || ''), 'Pine');
  assert.strictEqual(opener.type, 'click_element');
  assert.strictEqual(opener.verify.kind, 'editor-active');
  assert(prerequisites.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'resume prerequisites should re-select Pine Editor contents before destructive overwrite resumes');
});

test('open pine editor and summarize compile result stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'compile-result',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');
  assert(readback, 'compile-result workflow should gather Pine Editor text');
  assert.strictEqual(readback.pineEvidenceMode, 'compile-result');
  assert(/compile-result text/i.test(readback.reason), 'compile-result readback should use diagnostics-specific wording');
});

test('open pine editor and summarize diagnostics preserves bounded get_text readback', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'diagnostics',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');
  assert(readback, 'diagnostics workflow should gather Pine Editor text');
  assert.strictEqual(readback.pineEvidenceMode, 'diagnostics');
  assert(/diagnostics and warnings/i.test(readback.reason), 'diagnostics readback should use diagnostics-specific wording');
});

test('open pine editor and check 500-line budget stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-editor',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'line-budget',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+e', reason: 'Open Pine Editor' }
  ]);

  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  const readback = rewritten.find((action) => action?.type === 'get_text' && action?.text === 'Pine Editor');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert(readback, 'line-budget workflow should gather Pine Editor text');
  assert(/line-budget hints/i.test(readback.reason), 'pine editor line-budget readback should mention line-budget hints');
});

test('open pine profiler and summarize metrics stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-profiler',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'ctrl+shift+p', reason: 'Open Pine Profiler' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-profiler');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Profiler');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'profiler-summary');
});

test('open pine version history and read revisions stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-version-history',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'alt+h', reason: 'Open Pine Version History' }
  ]);

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Version History');
});

test('open pine version history and summarize visible revision metadata stays verification-first', () => {
  const rewritten = buildTradingViewPineWorkflowActions({
    appName: 'TradingView',
    surfaceTarget: 'pine-version-history',
    verifyKind: 'panel-visible',
    openerIndex: 0,
    wantsEvidenceReadback: true,
    pineEvidenceMode: 'provenance-summary',
    requiresObservedChange: false
  }, [
    { type: 'key', key: 'alt+h', reason: 'Open Pine Version History' }
  ]);

  assert.strictEqual(rewritten[4].type, 'get_text');
  assert.strictEqual(rewritten[4].text, 'Pine Version History');
  assert.strictEqual(rewritten[4].pineEvidenceMode, 'provenance-summary');
  assert.deepStrictEqual(rewritten[4].pineSummaryFields, [
    'latest-revision-label',
    'latest-relative-time',
    'visible-revision-count',
    'visible-recency-signal',
    'top-visible-revisions'
  ]);
  assert(/top visible Pine Version History revision metadata/i.test(rewritten[4].reason), 'version-history metadata readback should use provenance-summary wording');
});

test('pine evidence-gathering workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+shift+l' },
    { type: 'get_text', text: 'Pine Logs', reason: 'Read visible Pine Logs output' }
  ], {
    userMessage: 'open pine logs in tradingview and read output'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Logs');
  assert.strictEqual(readSteps[0].pineEvidenceMode, 'logs-summary');
  assert.strictEqual(rewritten[2].verify.target, 'pine-logs');
});

test('pine editor evidence workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+e' },
    { type: 'get_text', text: 'Pine Editor', reason: 'Read visible Pine Editor status text' }
  ], {
    userMessage: 'open pine editor in tradingview and summarize the visible compiler status'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  const opener = rewritten.find((action) => action?.verify?.target === 'pine-editor');
  assert.strictEqual(readSteps.length, 1, 'explicit pine editor readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Editor');
  assertSemanticPineIconRoute(rewritten);
  assert.strictEqual(opener.verify.target, 'pine-editor');
});

test('pine profiler evidence workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'ctrl+shift+p' },
    { type: 'get_text', text: 'Pine Profiler', reason: 'Read visible Pine Profiler output' }
  ], {
    userMessage: 'open pine profiler in tradingview and summarize what it says'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit profiler readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Profiler');
  assert.strictEqual(readSteps[0].pineEvidenceMode, 'profiler-summary');
  assert.strictEqual(rewritten[2].verify.target, 'pine-profiler');
});

test('pine version history workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'alt+h' },
    { type: 'get_text', text: 'Pine Version History', reason: 'Read visible Pine Version History entries' }
  ], {
    userMessage: 'open pine version history in tradingview and summarize the latest visible revisions'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit version-history readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Version History');
  assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
});

test('pine version history metadata workflow preserves trailing get_text read step', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'key', key: 'alt+h' },
    { type: 'get_text', text: 'Pine Version History', reason: 'Read top visible Pine Version History revision metadata', pineEvidenceMode: 'provenance-summary' }
  ], {
    userMessage: 'open pine version history in tradingview and summarize the top visible revision metadata'
  });

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  const readSteps = rewritten.filter((action) => action?.type === 'get_text');
  assert.strictEqual(readSteps.length, 1, 'explicit version-history metadata readback step should be preserved without duplication');
  assert.strictEqual(readSteps[0].text, 'Pine Version History');
  assert.strictEqual(readSteps[0].pineEvidenceMode, 'provenance-summary');
  assert.deepStrictEqual(readSteps[0].pineSummaryFields, [
    'latest-revision-label',
    'latest-relative-time',
    'visible-revision-count',
    'visible-recency-signal',
    'top-visible-revisions'
  ]);
  assert.strictEqual(rewritten[2].verify.target, 'pine-version-history');
});

test('pine workflow does not hijack speculative chart-analysis prompts', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    { type: 'screenshot' }
  ], {
    userMessage: 'use pine in tradingview to gather data for lunr and tell me what you think'
  });

  assert.strictEqual(rewritten, null, 'speculative chart-analysis prompts should not be auto-rewritten into Pine surface flows without an explicit safe open/read request');
});
