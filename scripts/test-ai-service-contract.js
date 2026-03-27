#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const aiService = require(path.join(__dirname, '..', 'src', 'main', 'ai-service.js'));

const EXPECTED_EXPORTS = [
  'AI_PROVIDERS',
  'ActionRiskLevel',
  'COPILOT_MODELS',
  'LIKU_TOOLS',
  'addVisualContext',
  'analyzeActionSafety',
  'clearChatContinuityState',
  'clearPendingAction',
  'clearSemanticDOMSnapshot',
  'clearVisualContext',
  'confirmPendingAction',
  'describeAction',
  'discoverCopilotModels',
  'executeActions',
  'getCopilotModels',
  'getCurrentCopilotModel',
  'getBrowserRecoverySnapshot',
  'getChatContinuityState',
  'getLatestVisualContext',
  'getModelMetadata',
  'getPendingAction',
  'getReflectionModel',
  'getSessionIntentState',
  'getStatus',
  'getToolDefinitions',
  'getUIWatcher',
  'gridToPixels',
  'handleCommand',
  'hasActions',
  'ingestUserIntentState',
  'loadCopilotToken',
  'memoryStore',
  'parseActions',
  'parsePreferenceCorrection',
  'preflightActions',
  'recordChatContinuityTurn',
  'rejectPendingAction',
  'resumeAfterConfirmation',
  'rewriteActionsForReliability',
  'saveSessionNote',
  'sendMessage',
  'setApiKey',
  'setCopilotModel',
  'setOAuthCallback',
  'setPendingAction',
  'setProvider',
  'setReflectionModel',
  'setSemanticDOMSnapshot',
  'setUIWatcher',
  'skillRouter',
  'startCopilotOAuth',
  'systemAutomation',
  'toolCallsToActions'
].sort();

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

function scoreGptModel(model) {
  const id = String(model?.id || '').toLowerCase();
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!match) return Number.NEGATIVE_INFINITY;
  const major = Number(match[1] || 0);
  const minor = Number(match[2] || 0);
  const miniPenalty = id.includes('mini') ? -0.1 : 0;
  return major * 100 + minor + miniPenalty;
}

test('export surface remains stable', () => {
  assert.deepStrictEqual(Object.keys(aiService).sort(), EXPECTED_EXPORTS);
});

test('status payload shape remains stable', () => {
  const status = aiService.getStatus();
  assert.strictEqual(typeof status.provider, 'string');
  assert.strictEqual(typeof status.model, 'string');
  assert.strictEqual(typeof status.modelName, 'string');
  assert.strictEqual(typeof status.configuredModel, 'string');
  assert.strictEqual(typeof status.configuredModelName, 'string');
  assert.strictEqual(typeof status.requestedModel, 'string');
  assert.ok(status.runtimeModel === null || typeof status.runtimeModel === 'string');
  assert.ok(status.runtimeModelName === null || typeof status.runtimeModelName === 'string');
  assert.ok(status.runtimeEndpointHost === null || typeof status.runtimeEndpointHost === 'string');
  assert.ok(status.runtimeActualModelId === null || typeof status.runtimeActualModelId === 'string');
  assert.ok(status.runtimeLastValidated === null || typeof status.runtimeLastValidated === 'string');
  assert.strictEqual(typeof status.hasCopilotKey, 'boolean');
  assert.strictEqual(typeof status.hasApiKey, 'boolean');
  assert.strictEqual(typeof status.hasOpenAIKey, 'boolean');
  assert.strictEqual(typeof status.hasAnthropicKey, 'boolean');
  assert.strictEqual(typeof status.historyLength, 'number');
  assert.strictEqual(typeof status.visualContextCount, 'number');
  assert.deepStrictEqual(status.availableProviders, ['copilot', 'openai', 'anthropic', 'ollama']);
  assert.ok(status.browserSessionState);
  assert.deepStrictEqual(Object.keys(status.browserSessionState).sort(), [
    'attemptedUrls',
    'goalStatus',
    'lastAttemptedUrl',
    'lastStrategy',
    'lastUpdated',
    'lastUserIntent',
    'navigationAttemptCount',
    'recoveryMode',
    'recoveryQuery',
    'title',
    'url'
  ]);
  assert.ok(Array.isArray(status.copilotModels));
  assert.ok(status.copilotModels.length > 0);
});

testAsync('handleCommand status response shape remains stable', async () => {
  const result = await aiService.handleCommand('/status');
  assert.ok(result);
  assert.strictEqual(result.type, 'info');
  assert.strictEqual(typeof result.message, 'string');
  assert.ok(result.message.includes('Provider:'));
  assert.ok(result.message.includes('History:'));
});

testAsync('handleCommand model shortcuts resolve through the live ai-service path', async () => {
  const originalModel = aiService.getCurrentCopilotModel();
  const selectableModels = aiService.getCopilotModels().filter((model) => model.selectable !== false);
  const cheapModel = selectableModels.find((model) => Array.isArray(model.recommendationTags) && model.recommendationTags.includes('budget'));
  const latestGptModel = selectableModels
    .filter((model) => /^gpt-/i.test(model.id || ''))
    .sort((left, right) => scoreGptModel(right) - scoreGptModel(left))[0];

  assert.ok(cheapModel, 'expected a budget model shortcut target');
  assert.ok(latestGptModel, 'expected a latest GPT shortcut target');

  try {
    const cheapResult = await aiService.handleCommand('/model cheap');
    assert.strictEqual(cheapResult.type, 'system');
    assert.strictEqual(aiService.getCurrentCopilotModel(), cheapModel.id);

    const latestResult = await aiService.handleCommand('/model latest-gpt');
    assert.strictEqual(latestResult.type, 'system');
    assert.strictEqual(aiService.getCurrentCopilotModel(), latestGptModel.id);
  } finally {
    aiService.setCopilotModel(originalModel);
  }
});

test('tool schema remains stable enough for function-calling', () => {
  assert.ok(Array.isArray(aiService.LIKU_TOOLS));
  const toolNames = aiService.LIKU_TOOLS.map((tool) => tool.function.name);
  assert.deepStrictEqual(toolNames, [
    'click_element',
    'click',
    'double_click',
    'right_click',
    'type_text',
    'press_key',
    'scroll',
    'drag',
    'wait',
    'screenshot',
    'run_command',
    'focus_window'
  ]);
});

test('tool call mapping remains stable', () => {
  const actions = aiService.toolCallsToActions([
    { function: { name: 'press_key', arguments: '{"key":"ctrl+s","reason":"save file"}' } },
    { function: { name: 'focus_window', arguments: '{"title":"Visual Studio Code"}' } },
    { function: { name: 'type_text', arguments: '{"text":"hello"}' } }
  ]);

  assert.deepStrictEqual(actions, [
    { type: 'key', key: 'ctrl+s', reason: 'save file' },
    { type: 'bring_window_to_front', title: 'Visual Studio Code' },
    { type: 'type', text: 'hello' }
  ]);
});

test('action parsing facade remains stable', () => {
  const response = 'Plan\n```json\n{\n  "actions": [\n    { "type": "wait", "ms": 250 }\n  ]\n}\n```';
  const parsed = aiService.parseActions(response);
  assert.ok(parsed);
  assert.ok(Array.isArray(parsed.actions));
  assert.strictEqual(parsed.actions[0].type, 'wait');
  assert.strictEqual(aiService.hasActions(response), true);
  assert.strictEqual(aiService.hasActions('No actions here.'), null);
});

test('pending action lifecycle remains stable', () => {
  const originalPending = aiService.getPendingAction();
  const samplePending = {
    response: 'Need confirmation',
    actions: [{ type: 'run_command', command: 'echo test' }],
    metadata: { source: 'contract-test' }
  };

  aiService.clearPendingAction();
  aiService.setPendingAction(samplePending);
  assert.deepStrictEqual(aiService.getPendingAction(), samplePending);
  aiService.clearPendingAction();
  assert.strictEqual(aiService.getPendingAction(), null);

  if (originalPending) {
    aiService.setPendingAction(originalPending);
  }
});
