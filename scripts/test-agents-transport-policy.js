#!/usr/bin/env node

// Phase 51: adaptive transport policy table. Isolated temp LIKU_HOME.
// Advisory only. No WAN. Does not expand production select() kinds.

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase51-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const policy = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-policy.js'));
const transport = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-fabric.js'));
const { createTransportManager } = transport;

const FLAG_KEYS = [
  'LIKU_TRANSPORT_POLICY', 'LIKU_TRANSPORT_POLICY_APPLY',
  'LIKU_QUIC_WORKER_LAB', 'LIKU_TRANSPORT_FABRIC'
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

test('flag gates default off', () => {
  delete process.env.LIKU_TRANSPORT_POLICY;
  delete process.env.LIKU_TRANSPORT_POLICY_APPLY;
  assert.strictEqual(policy.isTransportPolicyEnabled(process.env), false);
  assert.strictEqual(policy.isTransportPolicyApplyEnabled(process.env), false);
  process.env.LIKU_TRANSPORT_POLICY = '1';
  process.env.LIKU_TRANSPORT_POLICY_APPLY = '1';
  assert.strictEqual(policy.isTransportPolicyEnabled(process.env), true);
  assert.strictEqual(policy.isTransportPolicyApplyEnabled(process.env), true);
});

test('flags off: Supervisor require graph does not load transport-policy', () => {
  delete process.env.LIKU_TRANSPORT_POLICY;
  delete process.env.LIKU_TRANSPORT_POLICY_APPLY;
  const policyId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-policy.js'));
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
  assert.ok(!loaded.includes(policyId), 'Supervisor must not require transport-policy.js when flags are off');
});

test('bench missing: agent-handoff → inprocess, applied false, reason bench-missing', () => {
  const rec = policy.recommendTransport({
    workload: 'agent-handoff',
    bench: null,
    env: {},
    home: process.env.LIKU_HOME_OVERRIDE
  });
  assert.strictEqual(rec.kind, 'inprocess');
  assert.strictEqual(rec.applied, false);
  assert.strictEqual(rec.reason, 'bench-missing');
  assert.deepStrictEqual(Object.keys(rec).sort(), policy.RESULT_KEYS.slice().sort());
});

test('bench missing: inference → https-provider, applied false', () => {
  const rec = policy.recommendTransport({
    workload: 'inference',
    bench: null,
    env: {}
  });
  assert.strictEqual(rec.kind, 'https-provider');
  assert.strictEqual(rec.applied, false);
  assert.strictEqual(rec.reason, 'bench-missing');
});

test('faster stub http3 row is mentioned, never returned as kind', () => {
  const rec = policy.recommendTransport({
    workload: 'inference',
    bench: [
      { kind: 'https-provider', p50Ms: 8 },
      { kind: 'http3', p50Ms: 2 }
    ],
    env: { LIKU_TRANSPORT_POLICY: '1' }
  });
  assert.strictEqual(rec.kind, 'https-provider');
  assert.ok(/http3/.test(rec.reason), 'reason should mention the unavailable winner');
  assert.notStrictEqual(rec.kind, 'http3');
});

test('APPLY on + unsupported kind still does not select http3', () => {
  process.env.LIKU_TRANSPORT_POLICY = '1';
  process.env.LIKU_TRANSPORT_POLICY_APPLY = '1';
  const rec = policy.recommendTransport({
    workload: 'agent-handoff',
    bench: [{ kind: 'http3', p50Ms: 1 }],
    env: process.env
  });
  assert.strictEqual(rec.kind, 'inprocess');
  assert.strictEqual(rec.applied, true);
  const mgr = createTransportManager({ env: process.env });
  assert.throws(() => mgr.select({ kind: 'http3' }), (err) => err && err.code === 'unsupported-transport');
});

test('APPLY without lab flag must not enable quic', () => {
  process.env.LIKU_TRANSPORT_POLICY = '1';
  process.env.LIKU_TRANSPORT_POLICY_APPLY = '1';
  delete process.env.LIKU_QUIC_WORKER_LAB;
  const rec = policy.recommendTransport({
    workload: 'control',
    bench: [{ kind: 'quic', p50Ms: 1 }],
    env: process.env
  });
  assert.strictEqual(rec.kind, 'inprocess');
  const mgr = createTransportManager({ env: process.env });
  assert.throws(() => mgr.select({ kind: 'quic' }), (err) => err && err.code === 'unsupported-transport');
  assert.deepStrictEqual(mgr.listKinds(), ['inprocess', 'https-provider']);
});

test('lab on + control workload may return quic (lab source)', () => {
  const rec = policy.recommendTransport({
    workload: 'cancel',
    bench: null,
    env: { LIKU_QUIC_WORKER_LAB: '1', LIKU_TRANSPORT_POLICY: '1', LIKU_TRANSPORT_POLICY_APPLY: '1' }
  });
  assert.strictEqual(rec.kind, 'quic');
  assert.strictEqual(rec.source, 'lab');
  assert.strictEqual(rec.applied, true);
});

test('caps.apiKey is ignored; preferKind is advisory only', () => {
  const rec = policy.recommendTransport({
    workload: 'agent-handoff',
    bench: null,
    caps: { apiKey: 'SECRET-KEY', preferKind: 'inprocess', endpoint: 'https://api.x.ai' },
    env: { LIKU_TRANSPORT_POLICY: '1', LIKU_TRANSPORT_POLICY_APPLY: '1' }
  });
  assert.strictEqual(rec.kind, 'inprocess');
  assert.strictEqual(rec.source, 'flag');
  const blob = JSON.stringify(rec);
  assert.ok(!/SECRET-KEY/.test(blob));
});

test('preferKind http3 is ignored because it is unsupported', () => {
  const rec = policy.recommendTransport({
    workload: 'inference',
    bench: null,
    caps: { preferKind: 'http3' },
    env: { LIKU_TRANSPORT_POLICY: '1', LIKU_TRANSPORT_POLICY_APPLY: '1' }
  });
  assert.strictEqual(rec.kind, 'https-provider');
  assert.notStrictEqual(rec.kind, 'http3');
});

test('compatible bench winner for inference is https-provider / source bench', () => {
  const rec = policy.recommendTransport({
    workload: 'inference',
    bench: [{ kind: 'https-provider', p50Ms: 4 }, { kind: 'http2', p50Ms: 1 }],
    env: { LIKU_TRANSPORT_POLICY: '1' }
  });
  assert.strictEqual(rec.kind, 'https-provider');
  assert.ok(rec.source === 'bench' || rec.source === 'default');
});

test('Phase 50 invariant: select(http3) still throws with both policy flags on', () => {
  process.env.LIKU_TRANSPORT_POLICY = '1';
  process.env.LIKU_TRANSPORT_POLICY_APPLY = '1';
  const mgr = createTransportManager({ env: process.env });
  assert.throws(() => mgr.select({ kind: 'http3' }), (err) => err && err.code === 'unsupported-transport');
  assert.throws(() => mgr.select({ kind: 'http2' }), (err) => err && err.code === 'unsupported-transport');
});

test('Phase 50 invariant: select(quic) still throws when lab flag is off', () => {
  process.env.LIKU_TRANSPORT_POLICY = '1';
  process.env.LIKU_TRANSPORT_POLICY_APPLY = '1';
  delete process.env.LIKU_QUIC_WORKER_LAB;
  const mgr = createTransportManager({ env: process.env });
  assert.throws(() => mgr.select({ kind: 'quic' }), (err) => err && err.code === 'unsupported-transport');
});

test('policy module never calls select()', () => {
  let selects = 0;
  const orig = transport.TransportManager.prototype.select;
  transport.TransportManager.prototype.select = function wrapped() {
    selects += 1;
    return orig.apply(this, arguments);
  };
  try {
    policy.recommendTransport({
      workload: 'inference',
      bench: [{ kind: 'http3', p50Ms: 1 }],
      env: { LIKU_TRANSPORT_POLICY: '1', LIKU_TRANSPORT_POLICY_APPLY: '1' }
    });
    assert.strictEqual(selects, 0, 'recommendTransport must not call select()');
  } finally {
    transport.TransportManager.prototype.select = orig;
  }
});

test('writes stay under LIKU_HOME_OVERRIDE (no real-home pollution)', () => {
  const rec = policy.recommendTransport({
    workload: 'agent-handoff',
    bench: null,
    env: {},
    home: process.env.LIKU_HOME_OVERRIDE
  });
  assert.ok(rec);
  assert.strictEqual(fs.existsSync(path.join(os.homedir(), '.liku', 'bench', 'transport-bench.json')), false);
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 51 transport policy checks passed.');
});

runAll();
