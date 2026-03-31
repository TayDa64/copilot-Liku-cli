#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

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
    process.exitCode = 1;
  }
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
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
  assert.strictEqual(opener.type, 'key');
  assert.strictEqual(opener.key, 'enter');
  assert.strictEqual(opener.verify.target, 'pine-editor');
  assert(readback, 'pine editor status workflow should gather Pine Editor text');
  assert.strictEqual(readback.pineEvidenceMode, 'generic-status');
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
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
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
  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
  assert.strictEqual(opener.verify.kind, 'editor-active');
  assert(rewritten.some((action) => action?.type === 'get_text' && action?.text === 'Pine Editor'), 'safe authoring should inspect visible Pine Editor state first');
  assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'ctrl+a'), 'safe authoring should avoid select-all by default');
  assert(!rewritten.some((action) => String(action?.key || '').toLowerCase() === 'backspace'), 'safe authoring should avoid destructive clear-first behavior');
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

  assert(Array.isArray(rewritten), 'workflow should rewrite');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
  assert.strictEqual(opener.verify.kind, 'editor-active');
  assert(inspectStep, 'safe authoring should inspect Pine Editor state first');
  assert.strictEqual(inspectStep.continueOnPineEditorState, 'empty-or-starter');
  assert(Array.isArray(inspectStep.continueActions) && inspectStep.continueActions.length > 0, 'safe authoring inspect step should carry continuation actions');
  assert(inspectStep.continueActions.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i'), 'continuation should create a fresh Pine indicator through the official shortcut chord');
  const freshInspect = inspectStep.continueActions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect' && Array.isArray(action?.continueActions));
  assert(freshInspect, 'continuation should verify a fresh Pine script surface after creating a new indicator');
  assert(freshInspect.continueActions.some((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || ''))), 'fresh-script continuation should preserve clipboard preparation');
  assert(freshInspect.continueActions.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v'), 'fresh-script continuation should paste the prepared script');
  const saveInspect = freshInspect.continueActions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status');
  assert(saveInspect, 'fresh-script continuation should verify visible save status before applying');
  assert.strictEqual(saveInspect.continueOnPineLifecycleState, 'saved-state-verified');
  assert(Array.isArray(saveInspect?.continueActionsByPineLifecycleState?.['save-required-before-apply']), 'save verification should branch into a first-save recovery path when TradingView requires a script name');
  assert(saveInspect.continueActionsByPineLifecycleState['save-required-before-apply'].some((action) => action?.type === 'type' && /Momentum Confidence/.test(String(action?.text || ''))), 'first-save recovery should derive a script name from the Pine payload');
  assert(saveInspect.continueActions.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+enter'), 'save-verified continuation should add the script to the chart');
  assert(saveInspect.continueActions.some((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'compile-result'), 'save-verified continuation should gather compile-result feedback after add-to-chart');
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

    const firstInspectIndex = rewritten.findIndex((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
    const newIndicatorIndex = rewritten.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i');
    const freshInspect = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect' && Array.isArray(action?.continueActions));
    const clearIndex = freshInspect?.continueActions?.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+a');
    const backspaceIndex = freshInspect?.continueActions?.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'backspace');
    const clipboardIndex = freshInspect?.continueActions?.findIndex((action) => action?.type === 'run_command' && /get-content\s+-literalpath/i.test(String(action?.command || '')));
    const pasteIndex = freshInspect?.continueActions?.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v');
    const clipboardStep = clipboardIndex >= 0 ? freshInspect?.continueActions?.[clipboardIndex] : null;
    const pasteStep = pasteIndex >= 0 ? freshInspect?.continueActions?.[pasteIndex] : null;

    assert(freshInspect, 'canonical-state flow should still verify the fresh Pine surface');
    assert(newIndicatorIndex >= 0, 'validated canonical-state flow should force the official new-indicator shortcut');
    assert(firstInspectIndex > newIndicatorIndex, 'validated canonical-state flow should skip the ambiguous current-buffer inspect and inspect only after starting the fresh-indicator route');
    assert.strictEqual(
      rewritten.slice(0, Math.max(0, firstInspectIndex)).some((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect'),
      false,
      'validated canonical-state flow should not inspect the current Pine buffer before starting fresh-script creation'
    );
    assert(clearIndex >= 0, 'canonical-state flow should select the starter script before replacement');
    assert(backspaceIndex > clearIndex, 'canonical-state flow should clear the starter script after select-all');
    assert(clipboardIndex > backspaceIndex, 'canonical-state flow should reload the canonical script from disk after clearing');
    assert(pasteIndex > clipboardIndex, 'canonical-state flow should paste after loading the canonical script');
    assert.strictEqual(clipboardStep?.pineCanonicalState?.sourcePath, persisted.sourcePath, 'canonical-state clipboard step should preserve the persisted source path');
    assert.strictEqual(clipboardStep?.pineCanonicalState?.validation?.valid, true, 'canonical-state clipboard step should preserve validation proof');
    assert.strictEqual(pasteStep?.pineCanonicalState?.sourceHash, pineState.sourceHash, 'canonical-state paste step should preserve canonical artifact identity');
    assert(/Get-Content -LiteralPath/i.test(String(clipboardStep?.command || '')), 'canonical-state clipboard step should source the script from the persisted .pine file');
    assert(String(clipboardStep?.command || '').includes(persisted.sourcePath), 'canonical-state clipboard step should reference the persisted .pine file path');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('explicit fresh-indicator prompts skip the ambiguous current-buffer inspect and go straight to the new-indicator flow', () => {
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

  const firstInspectIndex = rewritten.findIndex((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const newIndicatorIndex = rewritten.findIndex((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i');

  assert(newIndicatorIndex >= 0, 'fresh-indicator prompts should still route through the official new-indicator shortcut');
  assert(firstInspectIndex > newIndicatorIndex, 'fresh-indicator prompts should inspect only after starting the fresh-indicator flow');
  assert.strictEqual(
    rewritten.slice(0, Math.max(0, firstInspectIndex)).some((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect'),
    false,
    'fresh-indicator prompts should not gate on inspecting the current buffer before starting the new-indicator flow'
  );
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

  const freshInspect = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect' && Array.isArray(action?.continueActions));
  assert(Array.isArray(rewritten), 'workflow should rewrite the transcript-style Pine plan');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].key, 'ctrl+k', 'rewrite should route Pine Editor opening through the verified TradingView quick-search path');
  assert(freshInspect, 'rewrite should restore the safe Pine inspection contract before any authoring edit resumes');
  assert(rewritten.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i'), 'rewrite should force fresh-indicator creation instead of preserving raw clipboard overwrite steps');
  assert(freshInspect.continueActions.some((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || ''))), 'rewrite should preserve bounded clipboard preparation only after the fresh Pine surface is verified');
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

test('generated Pine normalization restores an exact version-6 header', () => {
  const normalized = aiService.normalizeGeneratedPineScript('Pine editor//@version=5\nindicator("Momentum Confidence", overlay=false)\nplot(close)');

  assert.strictEqual(normalized.split('\n')[0], '//@version=6', 'generated Pine normalization should force a clean version-6 header on the first line');
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
    assert.strictEqual(state.normalizedSource.split('\n')[0], '//@version=6', 'canonical Pine state should normalize the version header');
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

  const freshInspect = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect' && Array.isArray(action?.continueActions));
  const clipboardStep = freshInspect?.continueActions?.find((action) => action?.type === 'run_command' && /set-clipboard/i.test(String(action?.command || '')));

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
  assert.strictEqual(prerequisites[2].key, 'ctrl+k');
  assert.strictEqual(opener.type, 'key');
  assert.strictEqual(opener.key, 'enter');
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
  assert.strictEqual(rewritten[2].type, 'key');
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
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
  assert.strictEqual(rewritten[2].key, 'ctrl+k');
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
