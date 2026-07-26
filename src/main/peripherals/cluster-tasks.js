/**
 * Cluster Task / Notification Visibility (Pillar 3, Phase 27). BEST-EFFORT +
 * COMPACT + STRICTLY ADVISORY.
 *
 * Mirrors a COMPACT summary of high-value Supervisor tasks + notifications
 * (anomaly→action, coordinated-reduce proposals, fleet actions, critical alerts)
 * to the shared cluster store (reusing coordination's generic shared-record
 * layer under LIKU_CLUSTER_DIR/tasks|notifications/). Any node can then SEE what
 * a peer has already created or is handling, minimizing duplicate work, and can
 * mirror status changes (acknowledged / confirmed / dismissed / resolved).
 *
 * SAFETY (non-negotiable):
 *   - The shared view is ADVISORY ONLY. It is NEVER an actuation path — a task is
 *     still a human-gated proposal, executed (if at all) through the PAL chain.
 *   - COMPACT: only identifying + status fields are shared (no payloads, no full
 *     task bodies). Stale entries are dropped by max-age / GC.
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) + CLUSTER-GATED
 *     (LIKU_CLUSTER_DIR). Single-machine → every call is an inert no-op.
 *
 * Config:
 *   LIKU_PERIPHERAL_CLUSTER_TASK_TTL_MS  default 3600000 (1h freshness / GC)
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const TASK_KIND = 'tasks';
const NOTIF_KIND = 'notifications';

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _coord() { return require('./coordination'); }

function _ttlMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_CLUSTER_TASK_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 3600000; // 1h
}

/** Compact, identifying-only projection of a task. @private */
function _compactTask(task) {
  const t = task || {};
  const device = t.device || {};
  return {
    id: t.id || null,
    dedupeKey: t.dedupeKey || null,
    type: t.type || 'peripheral-response',
    deviceId: device.id || null,
    severity: t.severityTier || (t.priority === 'high' ? 'critical' : (t.priority === 'medium' ? 'warning' : 'info')),
    priority: t.priority || null,
    status: t.status || 'pending-review',
    source: t.source || 'peripheral-alert',
    anomalyType: t.anomalyType || null
  };
}

function _compactNotification(n) {
  const nn = n || {};
  const device = nn.device || {};
  return {
    id: nn.id || null,
    kind: nn.kind || 'peripheral-alert',
    deviceId: device.id || null,
    severity: nn.severity || 'info',
    source: nn.source || 'peripheral-alert',
    status: nn.acknowledged ? 'acknowledged' : 'open'
  };
}

/** Publish a task summary to the shared cluster store. */
function publishTask(task) {
  if (!enabled()) return false;
  const coord = _coord();
  if (!coord.clusterEnabled() || !task || !task.id) return false;
  try { return coord.putShared(TASK_KIND, task.id, _compactTask(task)); }
  catch { return false; }
}

/** Publish a notification summary to the shared cluster store. */
function publishNotification(n) {
  if (!enabled()) return false;
  const coord = _coord();
  if (!coord.clusterEnabled() || !n || !n.id) return false;
  try { return coord.putShared(NOTIF_KIND, n.id, _compactNotification(n)); }
  catch { return false; }
}

/** Mirror a status change (acknowledged / confirmed / dismissed / resolved). */
function updateTaskStatus(taskId, status) {
  if (!enabled()) return false;
  const coord = _coord();
  if (!coord.clusterEnabled() || !taskId) return false;
  try {
    const rec = coord.getShared(TASK_KIND, taskId);
    if (!rec) return false;
    rec.status = String(status || rec.status);
    return coord.putShared(TASK_KIND, taskId, rec);
  } catch { return false; }
}

/** List peer task summaries (fresh only). */
function listTasks(opts = {}) {
  if (!enabled()) return [];
  const coord = _coord();
  if (!coord.clusterEnabled()) return [];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  try { return coord.listShared(TASK_KIND, { now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : _ttlMs() }); }
  catch { return []; }
}

/** List peer notification summaries (fresh only). */
function listNotifications(opts = {}) {
  if (!enabled()) return [];
  const coord = _coord();
  if (!coord.clusterEnabled()) return [];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  try { return coord.listShared(NOTIF_KIND, { now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : _ttlMs() }); }
  catch { return []; }
}

/**
 * Whether a PEER (another node) already has an OPEN task for the given condition
 * (dedupeKey). Advisory hint to minimize duplicate work — never a gate.
 */
function peerHasOpenTaskFor(dedupeKey, opts = {}) {
  if (!enabled() || !dedupeKey) return null;
  const coord = _coord();
  if (!coord.clusterEnabled()) return null;
  const me = coord.nodeId();
  for (const t of listTasks(opts)) {
    if (t.dedupeKey === dedupeKey && t.nodeId !== me
      && (t.status === 'pending-review' || t.status === 'escalate')) return t;
  }
  return null;
}

// ── Phase 28: distributed task OWNERSHIP / claim ────────────────────────────
// Exactly ONE node owns a high-value task at a time, using the existing TTL-lease
// primitive (`task:<id>`). A claim auto-expires (TTL) so a crashed owner never
// orphans a task; the owner renews while working and releases on resolve. STRICTLY
// ADVISORY — claiming is coordination only and is NEVER an actuation path.

function _claimTtlMs(opts) {
  if (opts && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) return opts.ttlMs;
  const v = Number(process.env.LIKU_PERIPHERAL_TASK_CLAIM_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 300000; // 5 min
}

/**
 * Claim ownership of a task. Single-machine → always claimed locally. Cluster →
 * granted only when free or already owned by this node. Records the owner on the
 * shared task summary for visibility.
 * @param {string} taskId
 * @param {{ ttlMs?:number, now?:number }} [opts]
 * @returns {{ claimed:boolean, local?:boolean, owner?:string, holder?:object }}
 */
function claimTask(taskId, opts = {}) {
  if (!enabled() || !taskId) return { claimed: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { claimed: true, local: true, owner: coord.nodeId() };
  const res = coord.acquireLease(`task:${taskId}`, { ttlMs: _claimTtlMs(opts), now: opts.now });
  if (res.granted) {
    try { const rec = coord.getShared(TASK_KIND, taskId); if (rec) { rec.owner = coord.nodeId(); coord.putShared(TASK_KIND, taskId, rec); } } catch { /* best-effort */ }
    return { claimed: true, owner: coord.nodeId() };
  }
  return { claimed: false, owner: res.holder ? res.holder.nodeId : null, holder: res.holder };
}

/** Renew this node's claim (extends the TTL while actively working). */
function renewClaim(taskId, opts = {}) {
  if (!enabled() || !taskId) return { claimed: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { claimed: true, local: true };
  const res = coord.renewLease(`task:${taskId}`, { ttlMs: _claimTtlMs(opts), now: opts.now });
  return { claimed: !!res.granted, owner: res.granted ? coord.nodeId() : (res.holder && res.holder.nodeId) };
}

/** Release a task claim (resolve / dismiss). Only the owner may release. */
function releaseTask(taskId) {
  if (!enabled() || !taskId) return { released: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { released: true, local: true };
  const res = coord.releaseLease(`task:${taskId}`);
  try { const rec = coord.getShared(TASK_KIND, taskId); if (rec && rec.owner === coord.nodeId()) { rec.owner = null; coord.putShared(TASK_KIND, taskId, rec); } } catch { /* best-effort */ }
  return { released: !!res.released, reason: res.reason };
}

/** Current owner of a task (or null when free / expired / single-machine). */
function taskOwner(taskId, now = Date.now()) {
  if (!enabled() || !taskId) return null;
  const coord = _coord();
  if (!coord.clusterEnabled()) return null;
  const holder = coord.whoHolds(`task:${taskId}`, now);
  return holder ? holder.nodeId : null;
}

/** True when a task is currently owned by ANOTHER node (peer is handling it). */
function isOwnedByPeer(taskId, now = Date.now()) {
  const owner = taskOwner(taskId, now);
  if (!owner) return false;
  return owner !== _coord().nodeId();
}

/** GC stale task + notification summaries (best-effort). */
function sweep(now = Date.now()) {
  if (!enabled()) return { tasks: [], notifications: [] };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { tasks: [], notifications: [] };
  try {
    return {
      tasks: coord.sweepShared(TASK_KIND, _ttlMs(), now).removed,
      notifications: coord.sweepShared(NOTIF_KIND, _ttlMs(), now).removed
    };
  } catch { return { tasks: [], notifications: [] }; }
}

module.exports = {
  FLAG, TASK_KIND, NOTIF_KIND, enabled,
  publishTask, publishNotification, updateTaskStatus,
  listTasks, listNotifications, peerHasOpenTaskFor, sweep,
  claimTask, renewClaim, releaseTask, taskOwner, isOwnedByPeer
};
