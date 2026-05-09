#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  buildPineCreateSaveScenario
} = require(path.join(__dirname, 'live-tradingview-smoke.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
  }
}

test('pine-create-save scenario uses fresh-script recovery when a visible existing Pine script is present', () => {
  const prompt = 'TradingView is already open. Create an industry standard confidence building indicator that includes ATR, VWAP, MACD, and RSI. Save the script and report the visible save status. Do not add it to the chart.';
  const scenario = buildPineCreateSaveScenario(prompt);
  const actions = scenario?.actionData?.actions || [];
  const inspectStep = actions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || [];
  const existingScriptContinuation = inspectStep?.continueActionsByPineEditorState?.['existing-script-visible'] || [];
  const createNewStep = existingScriptContinuation.find((action) =>
    action?.type === 'click_element' && String(action?.text || '').trim() === 'Create new'
  );
  const freshInspect = existingScriptContinuation.find((action) =>
    action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect'
  );
  const saveStatusStep = starterContinuation.find((action) =>
    action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status'
  );

  assert(inspectStep, 'scenario should inspect the active Pine surface before authoring');
  assert(Array.isArray(starterContinuation) && starterContinuation.length > 0, 'starter-safe continuation should remain available');
  assert(Array.isArray(existingScriptContinuation) && existingScriptContinuation.length > 0, 'existing-script continuation should pivot into a fresh-script route');
  assert(createNewStep, 'existing-script continuation should use the verified Pine Create new route');
  assert(freshInspect, 'existing-script continuation should re-verify the fresh Pine starter surface');
  assert.strictEqual(String(saveStatusStep?.pineExpectedScriptName || ''), 'ATR VWAP MACD RSI Confidence');

  const pasteStep = starterContinuation.find((action) =>
    action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v'
  );
  assert.strictEqual(String(pasteStep?.pinePreparedScriptName || ''), 'ATR VWAP MACD RSI Confidence');
  assert(/indicator\("ATR VWAP MACD RSI Confidence"/.test(String(pasteStep?.pinePreparedScriptText || '')));
});

test('pine-create-save scenario preserves an explicit smoke script name over synthesized feature titles', () => {
  const prompt = 'TradingView is already open. Create an industry standard confidence building indicator that includes ATR, VWAP, MACD, and RSI. Save the script and report the visible save status. Do not add it to the chart.';
  const explicitScriptName = 'Liku Monaco Steady State Probe 20260509-1445';
  const scenario = buildPineCreateSaveScenario(prompt, explicitScriptName);
  const actions = scenario?.actionData?.actions || [];
  const inspectStep = actions.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || [];
  const saveStatusStep = starterContinuation.find((action) =>
    action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status'
  );
  const pasteStep = starterContinuation.find((action) =>
    action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v'
  );

  assert.strictEqual(String(saveStatusStep?.pineExpectedScriptName || ''), explicitScriptName);
  assert.strictEqual(String(pasteStep?.pinePreparedScriptName || ''), explicitScriptName);
  assert(/indicator\("Liku Monaco Steady State Probe 20260509-1445"/.test(String(pasteStep?.pinePreparedScriptText || '')));
});

console.log(`\nLive TradingView pine-create-save tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
