#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));
const { resetBrowserSessionState, updateBrowserSessionState } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'browser-session-state.js'));

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

test('explicit Edge request rewrites Simple Browser flow to browser address bar flow', () => {
  resetBrowserSessionState();
  const actions = [
    { type: 'key', key: 'ctrl+shift+p', reason: 'Open Command Palette' },
    { type: 'type', text: 'Simple Browser: Show', reason: 'Open VS Code integrated Simple Browser' },
    { type: 'key', key: 'enter', reason: 'Run Simple Browser: Show' },
    { type: 'type', text: 'https://www.apple.com', reason: 'Enter URL' },
    { type: 'key', key: 'enter', reason: 'Navigate' }
  ];

  const rewritten = aiService.rewriteActionsForReliability(actions, {
    userMessage: 'Open https://www.apple.com in Edge without using search or intermediate pages.'
  });

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[0].processName, 'msedge');
  assert(rewritten.some((action) => action.type === 'type' && action.text === 'https://www.apple.com'), 'URL remains intact');
  assert(!rewritten.some((action) => action.type === 'type' && /simple browser\s*:\s*show/i.test(String(action.text || ''))), 'Simple Browser flow removed');
});

test('repeated failed direct navigation rewrites next retry into Google discovery search', () => {
  resetBrowserSessionState();
  updateBrowserSessionState({
    lastUserIntent: 'find a way to navigate to googles aitestkitchen in edge browser',
    attemptedUrls: ['https://labs.google/testkitchen', 'https://aitestkitchen.com'],
    navigationAttemptCount: 2,
    recoveryMode: 'search',
    recoveryQuery: 'google ai test kitchen official status'
  });

  const actions = [
    { type: 'focus_window', windowHandle: 67198 },
    { type: 'key', key: 'ctrl+l', reason: 'Focus the address bar in Edge.' },
    { type: 'type', text: 'https://labs.google/testkitchen', reason: 'Try another guessed URL.' },
    { type: 'key', key: 'enter', reason: 'Navigate.' },
    { type: 'wait', ms: 2000 },
    { type: 'screenshot' }
  ];

  const rewritten = aiService.rewriteActionsForReliability(actions, {
    userMessage: 'find a way to navigate to googles aitestkitchen in edge browser'
  });

  const typedValues = rewritten.filter((action) => action.type === 'type').map((action) => String(action.text || ''));
  assert(typedValues.some((value) => /google\.com\/search\?q=/i.test(value)), 'Recovery rewrite uses a Google search URL');
  assert(!typedValues.some((value) => value === 'https://labs.google/testkitchen'), 'Recovery rewrite suppresses another guessed direct URL');
  assert(rewritten.some((action) => action.type === 'screenshot'), 'Recovery rewrite keeps screenshot capture for result analysis');
});

test('browser recovery snapshot reports discovery mode on repeated failed direct navigation', () => {
  resetBrowserSessionState();
  updateBrowserSessionState({
    title: 'Google Labs 404',
    url: 'https://labs.google/404',
    goalStatus: 'needs_discovery',
    lastUserIntent: 'find a way to navigate to googles aitestkitchen in edge browser',
    attemptedUrls: ['https://labs.google/testkitchen', 'https://aitestkitchen.com'],
    navigationAttemptCount: 2,
    recoveryMode: 'search',
    recoveryQuery: 'google ai test kitchen official status'
  });

  const snapshot = aiService.getBrowserRecoverySnapshot('find a way to navigate to googles aitestkitchen in edge browser');
  assert.strictEqual(snapshot.phase, 'discovery-search');
  assert.strictEqual(snapshot.errorPage, true);
  assert(/Do not guess another destination URL/i.test(snapshot.directive), 'Discovery snapshot tells the model to stop guessing URLs');
});

test('browser recovery snapshot reports result-selection mode on Google results', () => {
  resetBrowserSessionState();
  updateBrowserSessionState({
    title: 'google ai test kitchen official status - Google Search',
    url: 'https://www.google.com/search?q=google+ai+test+kitchen+official+status',
    goalStatus: 'searching',
    lastUserIntent: 'find a way to navigate to googles aitestkitchen in edge browser',
    attemptedUrls: ['https://labs.google/testkitchen', 'https://aitestkitchen.com'],
    navigationAttemptCount: 2,
    recoveryMode: 'searching',
    recoveryQuery: 'google ai test kitchen official status'
  });

  const snapshot = aiService.getBrowserRecoverySnapshot('find a way to navigate to googles aitestkitchen in edge browser');
  assert.strictEqual(snapshot.phase, 'result-selection');
  assert.strictEqual(snapshot.searchResultsPage, true);
  assert(/Prefer click_element/i.test(snapshot.directive), 'Result-selection snapshot pushes grounded element selection');
});
