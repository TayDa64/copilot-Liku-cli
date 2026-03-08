#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const uiContext = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'ui-context.js'));
const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

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

test('public watcher setter/getter stays stable', () => {
  const originalWatcher = aiService.getUIWatcher();
  const watcher = { isRunning: true, getContextForAI() { return 'context'; } };

  aiService.setUIWatcher(watcher);
  assert.strictEqual(aiService.getUIWatcher(), watcher);

  aiService.setUIWatcher(originalWatcher);
});

test('semantic DOM formatter includes grounded nodes', () => {
  uiContext.setSemanticDOMSnapshot({
    role: 'Window',
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
    children: [
      {
        id: 'save-btn',
        name: 'Save',
        role: 'Button',
        isClickable: true,
        isFocusable: true,
        bounds: { x: 10, y: 20, width: 80, height: 30 }
      }
    ]
  });

  const text = uiContext.getSemanticDOMContextText();
  assert.ok(text.includes('Semantic DOM'));
  assert.ok(text.includes('Button \"Save\" id=save-btn'));
  assert.ok(text.includes('[clickable,focusable]'));

  uiContext.clearSemanticDOMSnapshot();
});

test('semantic DOM clear resets context text', () => {
  uiContext.setSemanticDOMSnapshot({
    role: 'Window',
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
    children: []
  });
  uiContext.clearSemanticDOMSnapshot();
  assert.strictEqual(uiContext.getSemanticDOMContextText(), '');
});
