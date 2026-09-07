#!/usr/bin/env node

// Phase 47: parallel scheduler for declared-independent fabric tasks.
// Isolated temp LIKU_HOME; no live network (handoffs/runners are faked).

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase47-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const schedulerModule = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'execution-scheduler.js'));
const { createExecutionScheduler, isParallelSchedulerEnabled, readCaps } = schedulerModule;
const { createInProcessExecutionFabric } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'execution-fabric.js'));
const { SupervisorAgent } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
const { AgentRole } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'base-agent.js'));

const FLAG_KEYS = [
  'LIKU_PARALLEL_SCHEDULER', 'LIKU_EXECUTION_FABRIC', 'LIKU_INFERENCE_FABRIC',
  'LIKU_TASK_CONTRACTS', 'LIKU_ESCALATION', 'LIKU_INDEPENDENT_VERIFIER',
  'LIKU_MAX_PARALLEL_TASKS', 'LIKU_MAX_PARALLEL_PER_PROVIDER', 'LIKU_MAX_PARALLEL_PER_ROLE'
];

let failures = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of queue) {
    const saved = {};
    for (const k of FLAG_KEYS) saved[k] = process.env[k];
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      process.exitCode = 1;
      console.error(`FAIL ${name}`);
      console.error(error.stack || error.message);
    } finally {
      for (const k of FLAG_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

// A generic runTask that records start order and gates completion on a release.
function makeRunTask(control = {}) {
  const started = [];
  const runTask = async (task) => {
    started.push(task.id);
    if (control.gates && control.gates[task.id]) {
      await control.gates[task.id];
    }
    const status = control.statusFor ? control.statusFor(task) : 'success';
    return {
      entry: { taskId: task.id, agent: String(task.targetAgent || task.role || 'builder'), success: status === 'success', ...(status !== 'success' ? { blocked: status === 'blocked' } : {}) },
      usedProvider: control.providerFor ? control.providerFor(task) : (task.explicitProvider || null),
      status,
      result: null,
      signal: null,
      rung: null
    };
  };
  return { runTask, started };
}

function tasks(list) {
  return list.map((t) => ({
    id: t.id,
    targetAgent: t.role || 'builder',
    description: t.id,
    dependencies: t.dependencies || [],
    ...(t.serial ? { serial: true } : {}),
    ...(t.explicitProvider ? { explicitProvider: t.explicitProvider } : {})
  }));
}

// ===== scheduler unit =====

test('flag gate + caps parse with sane defaults', () => {
  delete process.env.LIKU_PARALLEL_SCHEDULER;
  assert.strictEqual(isParallelSchedulerEnabled(process.env), false);
  process.env.LIKU_PARALLEL_SCHEDULER = 'on';
  assert.strictEqual(isParallelSchedulerEnabled(process.env), true);
  const caps = readCaps({});
  assert.deepStrictEqual(caps, { maxTasks: 2, maxPerProvider: 1, maxPerRole: 2 });
  assert.deepStrictEqual(
    readCaps({ LIKU_MAX_PARALLEL_TASKS: '5', LIKU_MAX_PARALLEL_PER_PROVIDER: '0', LIKU_MAX_PARALLEL_PER_ROLE: 'x' }),
    { maxTasks: 5, maxPerProvider: 1, maxPerRole: 2 } // 0 and non-int fall back
  );
});

test('two independent tasks run concurrently before either finishes (caps >=2)', async () => {
  const fabric = createInProcessExecutionFabric();
  const gates = { A: deferred(), B: deferred() };
  const { runTask, started } = makeRunTask({ gates: { A: gates.A.promise, B: gates.B.promise } });
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '2', LIKU_MAX_PARALLEL_PER_PROVIDER: '2', LIKU_MAX_PARALLEL_PER_ROLE: '2' }
  });
  const p = scheduler.schedule(tasks([{ id: 'A' }, { id: 'B' }]));
  await tick(); await tick();
  assert.deepStrictEqual([...started].sort(), ['A', 'B'], 'both started before either resolved');
  gates.A.resolve(); gates.B.resolve();
  const results = await p;
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.success));
});

test('dependent task runs only after its dependency succeeds', async () => {
  const fabric = createInProcessExecutionFabric();
  const gates = { A: deferred() };
  const { runTask, started } = makeRunTask({ gates: { A: gates.A.promise } });
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '2', LIKU_MAX_PARALLEL_PER_PROVIDER: '2', LIKU_MAX_PARALLEL_PER_ROLE: '2' }
  });
  const p = scheduler.schedule(tasks([{ id: 'A' }, { id: 'B', dependencies: ['A'] }]));
  await tick(); await tick();
  assert.deepStrictEqual(started, ['A'], 'B must wait for A');
  gates.A.resolve();
  const results = await p;
  assert.deepStrictEqual(started, ['A', 'B']);
  assert.ok(results.find((r) => r.taskId === 'B').success);
});

test('dependency failure skips the dependent with dependency-failed (no run)', async () => {
  const fabric = createInProcessExecutionFabric();
  const { runTask, started } = makeRunTask({ statusFor: (t) => (t.id === 'A' ? 'failure' : 'success') });
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '2', LIKU_MAX_PARALLEL_PER_PROVIDER: '2', LIKU_MAX_PARALLEL_PER_ROLE: '2' }
  });
  const results = await scheduler.schedule(tasks([{ id: 'A' }, { id: 'B', dependencies: ['A'] }]));
  assert.deepStrictEqual(started, ['A'], 'B never runs');
  const b = results.find((r) => r.taskId === 'B');
  assert.strictEqual(b.skipped, true);
  assert.strictEqual(b.reason, 'dependency-failed');
});

test('LIKU_MAX_PARALLEL_TASKS=1 serializes: second stays queued until first completes', async () => {
  const fabric = createInProcessExecutionFabric();
  const gates = { A: deferred() };
  const { runTask, started } = makeRunTask({ gates: { A: gates.A.promise } });
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '1', LIKU_MAX_PARALLEL_PER_PROVIDER: '2', LIKU_MAX_PARALLEL_PER_ROLE: '2' }
  });
  const p = scheduler.schedule(tasks([{ id: 'A' }, { id: 'B' }]));
  await tick(); await tick();
  assert.deepStrictEqual(started, ['A'], 'only one in flight at cap=1');
  gates.A.resolve();
  await p;
  assert.deepStrictEqual(started, ['A', 'B']);
});

test('LIKU_MAX_PARALLEL_PER_PROVIDER=1 + same explicitProvider serializes', async () => {
  const fabric = createInProcessExecutionFabric();
  const gates = { A: deferred() };
  const { runTask, started } = makeRunTask({ gates: { A: gates.A.promise } });
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '4', LIKU_MAX_PARALLEL_PER_PROVIDER: '1', LIKU_MAX_PARALLEL_PER_ROLE: '4' }
  });
  const p = scheduler.schedule(tasks([
    { id: 'A', explicitProvider: 'copilot' },
    { id: 'B', explicitProvider: 'copilot' }
  ]));
  await tick(); await tick();
  assert.deepStrictEqual(started, ['A'], 'same provider serialized under per-provider cap 1');
  gates.A.resolve();
  await p;
  assert.deepStrictEqual(started, ['A', 'B']);
});

test('cancel a queued sibling while another runs: cancelled sibling never runs', async () => {
  const fabric = createInProcessExecutionFabric();
  const gates = { A: deferred() };
  const { runTask, started } = makeRunTask({ gates: { A: gates.A.promise } });
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '1', LIKU_MAX_PARALLEL_PER_PROVIDER: '2', LIKU_MAX_PARALLEL_PER_ROLE: '2' }
  });
  const plan = tasks([{ id: 'A' }, { id: 'B' }]);
  const p = scheduler.schedule(plan);
  await tick(); await tick();
  assert.deepStrictEqual(started, ['A'], 'A running, B queued at cap=1');
  plan[1]._cancelRequested = true; // Phase 44 pre-dispatch cancel of the queued sibling
  gates.A.resolve();
  const results = await p;
  assert.deepStrictEqual(started, ['A'], 'B never ran after cancel');
  const b = results.find((r) => r.taskId === 'B');
  assert.strictEqual(b.cancelled, true);
  assert.strictEqual(b.skipped, true);
});

test('serial:true task never overlaps other tasks', async () => {
  const fabric = createInProcessExecutionFabric();
  const gates = { S: deferred(), A: deferred() };
  let maxConcurrent = 0;
  let live = 0;
  const runTask = async (task) => {
    live += 1; maxConcurrent = Math.max(maxConcurrent, live);
    if (gates[task.id]) await gates[task.id].promise;
    live -= 1;
    return { entry: { taskId: task.id, agent: 'builder', success: true }, usedProvider: null, status: 'success', result: null, signal: null, rung: null };
  };
  const scheduler = createExecutionScheduler({
    fabric, runTask,
    env: { LIKU_MAX_PARALLEL_TASKS: '4', LIKU_MAX_PARALLEL_PER_PROVIDER: '4', LIKU_MAX_PARALLEL_PER_ROLE: '4' }
  });
  const p = scheduler.schedule(tasks([{ id: 'S', serial: true }, { id: 'A' }]));
  await tick(); await tick();
  gates.S.resolve();
  await tick(); await tick();
  gates.A.resolve();
  await p;
  assert.strictEqual(maxConcurrent, 1, 'serial task ran alone');
});

// ===== supervisor integration =====

function makeSupervisor({ availableProviders = ['copilot'], onBuilder, onVerifier } = {}) {
  const captured = [];
  const sup = new SupervisorAgent({});
  sup.aiService = { getStatus: () => ({ availableProviders }) };
  sup.handoffToBuilder = async (ctx, message) => {
    captured.push({ agent: 'builder', ctx, message });
    return onBuilder ? onBuilder(captured.length - 1, ctx) : { success: true, usedProvider: 'copilot' };
  };
  sup.handoffToVerifier = async (ctx, message) => {
    captured.push({ agent: 'verifier', ctx, message });
    return onVerifier ? onVerifier(captured.length - 1, ctx) : { success: true, verdict: { passed: true }, usedProvider: 'copilot' };
  };
  return { sup, captured };
}

test('flags off: executePlan stays sequential (Phase 46 byte-compatible, no scheduler)', async () => {
  delete process.env.LIKU_PARALLEL_SCHEDULER;
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  const { sup, captured } = makeSupervisor();
  const plan = { planId: 'p1', steps: [
    { description: 'build', agent: AgentRole.BUILDER },
    { description: 'verify', agent: AgentRole.VERIFIER }
  ] };
  sup.decomposedTasks = await sup.decomposeTasks(plan);
  // default chain: verifier depends on builder
  assert.deepStrictEqual(sup.decomposedTasks[1].dependencies, ['subtask-1']);
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(results.length, 2);
  assert.strictEqual(captured.length, 2);
  assert.ok(results.every((r) => r.success));
});

test('flags on: independent builders dispatch in parallel via the scheduler', async () => {
  process.env.LIKU_PARALLEL_SCHEDULER = '1';
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_MAX_PARALLEL_TASKS = '2';
  process.env.LIKU_MAX_PARALLEL_PER_PROVIDER = '2';
  process.env.LIKU_MAX_PARALLEL_PER_ROLE = '2';
  const gates = [deferred(), deferred()];
  let inflight = 0; let maxInflight = 0;
  const { sup } = makeSupervisor({
    onBuilder: async (idx) => {
      inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      await gates[idx].promise;
      inflight -= 1;
      return { success: true, usedProvider: 'copilot' };
    }
  });
  const plan = { planId: 'p1', steps: [
    { description: 'b1', agent: AgentRole.BUILDER, independent: true },
    { description: 'b2', agent: AgentRole.BUILDER, independent: true }
  ] };
  sup.decomposedTasks = await sup.decomposeTasks(plan);
  assert.deepStrictEqual(sup.decomposedTasks[1].dependencies, [], 'declared independent → no chain');
  const p = sup.executePlan(sup.decomposedTasks, {});
  await tick(); await tick(); await tick();
  assert.strictEqual(maxInflight, 2, 'both builders in flight together');
  gates[0].resolve(); gates[1].resolve();
  const results = await p;
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.taskResult.status === 'success'));
});

test('shared budget ledger: second parallel call is blocked, no retry past policy', async () => {
  process.env.LIKU_PARALLEL_SCHEDULER = '1';
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  process.env.LIKU_MAX_PARALLEL_TASKS = '2';
  process.env.LIKU_MAX_PARALLEL_PER_PROVIDER = '2';
  process.env.LIKU_MAX_PARALLEL_PER_ROLE = '2';
  // One shared "governor" ledger both parallel builder calls consult.
  let budgetRemaining = 1;
  const { sup, captured } = makeSupervisor({
    onBuilder: async () => {
      if (budgetRemaining > 0) {
        budgetRemaining -= 1;
        return { success: true, usedProvider: 'copilot' };
      }
      return { success: false, error: 'inference budget exceeded', budget: { exceeded: true, reason: 'BUDGET_EXCEEDED' }, usedProvider: 'copilot' };
    }
  });
  const plan = { planId: 'p1', steps: [
    { description: 'b1', agent: AgentRole.BUILDER, independent: true },
    { description: 'b2', agent: AgentRole.BUILDER, independent: true }
  ] };
  sup.decomposedTasks = await sup.decomposeTasks(plan);
  const results = await sup.executePlan(sup.decomposedTasks, {});
  const successes = results.filter((r) => r.taskResult && r.taskResult.status === 'success');
  const blocked = results.filter((r) => r.taskResult && r.taskResult.status === 'blocked');
  assert.strictEqual(successes.length, 1, 'only one call fit the budget');
  assert.strictEqual(blocked.length, 1, 'the other is blocked, not retried');
  assert.strictEqual(captured.length, 2, 'no third HTTPS call — budget-exceeded never auto-retries');
});

test('escalation stays sequential inside one taskId (rungs not parallelized)', async () => {
  process.env.LIKU_PARALLEL_SCHEDULER = '1';
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  let call = 0;
  const { sup, captured } = makeSupervisor({
    onBuilder: async () => {
      call += 1;
      // first attempt fails tests, retry succeeds — both within one submitted taskId
      return call === 1
        ? { success: false, error: 'unit tests failed: 1 failing', usedProvider: 'copilot' }
        : { success: true, usedProvider: 'copilot' };
    }
  });
  const fabricSubmitIds = [];
  const plan = { planId: 'p1', steps: [{ description: 'b1', agent: AgentRole.BUILDER, independent: true }] };
  sup.decomposedTasks = await sup.decomposeTasks(plan);
  // spy on fabric.submit to prove one dispatch per taskId even with a retry
  const fabric = sup.getExecutionFabric();
  const origSubmit = fabric.submit.bind(fabric);
  fabric.submit = (input) => { fabricSubmitIds.push(input.taskId); return origSubmit(input); };
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 2, 'initial + one retry ran');
  assert.deepStrictEqual(fabricSubmitIds, ['subtask-1'], 'exactly one fabric dispatch for the taskId');
  assert.strictEqual(results[0].taskResult.status, 'success');
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 47 parallel scheduler checks passed.');
});

runAll();
