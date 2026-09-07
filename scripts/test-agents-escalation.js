#!/usr/bin/env node

// Phase 45: observable-signal escalation + optional independent verifier.
// Isolated temp LIKU_HOME; no live network (workers/handoffs are faked).

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase45-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const { classifySignal } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'escalation-signals.js'));
const escalation = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'escalation.js'));
const { SupervisorAgent } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
const { AgentRole } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'base-agent.js'));

let failures = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of queue) {
    const saved = { ...process.env };
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      process.exitCode = 1;
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
    } finally {
      for (const k of ['LIKU_INFERENCE_FABRIC', 'LIKU_TASK_CONTRACTS', 'LIKU_ESCALATION', 'LIKU_INDEPENDENT_VERIFIER']) {
        delete process.env[k];
        if (saved[k] !== undefined) process.env[k] = saved[k];
      }
    }
  }
}

// ===== classifier =====

test('classifier maps observable evidence to the closed signal set', () => {
  assert.strictEqual(classifySignal({ taskResult: { status: 'success' } }).signal, 'success');
  assert.strictEqual(classifySignal({ taskResult: { status: 'failure' }, error: 'unit tests failed: 2 failing' }).signal, 'tests-failed');
  assert.strictEqual(classifySignal({ taskResult: { status: 'failure' }, error: 'Unexpected token in JSON at position 3' }).signal, 'schema-invalid');
  assert.strictEqual(classifySignal({ taskResult: { status: 'failure' }, error: 'request timed out' }).signal, 'timeout');
  assert.strictEqual(classifySignal({ taskResult: { status: 'failure' }, error: 'xAI API error: 429 rate limit' }).signal, 'provider-error');
  assert.strictEqual(classifySignal({ taskResult: { status: 'failure' }, error: 'something odd' }).signal, 'unknown-failure');
});

test('classifier fails closed on budget and policy, never auto-retries them', () => {
  const budget = classifySignal({ taskResult: { status: 'failure' }, error: { code: 'BUDGET_EXCEEDED', message: 'Budget exceeded: usd-cap' } });
  assert.strictEqual(budget.signal, 'budget-exceeded');
  assert.strictEqual(budget.retryable, false);
  assert.strictEqual(budget.human, true);

  const policy = classifySignal({ taskResult: { status: 'failure' }, error: 'Action denied by safety hook: pending-confirm' });
  assert.strictEqual(policy.signal, 'policy-violation');
  assert.strictEqual(policy.retryable, false);
  assert.strictEqual(policy.human, true);

  const metaBudget = classifySignal({ taskResult: { status: 'failure' }, providerMetadata: { budget: { allowed: false } } });
  assert.strictEqual(metaBudget.signal, 'budget-exceeded');
});

test('classifier: files-missing, verifier-disagree, repeated-failure', () => {
  const filesMissing = classifySignal({ taskResult: { status: 'success', files: ['a.js'] }, requiredFiles: ['a.js', 'b.js'] });
  assert.strictEqual(filesMissing.signal, 'files-missing');

  const disagree = classifySignal({ taskResult: { status: 'failure' }, error: 'verifier verdict not passed', builderSucceeded: true });
  assert.strictEqual(disagree.signal, 'verifier-disagree');

  const repeated = classifySignal({ taskResult: { status: 'failure' }, error: 'unit tests failed', priorSignal: 'tests-failed' });
  assert.strictEqual(repeated.signal, 'repeated-failure');
  assert.strictEqual(repeated.human, true);
  assert.strictEqual(repeated.retryable, false);
});

test('classifier NEVER reads a confidence field', () => {
  // A high "confidence" must not turn an observable failure into success.
  const c = classifySignal({ taskResult: { status: 'failure', confidence: 0.99 }, error: 'unit tests failed' });
  assert.strictEqual(c.signal, 'tests-failed');
  // And low confidence on a real success must not manufacture a failure.
  const s = classifySignal({ taskResult: { status: 'success', confidence: 0.01 } });
  assert.strictEqual(s.signal, 'success');
});

// ===== ladder =====

test('nextRung: policy/budget jump straight to human stop', () => {
  assert.deepStrictEqual(escalation.nextRung({ currentRung: 0, signal: 'policy-violation', enabledProviders: ['copilot', 'xai'] }), { rung: 4, explicitProvider: null, explicitModel: null, stop: true, reason: 'policy-violation' });
  assert.strictEqual(escalation.nextRung({ currentRung: 1, signal: 'budget-exceeded', enabledProviders: ['copilot'] }).stop, true);
});

test('nextRung: rung0→1 same provider, rung1→2 prefers enabled xai', () => {
  const r1 = escalation.nextRung({ currentRung: 0, signal: 'tests-failed', enabledProviders: ['copilot', 'xai'], usedProvider: 'copilot' });
  assert.strictEqual(r1.rung, 1);
  assert.strictEqual(r1.explicitProvider, 'copilot');
  const r2 = escalation.nextRung({ currentRung: 1, signal: 'tests-failed', enabledProviders: ['copilot', 'xai'], usedProvider: 'copilot' });
  assert.strictEqual(r2.rung, 2);
  assert.strictEqual(r2.explicitProvider, 'xai');
});

test('nextRung: skips disabled rungs and stops when no alternate exists', () => {
  const r = escalation.nextRung({ currentRung: 1, signal: 'tests-failed', enabledProviders: ['copilot'], usedProvider: 'copilot' });
  assert.strictEqual(r.stop, true);
  assert.strictEqual(r.reason, 'ladder-exhausted');
  assert.strictEqual(escalation.pickAlternateProvider('cerebras', ['cerebras', 'xai']), 'xai');
  assert.strictEqual(escalation.pickAlternateProvider('cerebras', ['cerebras']), null);
});

// ===== supervisor integration =====

function makeSupervisor({ availableProviders = ['copilot'], onBuilder, onVerifier } = {}) {
  const captured = [];
  const sup = new SupervisorAgent({});
  sup.aiService = { getStatus: () => ({ availableProviders }) };
  sup.handoffToBuilder = async (ctx, message) => {
    captured.push({ agent: AgentRole.BUILDER, ctx, message });
    return onBuilder ? onBuilder(captured.filter((c) => c.agent === AgentRole.BUILDER).length - 1, ctx) : { success: true, usedProvider: 'copilot' };
  };
  sup.handoffToVerifier = async (ctx, message) => {
    captured.push({ agent: AgentRole.VERIFIER, ctx, message });
    return onVerifier ? onVerifier(captured.filter((c) => c.agent === AgentRole.VERIFIER).length - 1, ctx) : { success: true, usedProvider: 'copilot' };
  };
  return { sup, captured };
}

function builderPlan() {
  return { planId: 'p1', steps: [{ description: 'Implement foo', agent: AgentRole.BUILDER, status: 'pending' }] };
}

test('escalation off: one Builder call, no retry even on failure', async () => {
  delete process.env.LIKU_ESCALATION;
  process.env.LIKU_TASK_CONTRACTS = '1';
  const { sup, captured } = makeSupervisor({ onBuilder: () => ({ success: false, error: 'unit tests failed', usedProvider: 'copilot' }) });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 1);
});

test('escalation on, tests-failed persists, single enabled provider → exactly one retry then stop', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot'],
    onBuilder: () => ({ success: false, error: 'unit tests failed: 1 failing', usedProvider: 'copilot' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 2, 'initial + exactly one retry');
  assert.strictEqual(results[0].taskResult.status, 'blocked');
  assert.strictEqual(results[0].taskResult.recommendation, 'human review');
  assert.ok(Array.isArray(sup.decomposedTasks[0].escalation) && sup.decomposedTasks[0].escalation.length >= 2);
});

test('escalation respects the 2-retry cap even with multiple providers', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  // Distinct signals each attempt avoid the earlier repeated-failure stop, so the
  // hard 2-retry cap is what ends the loop.
  const errors = ['unit tests failed', 'Unexpected token in JSON', 'request timed out'];
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot', 'xai', 'openai', 'anthropic'],
    onBuilder: (idx) => ({ success: false, error: errors[idx] || 'still failing', usedProvider: 'copilot' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 3, 'initial + at most 2 retries');
});

test('escalation on: policy-violation → zero retries', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot', 'xai'],
    onBuilder: () => ({ success: false, error: 'denied by safety hook (pending-confirm)', usedProvider: 'copilot' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(results[0].taskResult.status, 'blocked');
});

test('escalation on: budget-exceeded → zero retries', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot', 'xai'],
    onBuilder: () => ({ success: false, error: 'Budget exceeded: usd-cap', budget: { allowed: false, reason: 'usd-cap' }, usedProvider: 'copilot' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 1);
});

test('escalation on: builder succeeds → no retry', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  const { sup, captured } = makeSupervisor({ availableProviders: ['copilot', 'xai'], onBuilder: () => ({ success: true, filesModified: ['a.js'], usedProvider: 'copilot' }) });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(results[0].taskResult.status, 'success');
});

// ===== independent verifier =====

function builderVerifierPlan() {
  return {
    planId: 'p2',
    steps: [
      { description: 'Implement foo', agent: AgentRole.BUILDER, status: 'pending' },
      { description: 'Verify foo', agent: AgentRole.VERIFIER, status: 'pending' }
    ]
  };
}

test('independent verifier OFF: verifier follows the table (no explicitProvider)', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  delete process.env.LIKU_INDEPENDENT_VERIFIER;
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot', 'cerebras', 'xai'],
    onBuilder: () => ({ success: true, usedProvider: 'cerebras' }),
    onVerifier: () => ({ success: true, verdict: { passed: true }, usedProvider: 'cerebras' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderVerifierPlan());
  await sup.executePlan(sup.decomposedTasks, {});
  const verifierCall = captured.find((c) => c.agent === AgentRole.VERIFIER);
  assert.strictEqual(verifierCall.ctx.explicitProvider, undefined);
});

test('independent verifier ON + builder used cerebras + xAI enabled → verifier routes to xai', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_INDEPENDENT_VERIFIER = '1';
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot', 'cerebras', 'xai'],
    onBuilder: () => ({ success: true, usedProvider: 'cerebras' }),
    onVerifier: () => ({ success: true, verdict: { passed: true }, usedProvider: 'xai' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderVerifierPlan());
  await sup.executePlan(sup.decomposedTasks, {});
  const verifierCall = captured.find((c) => c.agent === AgentRole.VERIFIER);
  assert.strictEqual(verifierCall.ctx.explicitProvider, 'xai');
  assert.strictEqual(sup.decomposedTasks[1].verifierProviderPick.reason, 'independent-verifier');
});

test('independent verifier ON + only builder provider enabled → no-alternate-provider, no throw', async () => {
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_INDEPENDENT_VERIFIER = '1';
  const { sup, captured } = makeSupervisor({
    availableProviders: ['cerebras'],
    onBuilder: () => ({ success: true, usedProvider: 'cerebras' }),
    onVerifier: () => ({ success: true, verdict: { passed: true }, usedProvider: 'cerebras' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderVerifierPlan());
  await sup.executePlan(sup.decomposedTasks, {});
  const verifierCall = captured.find((c) => c.agent === AgentRole.VERIFIER);
  assert.strictEqual(verifierCall.ctx.explicitProvider, undefined);
  assert.strictEqual(sup.decomposedTasks[1].verifierProviderPick.reason, 'no-alternate-provider');
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 45 escalation checks passed.');
});

runAll();
