// Phase 43: durable inference telemetry (append-only JSONL).
//
// One line per completed / failed / budget-blocked inference call. Writes only
// when LIKU_INFERENCE_FABRIC is on and LIKU_INFERENCE_TELEMETRY is not disabled.
//
// Privacy: only an explicit allowlist of scalar fields is written. Never API
// keys, raw messages, file contents, or screenshots. File mode 0o600, dir 0o700.

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../../shared/liku-home');

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function summarize(records) {
  const calls = records.length;
  const successes = records.filter((r) => r.success).length;
  const blocked = records.filter((r) => r.budgetAllowed === false).length;
  const sum = (key) => records.reduce((acc, r) => acc + (Number.isFinite(r[key]) ? r[key] : 0), 0);
  const tokensIn = sum('inputTokens');
  const tokensOut = sum('outputTokens');
  const estimatedUsd = records.reduce((acc, r) => acc + (typeof r.estimatedUsd === 'number' ? r.estimatedUsd : 0), 0);

  const latencies = records
    .map((r) => r.latencyMs)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  let latency;
  if (latencies.length >= 5) {
    latency = { p50: percentile(latencies, 50), p95: percentile(latencies, 95) };
  } else if (latencies.length > 0) {
    latency = { avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) };
  } else {
    latency = { avg: null };
  }

  const byProvider = {};
  const byRole = {};
  for (const r of records) {
    const p = r.provider || 'unknown';
    const role = r.role || 'unknown';
    byProvider[p] = (byProvider[p] || 0) + 1;
    byRole[role] = (byRole[role] || 0) + 1;
  }

  return {
    calls,
    successes,
    successRate: calls > 0 ? successes / calls : 0,
    blocked,
    tokensIn,
    tokensOut,
    estimatedUsd,
    latency,
    byProvider,
    byRole
  };
}

function createInferenceTelemetry(dependencies = {}) {
  const {
    env = process.env,
    home = LIKU_HOME,
    fabricFlagEnv = 'LIKU_INFERENCE_FABRIC',
    telemetryFlagEnv = 'LIKU_INFERENCE_TELEMETRY'
  } = dependencies;

  const dir = path.join(home, 'inference');
  const filePath = path.join(dir, 'inference.jsonl');

  function isEnabled() {
    if (!isEnabledFlag(env[fabricFlagEnv])) return false;
    const t = env[telemetryFlagEnv];
    if (t === undefined || t === '') return true; // default ON when fabric on
    return isEnabledFlag(t);
  }

  function record(rec = {}) {
    if (!isEnabled()) return null;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const line = {
        ts: new Date().toISOString(),
        provider: rec.provider || null,
        model: rec.model || null,
        role: rec.role || null,
        routeReason: rec.routeReason || null,
        inputTokens: Number.isFinite(rec.inputTokens) ? rec.inputTokens : null,
        outputTokens: Number.isFinite(rec.outputTokens) ? rec.outputTokens : null,
        latencyMs: Number.isFinite(rec.latencyMs) ? rec.latencyMs : null,
        estimatedUsd: typeof rec.estimatedUsd === 'number' ? rec.estimatedUsd : null,
        success: !!rec.success,
        budgetAllowed: rec.budgetAllowed !== false,
        usedProvider: rec.usedProvider || null
      };
      if (rec.blockedReason) {
        line.blockedReason = rec.blockedReason;
      }
      // Phase 45: observable-signal escalation fields (only when present).
      if (rec.signal) {
        line.signal = String(rec.signal);
      }
      if (Number.isFinite(Number(rec.escalationRung))) {
        line.escalationRung = Number(rec.escalationRung);
      }
      fs.appendFileSync(filePath, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(filePath, 0o600); } catch {}
      return line;
    } catch (error) {
      console.warn('[Inference] telemetry write failed:', error.message);
      return null;
    }
  }

  function readRecords() {
    try {
      if (!fs.existsSync(filePath)) return [];
      return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function getAnalytics() {
    return summarize(readRecords());
  }

  return { record, readRecords, getAnalytics, isEnabled, filePath };
}

module.exports = {
  createInferenceTelemetry,
  summarize
};
