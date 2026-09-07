/**
 * Transport measurement harness (Phase 49).
 *
 * Records latency / bytes / error-class for comparable request shapes over
 * *injected* adapters labeled https-provider | http2 | http3. This is a lab
 * bench, not a production transport:
 *   - TransportManager.listKinds() / isSupported() / select() are untouched.
 *   - Reserved production kinds (http2 | http3 | quic | ipc) still throw
 *     unsupported-transport. Bench kinds ≠ production kinds.
 *   - Default adapters are in-process stubs. They never open vendor APIs
 *     (api.x.ai / api.cerebras.ai / api.openai.com) and they never grant
 *     execution authority.
 *
 * Flag-gated (LIKU_TRANSPORT_BENCH, default OFF). Off → runTransportBench
 * refuses to persist and default adapters are not constructed by Supervisor
 * or ai-service (this module is not on that require graph).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');

const BENCH_KINDS = Object.freeze(['https-provider', 'http2', 'http3']);
const RESULT_KEYS = Object.freeze([
  'ts', 'kind', 'n', 'ok', 'fail', 'p50Ms', 'p95Ms', 'bytes', 'errorClasses'
]);
const ALLOWED_ERROR_CLASSES = Object.freeze([
  'ok',
  'unsupported-in-process',
  'timeout',
  'network',
  'invalid-payload',
  'adapter-missing',
  'unknown'
]);
const VENDOR_HOST_RE = /api\.x\.ai|api\.cerebras\.ai|api\.openai\.com|api\.anthropic\.com/i;

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isTransportBenchEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_TRANSPORT_BENCH);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function classifyError(value) {
  const raw = String(value || 'unknown').trim().toLowerCase();
  return ALLOWED_ERROR_CLASSES.includes(raw) ? raw : 'unknown';
}

function assertNoVendorTarget(value) {
  if (value == null) return;
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  if (VENDOR_HOST_RE.test(blob)) {
    const error = new Error('transport bench must not target vendor APIs');
    error.code = 'bench-vendor-forbidden';
    throw error;
  }
}

function createStubAdapter({ kind, latencyMs = 1, bytes = 256, ok = true, errorClass = 'ok' } = {}) {
  const resolvedKind = String(kind || 'https-provider');
  return async function stubInvoke(payload) {
    assertNoVendorTarget(payload);
    return {
      latencyMs,
      bytes,
      ok,
      errorClass: ok ? (errorClass === 'ok' ? 'ok' : classifyError(errorClass)) : classifyError(errorClass || 'unsupported-in-process'),
      kind: resolvedKind
    };
  };
}

function defaultAdapters() {
  // Stubs only. http2/http3 are labeled "unsupported-in-process" so a reader
  // cannot mistake a bench row for a production stack. Latencies are fixed so
  // aggregation is deterministic without a wall-clock race.
  return {
    'https-provider': createStubAdapter({ kind: 'https-provider', latencyMs: 2, bytes: 320, ok: true, errorClass: 'ok' }),
    http2: createStubAdapter({ kind: 'http2', latencyMs: 5, bytes: 320, ok: false, errorClass: 'unsupported-in-process' }),
    http3: createStubAdapter({ kind: 'http3', latencyMs: 9, bytes: 320, ok: false, errorClass: 'unsupported-in-process' })
  };
}

async function invokeOnce(adapter, payload) {
  const started = Date.now();
  try {
    const out = await adapter(payload);
    const latencyMs = Number.isFinite(out && out.latencyMs) ? Number(out.latencyMs) : (Date.now() - started);
    const bytes = Number.isFinite(out && out.bytes) ? Number(out.bytes) : 0;
    const ok = !!(out && out.ok);
    return {
      latencyMs: Math.max(0, latencyMs),
      bytes: Math.max(0, Math.floor(bytes)),
      ok,
      errorClass: classifyError(ok ? (out.errorClass || 'ok') : (out && out.errorClass) || 'unknown')
    };
  } catch (error) {
    return {
      latencyMs: Math.max(0, Date.now() - started),
      bytes: 0,
      ok: false,
      errorClass: error && error.code === 'unsupported-transport' ? 'unsupported-in-process' : 'unknown'
    };
  }
}

function aggregateKind({ kind, samples, now }) {
  const n = samples.length;
  const ok = samples.filter((s) => s.ok).length;
  const fail = n - ok;
  const latencies = samples.map((s) => s.latencyMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const bytes = samples.reduce((acc, s) => acc + (Number.isFinite(s.bytes) ? s.bytes : 0), 0);
  const errorClasses = {};
  for (const s of samples) {
    const cls = classifyError(s.errorClass);
    errorClasses[cls] = (errorClasses[cls] || 0) + 1;
  }
  return {
    ts: typeof now === 'function' ? now() : (now || new Date().toISOString()),
    kind,
    n,
    ok,
    fail,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    bytes,
    errorClasses
  };
}

function sanitizeRecord(record) {
  const out = {};
  for (const key of RESULT_KEYS) {
    out[key] = record[key];
  }
  const blob = JSON.stringify(out);
  if (/authorization/i.test(blob) || VENDOR_HOST_RE.test(blob)) {
    const error = new Error('bench record contained a forbidden field');
    error.code = 'bench-record-forbidden';
    throw error;
  }
  return out;
}

function benchFilePath(home = LIKU_HOME) {
  return path.join(home, 'bench', 'transport-bench.json');
}

function persistResults(records, { home = LIKU_HOME } = {}) {
  const dir = path.join(home, 'bench');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(dir, 0o700); } catch {}
  const doc = {
    ts: new Date().toISOString(),
    harness: 'transport-bench',
    phase: 49,
    note: 'harness only — not a production transport switch; reserved kinds stay unimplemented',
    results: records.map(sanitizeRecord)
  };
  const file = benchFilePath(home);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function formatTable(records) {
  const header = ['kind', 'n', 'ok', 'fail', 'p50Ms', 'p95Ms', 'bytes', 'errors'];
  const rows = records.map((r) => [
    r.kind,
    String(r.n),
    String(r.ok),
    String(r.fail),
    r.p50Ms == null ? '-' : String(r.p50Ms),
    r.p95Ms == null ? '-' : String(r.p95Ms),
    String(r.bytes),
    Object.entries(r.errorClasses || {}).map(([k, v]) => `${k}:${v}`).join(',') || '-'
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

async function runTransportBench(options = {}) {
  const env = options.env || process.env;
  const home = options.home || LIKU_HOME;
  const iterations = Math.max(1, Number(options.iterations) || 8);
  const kinds = Array.isArray(options.kinds) && options.kinds.length
    ? options.kinds.map((k) => String(k).trim().toLowerCase())
    : BENCH_KINDS.slice();
  const persist = options.persist !== false;
  const now = options.now || (() => new Date().toISOString());

  if (!isTransportBenchEnabled(env)) {
    const error = new Error('transport bench is disabled (set LIKU_TRANSPORT_BENCH=1)');
    error.code = 'bench-disabled';
    throw error;
  }

  for (const kind of kinds) {
    if (!BENCH_KINDS.includes(kind)) {
      const error = new Error(`unknown bench kind: ${kind}`);
      error.code = 'unknown-bench-kind';
      throw error;
    }
  }

  const adapters = options.adapters || defaultAdapters();
  const payload = options.payload || { shape: 'inference-bench', n: 1 };
  assertNoVendorTarget(payload);
  assertNoVendorTarget(adapters);

  const records = [];
  for (const kind of kinds) {
    const adapter = adapters[kind];
    if (typeof adapter !== 'function') {
      records.push(sanitizeRecord({
        ts: typeof now === 'function' ? now() : now,
        kind,
        n: 0,
        ok: 0,
        fail: 0,
        p50Ms: null,
        p95Ms: null,
        bytes: 0,
        errorClasses: { 'adapter-missing': 1 }
      }));
      continue;
    }
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      samples.push(await invokeOnce(adapter, payload));
    }
    records.push(sanitizeRecord(aggregateKind({ kind, samples, now: typeof now === 'function' ? now() : now })));
  }

  let file = null;
  if (persist) {
    file = persistResults(records, { home });
  }

  return { records, file, table: formatTable(records) };
}

module.exports = {
  BENCH_KINDS,
  RESULT_KEYS,
  ALLOWED_ERROR_CLASSES,
  isTransportBenchEnabled,
  createStubAdapter,
  defaultAdapters,
  runTransportBench,
  formatTable,
  benchFilePath,
  persistResults
};
