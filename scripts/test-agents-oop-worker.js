#!/usr/bin/env node

// Out-of-process execution lab. Not QUIC. Flag off = no fork.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const oop = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'oop-worker.js'));
const { SupervisorAgent } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
const { AgentRole } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'base-agent.js'));
const { createTransportManager } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-fabric.js'));

const FLAG_KEYS = ['LIKU_OOP_WORKER', 'LIKU_EXECUTION_FABRIC', 'LIKU_QUIC_WORKER_LAB'];

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

function childPidsOf(pid) {
  if (process.platform !== 'linux') return null;
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const ppid = Number((status.match(/^PPid:\s+(\d+)/m) || [])[1]);
      if (ppid === pid) found.push(Number(name));
    } catch { /* raced */ }
  }
  return found;
}

test('flag default off and select(http3) still throws', () => {
  delete process.env.LIKU_OOP_WORKER;
  delete process.env.LIKU_QUIC_WORKER_LAB;
  assert.strictEqual(oop.isOopWorkerEnabled(), false);
  assert.throws(
    () => createTransportManager().select({ kind: 'http3' }),
    (err) => err && err.code === 'unsupported-transport'
  );
  assert.throws(
    () => createTransportManager().select({ kind: 'quic' }),
    (err) => err && err.code === 'unsupported-transport'
  );
});

test('flag off: runIsolated throws before fork', async () => {
  delete process.env.LIKU_OOP_WORKER;
  const before = childPidsOf(process.pid);
  await assert.rejects(
    () => oop.runIsolated({ op: 'identity', taskId: 'off' }),
    (err) => err && err.code === 'oop-worker-disabled'
  );
  const after = childPidsOf(process.pid);
  if (before && after) {
    assert.deepStrictEqual(after.filter((pid) => !before.includes(pid)), []);
  }
});

test('vendor host and secret field are rejected before fork', async () => {
  process.env.LIKU_OOP_WORKER = '1';
  const before = childPidsOf(process.pid);
  await assert.rejects(
    () => oop.runIsolated({ op: 'ping', taskId: 'v', payload: { url: 'https://api.openai.com/v1/chat' } }),
    (err) => err && err.code === 'oop-vendor-forbidden'
  );
  await assert.rejects(
    () => oop.runIsolated({ op: 'ping', taskId: 's', payload: { apiKey: 'sk-test' } }),
    (err) => err && err.code === 'oop-secret-forbidden'
  );
  await assert.rejects(
    () => oop.runIsolated({ op: 'eval', taskId: 'e' }),
    (err) => err && err.code === 'oop-op-forbidden'
  );
  const after = childPidsOf(process.pid);
  if (before && after) {
    assert.deepStrictEqual(after.filter((pid) => !before.includes(pid)), []);
  }
});

test('identity runs in a different process and does not inherit a sentinel', async () => {
  process.env.LIKU_OOP_WORKER = '1';
  process.env.LIKU_PROOF_SENTINEL = 'sentinel-do-not-leak';
  const handle = await oop.spawnWorker();
  try {
    assert.notStrictEqual(handle.pid, process.pid);
    if (process.platform === 'linux') {
      const status = fs.readFileSync(`/proc/${handle.pid}/status`, 'utf8');
      const ppid = Number((status.match(/^PPid:\s+(\d+)/m) || [])[1]);
      assert.strictEqual(ppid, process.pid);
      const environ = fs.readFileSync(`/proc/${handle.pid}/environ`);
      assert.ok(!environ.includes(Buffer.from('sentinel-do-not-leak')));
      assert.ok(!environ.includes(Buffer.from('OPENAI_API_KEY')));
    }
    const result = await handle.invoke({ op: 'identity', taskId: 'id-1' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pid, handle.pid);
    assert.strictEqual(result.ppid, process.pid);
  } finally {
    delete process.env.LIKU_PROOF_SENTINEL;
    await handle.close();
  }
});

test('sleep cancel stops the child', async () => {
  process.env.LIKU_OOP_WORKER = '1';
  const handle = await oop.spawnWorker();
  try {
    const pending = handle.invoke({ op: 'sleep', taskId: 'sleep-1', payload: { ms: 2500 } });
    await new Promise((r) => setTimeout(r, 50));
    handle.cancel('sleep-1');
    const result = await pending;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'cancelled');
  } finally {
    await handle.close();
  }
});

test('child failure does not crash the parent', async () => {
  process.env.LIKU_OOP_WORKER = '1';
  const result = await oop.runIsolated({ op: 'fail', taskId: 'fail-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'oop-child-failed');
  assert.ok(process.pid > 0);
});

test('flag off: Supervisor require graph does not load the worker', () => {
  delete process.env.LIKU_OOP_WORKER;
  const workerId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'oop-worker.js'));
  const supervisorId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
  const loaded = [];
  const seen = new Set();
  function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = require.cache[id];
    if (!entry) return;
    for (const child of entry.children || []) {
      loaded.push(child.id);
      walk(child.id);
    }
  }
  walk(supervisorId);
  assert.ok(!loaded.includes(workerId));
});

test('planner cannot smuggle oop; flag off ignores a caller oop field', async () => {
  delete process.env.LIKU_OOP_WORKER;
  const sup = new SupervisorAgent({});
  let handoffs = 0;
  sup.handoffToBuilder = async () => {
    handoffs += 1;
    return { success: true, usedProvider: 'copilot' };
  };
  const steps = sup.parseSteps([
    { description: 'implement A', agent: 'builder', independent: true, oop: { op: 'identity' } }
  ]);
  assert.strictEqual(steps[0].oop, undefined);
  const out = await sup._runCoding(
    { id: 't1', description: 'implement A', oop: { op: 'identity' } },
    AgentRole.BUILDER,
    'Implement: A',
    {},
    {}
  );
  assert.strictEqual(handoffs, 1);
  assert.strictEqual(out.entry.oop, undefined);
});

test('flag on: declared task.oop skips the model handoff', async () => {
  process.env.LIKU_OOP_WORKER = '1';
  delete process.env.LIKU_EXECUTION_FABRIC;
  const sup = new SupervisorAgent({});
  let handoffs = 0;
  sup.handoffToBuilder = async () => {
    handoffs += 1;
    return { success: true, usedProvider: 'copilot' };
  };
  const out = await sup._runCoding(
    { id: 't-oop', description: 'implement A in parallel', oop: { op: 'identity' } },
    AgentRole.BUILDER,
    'Implement: A',
    {},
    {}
  );
  assert.strictEqual(handoffs, 0);
  assert.strictEqual(out.entry.success, true);
  assert.notStrictEqual(out.entry.oop.pid, process.pid);
  assert.strictEqual(out.entry.oop.ppid, process.pid);
  assert.strictEqual(out.usedProvider, null);
});

process.on('exit', () => {
  if (failures === 0) console.log('\nAll out-of-process worker checks passed.');
});

runAll();
