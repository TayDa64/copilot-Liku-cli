#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const {
  synthesizePineScriptTitleContract
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-title-synthesis.js'));
const {
  maybeRewriteTradingViewPineWorkflow
} = require(path.join(__dirname, '..', 'src', 'main', 'tradingview', 'pine-workflows.js'));

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

const FEATURE_PROMPT = 'TradingView is already open. Create an industry standard confidence building indicator that includes ATR, VWAP, MACD, and RSI.';
const FEATURE_TITLE = 'ATR VWAP MACD RSI Confidence';

test('synthesizePineScriptTitleContract preserves explicit user titles', () => {
  const contract = synthesizePineScriptTitleContract({
    userMessage: 'TradingView is already open. Create a Pine script called "Liquidity Confidence Suite".'
  });

  assert.strictEqual(contract.title, 'Liquidity Confidence Suite');
  assert.strictEqual(contract.sourceKind, 'prompt-explicit');
  assert.strictEqual(contract.authoritative, true);
});

test('synthesizePineScriptTitleContract builds compact feature titles for ATR/VWAP/MACD/RSI prompts', () => {
  const contract = synthesizePineScriptTitleContract({
    userMessage: FEATURE_PROMPT
  });

  assert.strictEqual(contract.title, FEATURE_TITLE);
  assert.strictEqual(contract.sourceKind, 'feature-synthesis');
  assert.deepStrictEqual(contract.featureLabels.slice(0, 4), ['ATR', 'VWAP', 'MACD', 'RSI']);
  assert(contract.semanticLabels.includes('Confidence'));
});

test('buildTradingViewPineCodeGenerationPrompt declares the exact synthesized title', () => {
  const prompt = aiService.buildTradingViewPineCodeGenerationPrompt(FEATURE_PROMPT);

  assert(prompt.includes(`Use this exact script title in the declaration: "${FEATURE_TITLE}".`));
});

test('normalizeGeneratedPineScript enforces the synthesized title contract on the declaration', () => {
  const normalized = aiService.normalizeGeneratedPineScript({
    pineScript: '//@version=6\nindicator("Industry Standard Confidence Building Indicator", overlay=false)\nplot(close)',
    userMessage: FEATURE_PROMPT
  });

  assert(/indicator\("ATR VWAP MACD RSI Confidence", overlay=false\)/.test(normalized), 'normalized Pine should carry the explicit synthesized title');
});

test('TradingView Pine workflow carries the synthesized title into save verification metadata', () => {
  const rewritten = maybeRewriteTradingViewPineWorkflow([
    {
      type: 'run_command',
      shell: 'powershell',
      command: "Set-Clipboard -Value @'\n//@version=6\nindicator(\"Industry Standard Confidence Building Indicator\", overlay=false)\nplot(close)\n'@",
      reason: 'Copy the prepared Pine script to the clipboard'
    }
  ], {
    userMessage: FEATURE_PROMPT
  });

  const inspectStep = rewritten.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'safe-authoring-inspect');
  const starterContinuation = inspectStep?.continueActionsByPineEditorState?.['empty-or-starter'] || inspectStep?.continueActions || [];
  const pasteAction = starterContinuation.find((action) => action?.type === 'key' && String(action?.key || '').toLowerCase() === 'ctrl+v');
  const saveStatusAction = starterContinuation.find((action) => action?.type === 'get_text' && action?.pineEvidenceMode === 'save-status');

  assert(pasteAction, 'workflow should retain the bounded paste step');
  assert.strictEqual(String(pasteAction?.pinePreparedScriptName || ''), FEATURE_TITLE);
  assert(saveStatusAction, 'workflow should retain the bounded save-status verification step');
  assert.strictEqual(String(saveStatusAction?.pineExpectedScriptName || ''), FEATURE_TITLE);
});

console.log(`\nPine title synthesis tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
