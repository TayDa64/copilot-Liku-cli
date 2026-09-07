/**
 * Adaptive transport policy table (Phase 51).
 *
 * Advisory only. Never calls TransportManager.select(), never opens a socket,
 * never spends budget, never reads caps.apiKey. Returned `kind` is always a
 * currently-legal kind under the active flags. Reserved kinds (http2/http3)
 * may appear in `reason` text only.
 *
 * LIKU_TRANSPORT_POLICY=1 enables recommendations.
 * LIKU_TRANSPORT_POLICY_APPLY=1 may set applied:true IFF the kind is supported.
 * Default OFF = Phase 50 byte-compatible (this module is lazily required).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');

const WORKLOADS = Object.freeze([
  'agent-handoff',
  'inference',
  'control',
  'cancel',
  'telemetry'
]);
const RESULT_KEYS = Object.freeze(['ts', 'workload', 'kind', 'reason', 'applied', 'source']);
const CONTROLISH = Object.freeze(['control', 'cancel', 'telemetry']);

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isTransportPolicyEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_TRANSPORT_POLICY);
}

function isTransportPolicyApplyEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_TRANSPORT_POLICY_APPLY);
}

function isQuicLabEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_QUIC_WORKER_LAB);
}

function normalizeWorkload(value) {
  const raw = String(value || '').trim().toLowerCase();
  return WORKLOADS.includes(raw) ? raw : 'agent-handoff';
}

function supportedKinds(env = process.env) {
  const kinds = new Set(['inprocess', 'https-provider']);
  if (isQuicLabEnabled(env)) kinds.add('quic');
  return kinds;
}

function compatibleKinds(workload, env = process.env) {
  if (workload === 'inference') return ['https-provider'];
  if (CONTROLISH.includes(workload) && isQuicLabEnabled(env)) {
    return ['quic', 'inprocess'];
  }
  return ['inprocess'];
}

function defaultKind(workload, env = process.env) {
  return compatibleKinds(workload, env)[0];
}

function extractRecords(bench) {
  if (!bench) return [];
  if (Array.isArray(bench)) return bench;
  if (typeof bench === 'object' && Array.isArray(bench.results)) return bench.results;
  if (typeof bench === 'string') {
    try {
      const raw = fs.readFileSync(bench, 'utf8');
      return extractRecords(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function pickFastest(records) {
  let best = null;
  for (const row of records || []) {
    if (!row || row.kind == null) continue;
    const p50 = Number(row.p50Ms);
    if (!Number.isFinite(p50)) continue;
    if (!best || p50 < best.p50Ms) best = { kind: String(row.kind).trim().toLowerCase(), p50Ms: p50 };
  }
  return best;
}

function defaultBenchPath(home = LIKU_HOME) {
  return path.join(home, 'bench', 'transport-bench.json');
}

function consultTransportPolicy(workload, env = process.env) {
  if (!isTransportPolicyEnabled(env) || !isTransportPolicyApplyEnabled(env)) return null;
  return recommendTransport({ workload, env });
}

function recommendTransport(options = {}) {
  const env = options.env || process.env;
  const home = options.home || LIKU_HOME;
  const workload = normalizeWorkload(options.workload);
  const policyOn = isTransportPolicyEnabled(env);
  const applyOn = isTransportPolicyApplyEnabled(env);
  const supported = supportedKinds(env);
  const compatible = compatibleKinds(workload, env);
  const caps = options.caps && typeof options.caps === 'object' ? options.caps : {};

  let benchInput = options.bench;
  if (benchInput === undefined) {
    const file = defaultBenchPath(home);
    benchInput = fs.existsSync(file) ? file : null;
  }
  const records = extractRecords(benchInput);
  const benchMissing = benchInput == null || benchInput === '';
  const fastest = pickFastest(records);

  let kind = defaultKind(workload, env);
  let reason;
  let source = kind === 'quic' ? 'lab' : 'default';

  const prefer = caps.preferKind != null ? String(caps.preferKind).trim().toLowerCase() : '';
  if (prefer && compatible.includes(prefer) && supported.has(prefer)) {
    kind = prefer;
    reason = `caps.preferKind=${prefer}`;
    source = 'flag';
  } else if (benchMissing) {
    reason = 'bench-missing';
    source = kind === 'quic' ? 'lab' : 'default';
  } else if (!fastest) {
    reason = 'bench-empty';
    source = kind === 'quic' ? 'lab' : 'default';
  } else if (compatible.includes(fastest.kind) && supported.has(fastest.kind)) {
    kind = fastest.kind;
    reason = `bench-fastest:${fastest.kind}`;
    source = fastest.kind === 'quic' ? 'lab' : 'bench';
  } else {
    reason = `bench-winner-unavailable:${fastest.kind}`;
    source = kind === 'quic' ? 'lab' : 'default';
  }

  const applied = !!(policyOn && applyOn && supported.has(kind) && compatible.includes(kind));

  const result = {
    ts: typeof options.now === 'function' ? options.now() : (options.now || new Date().toISOString()),
    workload,
    kind,
    reason,
    applied,
    source
  };
  const out = {};
  for (const key of RESULT_KEYS) out[key] = result[key];
  return out;
}

module.exports = {
  WORKLOADS,
  RESULT_KEYS,
  isTransportPolicyEnabled,
  isTransportPolicyApplyEnabled,
  recommendTransport,
  consultTransportPolicy,
  compatibleKinds,
  supportedKinds,
  defaultBenchPath
};
