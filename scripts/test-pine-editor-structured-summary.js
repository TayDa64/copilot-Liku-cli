#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('Pine compile-result summary stays bounded to visible compiler status', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Compiler: no errors. Status: strategy loaded.',
    'compile-result'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'compile-result');
  assert.strictEqual(summary.compileStatus, 'success');
  assert.strictEqual(summary.errorCountEstimate, 0);
  assert.strictEqual(summary.warningCountEstimate, 0);
  assert(summary.statusSignals.includes('compile-success-visible'));
  assert(summary.topVisibleDiagnostics.includes('Compiler: no errors. Status: strategy loaded.'));
});

test('Pine diagnostics summary surfaces visible compiler errors and warnings', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Compiler error at line 42: mismatched input. Warning: script has unused variable.',
    'diagnostics'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'diagnostics');
  assert.strictEqual(summary.compileStatus, 'errors-visible');
  assert.strictEqual(summary.errorCountEstimate, 1);
  assert.strictEqual(summary.warningCountEstimate, 1);
  assert(summary.statusSignals.includes('compile-errors-visible'));
  assert(summary.statusSignals.includes('warnings-visible'));
  assert.deepStrictEqual(summary.topVisibleDiagnostics, [
    'Compiler error at line 42: mismatched input. Warning: script has unused variable.'
  ]);
});

test('Pine line-budget summary exposes visible count hints and limit pressure', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Line count: 487 / 500 lines. Warning: script is close to the Pine limit.',
    'line-budget'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'line-budget');
  assert.strictEqual(summary.visibleLineCountEstimate, 487);
  assert.strictEqual(summary.lineBudgetSignal, 'near-limit-visible');
  assert.strictEqual(summary.warningCountEstimate, 1);
  assert(summary.statusSignals.includes('line-budget-hint-visible'));
  assert(summary.statusSignals.includes('near-limit-visible'));
});

testAsync('GET_TEXT attaches Pine structured summary for compile-result mode', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;

  uiAutomation.getElementText = async () => ({
    success: true,
    text: 'Compiler: no errors. Status: strategy loaded.',
    method: 'TextPattern'
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'compile-result'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'compile-result');
    assert.strictEqual(result.pineStructuredSummary.compileStatus, 'success');
    assert(result.message.includes('status=success'));
  } finally {
    uiAutomation.getElementText = originalGetElementText;
  }
});
