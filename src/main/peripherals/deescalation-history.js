/**
 * De-Escalation History — a tiny, PURE-OBSERVATION store for step-back /
 * de-escalation activity (Pillar 3, Phase 34).
 *
 * Records per-device rung transitions (e.g. unpair → rotate-token), the last
 * step-back timestamp, simple counts, and a bounded transition log so an operator
 * can SEE how the heal ladder is being walked down — WITHOUT changing any
 * proposal or confirmation behaviour.
 *
 * SAFETY:
 *   - PURE OBSERVATION: recording history NEVER changes what a de-escalation
 *     proposes or how a confirmation behaves. Recording is best-effort (a write
 *     failure is swallowed) and is called AFTER the state change it observes.
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) — no disk touched otherwise.
 *   - Atomic + locked write (reusing atomic-file), corruption-tolerant read.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const STORE_FILE = path.join(LIKU_HOME, 'deescalation-history.json');
const MAX_TRANSITIONS_PER_DEVICE = 20;

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

const _EMPTY = Object.freeze({ devices: {}, totals: { stepBacks: 0, clears: 0 } });

/** Read the persisted history (corruption-tolerant). Returns a safe default. */
function read() {
  if (!enabled()) return { devices: {}, totals: { stepBacks: 0, clears: 0 } };
  try {
    if (!fs.existsSync(STORE_FILE)) return { devices: {}, totals: { stepBacks: 0, clears: 0 } };
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    return {
      devices: (raw && typeof raw.devices === 'object') ? raw.devices : {},
      totals: (raw && typeof raw.totals === 'object') ? { ..._EMPTY.totals, ...raw.totals } : { ..._EMPTY.totals }
    };
  } catch { return { devices: {}, totals: { stepBacks: 0, clears: 0 } }; }
}

/**
 * Record one de-escalation transition (best-effort, pure observation).
 * @param {{ deviceId:string, from?:string, to?:string, kind?:string, at?:number }} t
 *   kind: 'step-back' (a rung step-down) | 'clear' (ladder reset / cleared)
 */
function record(t) {
  if (!enabled() || !t || !t.deviceId) return false;
  try {
    const st = read();
    const kind = t.kind === 'clear' ? 'clear' : 'step-back';
    const atMs = Number.isFinite(t.at) ? t.at : Date.now();
    const atIso = new Date(atMs).toISOString();
    const dev = st.devices[t.deviceId] || { lastStepBackAt: null, lastFrom: null, lastTo: null, stepBackCount: 0, clearCount: 0, transitions: [] };
    const transition = { from: t.from || null, to: t.to || null, kind, at: atIso };
    dev.transitions = [...(Array.isArray(dev.transitions) ? dev.transitions : []), transition].slice(-MAX_TRANSITIONS_PER_DEVICE);
    if (kind === 'step-back') { dev.lastStepBackAt = atIso; dev.lastFrom = t.from || null; dev.lastTo = t.to || null; dev.stepBackCount = (dev.stepBackCount || 0) + 1; st.totals.stepBacks = (st.totals.stepBacks || 0) + 1; }
    else { dev.clearCount = (dev.clearCount || 0) + 1; st.totals.clears = (st.totals.clears || 0) + 1; }
    st.devices[t.deviceId] = dev;
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(STORE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), devices: st.devices, totals: st.totals }, null, 2), { mode: 0o600 });
    // Phase 35: mirror a compact per-node summary to the cluster (best-effort,
    // cluster-gated) so peers see fleet-wide de-escalation activity. Pure observation.
    try { publishSummary({ at: atMs }); } catch { /* best-effort */ }
    return true;
  } catch { return false; }
}

/**
 * Observation-only view of a device's step-back state, including remaining
 * cooldown (based on the last recorded step-back). PURE READ.
 * @param {string} deviceId
 * @param {{ now?:number, cooldownMs?:number }} [opts]
 */
function deviceState(deviceId, opts = {}) {
  const st = read();
  const dev = st.devices[deviceId];
  if (!dev) return { deviceId, known: false, stepBackCount: 0, clearCount: 0, lastStepBackAt: null, cooldownRemainingMs: 0 };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs > 0 ? opts.cooldownMs : 0;
  const lastMs = dev.lastStepBackAt ? Date.parse(dev.lastStepBackAt) : 0;
  const cooldownRemainingMs = (cooldownMs > 0 && lastMs) ? Math.max(0, cooldownMs - (now - lastMs)) : 0;
  return {
    deviceId, known: true,
    lastStepBackAt: dev.lastStepBackAt || null, lastFrom: dev.lastFrom || null, lastTo: dev.lastTo || null,
    stepBackCount: dev.stepBackCount || 0, clearCount: dev.clearCount || 0,
    cooldownRemainingMs, transitions: Array.isArray(dev.transitions) ? dev.transitions.slice(-10) : []
  };
}

/** Remove the history file (governance/tests). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(STORE_FILE)) fs.rmSync(STORE_FILE); return true; }
  catch { return false; }
}

// ── Phase 35: TRENDS + CLUSTER ROLLUP (pure observation) ────────────────────

function _trendWindowMs(opts) {
  if (opts && Number.isFinite(opts.windowMs) && opts.windowMs > 0) return opts.windowMs;
  const v = Number(process.env.LIKU_PERIPHERAL_DEESC_TREND_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 24 * 3600 * 1000; // 24h
}

/**
 * Trend/aggregate view of step-back / clear activity: per-device counts within a
 * window, a recent transition RATE (per hour), remaining step-back cooldown, and
 * fleet totals. PURE OBSERVATION — reads only.
 * @param {{ now?:number, windowMs?:number, cooldownMs?:number }} [opts]
 */
function trends(opts = {}) {
  const st = read();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = _trendWindowMs(opts);
  const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs > 0 ? opts.cooldownMs : 0;
  const cutoff = now - windowMs;
  const devices = [];
  let recentStepBacks = 0; let recentClears = 0;
  for (const [deviceId, d] of Object.entries(st.devices || {})) {
    const trans = Array.isArray(d.transitions) ? d.transitions : [];
    const recent = trans.filter((t) => { const at = Date.parse(t.at); return Number.isFinite(at) && at >= cutoff; });
    const rs = recent.filter((t) => t.kind !== 'clear').length;
    const rc = recent.filter((t) => t.kind === 'clear').length;
    recentStepBacks += rs; recentClears += rc;
    const lastMs = d.lastStepBackAt ? Date.parse(d.lastStepBackAt) : 0;
    const cooldownRemainingMs = (cooldownMs > 0 && lastMs) ? Math.max(0, cooldownMs - (now - lastMs)) : 0;
    const hours = windowMs / 3600000;
    devices.push({
      deviceId,
      stepBackCount: d.stepBackCount || 0, clearCount: d.clearCount || 0,
      recentStepBacks: rs, recentClears: rc,
      ratePerHour: hours > 0 ? Math.round((recent.length / hours) * 1000) / 1000 : 0,
      lastStepBackAt: d.lastStepBackAt || null, lastTo: d.lastTo || null,
      cooldownRemainingMs
    });
  }
  devices.sort((a, b) => (b.recentStepBacks + b.recentClears) - (a.recentStepBacks + a.recentClears) || String(a.deviceId).localeCompare(String(b.deviceId)));
  return { windowMs, deviceCount: devices.length, devices, totals: { ...st.totals }, recent: { stepBacks: recentStepBacks, clears: recentClears } };
}

function _summaryTtlMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_DEESC_SUMMARY_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 3600000; // 1h
}

// Phase 36: FLAPPING detection — a device stepping back too many times in a short
// window is "flapping" (its posture is oscillating). PURE OBSERVATION: reports a
// deterministic threshold breach; NEVER changes de-escalation behaviour.
function _flapWindowMs(opts) {
  if (opts && Number.isFinite(opts.windowMs) && opts.windowMs > 0) return opts.windowMs;
  const v = Number(process.env.LIKU_PERIPHERAL_DEESC_FLAP_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 3600000; // 1h
}
function _flapThreshold(opts) {
  if (opts && Number.isFinite(opts.threshold) && opts.threshold > 0) return Math.floor(opts.threshold);
  const v = Number(process.env.LIKU_PERIPHERAL_DEESC_FLAP_THRESHOLD);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3; // ≥3 step-backs in the window
}

/**
 * Detect devices that stepped back ≥ threshold times within the window (flapping).
 * PURE OBSERVATION — reads only.
 * @param {{ now?:number, windowMs?:number, threshold?:number }} [opts]
 * @returns {{ windowMs:number, threshold:number, devices:Array<{deviceId,recentStepBacks,lastStepBackAt}> }}
 */
function flapping(opts = {}) {
  const st = read();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = _flapWindowMs(opts);
  const threshold = _flapThreshold(opts);
  const cutoff = now - windowMs;
  const devices = [];
  for (const [deviceId, d] of Object.entries(st.devices || {})) {
    const trans = Array.isArray(d.transitions) ? d.transitions : [];
    const recentStepBacks = trans.filter((t) => t.kind !== 'clear' && Number.isFinite(Date.parse(t.at)) && Date.parse(t.at) >= cutoff).length;
    if (recentStepBacks >= threshold) devices.push({ deviceId, recentStepBacks, lastStepBackAt: d.lastStepBackAt || null });
  }
  devices.sort((a, b) => b.recentStepBacks - a.recentStepBacks || String(a.deviceId).localeCompare(String(b.deviceId)));
  return { windowMs, threshold, devices };
}

/** Publish a COMPACT per-node de-escalation summary to the shared store (cluster-gated). */
function publishSummary(opts = {}) {
  if (!enabled()) return false;
  try {
    const coord = require('./coordination');
    if (!coord.clusterEnabled()) return false;
    const st = read();
    return coord.putShared('deescalation-summary', coord.nodeId(), {
      totals: st.totals, deviceCount: Object.keys(st.devices || {}).length,
      at: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString()
    });
  } catch { return false; }
}

/** Cluster-wide rollup of de-escalation activity (merges peer summaries). Cluster off → this node only. */
function clusterRollup(opts = {}) {
  const local = read();
  const base = { mode: 'single-machine', nodes: 1, totals: { ...local.totals }, perNode: [{ nodeId: 'local', totals: local.totals, deviceCount: Object.keys(local.devices || {}).length }] };
  try {
    const coord = require('./coordination');
    if (!coord.clusterEnabled()) return base;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const recs = coord.listShared('deescalation-summary', { now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : _summaryTtlMs() });
    const totals = { stepBacks: 0, clears: 0 };
    const perNode = [];
    for (const r of recs) {
      const t = (r && r.totals) || {};
      totals.stepBacks += Number(t.stepBacks) || 0;
      totals.clears += Number(t.clears) || 0;
      perNode.push({ nodeId: r.nodeId, totals: t, deviceCount: Number(r.deviceCount) || 0 });
    }
    return { mode: 'cluster', nodes: perNode.length, totals, perNode };
  } catch { return base; }
}

/** GC stale de-escalation summaries (best-effort, cluster-gated). */
function sweepSummary(now = Date.now()) {
  try {
    const coord = require('./coordination');
    if (!coord.clusterEnabled()) return { removed: [] };
    return { removed: coord.sweepShared('deescalation-summary', _summaryTtlMs(), now).removed };
  } catch { return { removed: [] }; }
}

module.exports = { FLAG, STORE_FILE, enabled, read, record, deviceState, clear, trends, flapping, publishSummary, clusterRollup, sweepSummary };
