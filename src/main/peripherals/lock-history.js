/**
 * Lock Observability Over Time (Pillar 3, Phase 21). PURE OBSERVATION.
 *
 * The advisory file-lock layer (src/shared/atomic-file.js) keeps in-memory
 * contention counters (global + per file). Those reset when the process exits.
 * This module PERSISTS periodic snapshots to a rolling JSONL log so an operator
 * can see contention TRENDS over time and identify which store is "hot".
 *
 * DISCIPLINE (mirrors power-history / token-store):
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) — no disk touched otherwise.
 *   - Atomic + locked writes (via atomic-file), corruption-tolerant reads.
 *   - PURE observability — it NEVER changes locking behaviour or actuates
 *     anything. Recording is on-demand (no background timer).
 *
 * Config:
 *   LIKU_LOCK_HISTORY_MAX  default 500 (rolling snapshot cap)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync, getLockMetrics, getPerFileLockMetrics } = require('../../shared/atomic-file');
const coordination = require('./coordination');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const HISTORY_FILE = path.join(LIKU_HOME, 'lock-history.jsonl');
const DEFAULT_MAX = 500;

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _max() {
  const v = Number(process.env.LIKU_LOCK_HISTORY_MAX);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX;
}

function _readLines() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch { return []; }
}

/**
 * Record a lock-metrics snapshot (global + per-file) to the rolling log.
 * On-demand only — best-effort, flag-gated. Returns the snapshot or null.
 * @param {{ now?:number }} [opts]
 */
function record(opts = {}) {
  if (!enabled()) return null;
  const snapshot = {
    at: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString(),
    metrics: getLockMetrics(),
    perFile: getPerFileLockMetrics()
  };
  try {
    const lines = _readLines();
    lines.push(JSON.stringify(snapshot));
    const capped = lines.slice(-_max());
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(HISTORY_FILE, capped.join('\n') + '\n', { mode: 0o600 });
    // Phase 22: mirror this node's latest snapshot to the shared cluster store so
    // contention can be aggregated fleet-wide. Cluster off → no-op.
    if (coordination.clusterEnabled()) _mirrorCluster(snapshot);
    return snapshot;
  } catch { return null; }
}

/** Path to this node's shared lock-metrics file (or null when cluster off). @private */
function _clusterNodePath(nodeId) {
  const dir = coordination.clusterDir();
  if (!dir) return null;
  const safe = String(nodeId || coordination.nodeId()).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 128);
  return path.join(dir, 'lock-metrics', `${safe}.json`);
}

/** Write this node's latest snapshot to the shared cluster store. @private */
function _mirrorCluster(snapshot) {
  const p = _clusterNodePath(coordination.nodeId());
  if (!p) return;
  try {
    atomicWriteFileSync(p, JSON.stringify({ nodeId: coordination.nodeId(), ...snapshot }, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}

/**
 * Phase 22 — CLUSTER-WIDE lock-metrics aggregation. Rolls up every node's latest
 * shared snapshot into fleet totals + a per-node breakdown + combined per-file
 * hotspots. Single-machine (cluster off) → this node's live view only.
 */
function clusterAggregate() {
  const nodeIds = [];
  const perNode = [];
  const totals = { acquired: 0, contended: 0, steals: 0, fallbacks: 0, retries: 0 };
  const perFile = {};
  const dir = coordination.clusterDir();
  if (coordination.clusterEnabled() && dir) {
    const mdir = path.join(dir, 'lock-metrics');
    try {
      if (fs.existsSync(mdir)) {
        for (const f of fs.readdirSync(mdir)) {
          if (!f.endsWith('.json')) continue;
          let snap;
          try { snap = JSON.parse(fs.readFileSync(path.join(mdir, f), 'utf-8')); } catch { snap = null; }
          if (!snap || !snap.metrics) continue;
          nodeIds.push(snap.nodeId);
          perNode.push({ nodeId: snap.nodeId, at: snap.at, metrics: snap.metrics });
          for (const k of Object.keys(totals)) totals[k] += Number(snap.metrics[k]) || 0;
          for (const [file, m] of Object.entries(snap.perFile || {})) {
            const acc = perFile[file] || (perFile[file] = { acquired: 0, contended: 0, steals: 0 });
            acc.acquired += Number(m.acquired) || 0;
            acc.contended += Number(m.contended) || 0;
            acc.steals += Number(m.steals) || 0;
          }
        }
      }
    } catch { /* best-effort */ }
  }
  // Fold in this node's LIVE counters (may be ahead of its last mirrored snapshot).
  const live = getLockMetrics();
  if (!nodeIds.includes(coordination.nodeId())) {
    for (const k of Object.keys(totals)) totals[k] += Number(live[k]) || 0;
    perNode.push({ nodeId: coordination.nodeId(), at: new Date().toISOString(), metrics: live, live: true });
  }
  const acquired = totals.acquired || 0;
  const hotFiles = Object.entries(perFile)
    .map(([file, m]) => ({ file, ...m }))
    .sort((a, b) => b.contended - a.contended || b.acquired - a.acquired)
    .slice(0, 5);
  return {
    mode: coordination.clusterEnabled() ? 'cluster' : 'single-machine',
    nodes: perNode.length,
    totals,
    contentionRate: acquired > 0 ? Math.round(totals.contended / acquired * 1000) / 1000 : 0,
    perNode,
    hotFiles
  };
}

/**
 * Query recent snapshots (newest last).
 * @param {{ limit?:number, sinceMs?:number }} [opts]
 */
function query(opts = {}) {
  if (!enabled()) return [];
  let snaps = _readLines().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (Number.isFinite(opts.sinceMs)) {
    const cutoff = Date.now() - opts.sinceMs;
    snaps = snaps.filter((s) => Date.parse(s.at) >= cutoff);
  }
  if (Number.isFinite(opts.limit) && opts.limit > 0) snaps = snaps.slice(-opts.limit);
  return snaps;
}

function _diff(a, b) {
  const out = {};
  for (const k of ['acquired', 'contended', 'steals', 'fallbacks', 'retries']) {
    out[k] = Math.max(0, (Number(b[k]) || 0) - (Number(a[k]) || 0));
  }
  return out;
}

/**
 * Contention TRENDS across the recorded snapshots: the delta between the first
 * and last snapshot, the current contention rate, and the hottest files by
 * contention. Advisory only.
 */
function trends(opts = {}) {
  const snaps = query(opts);
  if (!snaps.length) return { snapshots: 0, deltas: null, contentionRate: 0, hotFiles: [] };
  const first = snaps[0].metrics || {};
  const lastSnap = snaps[snaps.length - 1];
  const last = lastSnap.metrics || {};
  const deltas = snaps.length >= 2 ? _diff(first, last) : { ...last };
  const acquired = Number(last.acquired) || 0;
  const contentionRate = acquired > 0 ? Math.round((Number(last.contended) || 0) / acquired * 1000) / 1000 : 0;
  // Hottest files by contended count in the latest snapshot.
  const perFile = lastSnap.perFile || {};
  const hotFiles = Object.entries(perFile)
    .map(([file, m]) => ({ file, contended: Number(m.contended) || 0, acquired: Number(m.acquired) || 0, steals: Number(m.steals) || 0 }))
    .sort((a, b) => b.contended - a.contended || b.acquired - a.acquired)
    .slice(0, 5);
  return {
    snapshots: snaps.length,
    spanMs: snaps.length >= 2 ? (Date.parse(lastSnap.at) - Date.parse(snaps[0].at)) : 0,
    deltas,
    latest: last,
    contentionRate,
    hotFiles
  };
}

/** Remove the history log (governance/tests). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(HISTORY_FILE)) fs.rmSync(HISTORY_FILE); return true; }
  catch { return false; }
}

module.exports = { FLAG, HISTORY_FILE, enabled, record, query, trends, clusterAggregate, clear };