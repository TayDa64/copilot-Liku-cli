#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const systemAutomation = require(path.join(__dirname, '..', 'src', 'main', 'system-automation.js'));
const { shutdownSharedUIAHost } = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
const originalExecuteAction = systemAutomation.executeAction.bind(systemAutomation);

const forcedExitTimer = setTimeout(() => {
  console.error('FAIL test-pine-editor-structured-summary timed out');
  process.exit(1);
}, 45000);
if (typeof forcedExitTimer.unref === 'function') {
  forcedExitTimer.unref();
}

function buildInertAutomationRuntimeOptions(runtimeOptions = {}) {
  return {
    click: async () => ({ success: true, message: 'inert-click' }),
    doubleClick: async () => ({ success: true, message: 'inert-double-click' }),
    moveMouse: async () => ({ success: true, message: 'inert-move-mouse' }),
    typeText: async () => ({ success: true, message: 'inert-type' }),
    pressKey: async () => ({ success: true, message: 'inert-key' }),
    ...(runtimeOptions && typeof runtimeOptions === 'object' ? runtimeOptions : {})
  };
}

systemAutomation.executeAction = function executeActionHermetic(action, runtimeOptions = {}) {
  return originalExecuteAction(action, buildInertAutomationRuntimeOptions(runtimeOptions));
};

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
    try {
      await shutdownSharedUIAHost().catch(() => {});
    } finally {
      clearTimeout(forcedExitTimer);
      process.exit(process.exitCode || 0);
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

async function withMockForegroundHost(foreground, fn) {
  if (process.platform !== 'win32') {
    return fn();
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const sharedHost = typeof originalGetSharedUIAHost === 'function'
    ? originalGetSharedUIAHost()
    : {};
  const originalHostGetForegroundWindowInfo = sharedHost && typeof sharedHost === 'object'
    ? sharedHost.getForegroundWindowInfo
    : undefined;
  const foregroundInfo = foreground && typeof foreground === 'object'
    ? { ...foreground }
    : {
        hwnd: 777,
        processName: 'TradingView',
        title: 'TradingView',
        windowKind: 'main'
      };

  if (sharedHost && typeof sharedHost === 'object') {
    sharedHost.getForegroundWindowInfo = async () => foregroundInfo;
  }
  uiAutomation.getSharedUIAHost = () => sharedHost;
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    return await fn();
  } finally {
    if (sharedHost && typeof sharedHost === 'object') {
      sharedHost.getForegroundWindowInfo = originalHostGetForegroundWindowInfo;
    }
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
}

async function withMockAutomationHost(hostOverrides, fn) {
  if (process.platform !== 'win32') {
    return fn();
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const sharedHost = typeof originalGetSharedUIAHost === 'function'
    ? (originalGetSharedUIAHost() || {})
    : {};
  const originalHostValues = new Map();

  for (const [key, value] of Object.entries(hostOverrides && typeof hostOverrides === 'object' ? hostOverrides : {})) {
    originalHostValues.set(key, sharedHost[key]);
    sharedHost[key] = value;
  }

  uiAutomation.getSharedUIAHost = () => sharedHost;
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    return await fn();
  } finally {
    for (const [key, value] of originalHostValues.entries()) {
      sharedHost[key] = value;
    }
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
}

testAsync('KEY skips TradingView Ctrl+E when Pine Editor is already active', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP KEY skips TradingView Ctrl+E when Pine Editor is already active (requires Windows automation host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const tradingViewForeground = {
    hwnd: 777,
    processName: 'TradingView',
    title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
    windowKind: 'main',
    bounds: { x: 100, y: 20, width: 1200, height: 900 }
  };
  let pressCalls = 0;

  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => tradingViewForeground,
    findElementsByWindow: async () => ({
      elements: [
        {
          Name: 'Add to chart',
          ControlType: 'ControlType.Button',
          WindowHandle: 777,
          Bounds: { X: 420, Y: 690, Width: 120, Height: 28, CenterX: 480, CenterY: 704 }
        }
      ],
      stats: { visited: 6, elapsedMs: 18, timedOut: false }
    })
  });
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    const result = await systemAutomation.executeAction({
      type: 'key',
      key: 'ctrl+e',
      tradingViewShortcut: {
        id: 'open-pine-editor',
        surface: 'pine-editor'
      }
    }, {
      pressKey: async () => {
        pressCalls += 1;
      }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true, 'bounded Pine surface proof should skip redundant Ctrl+E presses');
    assert.strictEqual(result.skippedReason, 'pine-editor-already-active');
    assert.strictEqual(pressCalls, 0, 'redundant Ctrl+E should not reach keyboard injection when Pine is already active');
    assert(/already active/i.test(String(result.message || '')), 'skip message should explain why Ctrl+E was bypassed');
  } finally {
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
});

testAsync('CLICK_ELEMENT skips the TradingView semantic Pine icon when Pine Editor is already active', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP CLICK_ELEMENT skips the TradingView semantic Pine icon when Pine Editor is already active (requires Windows automation host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const tradingViewForeground = {
    hwnd: 777,
    processName: 'TradingView',
    title: 'LUNR ▲ 18.56 +13.52% / Untitled',
    windowKind: 'main',
    bounds: { x: 100, y: 20, width: 1200, height: 900 }
  };
  let semanticClickCalls = 0;

  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => tradingViewForeground,
    findElementsByWindow: async () => ({
      elements: [
        {
          Name: 'Add to chart',
          ControlType: 'ControlType.Button',
          WindowHandle: 777,
          Bounds: { X: 420, Y: 690, Width: 120, Height: 28, CenterX: 480, CenterY: 704 }
        }
      ],
      stats: { visited: 6, elapsedMs: 18, timedOut: false }
    })
  });
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    const result = await systemAutomation.executeAction({
      type: 'click_element',
      text: 'Pine',
      controlType: 'Button',
      allowCoordinateFallback: false,
      tradingViewShortcut: {
        id: 'open-pine-editor',
        route: 'semantic-icon',
        surface: 'pine-editor'
      },
      searchSurfaceContract: {
        id: 'open-pine-editor',
        route: 'semantic-icon',
        surface: 'pine-editor'
      }
    }, {
      clickElementByText: async () => {
        semanticClickCalls += 1;
        return { success: true };
      }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true, 'bounded Pine surface proof should skip redundant semantic Pine icon clicks');
    assert.strictEqual(result.skippedReason, 'pine-editor-already-active');
    assert.strictEqual(semanticClickCalls, 0, 'redundant semantic Pine icon clicks should not reach UIA click execution when Pine is already active');
    assert(/already active/i.test(String(result.message || '')), 'skip message should explain why the semantic Pine opener was bypassed');
  } finally {
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
});

testAsync('KEY verifies Pine authoring paste with a single bounded retry before save continues', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP KEY verifies Pine authoring paste with a single bounded retry before save continues (requires Windows automation host)');
    return;
  }

  const expectedScript = [
    '//@version=6',
    'indicator("Liku Live Save Probe", overlay=false)',
    'plot(close, title="Close")'
  ].join('\n');
  const starterScript = [
    '//@version=6',
    'indicator("My script")',
    'plot(close)'
  ].join('\n');
  let editorBuffer = starterScript;
  let clipboardText = expectedScript;
  let savedClipboardText = '';
  let selectionActive = false;
  let pasteAttempts = 0;

  const result = await withMockAutomationHost({
    getForegroundWindowInfo: async () => ({
      hwnd: 777,
      processName: 'TradingView',
      title: 'LIKU LIVE SAVE PROBE ▲ 28.97 +20.16% / Unnamed',
      windowKind: 'main'
    }),
    saveClipboardState: async () => {
      savedClipboardText = clipboardText;
      return { success: true, token: 'paste-proof-token', mode: 'host-token', source: 'uia-host' };
    },
    restoreClipboardState: async () => {
      clipboardText = savedClipboardText;
      return { success: true, token: 'paste-proof-token', source: 'uia-host' };
    },
    getClipboardText: async () => ({ text: clipboardText }),
    setClipboardText: async (text) => {
      clipboardText = String(text || '');
      return { success: true };
    }
  }, async () => systemAutomation.executeAction({
    type: 'key',
    key: 'ctrl+v',
    inputSurfaceContract: {
      appName: 'TradingView',
      route: 'pine-editor-authoring',
      surface: 'pine-editor',
      requiresPineEditorSurface: true,
      requiresCommandSurfaceClosed: true
    },
    pinePreparedScriptText: expectedScript,
    pinePreparedScriptName: 'Liku Live Save Probe'
  }, {
    disableTradingViewPineAuthoringCDP: true,
    pressKey: async (key) => {
      const normalizedKey = String(key || '').trim().toLowerCase();
      if (normalizedKey === 'ctrl+v') {
        pasteAttempts += 1;
        editorBuffer = pasteAttempts === 1
          ? `${expectedScript}\n\n${starterScript}`
          : expectedScript;
        selectionActive = false;
        return;
      }
      if (normalizedKey === 'ctrl+a') {
        selectionActive = true;
        return;
      }
      if (normalizedKey === 'ctrl+c') {
        clipboardText = selectionActive ? editorBuffer : clipboardText;
        return;
      }
      if (normalizedKey === 'backspace' && selectionActive) {
        editorBuffer = '';
        selectionActive = false;
      }
    }
  }));

  assert.strictEqual(result.success, true);
  assert.strictEqual(pasteAttempts, 2, 'paste proof should perform at most one bounded repair retry');
  assert.strictEqual(result.pineAuthoringPasteProof?.retryAttempted, true, 'paste proof should record the bounded retry');
  assert.strictEqual(result.pineAuthoringPasteProof?.proof?.exactMatch, true, 'retry proof should confirm the prepared script exactly matches the editor buffer');
  assert.strictEqual(result.pineAuthoringWriteTelemetry?.fallbackUsed, true);
  assert.strictEqual(result.pineAuthoringWriteTelemetry?.fallbackRetryAttempted, true);
  assert.strictEqual(result.pineAuthoringWriteTelemetry?.selectedMethod, 'ClipboardRoundTrip');
  assert.strictEqual(editorBuffer.replace(/\r/g, '').trim(), expectedScript.replace(/\r/g, '').trim(), 'bounded retry should leave the editor with only the prepared script');
  assert(/repaired the Pine buffer/i.test(String(result.message || '')), 'result message should explain that a single bounded repair retry was used');
});

testAsync('KEY fails closed when Pine authoring paste proof still mismatches after a single bounded retry', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP KEY fails closed when Pine authoring paste proof still mismatches after a single bounded retry (requires Windows automation host)');
    return;
  }

  const expectedScript = [
    '//@version=6',
    'indicator("Liku Live Save Probe", overlay=false)',
    'plot(close, title="Close")'
  ].join('\n');
  const starterScript = [
    '//@version=6',
    'indicator("My script")',
    'plot(close)'
  ].join('\n');
  let editorBuffer = starterScript;
  let clipboardText = expectedScript;
  let savedClipboardText = '';
  let selectionActive = false;
  let pasteAttempts = 0;

  const result = await withMockAutomationHost({
    getForegroundWindowInfo: async () => ({
      hwnd: 777,
      processName: 'TradingView',
      title: 'LIKU LIVE SAVE PROBE ▲ 28.97 +20.16% / Unnamed',
      windowKind: 'main'
    }),
    saveClipboardState: async () => {
      savedClipboardText = clipboardText;
      return { success: true, token: 'paste-proof-token', mode: 'host-token', source: 'uia-host' };
    },
    restoreClipboardState: async () => {
      clipboardText = savedClipboardText;
      return { success: true, token: 'paste-proof-token', source: 'uia-host' };
    },
    getClipboardText: async () => ({ text: clipboardText }),
    setClipboardText: async (text) => {
      clipboardText = String(text || '');
      return { success: true };
    }
  }, async () => systemAutomation.executeAction({
    type: 'key',
    key: 'ctrl+v',
    inputSurfaceContract: {
      appName: 'TradingView',
      route: 'pine-editor-authoring',
      surface: 'pine-editor',
      requiresPineEditorSurface: true,
      requiresCommandSurfaceClosed: true
    },
    pinePreparedScriptText: expectedScript,
    pinePreparedScriptName: 'Liku Live Save Probe'
  }, {
    disableTradingViewPineAuthoringCDP: true,
    pressKey: async (key) => {
      const normalizedKey = String(key || '').trim().toLowerCase();
      if (normalizedKey === 'ctrl+v') {
        pasteAttempts += 1;
        editorBuffer = `${expectedScript}\n\n${starterScript}`;
        selectionActive = false;
        return;
      }
      if (normalizedKey === 'ctrl+a') {
        selectionActive = true;
        return;
      }
      if (normalizedKey === 'ctrl+c') {
        clipboardText = selectionActive ? editorBuffer : clipboardText;
        return;
      }
      if (normalizedKey === 'backspace' && selectionActive) {
        editorBuffer = '';
        selectionActive = false;
      }
    }
  }));

  assert.strictEqual(result.success, false);
  assert.strictEqual(pasteAttempts, 2, 'paste proof should stop after one repair retry');
  assert.strictEqual(result.pineAuthoringPasteProof?.retryAttempted, true, 'paste proof should record the failed retry');
  assert(/single bounded retry/i.test(String(result.error || '')), 'failure should explain that the bounded retry was exhausted');
});

testAsync('KEY blocks orphan Pine save actions without a verified prepared script payload', async () => {
  const saveCalls = [];

  const result = await systemAutomation.executeAction({
    type: 'key',
    key: 'ctrl+s',
    inputSurfaceContract: {
      appName: 'TradingView',
      route: 'pine-editor-authoring',
      surface: 'pine-editor',
      requiresPineEditorSurface: true
    },
    reason: 'Save the Pine script'
  }, {
    pressKey: async (key) => {
      saveCalls.push(String(key || ''));
    }
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(saveCalls.length, 0, 'orphan Pine save should not reach keyboard injection');
  assert.strictEqual(result.pineSaveGuard?.reason, 'missing-prepared-pine-script');
  assert(/no verified prepared Pine script payload/i.test(String(result.error || '')));
});

testAsync('KEY allows Pine save only after the editor buffer matches the prepared script exactly', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP KEY allows Pine save only after the editor buffer matches the prepared script exactly (requires Windows automation host)');
    return;
  }

  const expectedScript = [
    '//@version=6',
    'indicator("Liku Live Save Probe", overlay=false)',
    'plot(close, title="Close")'
  ].join('\n');
  let clipboardText = 'previous clipboard';
  let savedClipboardText = '';
  let selectionActive = false;
  const keyCalls = [];

  const result = await withMockAutomationHost({
    saveClipboardState: async () => {
      savedClipboardText = clipboardText;
      return { success: true, token: 'pine-save-token', mode: 'host-token', source: 'uia-host' };
    },
    restoreClipboardState: async () => {
      clipboardText = savedClipboardText;
      return { success: true, token: 'pine-save-token', source: 'uia-host' };
    },
    getClipboardText: async () => ({ success: true, text: clipboardText }),
    setClipboardText: async (text) => {
      clipboardText = String(text || '');
      return { success: true };
    }
  }, async () => systemAutomation.executeAction({
    type: 'key',
    key: 'ctrl+s',
    inputSurfaceContract: {
      appName: 'TradingView',
      route: 'pine-editor-authoring',
      surface: 'pine-editor',
      requiresPineEditorSurface: true
    },
    pinePreparedScriptText: expectedScript,
    pinePreparedScriptName: 'Liku Live Save Probe',
    reason: 'Save the freshly created Pine script before adding it to the chart'
  }, {
    pressKey: async (key) => {
      const normalizedKey = String(key || '').trim().toLowerCase();
      keyCalls.push(normalizedKey);
      if (normalizedKey === 'ctrl+a') {
        selectionActive = true;
        return;
      }
      if (normalizedKey === 'ctrl+c' && selectionActive) {
        clipboardText = expectedScript;
      }
    }
  }));

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.pineSaveGuard?.proof?.exactMatch, true);
  assert(keyCalls.includes('ctrl+s'), 'verified Pine save should reach keyboard injection');
  assert.strictEqual(clipboardText, 'previous clipboard', 'save guard should restore the caller clipboard after readback');
});

testAsync('GET_TEXT uses the host-bounded Pine surface scan before legacy Pine anchor fallback', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP GET_TEXT uses the host-bounded Pine surface scan before legacy Pine anchor fallback (requires Windows automation host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  let legacyFindCalls = 0;

  uiAutomation.getElementText = async () => ({
    success: false,
    error: 'Element not found'
  });
  uiAutomation.findElement = async () => {
    legacyFindCalls += 1;
    return {
      success: false,
      error: 'Legacy fallback should not be needed when the bounded host Pine scan succeeds'
    };
  };
  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => ({
      hwnd: 777,
      processName: 'TradingView',
      title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
      windowKind: 'main',
      bounds: { x: 100, y: 20, width: 1200, height: 900 }
    }),
    findElementsByWindow: async () => ({
      elements: [
        {
          Name: 'Untitled script',
          ControlType: 'ControlType.Text',
          WindowHandle: 777,
          Bounds: { X: 260, Y: 660, Width: 130, Height: 24, CenterX: 325, CenterY: 672 }
        },
        {
          Name: 'Publish script',
          ControlType: 'ControlType.Button',
          WindowHandle: 777,
          Bounds: { X: 980, Y: 660, Width: 130, Height: 28, CenterX: 1045, CenterY: 674 }
        },
        {
          Name: 'Add to chart',
          ControlType: 'ControlType.Button',
          WindowHandle: 777,
          Bounds: { X: 1120, Y: 660, Width: 120, Height: 28, CenterX: 1180, CenterY: 674 }
        }
      ],
      stats: { visited: 9, elapsedMs: 26, timedOut: false }
    })
  });
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor' }
    });

    assert.strictEqual(result.success, true);
    assert(/UIAHostScan \(pine-editor-fallback\)/i.test(String(result.method || '')), 'bounded host Pine scan should be recorded as the fallback method');
    assert(/Untitled script/i.test(String(result.text || '')), 'bounded host Pine scan should preserve visible Pine starter anchors');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert(legacyFindCalls <= 5, 'bounded host Pine scans should probe only the bounded confirmation-modal candidates after the host proof succeeds');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
});

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

test('Pine safe-authoring summary treats default starter labels as new-script state', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary('My Script');

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'empty-or-starter');
  assert.strictEqual(summary.lifecycleState, 'new-script-required');
  assert(summary.visibleSignals.includes('starter-default-name'));
  assert(summary.visibleSignals.includes('editor-empty-hint'));
});

test('Pine safe-authoring summary classifies blocking unsaved-change confirmations explicitly', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'Confirmation\nYou have unsaved changes in your current script. Would you like to save them?\nNo\nYes'
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'confirmation-blocking');
  assert.strictEqual(summary.lifecycleState, 'save-confirmation-blocking');
  assert(summary.visibleSignals.includes('save-confirmation-modal'));
});

test('Pine safe-authoring summary classifies bounded saved-surface probes as existing script state even when fallback text stays generic', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'All changes saved\nPublish script',
    {
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchorEntries: [
          {
            text: 'All changes saved',
            observedText: 'All changes saved',
            category: 'save-confirmed',
            source: 'dom-node',
            ariaLabel: 'All changes saved',
            priority: 182
          },
          {
            text: 'Publish script',
            observedText: 'Publish script',
            category: 'surface',
            source: 'dom-node',
            className: 'pine-dialog',
            priority: 166
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'existing-script-visible');
  assert(summary.visibleSignals.includes('existing-script-saved-surface'));
  assert.strictEqual(summary.surfaceMatchedBy, 'chromium-cdp-dom');
  assert.deepStrictEqual(summary.surfaceVisibleAnchors, ['All changes saved', 'Publish script']);
});

test('Pine safe-authoring summary treats probe-visible starter labels as empty-or-starter state when raw fallback text stays sparse', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'Publish script',
    {
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'uia-host-pine-surface-header-scan',
        visibleAnchorEntries: [
          {
            text: 'My Script',
            observedText: 'My Script',
            category: 'starter',
            source: 'window-host-scan',
            scanId: 'panel-header-band',
            priority: 210
          },
          {
            text: 'Publish script',
            observedText: 'Publish script',
            category: 'surface',
            source: 'window-host-scan',
            scanId: 'panel-header-band',
            priority: 166
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'empty-or-starter');
  assert.strictEqual(summary.lifecycleState, 'new-script-required');
  assert(summary.visibleSignals.includes('starter-default-name'));
  assert(summary.visibleSignals.includes('editor-empty-hint'));
  assert.strictEqual(summary.surfaceMatchedBy, 'uia-host-pine-surface-header-scan');
});

test('Pine safe-authoring summary treats save-confirmed-only Pine surface evidence as insufficient', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'All changes saved',
    {
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchorEntries: [
          {
            text: 'All changes saved',
            observedText: 'All changes saved',
            category: 'save-confirmed',
            source: 'dom-node',
            ariaLabel: 'All changes saved',
            priority: 182
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'unknown-visible-state');
  assert.strictEqual(summary.lifecycleState, null);
  assert.strictEqual(summary.surfaceMatchedBy, 'chromium-cdp-dom');
});

test('Pine safe-authoring summary blocks authoring when a save-name dialog is already visible on the Pine surface', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'Untitled script\nSave script\nNew script name',
    {
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchorEntries: [
          {
            text: 'Untitled script',
            observedText: 'Untitled script',
            category: 'starter',
            source: 'dom-node',
            priority: 220
          },
          {
            text: 'Save script',
            observedText: 'Save script',
            category: 'save-required',
            source: 'dom-node',
            priority: 190
          },
          {
            text: 'New script name',
            observedText: 'New script name',
            category: 'save-required',
            source: 'dom-node',
            priority: 189
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'save-required-blocking');
  assert.strictEqual(summary.lifecycleState, 'save-required-before-apply');
  assert(summary.visibleSignals.includes('save-required-visible'));
});

test('Pine safe-authoring summary does not misclassify mixed starter and saved anchors as a blocking save-name dialog', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    'Untitled script\nSave script\nAll changes saved\nAdd to chart\nPublish script',
    {
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchorEntries: [
          {
            text: 'Untitled script',
            observedText: 'Untitled script',
            category: 'starter',
            source: 'dom-node',
            className: 'pine-dialog',
            priority: 220
          },
          {
            text: 'Save script',
            observedText: 'Save script',
            category: 'save-required',
            source: 'dom-node',
            className: 'Save script',
            priority: 190
          },
          {
            text: 'All changes saved',
            observedText: 'All changes saved',
            category: 'save-confirmed',
            source: 'dom-node',
            ariaLabel: 'All changes saved',
            priority: 182
          },
          {
            text: 'Add to chart',
            observedText: 'Add to chart',
            category: 'surface',
            source: 'dom-node',
            className: 'Add to chart',
            priority: 170
          },
          {
            text: 'Publish script',
            observedText: 'Publish script',
            category: 'surface',
            source: 'dom-node',
            priority: 166
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'empty-or-starter');
  assert.strictEqual(summary.lifecycleState, 'new-script-required');
  assert(!summary.visibleSignals.includes('save-required-visible'));
});

test('Pine safe-authoring summary blocks authoring when a replace-script confirmation is visible on the Pine surface', () => {
  const summary = systemAutomation.buildPineEditorSafeAuthoringSummary(
    "Untitled script\nConfirmation\nScript 'Liku Live Save Probe' already exists. Do you really want to replace it?\nYes\nNo",
    {
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchorEntries: [
          {
            text: 'Confirmation',
            observedText: 'Confirmation',
            category: 'confirmation-modal',
            source: 'dom-node',
            priority: 183
          },
          {
            text: 'already exists',
            observedText: "Script 'Liku Live Save Probe' already exists. Do you really want to replace it?",
            category: 'confirmation-modal',
            source: 'dom-node',
            priority: 180
          },
          {
            text: 'Untitled script',
            observedText: 'Untitled script',
            category: 'starter',
            source: 'dom-node',
            priority: 220
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'safe-authoring-inspect');
  assert.strictEqual(summary.editorVisibleState, 'replace-confirmation-blocking');
  assert.strictEqual(summary.lifecycleState, 'save-replace-confirmation-blocking');
  assert(summary.visibleSignals.includes('save-replace-confirmation-modal'));
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

test('Pine save-status summary requires the expected saved title before declaring success', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Untitled script\nMy Script\nAll changes saved\nPublish script',
    'save-status',
    { pineExpectedScriptName: 'Liku Live Save Probe' }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'save-status');
  assert.strictEqual(summary.expectedScriptName, 'Liku Live Save Probe');
  assert.strictEqual(summary.expectedScriptNameVisible, false);
  assert.strictEqual(summary.expectedScriptNameProofVisible, false);
  assert.strictEqual(summary.lifecycleState, 'save-title-unverified');
  assert(summary.statusSignals.includes('save-confirmed-visible'));
  assert(summary.statusSignals.includes('save-title-unverified'));
});

test('Pine save-status summary classifies unsaved-change confirmations before save-title checks', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Untitled script\nConfirmation\nYou have unsaved changes in your current script. Would you like to save them?\nNo\nYes',
    'save-status',
    { pineExpectedScriptName: 'Liku Live Save Probe' }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'save-status');
  assert.strictEqual(summary.saveConfirmationBlockingVisible, true);
  assert.strictEqual(summary.lifecycleState, 'save-confirmation-blocking');
  assert(summary.statusSignals.includes('save-confirmation-modal'));
});

test('Pine save-status summary classifies replace-script confirmations before save-required state', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    "Untitled script\nLiku Live Save Probe\nSave script\nScript name\nConfirmation\nScript 'Liku Live Save Probe' already exists. Do you really want to replace it?\nNo\nYes",
    'save-status',
    { pineExpectedScriptName: 'Liku Live Save Probe' }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'save-status');
  assert.strictEqual(summary.saveReplaceConfirmationVisible, true);
  assert.strictEqual(summary.lifecycleState, 'save-replace-confirmation-blocking');
  assert(summary.statusSignals.includes('save-replace-confirmation-modal'));
});

test('Pine save-status summary prefers a verified saved title over stale save-required text', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Untitled script\nLiku Live Save Probe\nSave script\nScript name\nConfirmation\nAll changes saved\nPublish script',
    'save-status',
    { pineExpectedScriptName: 'Liku Live Save Probe' }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'save-status');
  assert.strictEqual(summary.expectedScriptNameProofVisible, true);
  assert.strictEqual(summary.saveRequiredVisible, true);
  assert.strictEqual(summary.saveConfirmedVisible, true);
  assert.strictEqual(summary.lifecycleState, 'saved-state-verified');
  assert(summary.statusSignals.includes('save-title-confirmed-visible'));
});

test('Pine save-status summary keeps carried Pine surface save signals when fallback text collapses to a host title scan', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'LIKU LIVE SAVE PROBE ▲ 28.97 +20.16% / Unnamed',
    'save-status',
    {
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineEditorSurfaceProbe: {
        matchedBy: 'uia-host-pine-surface-header-scan',
        visibleAnchorEntries: [
          {
            text: 'Liku Live Save Probe',
            observedText: 'Liku Live Save Probe',
            category: 'save-title',
            source: 'window-host-scan',
            scanId: 'panel-header-band'
          },
          {
            text: 'Save script',
            observedText: 'Save script',
            category: 'save-required',
            source: 'dom-node'
          },
          {
            text: 'New script name',
            observedText: 'New script name',
            category: 'save-required',
            source: 'dom-node'
          },
          {
            text: 'All changes saved',
            observedText: 'All changes saved',
            category: 'save-confirmed',
            source: 'dom-node'
          }
        ]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.expectedScriptNameProofVisible, true, 'bounded header proof should still verify the expected title');
  assert.strictEqual(summary.saveRequiredVisible, true, 'carried Pine surface save-required anchors should survive a narrow host title scan');
  assert.strictEqual(summary.saveConfirmedVisible, true, 'carried Pine surface save-confirmed anchors should survive a narrow host title scan');
  assert.strictEqual(summary.lifecycleState, 'save-required-before-apply', 'save-required state should remain dominant until the first-save dialog is resolved');
  assert(summary.statusSignals.includes('save-required-visible'));
  assert(summary.statusSignals.includes('save-confirmed-visible'));
});

test('Pine save-status summary treats a prefilled save-name field as rename-surface evidence, not a saved header title', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'LIKU LIVE SAVE PROBE ▲ 28.97 +20.16% / Unnamed',
    'save-status',
    {
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineEditorSurfaceProbe: {
        matchedBy: 'uia-host-pine-surface-header-scan',
        visibleAnchorEntries: [{
          text: 'Liku Live Save Probe 1',
          observedText: 'Liku Live Save Probe 1',
          category: 'rename-surface',
          source: 'window-host-scan',
          scanId: 'panel-header-band',
          role: 'ControlType.Edit'
        }]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.expectedScriptNameProofVisible, false, 'rename-surface text must not verify the saved title');
  assert.strictEqual(summary.renameSurfaceVisible, true, 'prefilled save-name input should be surfaced explicitly');
  assert.strictEqual(summary.saveRequiredVisible, true, 'rename-surface evidence should keep the save-required gate active');
  assert.strictEqual(summary.lifecycleState, 'save-required-before-apply');
  assert(summary.statusSignals.includes('save-rename-surface-visible'));
  assert(/title=rename-surface/i.test(String(summary.compactSummary || '')));
});

test('Pine save-status summary verifies success only when the expected saved title is visible', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'Liku Live Save Probe\nAll changes saved\nPublish script',
    'save-status',
    { pineExpectedScriptName: 'Liku Live Save Probe' }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.evidenceMode, 'save-status');
  assert.strictEqual(summary.expectedScriptNameVisible, true);
  assert.strictEqual(summary.expectedScriptNameLineVisible, true);
  assert.strictEqual(summary.expectedScriptNameProofVisible, true);
  assert.strictEqual(summary.lifecycleState, 'saved-state-verified');
  assert(summary.statusSignals.includes('save-title-visible'));
  assert(!summary.statusSignals.includes('save-title-unverified'));
});

test('Pine save-status summary can verify a saved title from bounded header proof even when raw fallback text stays sparse', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'All changes saved\nPublish script',
    'save-status',
    {
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineEditorSurfaceProbe: {
        matchedBy: 'uia-host-pine-surface-header-scan',
        visibleAnchorEntries: [{
          text: 'Liku Live Save Probe',
          observedText: 'Liku Live Save Probe',
          category: 'save-title',
          source: 'window-host-scan',
          scanId: 'panel-header-band'
        }]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.expectedScriptNameVisible, false, 'raw fallback text should stay sparse in this regression');
  assert.strictEqual(summary.expectedScriptNameProofVisible, true, 'bounded header proof should verify the save title');
  assert.strictEqual(summary.expectedScriptNameEvidence, 'window-host-scan');
  assert.strictEqual(summary.lifecycleState, 'saved-state-verified');
  assert(summary.statusSignals.includes('save-title-visible'));
});

test('Pine save-status summary can verify a saved title from renderer title-button evidence when fallback text stays sparse', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'All changes saved\nPublish script',
    'save-status',
    {
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineEditorSurfaceProbe: {
        matchedBy: 'chromium-cdp-dom',
        rendererProof: {
          matchedBy: 'chromium-cdp-dom',
          titleButton: {
            text: 'Liku Live Save Probe',
            observedText: 'Liku Live Save Probe',
            category: 'save-title',
            source: 'renderer-title-button',
            role: 'button',
            surfaceKind: 'save-title'
          }
        }
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.expectedScriptNameVisible, false);
  assert.strictEqual(summary.expectedScriptNameProofVisible, true);
  assert.strictEqual(summary.expectedScriptNameEvidence, 'renderer-title-button');
  assert.strictEqual(summary.observedTitleButtonText, 'Liku Live Save Probe');
  assert.strictEqual(summary.lifecycleState, 'saved-state-verified');
});

test('Pine save-status summary rejects chart chrome as saved-title proof', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    'All changes saved\nPublish script',
    'save-status',
    {
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineEditorSurfaceProbe: {
        matchedBy: 'uia-host-pine-surface-header-scan',
        visibleAnchorEntries: [{
          text: 'LIKU LIVE SAVE PROBE ▲ 28.97 +20.16% / Unnamed',
          observedText: 'LIKU LIVE SAVE PROBE ▲ 28.97 +20.16% / Unnamed',
          category: 'save-title',
          source: 'window-host-scan',
          scanId: 'panel-header-band',
          role: 'ControlType.Text'
        }, {
          text: 'All changes saved',
          observedText: 'All changes saved',
          category: 'save-confirmed',
          source: 'window-host-scan',
          scanId: 'panel-header-band',
          role: 'ControlType.Text'
        }]
      }
    }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.expectedScriptNameVisible, false, 'raw fallback text should remain sparse');
  assert.strictEqual(summary.expectedScriptNameProofVisible, false, 'chart/window title chrome must not verify the saved title');
  assert.strictEqual(summary.lifecycleState, 'save-title-unverified');
  assert(summary.statusSignals.includes('save-title-unverified'));
});

test('Pine save-status summary does not treat code-body title text as saved-header proof', () => {
  const summary = systemAutomation.buildPineEditorDiagnosticsStructuredSummary(
    '//@version=6\nindicator("Liku Live Save Probe", overlay=false)\nplot(close)\nAll changes saved\nPublish script',
    'save-status',
    { pineExpectedScriptName: 'Liku Live Save Probe' }
  );

  assert(summary, 'summary should be returned');
  assert.strictEqual(summary.expectedScriptNameVisible, true, 'raw text still contains the expected title');
  assert.strictEqual(summary.expectedScriptNameLineVisible, false, 'code-body text should not count as a standalone saved title line');
  assert.strictEqual(summary.expectedScriptNameProofVisible, false, 'code-body text must not verify the saved title');
  assert.strictEqual(summary.lifecycleState, 'save-title-unverified');
  assert(summary.statusSignals.includes('save-title-text-visible-unverified'));
  assert(summary.statusSignals.includes('save-title-unverified'));
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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'compile-result'
    }));

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'compile-result');
    assert.strictEqual(result.pineStructuredSummary.compileStatus, 'success');
    assert(result.message.includes('status=success'));
  } finally {
    uiAutomation.getElementText = originalGetElementText;
  }
});

testAsync('GET_TEXT scopes Pine Editor readback to the current TradingView foreground title when dynamic titles are omitted', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP GET_TEXT scopes Pine Editor readback to the current TradingView foreground title when dynamic titles are omitted (requires Windows foreground host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const seenCriteria = [];

  uiAutomation.getElementText = async (criteria) => {
    seenCriteria.push(criteria);
    return {
      success: true,
      text: 'Untitled script\nPublish script',
      method: 'TextPattern'
    };
  };
  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => ({
      hwnd: 777,
      processName: 'TradingView',
      title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
      windowKind: 'main'
    })
  });
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(seenCriteria.length, 1, 'bounded Pine readback should issue a single scoped getElementText lookup');
    assert.strictEqual(seenCriteria[0].windowTitle, 'LUNR ▲ 18.56 +13.52% / Unnamed', 'Pine readback should scope to the current TradingView foreground title at execution time');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
});

testAsync('GET_TEXT fails fast when Pine Editor readback loses TradingView foreground to Edge', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP GET_TEXT fails fast when Pine Editor readback loses TradingView foreground to Edge (requires Windows foreground host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  let getElementTextCalls = 0;

  uiAutomation.getElementText = async () => {
    getElementTextCalls++;
    return {
      success: true,
      text: 'Unexpected text',
      method: 'TextPattern'
    };
  };
  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => ({
      hwnd: 3407948,
      processName: 'msedge',
      title: 'TradingView Workflow Optimization - Phased Implementation Task List (1).pdf and 11 more pages - Personal - Microsoft Edge Beta',
      windowKind: 'main'
    })
  });
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect'
    });

    assert.strictEqual(result.success, false, 'Pine readback should fail closed when TradingView no longer owns foreground');
    assert.strictEqual(getElementTextCalls, 0, 'foreground-guarded Pine readback should not start UIA text extraction after losing foreground');
    assert(/requires TradingView to remain foreground/i.test(String(result.error || '')), 'failure should explain the TradingView foreground requirement');
    assert(/msedge/i.test(String(result.error || '')), 'failure should preserve the foreign foreground process name');
    assert.strictEqual(result.method, 'ForegroundGuard', 'failure should record the foreground guard method for diagnostics');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
  }
});

testAsync('GET_TEXT performs one bounded refocus to the pinned TradingView window before Pine readback', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP GET_TEXT performs one bounded refocus to the pinned TradingView window before Pine readback (requires Windows foreground host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const originalFocusWindow = systemAutomation.focusWindow;
  let getElementTextCalls = 0;
  const foregroundSequence = [
    {
      hwnd: 3407948,
      processName: 'msedge',
      title: 'TradingView Workflow Optimization - Phased Implementation Task List (1).pdf and 11 more pages - Personal - Microsoft Edge Beta',
      windowKind: 'main'
    },
    {
      hwnd: 777,
      processName: 'TradingView',
      title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
      windowKind: 'main'
    }
  ];
  const focusCalls = [];

  uiAutomation.getElementText = async (criteria) => {
    getElementTextCalls++;
    return {
      success: true,
      text: 'Untitled script\nPublish script',
      method: `TextPattern:${String(criteria?.windowTitle || '')}`
    };
  };
  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => foregroundSequence.shift() || foregroundSequence[foregroundSequence.length - 1] || {
      hwnd: 777,
      processName: 'TradingView',
      title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
      windowKind: 'main'
    }
  });
  systemAutomation.focusWindow = async (hwnd) => {
    focusCalls.push(hwnd);
    return {
      success: true,
      requestedWindowHandle: hwnd,
      actualForegroundHandle: hwnd,
      exactMatch: true,
      outcome: 'exact'
    };
  };
  process.env.LIKU_USE_AUTOMATION_HOST = '1';

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true,
      windowHandle: 777
    });

    assert.strictEqual(result.success, true, 'Pine readback should recover after one bounded refocus');
    assert.deepStrictEqual(focusCalls, [777], 'Pine readback should refocus exactly once to the pinned TradingView handle');
    assert.strictEqual(getElementTextCalls, 1, 'Pine readback should continue into text extraction after the bounded refocus succeeds');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    systemAutomation.focusWindow = originalFocusWindow;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'save-status',
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

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

testAsync('GET_TEXT falls back to watcher-backed Pine surface text when Pine primary readback stalls', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async () => {
    throw new Error('timed primary Pine readback should prefer watcher fallback before slow Pine anchor probing');
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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      pineReadbackTimeoutMs: 25,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert(/WatcherCache \(pine-editor-fallback\)/i.test(String(result.method || '')), 'watcher fallback should satisfy bounded Pine timeout recovery');
    assert(/Untitled script/i.test(String(result.text || '')), 'watcher fallback should preserve bounded Pine surface text after timeout');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT falls back to bounded host Pine surface proof when Pine primary readback stalls', async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP GET_TEXT falls back to bounded host Pine surface proof when Pine primary readback stalls (requires Windows automation host)');
    return;
  }

  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const originalGetSharedUIAHost = uiAutomation.getSharedUIAHost;
  const originalHostFlag = process.env.LIKU_USE_AUTOMATION_HOST;
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const previousWatcher = uiContext.getUIWatcher();
  let legacyFindCalls = 0;

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async () => {
    legacyFindCalls += 1;
    throw new Error('timed primary Pine readback should not widen into legacy per-anchor probing when the bounded host surface proof succeeds');
  };
  uiAutomation.getSharedUIAHost = () => ({
    getForegroundWindowInfo: async () => ({
      hwnd: 777,
      processName: 'TradingView',
      title: 'LUNR ▲ 18.56 +13.52% / Unnamed',
      windowKind: 'main',
      bounds: { x: 100, y: 20, width: 1200, height: 900 }
    }),
    findElementsByWindow: async () => ({
      elements: [
        {
          Name: 'My Script',
          ControlType: 'ControlType.Text',
          WindowHandle: 777,
          Bounds: { X: 260, Y: 660, Width: 130, Height: 24, CenterX: 325, CenterY: 672 }
        }
      ],
      stats: { visited: 5, elapsedMs: 18, timedOut: false }
    })
  });
  process.env.LIKU_USE_AUTOMATION_HOST = '1';
  uiContext.setUIWatcher({
    cache: {
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: []
    }
  });

  try {
    const result = await systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      pineReadbackTimeoutMs: 25,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor' }
    });

    assert.strictEqual(result.success, true);
    assert(/UIAHostScan \(pine-editor-fallback\)/i.test(String(result.method || '')), 'bounded host surface proof should satisfy Pine timeout recovery');
    assert(/My Script/i.test(String(result.text || '')), 'bounded host surface proof should preserve the visible starter label');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'empty-or-starter');
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'new-script-required');
    assert(legacyFindCalls <= 5, 'timed Pine recovery should probe only the bounded confirmation-modal candidates after the bounded host surface proof succeeds');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    uiAutomation.getSharedUIAHost = originalGetSharedUIAHost;
    if (originalHostFlag === undefined) {
      delete process.env.LIKU_USE_AUTOMATION_HOST;
    } else {
      process.env.LIKU_USE_AUTOMATION_HOST = originalHostFlag;
    }
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT uses a carried Pine surface probe before slower timeout fallback when Pine primary readback stalls', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  let legacyFindCalls = 0;

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async () => {
    legacyFindCalls += 1;
    throw new Error('carried Pine surface probe should avoid slow legacy anchor fallback');
  };

  try {
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'save-status',
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineReadbackTimeoutMs: 25,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' },
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchors: [
          'Untitled script',
          'Save script',
          'New script name'
        ],
        element: {
          name: 'Untitled script'
        },
        foreground: {
          hwnd: 777
        }
      }
    }));

    assert.strictEqual(result.success, true);
    assert(/carried-probe/i.test(String(result.method || '')), 'carried Pine surface proof should satisfy Pine readback without cold re-probing');
    assert(/Save script/i.test(String(result.text || '')), 'carried Pine surface proof should preserve the visible first-save dialog anchors');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'save-status');
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'save-required-before-apply');
    assert.strictEqual(legacyFindCalls, 0, 'carried Pine surface proof should avoid slow legacy anchor fallback');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
  }
});

testAsync('GET_TEXT keeps a carried Pine surface probe when the fresh host re-probe stalls past the bounded grace window', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  let legacyFindCalls = 0;
  let hostFindCalls = 0;

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async () => {
    legacyFindCalls += 1;
    throw new Error('carried Pine surface probe should avoid slow legacy anchor fallback when host re-probe stalls');
  };

  try {
    const result = await withMockAutomationHost({
      getForegroundWindowInfo: async () => ({
        hwnd: 777,
        processName: 'TradingView',
        title: 'TradingView',
        windowKind: 'main',
        bounds: { x: 100, y: 20, width: 1200, height: 900 }
      }),
      getWindowInfoByHandle: async () => ({
        hwnd: 777,
        pid: 4242,
        processId: 4242,
        processName: 'TradingView',
        title: 'TradingView',
        windowKind: 'main',
        bounds: { x: 100, y: 20, width: 1200, height: 900 }
      }),
      findElementsByWindow: async () => {
        hostFindCalls += 1;
        return new Promise(() => {});
      }
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'save-status',
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineReadbackTimeoutMs: 100,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' },
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchors: [
          'Untitled script',
          'Save script',
          'New script name',
          'Liku Live Save Probe 1'
        ],
        element: {
          name: 'Untitled script'
        },
        foreground: {
          hwnd: 777
        }
      }
    }));

    assert.strictEqual(result.success, true);
    assert(/carried-probe/i.test(String(result.method || '')), 'carried Pine surface proof should survive a stalled host re-probe');
    assert(/Save script/i.test(String(result.text || '')), 'carried Pine surface proof should still expose the visible save dialog anchors');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'save-status');
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'save-required-before-apply');
    assert.strictEqual(legacyFindCalls, 0, 'stalled host re-probes should not force slow legacy element probing before using the carried proof');
    assert(hostFindCalls >= 1, 'a bounded fresh host re-probe should still be attempted before carrying forward the cached proof');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
  }
});

testAsync('GET_TEXT waits for a bounded fresh host save-title proof when a carried saved-state probe is missing the expected script title', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  let legacyFindCalls = 0;
  let hostFindCalls = 0;

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async () => {
    legacyFindCalls += 1;
    throw new Error('fresh host save-title proof should avoid slow legacy anchor fallback');
  };

  try {
    const result = await withMockAutomationHost({
      getForegroundWindowInfo: async () => ({
        hwnd: 777,
        processName: 'TradingView',
        title: 'TradingView',
        windowKind: 'main',
        bounds: { x: 100, y: 20, width: 1200, height: 900 }
      }),
      getWindowInfoByHandle: async () => ({
        hwnd: 777,
        pid: 4242,
        processId: 4242,
        processName: 'TradingView',
        title: 'TradingView',
        windowKind: 'main',
        bounds: { x: 100, y: 20, width: 1200, height: 900 }
      }),
      findElementsByWindow: async (hwnd, options = {}) => {
        hostFindCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 550));
        if (
          hwnd === 777
          && String(options?.textMode || '') === 'regex'
          && String(options?.view || '') === 'control'
          && Number(options?.bounds?.y || 0) <= 430
        ) {
          return {
            elements: [
              {
                Name: 'Liku Live Save Probe',
                ControlType: 'ControlType.Text',
                WindowHandle: hwnd,
                Bounds: { X: 1180, Y: 428, Width: 220, Height: 28, CenterX: 1290, CenterY: 442 }
              },
              {
                Name: 'All changes saved',
                ControlType: 'ControlType.Text',
                WindowHandle: hwnd,
                Bounds: { X: 1390, Y: 428, Width: 130, Height: 24, CenterX: 1455, CenterY: 440 }
              },
              {
                Name: 'Add to chart',
                ControlType: 'ControlType.Button',
                WindowHandle: hwnd,
                Bounds: { X: 1540, Y: 428, Width: 120, Height: 30, CenterX: 1600, CenterY: 443 }
              }
            ],
            count: 3,
            stats: { visited: 18, timedOut: false }
          };
        }
        return {
          elements: [],
          count: 0,
          stats: { visited: 8, timedOut: false }
        };
      }
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'save-status',
      pineExpectedScriptName: 'Liku Live Save Probe',
      pineReadbackTimeoutMs: 5000,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' },
      pineEditorSurfaceProbe: {
        active: true,
        matchedBy: 'chromium-cdp-dom',
        visibleAnchors: [
          'Untitled script',
          'All changes saved',
          'Add to chart',
          'Publish script'
        ],
        element: {
          name: 'Untitled script'
        },
        foreground: {
          hwnd: 777
        }
      }
    }));

    assert.strictEqual(result.success, true);
    assert(/UIAHostScan/i.test(String(result.method || '')), 'save-title recovery should wait for the bounded host header proof instead of returning the stale carried probe');
    assert(!/carried-probe/i.test(String(result.method || '')), 'save-title recovery should not settle on the stale carried probe when a bounded fresh header proof succeeds');
    assert(/Liku Live Save Probe/i.test(String(result.text || '')), 'fresh host save-title proof should surface the expected Pine header title');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'save-status');
    assert.strictEqual(result.pineStructuredSummary.expectedScriptNameProofVisible, true);
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'saved-state-verified');
    assert.strictEqual(legacyFindCalls, 0, 'save-title recovery should not fall through to slow legacy element probing');
    assert(hostFindCalls >= 1, 'save-title recovery should attempt a fresh bounded host header proof');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
  }
});

testAsync('GET_TEXT fails bounded when Pine primary readback stalls and no Pine anchors are visible', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async () => {
    throw new Error('timed primary Pine readback should not run slow Pine anchor probing when watcher has no anchors');
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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      pineReadbackTimeoutMs: 25,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

    assert.strictEqual(result.success, false);
    assert(/timed out/i.test(String(result.error || '')), 'timed Pine readback should surface a timeout error');
    assert(/no host-backed or watcher-backed pine anchors were visible/i.test(String(result.error || '')), 'timeout error should explain that Pine anchors were not visible through bounded host or watcher proof');
    assert(/TimeoutGuard/i.test(String(result.method || '')), 'timed Pine readback should record the timeout guard method');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
    uiContext.setUIWatcher(previousWatcher);
  }
});

testAsync('GET_TEXT surfaces blocking save-confirmation modals during Pine safe-authoring fallback', async () => {
  const uiAutomation = require(path.join(__dirname, '..', 'src', 'main', 'ui-automation'));
  const originalGetElementText = uiAutomation.getElementText;
  const originalFindElement = uiAutomation.findElement;
  const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
  const previousWatcher = uiContext.getUIWatcher();

  uiAutomation.getElementText = async () => new Promise(() => {});
  uiAutomation.findElement = async (criteria = {}) => {
    const text = String(criteria?.text || '');
    if (/you have unsaved changes/i.test(text) || /would you like to save them/i.test(text)) {
      return {
        success: true,
        element: {
          name: text
        }
      };
    }
    return {
      success: false,
      error: 'Element not found'
    };
  };
  uiContext.setUIWatcher({
    cache: {
      activeWindow: {
        hwnd: 777,
        title: 'TradingView',
        processName: 'tradingview',
        windowKind: 'main'
      },
      elements: []
    }
  });

  try {
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      pineReadbackTimeoutMs: 25,
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

    assert.strictEqual(result.success, true);
    assert(/ElementAnchor \(pine-editor-fallback\)/i.test(String(result.method || '')), 'blocking confirmation fallback should record its degraded evidence method');
    assert(/you have unsaved changes/i.test(String(result.text || '')), 'blocking confirmation fallback should preserve the visible modal text');
    assert.strictEqual(result.pineStructuredSummary.evidenceMode, 'safe-authoring-inspect');
    assert.strictEqual(result.pineStructuredSummary.editorVisibleState, 'confirmation-blocking');
    assert.strictEqual(result.pineStructuredSummary.lifecycleState, 'save-confirmation-blocking');
  } finally {
    uiAutomation.getElementText = originalGetElementText;
    uiAutomation.findElement = originalFindElement;
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
    const result = await withMockForegroundHost({
      hwnd: 777,
      processName: 'TradingView',
      title: 'TradingView',
      windowKind: 'main'
    }, async () => systemAutomation.executeAction({
      type: 'get_text',
      text: 'Pine Editor',
      pineEvidenceMode: 'safe-authoring-inspect',
      disableTradingViewPineReadbackCDP: true,
      criteria: { text: 'Pine Editor', windowTitle: 'TradingView' }
    }));

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
