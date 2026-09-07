#!/usr/bin/env node

// Phase 46: in-process Execution Fabric abstraction.
// Isolated temp LIKU_HOME; no live network (handoffs/runners are faked).

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase46-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const fabricModule = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'execution-fabric.js'));
const { createInProcessExecutionFabric, isExecutionFabricEnabled, FABRIC_EVENTS } = fabricModule;
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
      for (const k of ['LIKU_INFERENCE_FABRIC', 'LIKU_TASK_CONTRACTS', 'LIKU_ESCALATION', 'LIKU_INDEPENDENT_VERIFIER', 'LIKU_EXECUTION_FABRIC']) {
        delete process.env[k];
        if (saved[k] !== undefined) process.env[k] = saved[k];
      }
    }
  }
}

// ===== fabric unit =====

test('flag gate: isExecutionFabricEnabled reflects LIKU_EXECUTION_FABRIC', () => {
  delete process.env.LIKU_EXECUTION_FABRIC;
  assert.strictEqual(isExecutionFabricEnabled(process.env), false);
  process.env.LIKU_EXECUTION_FABRIC = '1';
  assert.strictEqual(isExecutionFabricEnabled(process.env), true);
});

test('submit runs the task and emits queued → started → terminal', async () => {
  const fabric = createInProcessExecutionFabric();
  const events = [];
  for (const e of FABRIC_EVENTS) fabric.on(e, (p) => events.push({ e, state: p.state }));
  const { taskId, done } = fabric.submit({
    taskId: 'subtask-1', role: 'builder',
    contract: { kind: 'task-contract', role: 'builder', cancellation: { requested: false } },
    run: async () => ({ status: 'success', result: { kind: 'task-result', status: 'success', files: ['a.js'] } })
  });
  await done;
  assert.strictEqual(fabric.get(taskId).state, 'succeeded');
  assert.deepStrictEqual(events.map((x) => x.e), ['task.queued', 'task.started', 'task.completed']);
});

test('failed mock maps to failed state', async () => {
  const fabric = createInProcessExecutionFabric();
  const { taskId, done } = fabric.submit({ taskId: 't-fail', role: 'builder', run: async () => ({ status: 'failure' }) });
  await done;
  assert.strictEqual(fabric.get(taskId).state, 'failed');
});

test('cancel on a queued task → cancelled, run never called', async () => {
  const fabric = createInProcessExecutionFabric();
  let ran = false;
  const cancelledEvents = [];
  fabric.on('task.cancelled', (p) => cancelledEvents.push(p));
  const { taskId, done } = fabric.submit({ taskId: 't-cancel', role: 'builder', run: async () => { ran = true; return { status: 'success' }; } });
  const cancelled = fabric.cancel(taskId); // synchronous, before the deferred run
  assert.strictEqual(cancelled, true);
  await done;
  assert.strictEqual(ran, false, 'handoff/run must not be called');
  assert.strictEqual(fabric.get(taskId).state, 'cancelled');
  assert.strictEqual(cancelledEvents.length, 1);
});

test('cancel after started → false, in-flight run still completes', async () => {
  const fabric = createInProcessExecutionFabric();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { taskId, done } = fabric.submit({ taskId: 't-running', role: 'builder', run: async () => { await gate; return { status: 'success' }; } });
  await Promise.resolve(); // let the deferred run start (state → running)
  assert.strictEqual(fabric.get(taskId).state, 'running');
  assert.strictEqual(fabric.cancel(taskId), false, 'cannot cancel a running task');
  release();
  await done;
  assert.strictEqual(fabric.get(taskId).state, 'succeeded');
});

test('list() is capped at 20 and snapshots carry no raw transcript', async () => {
  const fabric = createInProcessExecutionFabric();
  const dones = [];
  for (let i = 0; i < 25; i++) {
    dones.push(fabric.submit({
      taskId: `t-${i}`, role: 'builder',
      run: async () => ({ status: 'success', result: { kind: 'task-result', status: 'success', findings: ['ok'], text: 'SECRET TRANSCRIPT', rationale: 'SECRET' } })
    }).done);
  }
  await Promise.all(dones);
  const list = fabric.list();
  assert.ok(list.length <= 20, `list capped, got ${list.length}`);
  const serialized = JSON.stringify(list);
  assert.ok(!/SECRET/.test(serialized), 'no transcript/rationale leaks into snapshots');
  assert.ok(list.every((s) => !s.result || s.result.text === undefined));
});

// ===== supervisor integration =====

function makeSupervisor({ availableProviders = ['copilot'], onBuilder } = {}) {
  const captured = [];
  const sup = new SupervisorAgent({});
  sup.aiService = { getStatus: () => ({ availableProviders }) };
  sup.handoffToBuilder = async (ctx, message) => {
    captured.push({ agent: AgentRole.BUILDER, ctx, message });
    return onBuilder ? onBuilder(captured.length - 1) : { success: true, usedProvider: 'copilot' };
  };
  sup.handoffToVerifier = async () => ({ success: true, verdict: { passed: true }, usedProvider: 'copilot' });
  return { sup, captured };
}

function builderPlan() {
  return { planId: 'p1', steps: [{ description: 'Implement foo', agent: AgentRole.BUILDER, status: 'pending' }] };
}

test('flag off: Supervisor never constructs a fabric', async () => {
  delete process.env.LIKU_EXECUTION_FABRIC;
  const { sup } = makeSupervisor();
  assert.strictEqual(sup.getExecutionFabric(), null);
});

test('flag on: executePlan dispatches through the fabric and list() sees the task', async () => {
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  const { sup, captured } = makeSupervisor({ onBuilder: () => ({ success: true, filesModified: ['a.js'], usedProvider: 'copilot' }) });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 1, 'handoff ran once via the fabric');
  assert.strictEqual(results[0].taskResult.status, 'success');
  const fabric = sup.getExecutionFabric();
  const snap = fabric.get('subtask-1');
  assert.ok(snap, 'fabric recorded the subtask');
  assert.strictEqual(snap.state, 'succeeded');
});

test('flag on + escalation on: tests-failed still retries once through the fabric', async () => {
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_INFERENCE_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_ESCALATION = '1';
  const { sup, captured } = makeSupervisor({
    availableProviders: ['copilot'],
    onBuilder: () => ({ success: false, error: 'unit tests failed: 1 failing', usedProvider: 'copilot' })
  });
  sup.decomposedTasks = await sup.decomposeTasks(builderPlan());
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured.length, 2, 'initial + one retry still happens under the fabric');
  assert.strictEqual(results[0].taskResult.status, 'blocked');
  assert.strictEqual(sup.getExecutionFabric().get('subtask-1').state, 'blocked');
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 46 execution fabric checks passed.');
});

runAll();
