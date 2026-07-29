/**
 * Fleet Observability Snapshot Store — best-effort, atomic, flag-gated persistence
 * of a COMPACT fleet-observability snapshot (Pillar 3, Phase 38). PURE OBSERVATION.
 *
 * The unified fleet-observability view (`PAL.getFleetObservability`) is a live
 * composition of many getters and is lost on restart. This store lets an operator
 * OPT IN to persisting a small, bounded snapshot so the last-known fleet posture
 * survives a restart. It never changes behaviour and never actuates.
 *
 * SAFETY:
 *   - PURE OBSERVATION: recording a snapshot NEVER changes any tick / heal / driver
 *     behaviour and NEVER actuates. Recording is best-effort (a write failure is
 *     swallowed). Reads are corruption-tolerant.
 *   - DOUBLE-GATED: requires LIKU_ENABLE_PERIPHERALS=1 AND the opt-in flag
 *     LIKU_PERIPHERAL_FLEET_SNAPSHOT=1 — no disk touched otherwise (so the default
 *     path writes nothing new).
 *   - Atomic + locked write (reusing atomic-file); a bounded ring of recent
 *     snapshots (default 20) keeps the file small.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const OPT_IN = 'LIKU_PERIPHERAL_FLEET_SNAPSHOT';
const SNAPSHOT_FILE = path.join(LIKU_HOME, 'fleet-snapshot.json');

function peripheralsEnabled() { return String(process.env[FLAG] || '').trim() === '1'; }
/** Opt-in gate — persistence only happens when BOTH flags are on. */
function enabled() { return peripheralsEnabled() && String(process.env[OPT_IN] || '').trim() === '1'; }

function _maxSnapshots() {
  const v = Number(process.env.LIKU_PERIPHERAL_FLEET_SNAPSHOT_MAX);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20;
}

const _EMPTY = Object.freeze({ latest: null, recent: [], totals: { snapshots: 0 } });

/** Read the persisted snapshots (corruption-tolerant). Safe default when off. */
function read() {
  if (!peripheralsEnabled()) return { latest: null, recent: [], totals: { snapshots: 0 } };
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return { latest: null, recent: [], totals: { snapshots: 0 } };
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    return {
      latest: (raw && typeof raw.latest === 'object') ? raw.latest : null,
      recent: (raw && Array.isArray(raw.recent)) ? raw.recent : [],
      totals: (raw && typeof raw.totals === 'object') ? { snapshots: Number(raw.totals.snapshots) || 0 } : { snapshots: 0 }
    };
  } catch { return { latest: null, recent: [], totals: { snapshots: 0 } }; }
}

/**
 * Reduce a full fleet-observability object to a small, stable snapshot. Pure —
 * extracts only compact scalars/counts so the persisted file stays tiny.
 */
function compact(obs, now = Date.now()) {
  const o = obs || {};
  const nh = o.nodeHealth || {};
  const de = o.deescalation || {};
  const pw = o.power || {};
  const an = o.anomalies || {};
  return {
    at: o.at || new Date(now).toISOString(),
    mode: o.mode || 'single-machine',
    selfHeal: o.selfHeal && o.selfHeal.health ? { stalled: !!o.selfHeal.health.stalled } : null,
    nodeHealthScore: (nh.local && Number.isFinite(nh.local.score)) ? nh.local.score : null,
    tickStalledNodes: (nh.tickHealth && Number.isFinite(nh.tickHealth.stalled)) ? nh.tickHealth.stalled : 0,
    deescalation: { flapping: Array.isArray(de.flapping) ? de.flapping.length : 0, totals: (de.rollup && de.rollup.totals) ? de.rollup.totals : ((de.trends && de.trends.totals) || {}) },
    power: { budgetW: pw.budgetW ?? null, currentW: pw.currentW ?? null, overBudget: !!pw.overBudget, anomalies: Number(pw.anomalies) || 0 },
    anomalies: { count: Number(an.count) || 0, topDevice: an.topDevice || null }
  };
}

/**
 * Persist a compact snapshot (best-effort, non-fatal, double-gated). Returns
 * { recorded:boolean }. No-op unless BOTH flags are enabled.
 * @param {object} obs  a full getFleetObservability() result
 * @param {{ now?:number }} [opts]
 */
function record(obs, opts = {}) {
  if (!enabled() || !obs) return { recorded: false };
  try {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const snap = compact(obs, now);
    const prev = read();
    const recent = [snap, ...(prev.recent || [])].slice(0, _maxSnapshots());
    const next = { latest: snap, recent, totals: { snapshots: (prev.totals.snapshots || 0) + 1 } };
    atomicWriteFileSync(SNAPSHOT_FILE, JSON.stringify(next, null, 2));
    return { recorded: true, snapshot: snap };
  } catch { return { recorded: false }; }
}

/** Remove the snapshot file (governance/tests). No-op when peripherals disabled. */
function clear() {
  if (!peripheralsEnabled()) return false;
  try { if (fs.existsSync(SNAPSHOT_FILE)) fs.rmSync(SNAPSHOT_FILE); return true; }
  catch { return false; }
}

function _round(n) { return (n == null || !Number.isFinite(Number(n))) ? null : Math.round(Number(n) * 1000) / 1000; }
function _delta(a, b) { return (a == null || b == null) ? null : _round(Number(a) - Number(b)); }

/**
 * Phase 39 — SNAPSHOT TRENDS: a pure-observation view over the persisted ring of
 * recent fleet snapshots (newest-first) so an operator can see how fleet health,
 * contention, flapping and power evolve over time. Reads only — never actuates,
 * never mutates. Returns a compact per-metric latest/oldest/delta plus a small
 * time series. Needs ≥2 snapshots for deltas.
 * @param {{ limit?:number }} [opts]
 */
function trends(opts = {}) {
  const st = read();
  const all = Array.isArray(st.recent) ? st.recent : [];
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : all.length;
  const recent = all.slice(0, limit);
  const series = recent.map((s) => ({
    at: s.at,
    nodeHealthScore: s.nodeHealthScore ?? null,
    flapping: (s.deescalation && Number(s.deescalation.flapping)) || 0,
    currentW: (s.power && s.power.currentW != null) ? s.power.currentW : null,
    anomalies: (s.anomalies && Number(s.anomalies.count)) || 0,
    tickStalledNodes: Number(s.tickStalledNodes) || 0
  }));
  if (recent.length < 2) return { points: recent.length, trend: null, series };
  const newest = recent[0];
  const oldest = recent[recent.length - 1];
  const oFlap = (oldest.deescalation && Number(oldest.deescalation.flapping)) || 0;
  const nFlap = (newest.deescalation && Number(newest.deescalation.flapping)) || 0;
  const oAn = (oldest.anomalies && Number(oldest.anomalies.count)) || 0;
  const nAn = (newest.anomalies && Number(newest.anomalies.count)) || 0;
  return {
    points: recent.length,
    windowFrom: oldest.at, windowTo: newest.at,
    nodeHealthScore: { latest: newest.nodeHealthScore ?? null, oldest: oldest.nodeHealthScore ?? null, delta: _delta(newest.nodeHealthScore, oldest.nodeHealthScore) },
    flapping: { latest: nFlap, oldest: oFlap, delta: nFlap - oFlap },
    currentW: { latest: (newest.power && newest.power.currentW) ?? null, oldest: (oldest.power && oldest.power.currentW) ?? null, delta: _delta(newest.power && newest.power.currentW, oldest.power && oldest.power.currentW) },
    anomalies: { latest: nAn, oldest: oAn, delta: nAn - oAn },
    tickStalledNodes: { latest: Number(newest.tickStalledNodes) || 0, oldest: Number(oldest.tickStalledNodes) || 0 },
    series
  };
}

module.exports = { enabled, read, record, compact, clear, trends, SNAPSHOT_FILE };
