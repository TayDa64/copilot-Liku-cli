#!/usr/bin/env node

// Phase 44: TaskContract + compressed worker reports.
// Isolated temp LIKU_HOME so persistence tests never touch the real home.

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase44-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const tc = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'task-contract.js'));
const contractStore = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'task-contract-store.js'));
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
      // Restore flag env between tests.
      delete process.env.LIKU_TASK_CONTRACTS;
      delete process.env.LIKU_PERSIST_TASK_CONTRACTS;
      if (saved.LIKU_TASK_CONTRACTS !== undefined) process.env.LIKU_TASK_CONTRACTS = saved.LIKU_TASK_CONTRACTS;
      if (saved.LIKU_PERSIST_TASK_CONTRACTS !== undefined) process.env.LIKU_PERSIST_TASK_CONTRACTS = saved.LIKU_PERSIST_TASK_CONTRACTS;
    }
  }
}

function makeSupervisor(captured) {
  const sup = new SupervisorAgent({});
  sup.orchestrator = {
    executeHandoff: async (_fromAgent, targetRole, context, message) => {
      captured.push({ targetRole, context, message });
      if (targetRole === AgentRole.BUILDER) {
        return {
          success: true,
          filesModified: ['src/a.js'],
          proofs: [{ name: 'lint', passed: true }, { name: 'unit', passed: true }],
          rationale: '1. Changed foo in a.js\n2. Added bar helper\n3. Verified locally',
          suggestedNext: 'verify'
        };
      }
      return {
        success: true,
        verdict: { passed: true },
        results: [{ phase: 'lint' }, { phase: 'build' }],
        suggestions: ['Looks correct'],
        suggestedNext: 'complete'
      };
    }
  };
  return sup;
}

function buildPlan() {
  return {
    planId: 'plan-xyz',
    steps: [
      { description: 'Implement foo in src/a.js', agent: AgentRole.BUILDER, status: 'pending' },
      { description: 'Verify foo behavior', agent: AgentRole.VERIFIER, status: 'pending' }
    ]
  };
}

// ===== factory caps =====

test('createTaskContract truncates text and caps lists/paths', () => {
  const c = tc.createTaskContract({
    taskId: 'subtask-1',
    role: 'builder',
    objective: 'x'.repeat(1000),
    scope: Array.from({ length: 40 }, (_, i) => `path/${i}/` + 'y'.repeat(400)),
    constraints: Array.from({ length: 30 }, (_, i) => 'c'.repeat(400) + i),
    verification: 'diff-review',
    risk: 'high'
  });
  assert.strictEqual(c.objective.length, 400);
  assert.ok(c.scope.length <= 16);
  assert.ok(c.scope.every((p) => p.length <= 240));
  assert.ok(c.constraints.length <= 8);
  assert.ok(c.constraints.every((p) => p.length <= 240));
  assert.strictEqual(c.verification, 'diff-review');
  assert.strictEqual(c.risk, 'high');
  assert.deepStrictEqual(c.cancellation, { requested: false });
});

test('createTaskContract serializes under 4 KiB even with oversized input', () => {
  const c = tc.createTaskContract({
    taskId: 't',
    role: 'builder',
    objective: 'o'.repeat(1000),
    scope: Array.from({ length: 100 }, () => 'p'.repeat(400)),
    forbidden: Array.from({ length: 100 }, () => 'f'.repeat(400)),
    constraints: Array.from({ length: 100 }, () => 'c'.repeat(400)),
    successCriteria: Array.from({ length: 100 }, () => 's'.repeat(400))
  });
  assert.ok(Buffer.byteLength(JSON.stringify(c), 'utf8') <= 4096);
});

test('createTaskResult caps fields and rejects invalid status', () => {
  const r = tc.createTaskResult({
    taskId: 'subtask-1',
    status: 'not-a-status',
    findings: Array.from({ length: 30 }, (_, i) => 'finding ' + 'z'.repeat(400) + i),
    files: Array.from({ length: 40 }, (_, i) => `f${i}.js`),
    evidence: ['test-a', 'test-b'],
    recommendation: 'r'.repeat(1000),
    confidence: 5
  });
  assert.strictEqual(r.status, 'failure');
  assert.ok(r.findings.length <= 8);
  assert.ok(r.findings.every((f) => f.length <= 240));
  assert.ok(r.files.length <= 16);
  assert.strictEqual(r.recommendation.length, 400);
  assert.strictEqual(r.confidence, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 4096);
});

// ===== extractor =====

test('taskResultFromWorkerReturn compresses prose into bounded findings, no raw text', () => {
  const workerReturn = {
    success: true,
    filesModified: ['src/a.js'],
    proofs: [{ name: 'lint', passed: true }],
    rationale: '1. Did the thing\n2. Did another thing\n' + 'noise '.repeat(5000),
    suggestedNext: 'verify'
  };
  const r = tc.taskResultFromWorkerReturn('subtask-1', 'builder', workerReturn);
  assert.strictEqual(r.kind, 'task-result');
  assert.strictEqual(r.status, 'success');
  assert.deepStrictEqual(r.files, ['src/a.js']);
  assert.ok(r.findings.length >= 1 && r.findings.length <= 8);
  assert.strictEqual(r.recommendation, 'next:verify');
  // no raw transcript leaks through
  assert.ok(!JSON.stringify(r).includes('noise noise'));
  assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 4096);
});

// ===== supervisor flag OFF (byte-compat) =====

test('flag off: handoff strings unchanged and no contract attached', async () => {
  delete process.env.LIKU_TASK_CONTRACTS;
  const captured = [];
  const sup = makeSupervisor(captured);
  sup.decomposedTasks = await sup.decomposeTasks(buildPlan());
  assert.strictEqual(sup.decomposedTasks[0].contract, undefined);
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(captured[0].message, 'Implement: Implement foo in src/a.js');
  assert.ok(captured[1].message.startsWith('Verify:'));
  // raw worker fields preserved on the aggregate (Phase 43 shape)
  assert.ok('rationale' in results[0]);
  assert.strictEqual(results[0].taskResult, undefined);
  assert.strictEqual(captured[0].context.contract, undefined);
});

// ===== supervisor flag ON =====

test('flag on: contract.role matches targetAgent and handoff carries a small contract', async () => {
  process.env.LIKU_TASK_CONTRACTS = '1';
  const captured = [];
  const sup = makeSupervisor(captured);
  sup.decomposedTasks = await sup.decomposeTasks(buildPlan());
  assert.strictEqual(sup.decomposedTasks[0].contract.role, AgentRole.BUILDER);
  assert.strictEqual(sup.decomposedTasks[1].contract.role, AgentRole.VERIFIER);
  assert.strictEqual(sup.decomposedTasks[0].contract.parentTaskId, 'plan-xyz');

  const results = await sup.executePlan(sup.decomposedTasks, {});
  // handoff payload is the small contract, not a multi-page prompt
  assert.ok(captured[0].context.contract);
  assert.ok(Buffer.byteLength(JSON.stringify(captured[0].context.contract), 'utf8') <= 4096);
  assert.ok(captured[0].message.length < 200);
  // aggregate carries a compressed TaskResult, not raw rationale/diffs
  assert.strictEqual(results[0].taskResult.kind, 'task-result');
  assert.strictEqual(results[0].rationale, undefined);
  assert.strictEqual(results[0].diffs, undefined);
  assert.ok(results[0].taskResult.files.includes('src/a.js'));
  assert.strictEqual(results[1].taskResult.status, 'success');
});

test('flag on: requestCancel skips the next handoff', async () => {
  process.env.LIKU_TASK_CONTRACTS = '1';
  const captured = [];
  const sup = makeSupervisor(captured);
  sup.decomposedTasks = await sup.decomposeTasks(buildPlan());
  assert.strictEqual(sup.requestCancel('subtask-2'), true);
  const results = await sup.executePlan(sup.decomposedTasks, {});
  // only the builder handoff happened; verifier was cancelled before dispatch
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].targetRole, AgentRole.BUILDER);
  const verifierResult = results.find((r) => r.taskId === 'subtask-2');
  assert.strictEqual(verifierResult.skipped, true);
  assert.strictEqual(verifierResult.cancelled, true);
});

// ===== persistence (separate store, flag-gated) =====

test('persist store: off by default writes no file', () => {
  delete process.env.LIKU_PERSIST_TASK_CONTRACTS;
  assert.strictEqual(contractStore.enabled(), false);
  assert.strictEqual(contractStore.save([{ taskId: 't', contract: tc.createTaskContract({ taskId: 't', role: 'builder' }) }]), false);
  assert.strictEqual(fs.existsSync(contractStore.STORE_FILE), false);
});

test('persist store: on writes a bounded, separate file (not supervisor-tasks.json)', () => {
  process.env.LIKU_PERSIST_TASK_CONTRACTS = '1';
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    taskId: `subtask-${i}`,
    status: 'completed',
    contract: tc.createTaskContract({ taskId: `subtask-${i}`, role: 'builder', objective: 'do thing' })
  }));
  assert.strictEqual(contractStore.save(tasks), true);
  assert.ok(contractStore.STORE_FILE.endsWith('task-contracts.json'));
  assert.ok(!contractStore.STORE_FILE.endsWith('supervisor-tasks.json'));
  const loaded = contractStore.load();
  assert.ok(loaded.tasks.length <= 20);
  assert.ok(loaded.tasks.every((t) => t.contract && t.contract.kind === 'task-contract'));
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 44 TaskContract checks passed.');
});

runAll();
