/**
 * Cross-Host Coordination Foundation (Pillar 3, Phase 21).
 *
 * A minimal, dependency-free TTL-LEASE layer that lets multiple Liku instances
 * (a multi-node fleet) safely coordinate on shared resources — a device, a task,
 * or a token — WITHOUT a central server. It reuses the same advisory-locking
 * philosophy as atomic-file.js, but across a SHARED directory that all nodes can
 * see (e.g. an NFS/SMB mount or a synced folder), pointed at by LIKU_CLUSTER_DIR.
 *
 * DESIGN:
 *   - NODE IDENTITY: LIKU_NODE_ID or `${hostname}:${pid}`.
 *   - A lease is an atomically-created directory `<clusterDir>/leases/<res>.lease`
 *     holding `holder.json` = { nodeId, acquiredAt, expiresAt }. mkdir is atomic
 *     across hosts on a shared FS, giving mutual exclusion.
 *   - Leases are TIME-BOUNDED (ttlMs). An EXPIRED lease (crashed/stalled holder)
 *     is stolen. The owning node can renew or release early.
 *
 * SAFETY + BACKWARD COMPATIBILITY (non-negotiable):
 *   - SINGLE-MACHINE IS THE DEFAULT. When LIKU_CLUSTER_DIR is unset, cluster mode
 *     is OFF and every lease is granted trivially/locally — the single-machine
 *     path is completely unchanged (no new files, no new behaviour).
 *   - Best-effort + NON-FATAL: any FS error degrades to "granted locally" so a
 *     coordination hiccup never blocks a single node from operating.
 *   - Resource ids are STRICTLY SANITIZED (allow-list) before touching the FS, so
 *     a device/token id can never traverse paths — no new attack surface.
 *   - PURE coordination bookkeeping — it NEVER actuates a device and NEVER
 *     bypasses the PAL safety chain (DCP → class gate → pending/confirm).
 *
 * Config:
 *   LIKU_CLUSTER_DIR        shared directory enabling cluster mode (default: unset → off)
 *   LIKU_NODE_ID            stable node identity (default: hostname:pid)
 *   LIKU_LEASE_TTL_MS       default lease TTL (default 30000)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 30000;

/** Stable identity for THIS node. */
function nodeId() {
  const explicit = String(process.env.LIKU_NODE_ID || '').trim();
  if (explicit) return explicit;
  return `${os.hostname()}:${process.pid}`;
}

/** The shared cluster directory, or null when cluster mode is off. */
function clusterDir() {
  const d = String(process.env.LIKU_CLUSTER_DIR || '').trim();
  return d || null;
}

/** True only when a shared cluster directory is configured. */
function clusterEnabled() {
  return clusterDir() != null;
}

function _ttlMs(opts) {
  if (opts && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) return opts.ttlMs;
  const v = Number(process.env.LIKU_LEASE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

/**
 * Strict allow-list sanitization of a resource id so it can never traverse
 * paths. Only [A-Za-z0-9._-] survive; everything else becomes '_'. @private
 */
function _safeResource(resourceId) {
  const s = String(resourceId || '').trim();
  // Allow-list survivors only, then collapse any dot-runs so no '..' traversal
  // component can ever survive (defense in depth — '/' and '\' are already gone).
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  // Defensive: never allow '.' / '..' / empty after cleaning.
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 128);
}

function _leasesDir() {
  const base = clusterDir();
  return base ? path.join(base, 'leases') : null;
}

function _leasePath(safeRes) {
  const dir = _leasesDir();
  return dir ? path.join(dir, `${safeRes}.lease`) : null;
}

function _readHolder(leasePath) {
  try { return JSON.parse(fs.readFileSync(path.join(leasePath, 'holder.json'), 'utf-8')); }
  catch { return null; }
}

function _writeHolder(leasePath, holder) {
  try {
    fs.writeFileSync(path.join(leasePath, 'holder.json'), JSON.stringify(holder, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Acquire (or renew) a TTL lease for a resource. Single-machine (cluster off) →
 * always granted locally. Cluster mode → atomic mkdir with steal-on-expiry.
 * @param {string} resourceId
 * @param {{ ttlMs?:number, now?:number }} [opts]
 * @returns {{ granted:boolean, local?:boolean, holder?:object, lease?:object, reason?:string }}
 */
function acquireLease(resourceId, opts = {}) {
  if (!clusterEnabled()) return { granted: true, local: true, nodeId: nodeId() };
  const res = _safeResource(resourceId);
  if (!res) return { granted: false, reason: 'invalid-resource' };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttl = _ttlMs(opts);
  const me = nodeId();
  const leasePath = _leasePath(res);
  const dir = _leasesDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { return { granted: true, local: true, nodeId: me, reason: 'cluster-dir-unavailable' }; }
  const lease = { nodeId: me, resource: res, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(), expiresMs: now + ttl };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(leasePath); // atomic across hosts on a shared FS
      _writeHolder(leasePath, lease);
      return { granted: true, holder: lease, lease };
    } catch (err) {
      if (err.code !== 'EEXIST') return { granted: true, local: true, nodeId: me, reason: 'lease-fs-error' };
      const holder = _readHolder(leasePath);
      const expiresMs = holder && Number.isFinite(Date.parse(holder.expiresAt)) ? Date.parse(holder.expiresAt) : 0;
      if (holder && holder.nodeId === me) { _writeHolder(leasePath, lease); return { granted: true, holder: lease, lease, renewed: true }; }
      if (!holder || now >= expiresMs) {
        // Expired / crashed holder → steal.
        try { fs.rmSync(leasePath, { recursive: true, force: true }); } catch { /* ignore */ }
        continue;
      }
      return { granted: false, holder, reason: 'held-by-other-node' };
    }
  }
  return { granted: false, reason: 'contended' };
}

/** Renew a lease this node already holds (extends the TTL). */
function renewLease(resourceId, opts = {}) {
  if (!clusterEnabled()) return { granted: true, local: true, nodeId: nodeId() };
  return acquireLease(resourceId, opts); // acquire renews when held by this node
}

/** Release a lease — only the owning node may remove it. */
function releaseLease(resourceId) {
  if (!clusterEnabled()) return { released: true, local: true };
  const res = _safeResource(resourceId);
  if (!res) return { released: false, reason: 'invalid-resource' };
  const leasePath = _leasePath(res);
  const holder = _readHolder(leasePath);
  if (holder && holder.nodeId !== nodeId()) return { released: false, reason: 'not-owner', holder };
  try { fs.rmSync(leasePath, { recursive: true, force: true }); return { released: true }; }
  catch { return { released: false, reason: 'fs-error' }; }
}

/** Who currently holds a resource lease (or null when free / cluster off). */
function whoHolds(resourceId, now = Date.now()) {
  if (!clusterEnabled()) return null;
  const res = _safeResource(resourceId);
  if (!res) return null;
  const holder = _readHolder(_leasePath(res));
  if (!holder) return null;
  const expiresMs = Number.isFinite(Date.parse(holder.expiresAt)) ? Date.parse(holder.expiresAt) : 0;
  if (now >= expiresMs) return null; // expired → effectively free
  return holder;
}

/** True when this node may act on a resource (free, expired, or owned by us). */
function canAct(resourceId, now = Date.now()) {
  if (!clusterEnabled()) return true;
  const holder = whoHolds(resourceId, now);
  return !holder || holder.nodeId === nodeId();
}

/** List all active (non-expired) leases. */
function listLeases(now = Date.now()) {
  if (!clusterEnabled()) return [];
  const dir = _leasesDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((n) => n.endsWith('.lease'))
      .map((n) => _readHolder(path.join(dir, n)))
      .filter((h) => h && Number.isFinite(Date.parse(h.expiresAt)) && now < Date.parse(h.expiresAt));
  } catch { return []; }
}

/**
 * Phase 25 — CLAIM-ONCE: atomically claim a one-shot resource (e.g. a cron rule
 * firing bucket) so exactly ONE node acts on it. Single-machine → always claimed.
 * In cluster mode a claim succeeds only for the node that FIRST creates the
 * short-lived lease (a re-claim by the same owner, or a claim by another node
 * while held, returns claimed:false). The lease auto-expires after ttlMs so the
 * next firing window is claimable again.
 * @param {string} resourceId
 * @param {{ ttlMs?:number, now?:number }} [opts]
 * @returns {{ claimed:boolean, local?:boolean, holder?:object }}
 */
function claimOnce(resourceId, opts = {}) {
  if (!clusterEnabled()) return { claimed: true, local: true };
  const res = acquireLease(resourceId, opts);
  return { claimed: !!(res.granted && !res.renewed), granted: !!res.granted, holder: res.holder, reason: res.reason };
}

/**
 * Phase 25 — best-effort sweeper: remove EXPIRED lease directories (crashed /
 * released holders whose TTL elapsed). Cluster off → no-op. Never throws.
 * @param {number} [now]
 * @returns {{ removed:string[] }}
 */
function pruneExpiredLeases(now = Date.now()) {
  if (!clusterEnabled()) return { removed: [] };
  const dir = _leasesDir();
  const removed = [];
  try {
    if (!fs.existsSync(dir)) return { removed };
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.lease')) continue;
      const leasePath = path.join(dir, n);
      const holder = _readHolder(leasePath);
      const expiresMs = holder && Number.isFinite(Date.parse(holder.expiresAt)) ? Date.parse(holder.expiresAt) : 0;
      if (!holder || now >= expiresMs) {
        try { fs.rmSync(leasePath, { recursive: true, force: true }); removed.push(n); } catch { /* ignore */ }
      }
    }
  } catch { /* best-effort */ }
  return { removed };
}

/** Coordination status for the CLI / PAL. */
function status(now = Date.now()) {
  const enabled = clusterEnabled();
  return {
    enabled,
    nodeId: nodeId(),
    clusterDir: clusterDir(),
    mode: enabled ? 'cluster' : 'single-machine',
    leases: enabled ? listLeases(now).length : 0
  };
}

module.exports = {
  DEFAULT_TTL_MS, nodeId, clusterDir, clusterEnabled,
  acquireLease, renewLease, releaseLease, whoHolds, canAct, listLeases, status,
  claimOnce, pruneExpiredLeases
};
