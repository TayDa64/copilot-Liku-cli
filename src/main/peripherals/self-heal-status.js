/**
 * Self-Heal Status — a tiny, best-effort observability store for the periodic
 * self-healing tick (Pillar 3, Phase 32). PURE OBSERVATION.
 *
 * The self-healing-scheduler records the LAST run's per-step timings + counts here
 * plus small cumulative totals, so an operator can see what the tick did (and how
 * long each step took) via the PAL / CLI — WITHOUT standing up a heavy store.
 *
 * SAFETY:
 *   - PURE OBSERVATION: recording status NEVER changes tick behaviour and NEVER
 *     actuates anything. Recording is best-effort (a write failure is swallowed).
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) — no disk touched otherwise.
 *   - Atomic + locked write (reusing atomic-file), corruption-tolerant read.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const STATUS_FILE = path.join(LIKU_HOME, 'self-heal-status.json');

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

const _EMPTY = Object.freeze({
  lastRun: null,
  totals: { runs: 0, rebalanced: 0, expiryTasks: 0, deescalations: 0, autoCleared: 0 }
});

/** Read the persisted status (corruption-tolerant). Returns a safe default. */
function read() {
  if (!enabled()) return { ..._EMPTY, totals: { ..._EMPTY.totals }, stalled: false };
  try {
    if (!fs.existsSync(STATUS_FILE)) return { ..._EMPTY, totals: { ..._EMPTY.totals }, stalled: false };
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    return {
      lastRun: (raw && typeof raw.lastRun === 'object') ? raw.lastRun : null,
      totals: (raw && typeof raw.totals === 'object') ? { ..._EMPTY.totals, ...raw.totals } : { ..._EMPTY.totals },
      stalled: !!(raw && raw.stalled)
    };
  } catch { return { ..._EMPTY, totals: { ..._EMPTY.totals }, stalled: false }; }
}

/**
 * Record a completed tick's summary (last run + folded cumulative totals).
 * Best-effort + non-fatal. `run` = { at, durationMs, timings, counts }.
 */
function record(run) {
  if (!enabled() || !run) return false;
  try {
    const prev = read();
    const counts = run.counts || {};
    const totals = {
      runs: (prev.totals.runs || 0) + 1,
      rebalanced: (prev.totals.rebalanced || 0) + (Number(counts.rebalanced) || 0),
      expiryTasks: (prev.totals.expiryTasks || 0) + (Number(counts.expiryTasks) || 0),
      deescalations: (prev.totals.deescalations || 0) + (Number(counts.deescalations) || 0),
      autoCleared: (prev.totals.autoCleared || 0) + (Number(counts.autoCleared) || 0)
    };
    const lastRun = {
      at: run.at || new Date().toISOString(),
      durationMs: Number(run.durationMs) || 0,
      timings: run.timings || {},
      counts: {
        rebalanced: Number(counts.rebalanced) || 0,
        expiryTasks: Number(counts.expiryTasks) || 0,
        deescalations: Number(counts.deescalations) || 0,
        autoCleared: Number(counts.autoCleared) || 0
      }
    };
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(STATUS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), lastRun, totals, stalled: !!run.stalled }, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Remove the status file (governance/tests). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(STATUS_FILE)) fs.rmSync(STATUS_FILE); return true; }
  catch { return false; }
}

/** Configured staleness threshold for tick-health (ms). @private */
function _staleMs(opts) {
  if (opts && Number.isFinite(opts.staleMs) && opts.staleMs > 0) return opts.staleMs;
  const v = Number(process.env.LIKU_PERIPHERAL_SELF_HEAL_STALE_MS);
  return Number.isFinite(v) && v > 0 ? v : 900000; // 15 min without a tick → stale
}

/**
 * Phase 33 — TICK HEALTH: compute the last-run age and whether the self-heal tick
 * is STALE (no run within the threshold). PURE OBSERVATION — reading health never
 * changes behaviour or actuates. A never-run tick is reported `ran:false` (not
 * "stale" — there is simply nothing to age yet).
 * @param {{ now?:number, staleMs?:number }} [opts]
 * @returns {{ ran:boolean, lastRunAt:(string|null), lastRunAgeMs:(number|null), staleMs:number, stale:boolean }}
 */
function health(opts = {}) {
  const staleMs = _staleMs(opts);
  const st = read();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!st.lastRun || !st.lastRun.at) {
    return { ran: false, lastRunAt: null, lastRunAgeMs: null, staleMs, stale: false };
  }
  const at = Date.parse(st.lastRun.at);
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : null;
  return { ran: true, lastRunAt: st.lastRun.at, lastRunAgeMs: ageMs, staleMs, stale: ageMs != null && ageMs > staleMs };
}

module.exports = { FLAG, STATUS_FILE, enabled, read, record, clear, health };
