#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

const {
  buildTradingViewPineResumePrerequisites,
  inferTradingViewPineIntent,
  buildTradingViewPineWorkflowActions,
  maybeRewriteTradingViewPineWorkflow,
  inferPineVersionHistoryEvidenceMode
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));

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
  assert(Array.isArray(rewritten), 'workflow should rewrite the transcript-style Pine plan');
  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[2].key, 'ctrl+k', 'rewrite should route Pine Editor opening through the verified TradingView quick-search path');
  assert(inspectStep, 'rewrite should restore the safe Pine inspection contract before any authoring edit resumes');
  assert(inspectStep.continueActions.some((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+i'), 'rewrite should force fresh-indicator creation instead of preserving raw clipboard overwrite steps');
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
