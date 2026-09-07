#!/usr/bin/env node

// Phase 43: budget governor + inference telemetry + analytics.
// Runs against an ISOLATED temp LIKU_HOME so no real-home pollution occurs.

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase43-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const { createBudgetGovernor } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'budget.js'));
const { estimateUsd, loadRates } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'rates.js'));
const { createInferenceTelemetry, summarize } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'inference-telemetry.js'));
const { createProviderOrchestrator } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'orchestration.js'));
const { createRoutingPolicy } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'routing.js'));
const { callOpenAICompatibleChatCompletion } = require(path.join(__dirname, '..', 'src', 'main', 'ai-service', 'providers', 'openai-compatible.js'));

let failures = 0;
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      process.exitCode = 1;
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
    }
  }
}

function inferenceFile() {
  return path.join(process.env.LIKU_HOME_OVERRIDE, 'inference', 'inference.jsonl');
}

function cleanInferenceFile() {
  try { fs.rmSync(path.dirname(inferenceFile()), { recursive: true, force: true }); } catch {}
}

function mockHttps({ statusCode = 200, body }) {
  const calls = [];
  const request = (options, callback) => {
    const req = new EventEmitter();
    req.body = '';
    req.write = (chunk) => { req.body += chunk; };
    req.end = () => {
      calls.push({ options, body: req.body });
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    };
    return req;
  };
  return { request, calls };
}

// ===== rates =====

test('estimateUsd returns null for unknown rate, number for known rate', () => {
  const rates = loadRates({});
  assert.strictEqual(estimateUsd(rates, 'copilot', 'gpt-4o', 1000, 1000), null);
  const usd = estimateUsd(rates, 'cerebras', 'gpt-oss-120b', 1000000, 1000000);
  assert.ok(typeof usd === 'number' && usd > 0);
  // missing usage → null, never invented
  assert.strictEqual(estimateUsd(rates, 'cerebras', 'gpt-oss-120b', null, null), null);
});

// ===== budget governor =====

test('fabric off: budget allows, no counters move', () => {
  const gov = createBudgetGovernor({ env: {} });
  const d = gov.evaluateBudget({ role: 'builder' });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.reason, 'fabric-disabled');
  gov.commitCall({ role: 'builder' });
  gov.recordUsage({ provider: 'cerebras', model: 'gpt-oss-120b', inputTokens: 100, outputTokens: 100 });
  const ledger = gov.getLedger();
  assert.strictEqual(ledger.totalTokens, 0);
  assert.strictEqual(ledger.totalUsd, 0);
  assert.deepStrictEqual(ledger.callsByRole, {});
});

test('token cap: second call blocked after first consumes the cap', () => {
  const gov = createBudgetGovernor({ env: { LIKU_INFERENCE_FABRIC: '1', LIKU_INFERENCE_BUDGET_TOKENS: '10' } });
  assert.strictEqual(gov.evaluateBudget({ role: 'builder' }).allowed, true);
  gov.commitCall({ role: 'builder' });
  gov.recordUsage({ provider: 'cerebras', model: 'gpt-oss-120b', inputTokens: 50, outputTokens: 50 });
  const second = gov.evaluateBudget({ role: 'builder' });
  assert.strictEqual(second.allowed, false);
  assert.strictEqual(second.reason, 'token-cap');
});

test('usd cap: second call blocked after estimated spend exceeds cap', () => {
  const gov = createBudgetGovernor({ env: { LIKU_INFERENCE_FABRIC: '1', LIKU_INFERENCE_BUDGET_USD: '0.0001' } });
  assert.strictEqual(gov.evaluateBudget({ role: 'supervisor' }).allowed, true);
  gov.commitCall({ role: 'supervisor' });
  const rec = gov.recordUsage({ provider: 'xai', model: 'grok-4.6', inputTokens: 1000, outputTokens: 1000 });
  assert.ok(rec.estimatedUsd > 0.0001);
  const second = gov.evaluateBudget({ role: 'supervisor' });
  assert.strictEqual(second.allowed, false);
  assert.strictEqual(second.reason, 'usd-cap');
});

test('iteration cap increments even when usage is missing', () => {
  const gov = createBudgetGovernor({ env: { LIKU_INFERENCE_FABRIC: '1', LIKU_INFERENCE_MAX_CALLS_PER_ROLE: '2' } });
  gov.commitCall({ role: 'builder' });
  gov.recordUsage({ provider: 'cerebras', model: 'gpt-oss-120b' }); // no usage
  gov.commitCall({ role: 'builder' });
  const ledger = gov.getLedger();
  assert.strictEqual(ledger.callsByRole.builder, 2);
  assert.strictEqual(ledger.totalTokens, 0, 'missing usage must not invent tokens');
  const third = gov.evaluateBudget({ role: 'builder' });
  assert.strictEqual(third.allowed, false);
  assert.strictEqual(third.reason, 'iteration-cap');
});

// ===== inference telemetry =====

test('fabric off: telemetry writes nothing (no file)', () => {
  cleanInferenceFile();
  const tel = createInferenceTelemetry({ env: {} });
  const written = tel.record({ provider: 'cerebras', model: 'gpt-oss-120b', role: 'builder', success: true });
  assert.strictEqual(written, null);
  assert.strictEqual(fs.existsSync(inferenceFile()), false);
});

test('fabric on: one success writes exactly one JSONL line with no key material', () => {
  cleanInferenceFile();
  const tel = createInferenceTelemetry({ env: { LIKU_INFERENCE_FABRIC: '1' } });
  tel.record({
    provider: 'cerebras', model: 'gpt-oss-120b', role: 'builder', routeReason: 'default-table',
    inputTokens: 4200, outputTokens: 1100, latencyMs: 842, estimatedUsd: 0.0023,
    success: true, budgetAllowed: true, usedProvider: 'cerebras',
    // fields that must NOT be persisted:
    apiKey: 'SECRET', messages: [{ role: 'user', content: 'private prompt text' }]
  });
  const lines = fs.readFileSync(inferenceFile(), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);
  const raw = lines[0];
  assert.ok(!/SECRET/.test(raw), 'no api key material');
  assert.ok(!/private prompt text/.test(raw), 'no prompt text');
  const rec = JSON.parse(raw);
  assert.strictEqual(rec.provider, 'cerebras');
  assert.strictEqual(rec.inputTokens, 4200);
  assert.strictEqual(rec.success, true);
  assert.strictEqual(rec.apiKey, undefined);
  assert.strictEqual(rec.messages, undefined);
});

test('telemetry file mode is 0o600', () => {
  cleanInferenceFile();
  const tel = createInferenceTelemetry({ env: { LIKU_INFERENCE_FABRIC: '1' } });
  tel.record({ provider: 'xai', model: 'grok-4.6', role: 'supervisor', success: true });
  const mode = fs.statSync(inferenceFile()).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('LIKU_INFERENCE_TELEMETRY=0 disables writes while fabric stays on', () => {
  cleanInferenceFile();
  const tel = createInferenceTelemetry({ env: { LIKU_INFERENCE_FABRIC: '1', LIKU_INFERENCE_TELEMETRY: '0' } });
  assert.strictEqual(tel.record({ provider: 'xai', model: 'grok-4.6', success: true }), null);
  assert.strictEqual(fs.existsSync(inferenceFile()), false);
});

test('analytics summary matches a two-call fixture', () => {
  const records = [
    { provider: 'cerebras', model: 'gpt-oss-120b', role: 'builder', inputTokens: 100, outputTokens: 50, latencyMs: 200, estimatedUsd: 0.001, success: true, budgetAllowed: true },
    { provider: 'xai', model: 'grok-4.6', role: 'supervisor', inputTokens: 200, outputTokens: 80, latencyMs: 400, estimatedUsd: 0.002, success: true, budgetAllowed: true }
  ];
  const s = summarize(records);
  assert.strictEqual(s.calls, 2);
  assert.strictEqual(s.successes, 2);
  assert.strictEqual(s.tokensIn, 300);
  assert.strictEqual(s.tokensOut, 130);
  assert.ok(Math.abs(s.estimatedUsd - 0.003) < 1e-9);
  assert.strictEqual(s.byProvider.cerebras, 1);
  assert.strictEqual(s.byProvider.xai, 1);
  assert.strictEqual(s.byRole.builder, 1);
  assert.strictEqual(s.latency.avg, 300);
});

// ===== orchestration integration =====

function buildIntegration(env) {
  const providers = {
    copilot: { visionModel: 'gpt-4o', chatModel: 'gpt-4o', model: 'gpt-4o' },
    cerebras: { model: 'gpt-oss-120b' },
    xai: { baseUrl: 'api.x.ai', path: '/v1/chat/completions', model: 'grok-4.6' }
  };
  const catalog = {
    cerebras: [{ id: 'gpt-oss-120b' }],
    xai: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }]
  };
  const routing = createRoutingPolicy({
    env,
    getCurrentProvider: () => 'copilot',
    getCurrentModel: () => 'gpt-4o',
    isProviderEnabled: (p) => !!providers[p],
    isProviderExplicit: () => false,
    getProviderDefaultModel: (p) => providers[p].model,
    providerModelCatalog: catalog
  });
  const budget = createBudgetGovernor({ env });
  const telemetry = createInferenceTelemetry({ env });
  return { providers, catalog, routing, budget, telemetry };
}

test('integration: fabric off makes no inference file and never blocks', async () => {
  cleanInferenceFile();
  const { providers, routing, budget, telemetry } = buildIntegration({});
  const orchestrator = createProviderOrchestrator({
    aiProviders: providers,
    apiKeys: { copilot: 'token' },
    callCopilot: async (_m, model) => model,
    callAnthropic: async () => '', callOllama: async () => '', callOpenAI: async () => '',
    callCerebras: async () => ({ content: 'c' }), callXai: async () => ({ content: 'x' }),
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot'],
    resolveCopilotModelKey: (v) => v || 'gpt-4o',
    resolveRoute: routing.resolveRoute,
    budgetGovernor: budget,
    inferenceTelemetry: telemetry
  });
  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'supervisor' });
  assert.strictEqual(result.usedProvider, 'copilot');
  assert.ok(!result.providerMetadata.budget, 'no budget metadata when fabric off');
  assert.strictEqual(fs.existsSync(inferenceFile()), false);
});

test('integration: routed catalog model reaches HTTPS body and is the requestedModel', async () => {
  cleanInferenceFile();
  const env = { LIKU_INFERENCE_FABRIC: '1' };
  const { providers, catalog, routing, budget, telemetry } = buildIntegration(env);
  routing.setRouteOverride('builder', 'xai', 'grok-4.5');
  const mock = mockHttps({ body: { model: 'grok-4.5', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });

  const orchestrator = createProviderOrchestrator({
    aiProviders: providers,
    apiKeys: { copilot: 'token', xai: 'xai-key' },
    callCopilot: async (_m, model) => model,
    callAnthropic: async () => '', callOllama: async () => '', callOpenAI: async () => '',
    callCerebras: async () => ({ content: 'c' }),
    callXai: (messages, effectiveModel, requestOptions) => callOpenAICompatibleChatCompletion({
      provider: 'xAI', config: providers.xai, apiKey: 'xai-key', messages, effectiveModel, requestOptions,
      allowedIds: catalog.xai.map((e) => e.id), request: mock.request
    }),
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot', 'xai'],
    resolveCopilotModelKey: (v) => v || 'gpt-4o',
    resolveRoute: routing.resolveRoute,
    budgetGovernor: budget,
    inferenceTelemetry: telemetry
  });

  const result = await orchestrator.requestWithFallback([{ role: 'user', content: 'hi' }], null, { role: 'builder' });
  assert.strictEqual(result.usedProvider, 'xai');
  assert.strictEqual(JSON.parse(mock.calls[0].body).model, 'grok-4.5', 'wire payload uses routed catalog id');
  assert.strictEqual(result.requestedModel, 'grok-4.5');
  assert.strictEqual(result.providerMetadata.budget.allowed, true);
  // one telemetry line written
  const lines = fs.readFileSync(inferenceFile(), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).model, 'grok-4.5');
});

test('integration: over-budget call does not dispatch HTTPS and returns a budget error', async () => {
  cleanInferenceFile();
  const env = { LIKU_INFERENCE_FABRIC: '1', LIKU_INFERENCE_MAX_CALLS_PER_ROLE: '1' };
  const { providers, catalog, routing, budget, telemetry } = buildIntegration(env);
  let xaiCalls = 0;
  const mock = mockHttps({ body: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  const orchestrator = createProviderOrchestrator({
    aiProviders: providers,
    apiKeys: { copilot: 'token', xai: 'xai-key' },
    callCopilot: async (_m, model) => model,
    callAnthropic: async () => '', callOllama: async () => '', callOpenAI: async () => '',
    callCerebras: async () => ({ content: 'c' }),
    callXai: (messages, effectiveModel, requestOptions) => {
      xaiCalls++;
      return callOpenAICompatibleChatCompletion({
        provider: 'xAI', config: providers.xai, apiKey: 'xai-key', messages, effectiveModel, requestOptions,
        allowedIds: catalog.xai.map((e) => e.id), request: mock.request
      });
    },
    getCurrentCopilotModel: () => 'gpt-4o',
    getCurrentProvider: () => 'copilot',
    loadCopilotToken: () => true,
    modelRegistry: () => ({ 'gpt-4o': { id: 'gpt-4o', vision: true, capabilities: { chat: true, tools: true, vision: true } } }),
    providerFallbackOrder: ['copilot', 'xai'],
    resolveCopilotModelKey: (v) => v || 'gpt-4o',
    resolveRoute: routing.resolveRoute,
    budgetGovernor: budget,
    inferenceTelemetry: telemetry
  });

  // First supervisor call consumes the single per-role slot.
  await orchestrator.requestWithFallback([{ role: 'user', content: 'a' }], null, { role: 'supervisor' });
  const firstXaiCalls = xaiCalls;
  // Second supervisor call must be blocked before any HTTPS dispatch.
  await assert.rejects(
    () => orchestrator.requestWithFallback([{ role: 'user', content: 'b' }], null, { role: 'supervisor' }),
    (err) => err.code === 'BUDGET_EXCEEDED' && err.budget && err.budget.reason === 'iteration-cap'
  );
  assert.strictEqual(xaiCalls, firstXaiCalls, 'no second HTTPS dispatch on budget block');
  // A blocked record is still written (budgetAllowed:false).
  const recs = fs.readFileSync(inferenceFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(recs.some((r) => r.budgetAllowed === false && r.blockedReason === 'iteration-cap'));
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 43 inference budget/telemetry checks passed.');
});

runAll();
