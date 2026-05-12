#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const {
  writeFailureArtifactBundleSync
} = require(path.join(__dirname, 'lib', 'failure-artifacts.js'));

const {
  windowLooksLikeTradingView,
  pickPreferredTradingViewWindow
} = require(path.join(__dirname, 'live-tradingview-smoke.js'));

const BROWSER_CHART_FIXTURE_SYMBOL = 'ZZTVTEST';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    try {
      const artifact = writeFailureArtifactBundleSync({
        suiteName: 'test-live-tradingview-smoke-window-selection',
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
  }
}

test('windowLooksLikeTradingView rejects browser reference pages that only mention TradingView', () => {
  assert.strictEqual(windowLooksLikeTradingView({
    hwnd: 3407948,
    processName: 'msedge',
    windowKind: 'main',
    title: 'TradingView Keyboard Shortcuts - Hotkey List - TradingView and 8 more pages - Personal - Microsoft Edge Beta'
  }), false);
});

test('pickPreferredTradingViewWindow prefers the real TradingView process over a TradingView docs browser tab', () => {
  const browserReferencePage = {
    hwnd: 3407948,
    processName: 'msedge',
    windowKind: 'main',
    isMinimized: false,
    title: 'TradingView Keyboard Shortcuts - Hotkey List - TradingView and 8 more pages - Personal - Microsoft Edge Beta'
  };
  const actualTradingViewWindow = {
    hwnd: 460832,
    processName: 'TradingView',
    windowKind: 'main',
    isMinimized: false,
    title: 'INTC ▲ 108.82 +13.61% / Unnamed'
  };

  const selected = pickPreferredTradingViewWindow([
    browserReferencePage,
    actualTradingViewWindow
  ], browserReferencePage);

  assert(selected, 'A preferred TradingView window should be selected');
  assert.strictEqual(selected.hwnd, actualTradingViewWindow.hwnd);
  assert.strictEqual(String(selected.processName).toLowerCase(), 'tradingview');
});

test('pickPreferredTradingViewWindow still allows a browser-hosted TradingView chart session when no desktop process exists', () => {
  const browserReferencePage = {
    hwnd: 3407948,
    processName: 'msedge',
    windowKind: 'main',
    isMinimized: false,
    title: 'TradingView Keyboard Shortcuts - Hotkey List - TradingView and 8 more pages - Personal - Microsoft Edge Beta'
  };
  const browserChartSession = {
    hwnd: 112233,
    processName: 'msedge',
    windowKind: 'main',
    isMinimized: false,
    title: `NASDAQ:${BROWSER_CHART_FIXTURE_SYMBOL} Chart — TradingView — Microsoft Edge`
  };

  assert.strictEqual(windowLooksLikeTradingView(browserChartSession), true, 'Browser-hosted TradingView chart windows should remain eligible');

  const selected = pickPreferredTradingViewWindow([
    browserReferencePage,
    browserChartSession
  ], browserReferencePage);

  assert(selected, 'A preferred browser-hosted TradingView chart window should be selected');
  assert.strictEqual(selected.hwnd, browserChartSession.hwnd);
});

test('pickPreferredTradingViewWindow prefers the relaunch-pinned TradingView PID when two desktop windows are otherwise eligible', () => {
  const originalTradingViewWindow = {
    hwnd: 460832,
    pid: 111,
    processId: 111,
    processName: 'TradingView',
    windowKind: 'main',
    isMinimized: false,
    title: 'INTC ▲ 108.82 +13.61% / Unnamed'
  };
  const relaunchedTradingViewWindow = {
    hwnd: 460999,
    pid: 222,
    processId: 222,
    processName: 'TradingView',
    windowKind: 'main',
    isMinimized: false,
    title: 'INTC ▲ 108.82 +13.61% / Unnamed'
  };

  const selected = pickPreferredTradingViewWindow(
    [originalTradingViewWindow, relaunchedTradingViewWindow],
    null,
    { preferredProcessIds: [222] }
  );

  assert(selected, 'A preferred relaunched TradingView window should be selected');
  assert.strictEqual(selected.hwnd, relaunchedTradingViewWindow.hwnd);
  assert.strictEqual(selected.pid, 222);
});

test('pickPreferredTradingViewWindow falls back to the best-scored TradingView window when the preferred PID is absent', () => {
  const browserChartSession = {
    hwnd: 112233,
    pid: 333,
    processId: 333,
    processName: 'msedge',
    windowKind: 'main',
    isMinimized: false,
    title: `NASDAQ:${BROWSER_CHART_FIXTURE_SYMBOL} Chart — TradingView — Microsoft Edge`
  };
  const actualTradingViewWindow = {
    hwnd: 460832,
    pid: 111,
    processId: 111,
    processName: 'TradingView',
    windowKind: 'main',
    isMinimized: false,
    title: 'INTC ▲ 108.82 +13.61% / Unnamed'
  };

  const selected = pickPreferredTradingViewWindow(
    [browserChartSession, actualTradingViewWindow],
    browserChartSession,
    { preferredProcessIds: [9999] }
  );

  assert(selected, 'A fallback TradingView window should still be selected');
  assert.strictEqual(selected.hwnd, actualTradingViewWindow.hwnd);
});

console.log(`\nLive TradingView smoke window-selection tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
