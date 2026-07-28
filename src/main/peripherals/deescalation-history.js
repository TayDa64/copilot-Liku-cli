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

module.exports = { FLAG, STORE_FILE, enabled, read, record, deviceState, clear };
