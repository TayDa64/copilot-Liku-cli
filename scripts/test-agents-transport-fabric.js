#!/usr/bin/env node

// Phase 48: transport fabric interface + in-process / HTTPS-provider adapters.
// Isolated temp LIKU_HOME; NO real network (https adapter is an injected stub).

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase48-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const transport = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-fabric.js'));
const { createTransportManager, isTransportFabricEnabled, IMPLEMENTED_KINDS, RESERVED_KINDS } = transport;
const { SupervisorAgent } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
const { AgentRole } = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'base-agent.js'));

const FLAG_KEYS = [
  'LIKU_TRANSPORT_FABRIC', 'LIKU_PARALLEL_SCHEDULER', 'LIKU_EXECUTION_FABRIC',
  'LIKU_TASK_CONTRACTS', 'LIKU_MAX_PARALLEL_TASKS', 'LIKU_MAX_PARALLEL_PER_PROVIDER', 'LIKU_MAX_PARALLEL_PER_ROLE'
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

const tick = () => new Promise((r) => setImmediate(r));

// ===== transport module unit =====

test('flag gate + kind inventory', () => {
  delete process.env.LIKU_TRANSPORT_FABRIC;
  assert.strictEqual(isTransportFabricEnabled(process.env), false);
  process.env.LIKU_TRANSPORT_FABRIC = '1';
  assert.strictEqual(isTransportFabricEnabled(process.env), true);
  const mgr = createTransportManager({});
  assert.deepStrictEqual(mgr.listKinds(), ['inprocess', 'https-provider']);
  assert.strictEqual(mgr.isSupported('inprocess'), true);
  assert.strictEqual(mgr.isSupported('https-provider'), true);
  for (const reserved of RESERVED_KINDS) assert.strictEqual(mgr.isSupported(reserved), false);
});

test('select() default kind is inprocess and invoke hits the injected fn once', async () => {
  let calls = 0;
  let seen = null;
  const mgr = createTransportManager({ invokeInProcess: async (payload) => { calls += 1; seen = payload; return { ok: true }; } });
  const handle = mgr.select();
  assert.strictEqual(handle.kind, 'inprocess');
  const out = await handle.invoke({ task: { id: 't1' } });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(calls, 1);
  assert.strictEqual(seen.task.id, 't1');
});

test('kind https-provider hits the injected HTTPS fn for inference payloads (no real network)', async () => {
  let httpsCalls = 0;
  let inProcessCalls = 0;
  const seen = [];
  const mgr = createTransportManager({
    invokeInProcess: async () => { inProcessCalls += 1; return {}; },
    invokeHttpsProvider: async (payload) => { httpsCalls += 1; seen.push(payload); return { response: 'ok' }; }
  });
  const handle = mgr.select({ kind: 'https-provider' });
  assert.strictEqual(handle.kind, 'https-provider');
  const out = await handle.invoke({ messages: [{ role: 'user', content: 'hi' }], provider: 'xai', model: 'grok' });
  assert.deepStrictEqual(out, { response: 'ok' });
  assert.strictEqual(httpsCalls, 1);
  assert.strictEqual(inProcessCalls, 0, 'inprocess path untouched');
});

test('https-provider refuses non-inference payloads (no generic POST escape hatch)', async () => {
  let httpsCalls = 0;
  const mgr = createTransportManager({ invokeHttpsProvider: async () => { httpsCalls += 1; return {}; } });
  const handle = mgr.select({ kind: 'https-provider' });
  await assert.rejects(() => handle.invoke({ url: 'https://api.x.ai', body: 'anything' }), /inference-shaped/);
  assert.strictEqual(httpsCalls, 0, 'injected HTTPS fn never called for non-inference payload');
});

test('reserved kinds fail closed with unsupported-transport and never connect', async () => {
  let anyCall = 0;
  const mgr = createTransportManager({
    invokeInProcess: async () => { anyCall += 1; },
    invokeHttpsProvider: async () => { anyCall += 1; }
  });
  for (const reserved of ['http2', 'http3', 'quic', 'ipc', 'bogus']) {
    assert.throws(() => mgr.select({ kind: reserved }), (err) => err && err.code === 'unsupported-transport', `expected ${reserved} to fail closed`);
  }
  assert.strictEqual(anyCall, 0, 'no adapter invoked while selecting a reserved/unknown kind');
});

test('manager never forwards an API key from caps around policy', async () => {
  const seen = [];
  const mgr = createTransportManager({ invokeHttpsProvider: async (payload) => { seen.push(payload); return {}; } });
  const handle = mgr.select({ kind: 'https-provider', caps: { apiKey: 'SECRET-KEY', endpoint: 'https://evil.example' } });
  await handle.invoke({ messages: [{ role: 'user', content: 'hi' }], provider: 'xai', model: 'grok' });
  const serialized = JSON.stringify(seen);
  assert.ok(!/SECRET-KEY/.test(serialized), 'caps.apiKey must never reach the injected path');
  assert.ok(!/evil\.example/.test(serialized), 'caps endpoint must never reach the injected path');
});

// ===== supervisor integration =====

function makeSupervisor({ onBuilder } = {}) {
  const captured = [];
  const sup = new SupervisorAgent({});
  sup.aiService = { getStatus: () => ({ availableProviders: ['copilot'] }) };
  sup.handoffToBuilder = async (ctx, message) => {
    captured.push({ agent: 'builder', ctx, message });
    return onBuilder ? onBuilder(captured.length - 1) : { success: true, usedProvider: 'copilot' };
  };
  sup.handoffToVerifier = async () => ({ success: true, verdict: { passed: true }, usedProvider: 'copilot' });
  return { sup, captured };
}

test('flag off: Supervisor constructs no transport manager (Phase 47 byte-compatible)', async () => {
  delete process.env.LIKU_TRANSPORT_FABRIC;
  const { sup } = makeSupervisor();
  assert.strictEqual(sup._getTransportManager(), null);
  assert.strictEqual(sup._transportManager, undefined);
});

test('flags on: scheduler routes the in-process handoff through the transport manager', async () => {
  process.env.LIKU_TRANSPORT_FABRIC = '1';
  process.env.LIKU_PARALLEL_SCHEDULER = '1';
  process.env.LIKU_EXECUTION_FABRIC = '1';
  process.env.LIKU_TASK_CONTRACTS = '1';
  process.env.LIKU_MAX_PARALLEL_TASKS = '2';
  process.env.LIKU_MAX_PARALLEL_PER_PROVIDER = '2';
  process.env.LIKU_MAX_PARALLEL_PER_ROLE = '2';
  const { sup, captured } = makeSupervisor();
  const plan = { planId: 'p1', steps: [
    { description: 'b1', agent: AgentRole.BUILDER, independent: true },
    { description: 'b2', agent: AgentRole.BUILDER, independent: true }
  ] };
  sup.decomposedTasks = await sup.decomposeTasks(plan);
  const results = await sup.executePlan(sup.decomposedTasks, {});
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.taskResult.status === 'success'));
  assert.strictEqual(captured.length, 2, 'each task ran once through the inprocess transport');
  assert.ok(sup._transportManager, 'transport manager was lazily constructed when the flag is on');
  assert.strictEqual(sup._getTransportManager().select().kind, 'inprocess');
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 48 transport fabric checks passed.');
});

runAll();
