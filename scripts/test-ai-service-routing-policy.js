#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const {
  createRoutingPolicy,
  DEFAULT_ROUTING_TABLE
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'routing.js'));
const {
  createProviderOrchestrator
} = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'orchestration.js'));

function test(name, fn) {
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

const CATALOG = {
  cerebras: [{ id: 'gpt-oss-120b', name: 'GPT-OSS 120B' }],
  xai: [
    { id: 'grok-4.6', name: 'Grok 4.6' },
    { id: 'grok-4.5', name: 'Grok 4.5' }
  ]
};

const PROVIDER_DEFAULT_MODELS = {
  copilot: 'gpt-4o',
  cerebras: 'gpt-oss-120b',
  xai: 'grok-4.6'
};

function buildPolicy(overrides = {}) {
  const state = {
    env: overrides.env || {},
    currentProvider: overrides.currentProvider || 'copilot',
    currentModel: overrides.currentModel || 'gpt-4o',
    enabled: new Set(overrides.enabled || ['copilot', 'openai', 'anthropic', 'ollama']),
    explicit: overrides.explicit || false
  };
  const policy = createRoutingPolicy({
    env: state.env,
    getCurrentProvider: () => state.currentProvider,
    getCurrentModel: () => state.currentModel,
    isProviderEnabled: (provider) => state.enabled.has(provider),
    isProviderExplicit: () => state.explicit,
    getProviderDefaultModel: (provider) => PROVIDER_DEFAULT_MODELS[provider] || 'gpt-4o',
    providerModelCatalog: CATALOG
  });
  return { policy, state };
}

// ===== resolveRoute policy tests =====

test('fabric flag off keeps current provider/model, policyApplied false', () => {
  const { policy } = buildPolicy({ env: {} });
  const route = policy.resolveRoute({ role: 'supervisor' });
  assert.strictEqual(route.provider, 'copilot');
  assert.strictEqual(route.model, 'gpt-4o');
  assert.strictEqual(route.policyApplied, false);
  assert.strictEqual(route.reason, 'fabric-disabled');
});

test('fabric on + xAI enabled routes supervisor to xai/grok-4.6', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai']
  });
  const route = policy.resolveRoute({ role: 'supervisor' });
  assert.strictEqual(route.provider, 'xai');
  assert.strictEqual(route.model, 'grok-4.6');
  assert.strictEqual(route.policyApplied, true);
  assert.strictEqual(route.reason, 'default-table');
});

test('fabric on + Cerebras enabled routes builder to cerebras/gpt-oss-120b', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: 'true' },
    enabled: ['copilot', 'cerebras']
  });
  const route = policy.resolveRoute({ role: 'builder' });
  assert.strictEqual(route.provider, 'cerebras');
  assert.strictEqual(route.model, 'gpt-oss-120b');
  assert.strictEqual(route.policyApplied, true);
});

test('fabric on but target provider not enabled falls back to current, no throw', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot']
  });
  const route = policy.resolveRoute({ role: 'builder' });
  assert.strictEqual(route.provider, 'copilot');
  assert.strictEqual(route.model, 'gpt-4o');
  assert.strictEqual(route.reason, 'provider-unavailable');
  assert.strictEqual(route.policyApplied, true);
});

test('explicit per-call provider wins over the table', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai']
  });
  const route = policy.resolveRoute({ role: 'supervisor', explicitProvider: 'copilot' });
  assert.strictEqual(route.provider, 'copilot');
  assert.strictEqual(route.reason, 'explicit-provider');
});

test('session /provider selection (isProviderExplicit) wins over the table', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai'],
    currentProvider: 'copilot',
    explicit: true
  });
  const route = policy.resolveRoute({ role: 'supervisor' });
  assert.strictEqual(route.provider, 'copilot');
  assert.strictEqual(route.reason, 'explicit-provider');
});

test('producer / vision / unknown roles stay on current provider', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'cerebras', 'xai']
  });
  assert.strictEqual(policy.resolveRoute({ role: 'producer' }).provider, 'copilot');
  assert.strictEqual(policy.resolveRoute({ role: 'producer' }).policyApplied, false);
  assert.strictEqual(policy.resolveRoute({ role: 'unknown-role' }).provider, 'copilot');
  assert.strictEqual(policy.resolveRoute({ routingContext: { includeVisualContext: true } }).provider, 'copilot');
});

// ===== session override tests =====

test('/route override sets and applies builder → xai/grok-4.6', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai']
  });
  const result = policy.setRouteOverride('builder', 'xai', 'grok-4.6');
  assert.strictEqual(result.ok, true);
  const route = policy.resolveRoute({ role: 'builder' });
  assert.strictEqual(route.provider, 'xai');
  assert.strictEqual(route.model, 'grok-4.6');
  assert.strictEqual(route.reason, 'route-override');
});

test('/route override rejects unknown role, disabled provider, unknown model', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai']
  });
  assert.strictEqual(policy.setRouteOverride('nonrole', 'xai').ok, false);
  assert.strictEqual(policy.setRouteOverride('builder', 'cerebras').ok, false);
  assert.strictEqual(policy.setRouteOverride('builder', 'xai', 'grok-9').ok, false);
});

test('/route reset and per-role default clear overrides', () => {
  const { policy } = buildPolicy({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai']
  });
  policy.setRouteOverride('supervisor', 'xai', 'grok-4.5');
  assert.strictEqual(policy.resolveRoute({ role: 'supervisor' }).model, 'grok-4.5');
  assert.strictEqual(policy.clearRouteOverride('supervisor'), true);
  assert.strictEqual(policy.resolveRoute({ role: 'supervisor' }).model, 'grok-4.6');

  policy.setRouteOverride('supervisor', 'xai', 'grok-4.5');
  policy.resetRouteOverrides();
  assert.deepStrictEqual(policy.getRouteOverrides(), {});
});

test('default table exposes expected role → vendor mapping', () => {
  assert.strictEqual(DEFAULT_ROUTING_TABLE.supervisor.provider, 'xai');
  assert.strictEqual(DEFAULT_ROUTING_TABLE.architect.provider, 'xai');
  assert.strictEqual(DEFAULT_ROUTING_TABLE.researcher.provider, 'cerebras');
  assert.strictEqual(DEFAULT_ROUTING_TABLE.builder.provider, 'cerebras');
  assert.strictEqual(DEFAULT_ROUTING_TABLE.verifier.provider, 'cerebras');
  assert.strictEqual(DEFAULT_ROUTING_TABLE.diagnostician.provider, 'cerebras');
  assert.strictEqual(DEFAULT_ROUTING_TABLE.producer.provider, null);
});

// ===== orchestration integration (mocked HTTP, no live network) =====

function buildOrchestrator(overrides = {}) {
  const calls = [];
  const providers = overrides.aiProviders || {
    copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o', model: 'gpt-4o' },
    cerebras: { model: 'gpt-oss-120b' },
    xai: { model: 'grok-4.6' }
  };
  const { policy, state } = buildPolicy({
    env: overrides.env || {},
    enabled: overrides.enabled || Object.keys(providers),
    explicit: overrides.explicit || false,
    currentProvider: overrides.currentProvider || 'copilot'
  });
  const orchestrator = createProviderOrchestrator({
    aiProviders: providers,
    apiKeys: { copilot: 'token', openai: '', anthropic: '', cerebras: 'ck', xai: 'xk' },
    callAnthropic: async () => { calls.push('anthropic'); return 'anthropic'; },
    callCopilot: async (_m, effectiveModel) => { calls.push('copilot'); return effectiveModel; },
    callOllama: async () => { calls.push('ollama'); return 'ollama'; },
    callOpenAI: async () => { calls.push('openai'); return 'openai'; },
    callCerebras: async (_m, effectiveModel) => { calls.push(`cerebras:${effectiveModel}`); return { content: 'cerebras', effectiveModel }; },
    callXai: async (_m, effectiveModel) => { calls.push(`xai:${effectiveModel}`); return { content: 'xai', effectiveModel }; },
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => state.currentProvider,
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot', 'openai', 'anthropic', 'ollama', 'cerebras', 'xai'],
    resolveCopilotModelKey: (value) => value || 'gpt-4o',
    resolveRoute: policy.resolveRoute
  });
  return { orchestrator, calls, policy, state };
}

test('integration: fabric off routes to current provider, no optional provider calls', async () => {
  const { orchestrator, calls } = buildOrchestrator({ env: {} });
  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'supervisor' });
  assert.strictEqual(result.usedProvider, 'copilot');
  assert.strictEqual(calls.includes('xai:grok-4.6'), false);
  assert.ok(!result.providerMetadata.route, 'no route metadata when fabric off');
});

test('integration: fabric on routes supervisor to xai', async () => {
  const { orchestrator, calls, state } = buildOrchestrator({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai']
  });
  state.currentProvider = 'copilot';
  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'supervisor' });
  assert.strictEqual(result.usedProvider, 'xai');
  assert.ok(calls.includes('xai:grok-4.6'));
  assert.strictEqual(result.providerMetadata.route.provider, 'xai');
  assert.strictEqual(result.providerMetadata.route.reason, 'default-table');
});

test('integration: fabric on routes builder to cerebras/gpt-oss-120b', async () => {
  const { orchestrator, calls } = buildOrchestrator({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'cerebras']
  });
  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'builder' });
  assert.strictEqual(result.usedProvider, 'cerebras');
  assert.ok(calls.includes('cerebras:gpt-oss-120b'));
});

test('integration: builder falls back to current provider when cerebras disabled, no throw', async () => {
  const { orchestrator, calls } = buildOrchestrator({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot']
  });
  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'builder' });
  assert.strictEqual(result.usedProvider, 'copilot');
  assert.strictEqual(calls.filter((c) => c.startsWith('cerebras')).length, 0);
  assert.strictEqual(result.providerMetadata.route.reason, 'provider-unavailable');
});

test('integration: explicit /provider copilot wins over table and runs copilot model resolution', async () => {
  const { orchestrator, calls } = buildOrchestrator({
    env: { LIKU_INFERENCE_FABRIC: '1' },
    enabled: ['copilot', 'xai'],
    explicit: true,
    currentProvider: 'copilot'
  });
  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'supervisor' });
  assert.strictEqual(result.usedProvider, 'copilot');
  // Copilot capability routing still resolves the effective model key.
  assert.strictEqual(result.effectiveModel, 'gpt-4o');
  assert.ok(calls.includes('copilot'));
});
