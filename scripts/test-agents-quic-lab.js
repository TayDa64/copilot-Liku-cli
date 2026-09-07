#!/usr/bin/env node

// Phase 50: QUIC worker lab (loopback stand-in). Isolated temp LIKU_HOME.
// NO live WAN. Flag off = Phase 49 byte-compatible.

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase50-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const transport = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-fabric.js'));
const { createTransportManager, isQuicWorkerLabEnabled, RESERVED_KINDS } = transport;

const FLAG_KEYS = ['LIKU_QUIC_WORKER_LAB', 'LIKU_TRANSPORT_FABRIC'];

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

test('flag gate default off', () => {
  delete process.env.LIKU_QUIC_WORKER_LAB;
  assert.strictEqual(isQuicWorkerLabEnabled(process.env), false);
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  assert.strictEqual(isQuicWorkerLabEnabled(process.env), true);
});

test('flag off: select(quic) throws unsupported-transport and never listens', async () => {
  delete process.env.LIKU_QUIC_WORKER_LAB;
  const mgr = createTransportManager({ env: process.env });
  assert.strictEqual(mgr.isSupported('quic'), false);
  assert.deepStrictEqual(mgr.listKinds(), ['inprocess', 'https-provider']);
  assert.throws(
    () => mgr.select({ kind: 'quic' }),
    (err) => err && err.code === 'unsupported-transport'
  );
});

test('flag off: Supervisor require graph does not load quic-lab', () => {
  delete process.env.LIKU_QUIC_WORKER_LAB;
  const labId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'quic-lab.js'));
  const supervisorId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
  delete require.cache[supervisorId];
  require(supervisorId);
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
  assert.ok(!loaded.includes(labId), 'Supervisor must not require quic-lab.js when the lab flag is off');
});

test('flag on: loopback cancel frame round-trips', async () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  assert.strictEqual(mgr.isSupported('quic'), true);
  assert.ok(mgr.listKinds().includes('quic'));
  const handle = mgr.select({ kind: 'quic' });
  assert.strictEqual(handle.kind, 'quic');
  try {
    const out = await handle.invoke({ type: 'cancel', taskId: 't-cancel' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.type, 'ack');
    assert.strictEqual(out.echoType, 'cancel');
    assert.strictEqual(out.taskId, 't-cancel');
    const bound = handle._getBoundAddress();
    assert.ok(bound);
    assert.strictEqual(bound.host, '127.0.0.1');
  } finally {
    await handle.close();
  }
});

test('inference-shaped payload is rejected on the quic handle', async () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  const handle = mgr.select({ kind: 'quic' });
  try {
    await assert.rejects(
      () => handle.invoke({ messages: [{ role: 'user', content: 'hi' }], provider: 'xai', model: 'grok' }),
      (err) => err && err.code === 'invalid-quic-payload'
    );
  } finally {
    await handle.close();
  }
});

test('vendor URL in a lab frame is rejected', async () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  const handle = mgr.select({ kind: 'quic' });
  try {
    await assert.rejects(
      () => handle.invoke({ type: 'control', taskId: 't1', url: 'https://api.x.ai/v1/chat/completions' }),
      (err) => err && err.code === 'quic-vendor-forbidden'
    );
  } finally {
    await handle.close();
  }
});

test('non-loopback host in a lab frame is rejected', async () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  const handle = mgr.select({ kind: 'quic' });
  try {
    await assert.rejects(
      () => handle.invoke({ type: 'control', taskId: 't1', host: '8.8.8.8' }),
      (err) => err && err.code === 'quic-non-loopback'
    );
  } finally {
    await handle.close();
  }
});

test('caps.apiKey is never read or forwarded onto the lab frame', async () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const seen = [];
  const mgr = createTransportManager({
    env: process.env,
    invokeQuicLab: (payload) => {
      seen.push(payload);
      return { ok: true, type: 'ack', echoType: payload.type, taskId: payload.taskId };
    }
  });
  const handle = mgr.select({
    kind: 'quic',
    caps: { apiKey: 'SECRET-KEY', endpoint: 'https://evil.example' }
  });
  try {
    await handle.invoke({ type: 'telemetry', taskId: 't2' });
    const blob = JSON.stringify(seen);
    assert.ok(!/SECRET-KEY/.test(blob), 'caps.apiKey must never reach the lab frame');
    assert.ok(!/evil\.example/.test(blob), 'caps endpoint must never reach the lab frame');
    assert.strictEqual(seen[0].type, 'telemetry');
  } finally {
    await handle.close();
  }
});

test('Phase 49 invariant: select(http3) still throws even with the lab flag on', () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  assert.throws(
    () => mgr.select({ kind: 'http3' }),
    (err) => err && err.code === 'unsupported-transport'
  );
  assert.throws(
    () => mgr.select({ kind: 'http2' }),
    (err) => err && err.code === 'unsupported-transport'
  );
  assert.strictEqual(mgr.isSupported('http3'), false);
  assert.ok(!mgr.listKinds().includes('http3'));
});

test('lab server binds loopback (127.0.0.1) only', async () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  const handle = mgr.select({ kind: 'quic' });
  try {
    await handle.invoke({ type: 'ping', taskId: 'bind' });
    const bound = handle._getBoundAddress();
    assert.strictEqual(bound.host, '127.0.0.1');
    assert.ok(Number.isInteger(bound.port) && bound.port > 0);
  } finally {
    await handle.close();
  }
});

test('reserved kinds other than lab-quic still fail closed', () => {
  process.env.LIKU_QUIC_WORKER_LAB = '1';
  const mgr = createTransportManager({ env: process.env });
  for (const reserved of RESERVED_KINDS) {
    if (reserved === 'quic') continue;
    assert.throws(
      () => mgr.select({ kind: reserved }),
      (err) => err && err.code === 'unsupported-transport',
      `expected ${reserved} to stay unimplemented`
    );
  }
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 50 QUIC worker lab checks passed.');
});

runAll();
