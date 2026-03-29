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

test('Pine logs summary stays bounded to visible error output', () => {
  const summary = systemAutomation.buildPineLogsStructuredSummary(
    'Runtime error at bar 12: division by zero.\nWarning: fallback branch used.'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'logs-summary');
  assert.strictEqual(summary.outputSurface, 'pine-logs');
  assert.strictEqual(summary.outputSignal, 'errors-visible');
  assert.strictEqual(summary.visibleOutputEntryCount, 2);
  assert.deepStrictEqual(summary.topVisibleOutputs, [
    'Runtime error at bar 12: division by zero.',
    'Warning: fallback branch used.'
  ]);
});

test('Pine profiler summary extracts visible performance metrics', () => {
  const summary = systemAutomation.buildPineProfilerStructuredSummary(
    'Profiler: 12 calls, avg 1.3ms, max 3.8ms.\nSlowest block: request.security'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'profiler-summary');
  assert.strictEqual(summary.outputSurface, 'pine-profiler');
  assert.strictEqual(summary.outputSignal, 'metrics-visible');
  assert.strictEqual(summary.functionCallCountEstimate, 12);
  assert.strictEqual(summary.avgTimeMs, 1.3);
  assert.strictEqual(summary.maxTimeMs, 3.8);
  assert(summary.topVisibleOutputs.includes('Profiler: 12 calls, avg 1.3ms, max 3.8ms.'));
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

testAsync('GET_TEXT attaches Pine structured summary for Pine Logs', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;

  uiAutomation.getElementText = async () => ({
    success: true,
    text: 'Runtime error at bar 12: division by zero.\nWarning: fallback branch used.',
    method: 'TextPattern'
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Logs',
      pineEvidenceMode: 'logs-summary'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'logs-summary');
    assert.strictEqual(result.pineStructuredSummary.outputSignal, 'errors-visible');
    assert(result.message.includes('signal=errors-visible'));
  } finally {
    uiAutomation.getElementText = originalGetElementText;
  }
});

testAsync('GET_TEXT attaches Pine structured summary for Pine Profiler', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;

  uiAutomation.getElementText = async () => ({
    success: true,
    text: 'Profiler: 12 calls, avg 1.3ms, max 3.8ms.',
    method: 'TextPattern'
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Profiler',
      pineEvidenceMode: 'profiler-summary'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'profiler-summary');
    assert.strictEqual(result.pineStructuredSummary.functionCallCountEstimate, 12);
    assert.strictEqual(result.pineStructuredSummary.avgTimeMs, 1.3);
    assert.strictEqual(result.pineStructuredSummary.maxTimeMs, 3.8);
    assert(result.message.includes('signal=metrics-visible'));
  } finally {
    uiAutomation.getElementText = originalGetElementText;
  }
});
