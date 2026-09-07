#!/usr/bin/env node

// Phase 49: transport measurement harness. Isolated temp LIKU_HOME.
// NO live WAN. Adapters are injected stubs. Production select() stays frozen.

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liku-phase49-'));
process.env.LIKU_HOME_OVERRIDE = path.join(tempRoot, '.liku');

const bench = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-bench.js'));
const transport = require(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-fabric.js'));
const { createTransportManager, RESERVED_KINDS } = transport;

const FLAG_KEYS = ['LIKU_TRANSPORT_BENCH', 'LIKU_TRANSPORT_FABRIC'];

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
  delete process.env.LIKU_TRANSPORT_BENCH;
  assert.strictEqual(bench.isTransportBenchEnabled(process.env), false);
  process.env.LIKU_TRANSPORT_BENCH = '1';
  assert.strictEqual(bench.isTransportBenchEnabled(process.env), true);
});

test('flag off: runTransportBench refuses to persist', async () => {
  delete process.env.LIKU_TRANSPORT_BENCH;
  const home = process.env.LIKU_HOME_OVERRIDE;
  await assert.rejects(
    () => bench.runTransportBench({ env: process.env, home, persist: true, adapters: bench.defaultAdapters() }),
    (err) => err && err.code === 'bench-disabled'
  );
  assert.strictEqual(fs.existsSync(path.join(home, 'bench')), false, 'no bench dir when flag off');
});

test('flag off: Supervisor/ai-service require graph does not load the bench writer', () => {
  delete process.env.LIKU_TRANSPORT_BENCH;
  const benchId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'transport-bench.js'));
  const supervisorId = require.resolve(path.join(__dirname, '..', 'src', 'main', 'agents', 'supervisor.js'));
  delete require.cache[supervisorId];
  require(supervisorId);
  const loadedBySupervisor = [];
  const seen = new Set();
  function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const entry = require.cache[id];
    if (!entry) return;
    for (const child of entry.children || []) {
      loadedBySupervisor.push(child.id);
      walk(child.id);
    }
  }
  walk(supervisorId);
  assert.ok(!loadedBySupervisor.includes(benchId), 'Supervisor must not require transport-bench.js');
});

test('injected adapters: https-provider faster-or-equal vs slower http3 (aggregation, not the internet)', async () => {
  process.env.LIKU_TRANSPORT_BENCH = '1';
  const adapters = {
    'https-provider': bench.createStubAdapter({ kind: 'https-provider', latencyMs: 3, bytes: 100, ok: true }),
    http2: bench.createStubAdapter({ kind: 'http2', latencyMs: 6, bytes: 100, ok: true }),
    http3: bench.createStubAdapter({ kind: 'http3', latencyMs: 12, bytes: 100, ok: true })
  };
  const { records, file, table } = await bench.runTransportBench({
    env: process.env,
    home: process.env.LIKU_HOME_OVERRIDE,
    iterations: 8,
    adapters,
    persist: true,
    now: () => '2026-09-07T00:00:00.000Z'
  });
  assert.strictEqual(records.length, 3);
  const byKind = Object.fromEntries(records.map((r) => [r.kind, r]));
  assert.ok(byKind['https-provider'].p50Ms <= byKind.http3.p50Ms);
  assert.ok(byKind['https-provider'].p95Ms <= byKind.http3.p95Ms);
  assert.strictEqual(byKind['https-provider'].ok, 8);
  assert.strictEqual(byKind.http3.n, 8);
  assert.strictEqual(byKind['https-provider'].bytes, 800);
  assert.ok(table.includes('https-provider'));
  assert.ok(file && fs.existsSync(file));
});

test('result record is allowlisted and file mode is 0o600 / dir 0o700', async () => {
  process.env.LIKU_TRANSPORT_BENCH = '1';
  const { records, file } = await bench.runTransportBench({
    env: process.env,
    home: process.env.LIKU_HOME_OVERRIDE,
    iterations: 2,
    adapters: {
      'https-provider': bench.createStubAdapter({ latencyMs: 1, bytes: 10, ok: true })
    },
    kinds: ['https-provider'],
    persist: true
  });
  const rec = records[0];
  assert.deepStrictEqual(Object.keys(rec).sort(), bench.RESULT_KEYS.slice().sort());
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!/authorization/i.test(raw));
  assert.ok(!/api\.x\.ai/.test(raw));
  assert.ok(!/Bearer /.test(raw));
  const fileMode = fs.statSync(file).mode & 0o777;
  const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
  assert.strictEqual(fileMode, 0o600);
  assert.strictEqual(dirMode, 0o700);
});

test('bench refuses vendor API targets', async () => {
  process.env.LIKU_TRANSPORT_BENCH = '1';
  await assert.rejects(
    () => bench.runTransportBench({
      env: process.env,
      home: process.env.LIKU_HOME_OVERRIDE,
      persist: false,
      payload: { url: 'https://api.x.ai/v1/chat/completions' },
      adapters: { 'https-provider': async () => ({ ok: true, latencyMs: 1, bytes: 1 }) },
      kinds: ['https-provider']
    }),
    (err) => err && err.code === 'bench-vendor-forbidden'
  );
});

test('production select(http3) still throws unsupported-transport after the harness lands', () => {
  const mgr = createTransportManager({});
  assert.deepStrictEqual(mgr.listKinds(), ['inprocess', 'https-provider']);
  assert.strictEqual(mgr.isSupported('http3'), false);
  assert.strictEqual(mgr.isSupported('http2'), false);
  assert.ok(!mgr.listKinds().includes('http3'));
  for (const reserved of RESERVED_KINDS) {
    assert.throws(
      () => mgr.select({ kind: reserved }),
      (err) => err && err.code === 'unsupported-transport',
      `expected ${reserved} to stay unimplemented`
    );
  }
});

test('zero real-home pollution: writes stay under LIKU_HOME_OVERRIDE', async () => {
  process.env.LIKU_TRANSPORT_BENCH = '1';
  const home = process.env.LIKU_HOME_OVERRIDE;
  await bench.runTransportBench({
    env: process.env,
    home,
    iterations: 1,
    adapters: bench.defaultAdapters(),
    persist: true
  });
  const expected = path.join(home, 'bench', 'transport-bench.json');
  assert.ok(fs.existsSync(expected));
  assert.ok(expected.startsWith(tempRoot));
});

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (failures === 0) console.log('\nAll Phase 49 transport bench checks passed.');
});

runAll();
