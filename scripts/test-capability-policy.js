#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  SURFACE_CLASSES,
  buildCapabilityPolicySnapshot,
  buildCapabilityPolicySystemMessage,
  classifyActiveAppCapability
} = require(path.join(__dirname, '..', 'src', 'main', 'capability-policy.js'));

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

test('surface taxonomy remains stable for N4 runtime matrix', () => {
  assert.deepStrictEqual(SURFACE_CLASSES, ['browser', 'uia-rich', 'visual-first-low-uia', 'keyboard-window-first']);
});

test('browser snapshot prefers browser-native and semantic channels', () => {
  const snapshot = buildCapabilityPolicySnapshot({
    foreground: {
      success: true,
      processName: 'msedge',
      title: 'Docs - Microsoft Edge',
      hwnd: 101,
      className: 'Chrome_WidgetWin_1',
      windowKind: 'main'
    },
    watcherSnapshot: {
      activeWindowElementCount: 12,
      interactiveElementCount: 9,
      namedInteractiveElementCount: 7,
      activeWindow: {
        processName: 'msedge',
        title: 'Docs - Microsoft Edge'
      }
    },
    browserState: {
      url: 'https://example.com'
    }
  });

  assert.strictEqual(snapshot.surfaceClass, 'browser');
  assert(snapshot.channels.preferred.includes('browser-native'));
  assert(snapshot.channels.preferred.includes('semantic-uia'));
  assert.strictEqual(snapshot.supports.semanticControl, 'supported');
  assert.strictEqual(snapshot.supports.boundedTextExtraction, 'supported');
  assert.strictEqual(snapshot.claimBounds.strictness, 'standard');
});

test('tradingview snapshot applies low-uia surface defaults and overlay', () => {
  const snapshot = buildCapabilityPolicySnapshot({
    foreground: {
      success: true,
      processName: 'tradingview',
      title: 'TradingView - LUNR',
      hwnd: 404,
      className: 'Chrome_WidgetWin_1',
      windowKind: 'main'
    },
    watcherSnapshot: {
      activeWindowElementCount: 4,
      interactiveElementCount: 2,
      namedInteractiveElementCount: 1,
      activeWindow: {
        processName: 'tradingview',
        title: 'TradingView - LUNR'
      }
    },
    latestVisual: {
      captureMode: 'screen-copyfromscreen',
      captureTrusted: false,
      captureCapability: 'degraded'
    },
    userMessage: 'help me inspect tradingview paper trading and pine editor state'
  });

  assert.strictEqual(snapshot.surfaceClass, 'visual-first-low-uia');
  assert.strictEqual(snapshot.appId, 'tradingview');
  assert(snapshot.overlays.includes('tradingview'));
  assert(snapshot.channels.forbidden.includes('precise-placement'));
  assert.strictEqual(snapshot.supports.precisePlacement, 'unsupported');
  assert.strictEqual(snapshot.supports.boundedTextExtraction, 'limited');
  assert.strictEqual(snapshot.tradingMode.mode, 'paper');
  assert(snapshot.shortcutPolicy.stableDefaultIds.includes('indicator-search'));
  assert(snapshot.shortcutPolicy.customizableIds.includes('drawing-tool-binding'));
  assert.strictEqual(snapshot.claimBounds.strictness, 'very-high');
  assert.strictEqual(snapshot.evidence.captureCapability, 'degraded');
});

test('system message explains capability matrix outputs', () => {
  const snapshot = buildCapabilityPolicySnapshot({
    foreground: {
      success: true,
      processName: 'code',
      title: 'app.js - Visual Studio Code',
      hwnd: 505,
      className: 'Chrome_WidgetWin_1',
      windowKind: 'main'
    },
    watcherSnapshot: {
      activeWindowElementCount: 25,
      interactiveElementCount: 18,
      namedInteractiveElementCount: 10,
      activeWindow: {
        processName: 'code',
        title: 'app.js - Visual Studio Code'
      }
    },
    appPolicy: {
      executionMode: 'prompt',
      actionPolicies: [{ intent: 'click_element' }],
      negativePolicies: []
    }
  });

  const message = buildCapabilityPolicySystemMessage(snapshot);
  assert(message.includes('## Active App Capability'));
  assert(message.includes('policySource: capability-policy-matrix'));
  assert(message.includes('surfaceClass: uia-rich'));
  assert(message.includes('preferredChannels: semantic-uia'));
  assert(message.includes('semanticControl: supported'));
  assert(message.includes('boundedTextExtraction: supported'));
  assert(message.includes('userPolicyOverride: actionPolicies=yes, negativePolicies=no'));
});

test('classifier remains callable as a standalone seam', () => {
  const capability = classifyActiveAppCapability({
    foreground: {
      success: true,
      processName: 'unknownapp',
      title: 'Mystery App'
    },
    watcherSnapshot: {
      activeWindowElementCount: 9,
      interactiveElementCount: 4,
      namedInteractiveElementCount: 1,
      activeWindow: {
        processName: 'unknownapp',
        title: 'Mystery App'
      }
    },
    browserState: {}
  });

  assert.strictEqual(capability.mode, 'keyboard-window-first');
});