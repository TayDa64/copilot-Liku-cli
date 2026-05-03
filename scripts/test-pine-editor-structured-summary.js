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

let asyncTestChain = Promise.resolve();
let asyncDrainScheduled = false;

function scheduleAsyncDrain() {
  if (asyncDrainScheduled) return;
  asyncDrainScheduled = true;
  setImmediate(async () => {
    try {
      await asyncTestChain;
    } catch {
      // Individual tests already record failures via process.exitCode.
    }
    if (process.exitCode) {
      process.exit(process.exitCode);
    }
  });
}

async function testAsync(name, fn) {
  asyncTestChain = asyncTestChain.then(async () => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    }
  });
  scheduleAsyncDrain();
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

test('Pine safe-authoring summary treats anchor-only starter surfaces as empty-or-starter', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'Publish script\nAdd to chart\nPine Logs\nStrategy Tester'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'empty-or-starter');
  assert(summary.visibleSignals.includes('starter-surface-anchors-visible'));
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

testAsync('GET_TEXT falls back to Pine editor anchors when exact Pine Editor element is not discoverable', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async (criteria) => {
    if (/publish script/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Publish script',
          bounds: { x: 100, y: 100, width: 120, height: 24, centerX: 160, centerY: 112 }
        }
      };
    }
    return { success: false, error: 'Element not found' };
  };
  host.getText = async () => ({
    text: 'Untitled script\nplot(close)\nPublish script',
    method: 'TextPattern',
    element: { name: 'Publish script' }
  });
  uiContext.setUIWatcher(null);

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      allowSparseOpenStateFallback: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert(
      /pine-editor-fallback:Publish script|WatcherCache \(pine-editor-fallback\)/i.test(String(result.method || '')),
      'fallback method should record either the Pine anchor or the watcher-backed Pine fallback'
    );
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT prefers fast Pine fallback before full UIA text extraction for safe authoring', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = uiContext.getUIWatcher();
  let getElementTextCalls = 0;

  uiAutomation.getElementText = async () => {
    getElementTextCalls++;
    return {
      success: false,
      error: 'This path should not be used when fast Pine fallback succeeds'
    };
  };
  uiAutomation.findElement = async (criteria) => {
    if (/publish script/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Publish script',
          bounds: { x: 100, y: 100, width: 120, height: 24, centerX: 160, centerY: 112 }
        }
      };
    }
    if (/add to chart/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Add to chart',
          bounds: { x: 100, y: 140, width: 120, height: 24, centerX: 160, centerY: 152 }
        }
      };
    }
    return { success: false, error: 'Element not found' };
  };
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher(null);

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      allowSparseOpenStateFallback: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(getElementTextCalls, 0, 'fast Pine fallback should bypass full UIA text extraction when anchors are already enough');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert(/ElementAnchor \(pine-editor-fallback\)/i.test(String(result.method || '')));
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT checks synthetic Pine anchors before literal Pine Editor probe for safe authoring', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = uiContext.getUIWatcher();
  const searchedTexts = [];

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async (criteria) => {
    const text = String(criteria?.text || '');
    searchedTexts.push(text);
    if (/untitled script/i.test(text)) {
      return {
        success: true,
        element: {
          name: 'Untitled script',
          bounds: { x: 100, y: 100, width: 120, height: 24, centerX: 160, centerY: 112 }
        }
      };
    }
    if (/pine editor/i.test(text)) {
      throw new Error('literal Pine Editor probe should not be attempted before synthetic anchors');
    }
    return { success: false, error: 'Element not found' };
  };
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher(null);

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(searchedTexts[0], 'Untitled script');
    assert(/ElementAnchor \(pine-editor-fallback\)/i.test(String(result.method || '')));
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT degrades to bounded Pine element anchors when UIA text extraction still fails on a fresh script surface', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async (criteria) => {
    if (/untitled script/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Untitled script',
          bounds: { x: 100, y: 100, width: 120, height: 24, centerX: 160, centerY: 112 }
        }
      };
    }
    if (/publish script/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Publish script',
          bounds: { x: 100, y: 140, width: 120, height: 24, centerX: 160, centerY: 152 }
        }
      };
    }
    return { success: false, error: 'Element not found' };
  };
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher(null);

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert(/ElementAnchor \(pine-editor-fallback\)/i.test(String(result.method || '')), 'bounded Pine anchor fallback should record its degraded evidence method');
    assert(/Untitled script/i.test(String(result.text || '')), 'bounded Pine anchor fallback should preserve the starter-surface anchor text');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT bounds safe-authoring fallback candidates when watcher evidence is sparse', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = uiContext.getUIWatcher();
  const searchedTexts = [];

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Full UIA text extraction should remain bypassed for safe-authoring fast fallback'
  });
  uiAutomation.findElement = async (criteria) => {
    searchedTexts.push(String(criteria?.text || ''));
    return { success: false, error: 'Element not found' };
  };
  host.getText = async () => {
    throw new Error('TextPattern should not run without a matched bounded candidate');
  };
  uiContext.setUIWatcher({
    cache: {
      activeWindow: {
        hwnd: 986022,
        processName: 'TradingView',
        title: 'INTC / Unnamed'
      },
      elements: [
        { name: 'chart', windowHandle: 986022 },
        { name: 'price scale', windowHandle: 986022 },
        { name: 'toolbar', windowHandle: 986022 },
        ...Array.from({ length: 12 }, (_, index) => ({ name: `other-${index}`, windowHandle: 12345 }))
      ]
    }
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      allowSparseOpenStateFallback: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true, 'sparse watcher evidence without Pine anchors should return bounded open-state proof instead of hanging');
    assert(searchedTexts.length <= 2, `safe-authoring inspect should stop after a sparse watcher candidate budget, saw ${searchedTexts.length}`);
    assert(!searchedTexts.includes('My Strategy'), 'sparse watcher budget should not exhaust later synthetic candidates');
    assert(/WatcherOpenState \(pine-editor-sparse-safe-authoring\)/i.test(String(result.method || '')), 'sparse watcher fallback should record bounded open-state proof');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT degrades to bounded save-state anchors when TradingView first-save text extraction fails', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async (criteria) => {
    if (/save script/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Save script',
          bounds: { x: 100, y: 100, width: 120, height: 24, centerX: 160, centerY: 112 }
        }
      };
    }
    if (/script name/i.test(String(criteria?.text || ''))) {
      return {
        success: true,
        element: {
          name: 'Script name',
          bounds: { x: 100, y: 140, width: 120, height: 24, centerX: 160, centerY: 152 }
        }
      };
    }
    return { success: false, error: 'Element not found' };
  };
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher(null);

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'save-status',
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'save-status');
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'save-required-before-apply');
    assert(/ElementAnchor \(pine-editor-fallback\)/i.test(String(result.method || '')), 'bounded save-state anchor fallback should record its degraded evidence method');
    assert(/Save script/i.test(String(result.text || '')), 'bounded save-state anchor fallback should preserve visible save prompts');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT falls back to watcher-backed Pine surface text when UIA text extraction still fails', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const previousWatcher = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js')).getUIWatcher();
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async () => ({
    success: false,
    error: 'Element not found'
  });
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher({
    cache: {
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: [
        { name: 'Untitled script', windowHandle: 777, automationId: '', className: 'Tab' },
        { name: 'Publish script', windowHandle: 777, automationId: '', className: 'Button' },
        { name: 'Add to chart', windowHandle: 777, automationId: '', className: 'Button' }
      ]
    }
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert(/WatcherCache \(pine-editor-fallback\)/i.test(String(result.method || '')), 'watcher fallback should record its method');
    assert(/Untitled script/i.test(String(result.text || '')), 'watcher fallback should preserve bounded Pine surface text');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT returns bounded unknown save-state proof when sparse TradingView UIA cannot expose save text', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async () => ({
    success: false,
    error: 'Element not found'
  });
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher({
    cache: {
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: [
        { name: 'Pine Editor container', windowHandle: 777, automationId: '', className: 'Pane' },
        { name: 'Editor shell', windowHandle: 777, automationId: '', className: 'Pane' },
        { name: 'Status area', windowHandle: 777, automationId: '', className: 'Text' },
        { name: 'Off-window chart title', windowHandle: 999, automationId: '', className: 'Text' }
      ]
    }
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'save-status',
      allowSparseSaveStateFallback: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'save-status');
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'unknown-save-state');
    assert(/WatcherOpenState \(pine-editor-sparse-save-status\)/i.test(String(result.method || '')), 'sparse save fallback should record bounded degraded proof');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT rejects watcher chart-title noise as Pine editor evidence when no Pine anchors are visible', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const host = uiAutomation.getSharedUIAHost();
  const originalHostGetText = host.getText.bind(host);
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async () => ({
    success: false,
    error: 'Element not found'
  });
  host.getText = async () => {
    throw new Error('TextPattern failed');
  };
  uiContext.setUIWatcher({
    cache: {
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: [
        { name: 'LUNR ▲ 18.56 +13.52% / Unnamed', windowHandle: 777, automationId: '', className: 'Text' }
      ]
    }
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    });

    assert.strictEqual(result.success, false);
    assert(/element not found/i.test(String(result.error || '')), 'chart-title noise should not be accepted as Pine editor evidence');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    host.getText = originalHostGetText;
    uiContext.setUIWatcher(previousWatcher);
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
