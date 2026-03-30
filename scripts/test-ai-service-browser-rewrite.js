#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
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

function testAsync(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

test('explicit Edge request rewrites Simple Browser flow to browser address bar flow', () => {
  resetBrowserSessionState();
  const actions = [
    { type: 'key', key: 'ctrl+shift+p', reason: 'Open Command Palette' },
    { type: 'type', text: 'Simple Browser: Show', reason: 'Open VS Code integrated Simple Browser' },
    { type: 'key', key: 'enter', reason: 'Run Simple Browser: Show' },
    { type: 'type', text: 'https://example.com', reason: 'Enter URL' },
    { type: 'key', key: 'enter', reason: 'Navigate' }
  ];

  const rewritten = aiService.rewriteActionsForReliability(actions, {
    userMessage: 'Open https://example.com in Edge without using search or intermediate pages.'
  });

  assert.strictEqual(rewritten[0].type, 'bring_window_to_front');
  assert.strictEqual(rewritten[0].processName, 'msedge');
  assert(rewritten.some((action) => action.type === 'type' && action.text === 'https://example.com'), 'URL remains intact');
  assert(!rewritten.some((action) => action.type === 'type' && /simple browser\s*:\s*show/i.test(String(action.text || ''))), 'Simple Browser flow removed');
});

test('runtime browser guidance stays generic and avoids Apple-specific hardcoding', () => {
  const systemPromptPath = path.join(__dirname, '..', 'src', 'main', 'ai-service', 'system-prompt.js');
  const chatPath = path.join(__dirname, '..', 'src', 'cli', 'commands', 'chat.js');
  const systemPromptContent = fs.readFileSync(systemPromptPath, 'utf8');
  const chatContent = fs.readFileSync(chatPath, 'utf8');

  assert(!/apple\.com/i.test(systemPromptContent), 'Runtime system prompt should not hardcode apple.com');
  assert(!/official apple/i.test(systemPromptContent), 'Runtime system prompt should not hardcode Apple-specific browser guidance');
  assert(!/apple\.com/i.test(chatContent), 'Chat browser recovery hint should not hardcode apple.com');
  assert(systemPromptContent.includes('final URL is already provided or strongly inferable'), 'System prompt should keep the generic direct-navigation rule');
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

testAsync('achieved browser repeat request converges to concise no-op reply', async () => {
  resetBrowserSessionState();
  updateBrowserSessionState({
    url: 'https://example.com',
    title: 'Example Domain - Microsoft Edge',
    goalStatus: 'achieved',
    lastUserIntent: 'Open https://example.com in Edge without using search or intermediate pages. Use the most direct grounded method.'
  });

  const result = await aiService.sendMessage('Open https://example.com in Edge without using search or intermediate pages. Use the most direct grounded method.', {
    enforceActions: true,
    includeVisualContext: false
  });

  assert.strictEqual(result.success, true);
  assert(/Example(?: Domain)? (website|page) should now be open in Edge/i.test(result.message));
  assert(/No further actions needed/i.test(result.message));
  assert(!/```json|"actions"\s*:/i.test(result.message));
});

testAsync('achieved browser confirmation request stays explicit and action-free', async () => {
  resetBrowserSessionState();
  updateBrowserSessionState({
    url: 'https://example.com',
    title: 'Example Domain - Microsoft Edge',
    goalStatus: 'achieved',
    lastUserIntent: 'Open https://example.com in Edge without using search or intermediate pages. Use the most direct grounded method.'
  });

  const result = await aiService.sendMessage('The Example Domain page should already be open. Confirm briefly and do not propose any new actions.', {
    enforceActions: true,
    includeVisualContext: false
  });

  assert.strictEqual(result.success, true);
  assert(/Confirmed\./i.test(result.message));
  assert(/Example(?: Domain)? page is already open in Edge/i.test(result.message));
  assert(/No further actions needed/i.test(result.message));
  assert(!/```json|"actions"\s*:/i.test(result.message));
});

test('satisfied browser no-op does not hijack TradingView application requests', () => {
  resetBrowserSessionState();
  updateBrowserSessionState({
    url: 'https://example.com',
    title: 'Example Domain - Microsoft Edge',
    goalStatus: 'achieved',
    lastUserIntent: 'Open https://example.com in Edge without using search or intermediate pages. Use the most direct grounded method.'
  });

  const response = aiService.maybeBuildSatisfiedBrowserNoOpResponse(
    'tradingview application is in the background, create a pine script that shows confidence in volume and momentum. then use key ctrl + enter to apply to the LUNR chart.',
    {
      recentHistory: [
        { role: 'user', content: 'Open https://example.com in Edge without using search or intermediate pages. Use the most direct grounded method.' },
        { role: 'assistant', content: 'Example website should now be open in Edge. No further actions needed.' }
      ]
    }
  );

  assert.strictEqual(response, null, 'TradingView application requests should not be short-circuited as browser no-op replies');
});
