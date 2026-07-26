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

// ── Phase 29: explicit ASSIGNMENT / HANDOFF + AUTO-RENEW ─────────────────────
// Ownership (the TTL lease `task:<id>`) says WHO is working a task right now.
// ASSIGNMENT is a separate advisory INTENT record (`task-assignments` shared kind)
// that says WHICH node SHOULD take a task next — letting an owner hand a task off
// cleanly to a specific peer (or release it back to the open pool). AUTO-RENEW
// keeps a legitimate long-running claim alive past its TTL while the owner is
// actively working — a crashed owner simply stops renewing, so the lease TTL
// still expires and the task is never orphaned.
//
// SAFETY: assignment / handoff / renew are PURE coordination bookkeeping. None of
// them ever actuate a device or bypass the PAL safety chain. Cluster off → inert.

const ASSIGN_KIND = 'task-assignments';

function _assignTtlMs(opts) {
  if (opts && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) return opts.ttlMs;
  const v = Number(process.env.LIKU_PERIPHERAL_TASK_ASSIGN_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 3600000; // 1h freshness / GC
}

/**
 * Assign a task to a specific node (advisory INTENT). The target node can see the
 * assignment via {@link myAssignments} and then {@link claimTask} it. Assignment is
 * NEVER exclusive by itself — exclusivity comes from the claim (lease). Cluster off
 * → inert local ack.
 * @param {string} taskId
 * @param {string} assignee target nodeId
 * @param {{ now?:number }} [opts]
 */
function assignTask(taskId, assignee, opts = {}) {
  if (!enabled() || !taskId || !assignee) return { assigned: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { assigned: true, local: true, assignee: String(assignee) };
  try {
    const ok = coord.putShared(ASSIGN_KIND, taskId, {
      taskId, assignee: String(assignee), assignedBy: coord.nodeId(), assignedAt: new Date().toISOString()
    });
    return { assigned: !!ok, assignee: String(assignee) };
  } catch { return { assigned: false }; }
}

/** The node a task is currently assigned to (or null). */
function assignmentFor(taskId, opts = {}) {
  if (!enabled() || !taskId) return null;
  const coord = _coord();
  if (!coord.clusterEnabled()) return null;
  try {
    const rec = coord.getShared(ASSIGN_KIND, taskId);
    if (!rec || !rec.assignee) return null;
    if (Number.isFinite(opts.maxAgeMs)) {
      const now = Number.isFinite(opts.now) ? opts.now : Date.now();
      const updated = Number.isFinite(Date.parse(rec.updatedAt)) ? Date.parse(rec.updatedAt) : 0;
      if ((now - updated) > opts.maxAgeMs) return null;
    }
    return rec.assignee;
  } catch { return null; }
}

/** Clear a task assignment (return it to the open pool). Best-effort. */
function releaseAssignment(taskId) {
  if (!enabled() || !taskId) return false;
  const coord = _coord();
  if (!coord.clusterEnabled()) return false;
  try { return coord.deleteShared(ASSIGN_KIND, taskId); } catch { return false; }
}

/** Fresh assignments targeting THIS node (the node's inbox). */
function myAssignments(opts = {}) {
  if (!enabled()) return [];
  const coord = _coord();
  if (!coord.clusterEnabled()) return [];
  const me = coord.nodeId();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  try {
    return coord.listShared(ASSIGN_KIND, { now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : _assignTtlMs(opts) })
      .filter((r) => r && r.assignee === me);
  } catch { return []; }
}

/**
 * Hand a task off cleanly. Only the current owner may hand off. Releases this
 * node's claim (so the target — or the pool — can claim it) and records the new
 * assignment; pass a falsy `toNodeId` to release the task back to the OPEN pool
 * (no assignment). Cluster off → advisory local reassignment only.
 * @param {string} taskId
 * @param {string} [toNodeId] target node (falsy → open pool)
 * @param {{ now?:number }} [opts]
 * @returns {{ handedOff:boolean, to?:string|null, released?:boolean, reason?:string, owner?:string }}
 */
function handoffTask(taskId, toNodeId, opts = {}) {
  if (!enabled() || !taskId) return { handedOff: false, reason: 'invalid' };
  const coord = _coord();
  if (!coord.clusterEnabled()) {
    if (toNodeId) assignTask(taskId, toNodeId, opts); else releaseAssignment(taskId);
    return { handedOff: true, local: true, to: toNodeId || null };
  }
  const me = coord.nodeId();
  const owner = taskOwner(taskId, opts.now);
  // Only the owner may hand off. A free task (no owner) may be assigned by anyone.
  if (owner && owner !== me) return { handedOff: false, reason: 'not-owner', owner };
  // Release our lease so the target (or pool) can claim cleanly.
  const rel = coord.releaseLease(`task:${taskId}`);
  if (toNodeId) assignTask(taskId, toNodeId, opts); else releaseAssignment(taskId);
  // Clear the owner field on the shared task summary (now unowned until re-claimed).
  try { const rec = coord.getShared(TASK_KIND, taskId); if (rec) { rec.owner = null; coord.putShared(TASK_KIND, taskId, rec); } } catch { /* best-effort */ }
  return { handedOff: true, to: toNodeId || null, released: !!rel.released };
}

function _renewIntervalMs(opts, ttlMs) {
  if (opts && Number.isFinite(opts.intervalMs) && opts.intervalMs > 0) return opts.intervalMs;
  const v = Number(process.env.LIKU_PERIPHERAL_TASK_RENEW_INTERVAL_MS);
  if (Number.isFinite(v) && v > 0) return v;
  return Math.max(1000, Math.floor(ttlMs / 2)); // renew at half the TTL by default
}

/**
 * Keep an owned claim ALIVE while actively working a task. Returns a handle:
 *   - renewNow(now?)  → renew the claim once (the TIMER-FREE default; call it from
 *                       a tick/consumer loop). Renews only if this node owns it.
 *   - stop()          → stop any background interval.
 * A background interval is started ONLY when a positive `intervalMs` is supplied
 * (opt-in, matching the cron-scheduler pattern); it is unref'd so it never keeps
 * the process alive. Because renewal requires the process to be alive, a crashed
 * owner stops renewing and the lease TTL expires → no permanent orphan.
 * @param {string} taskId
 * @param {{ ttlMs?:number, intervalMs?:number }} [opts]
 */
function startAutoRenew(taskId, opts = {}) {
  const ttlMs = _claimTtlMs(opts);
  const renewNow = (now) => renewClaim(taskId, { ttlMs, now });
  let timer = null;
  const intervalMs = _renewIntervalMs(opts, ttlMs);
  if (Number.isFinite(opts.intervalMs) && opts.intervalMs > 0) {
    timer = setInterval(() => { try { renewNow(); } catch { /* best-effort */ } }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  return { renewNow, ttlMs, intervalMs, stop() { if (timer) { clearInterval(timer); timer = null; } } };
}

/** GC stale task + notification + assignment summaries (best-effort). */
function sweep(now = Date.now()) {
  if (!enabled()) return { tasks: [], notifications: [], assignments: [] };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { tasks: [], notifications: [], assignments: [] };
  try {
    return {
      tasks: coord.sweepShared(TASK_KIND, _ttlMs(), now).removed,
      notifications: coord.sweepShared(NOTIF_KIND, _ttlMs(), now).removed,
      assignments: coord.sweepShared(ASSIGN_KIND, _assignTtlMs(), now).removed
    };
  } catch { return { tasks: [], notifications: [], assignments: [] }; }
}

module.exports = {
  FLAG, TASK_KIND, NOTIF_KIND, ASSIGN_KIND, enabled,
  publishTask, publishNotification, updateTaskStatus,
  listTasks, listNotifications, peerHasOpenTaskFor, sweep,
  claimTask, renewClaim, releaseTask, taskOwner, isOwnedByPeer,
  assignTask, assignmentFor, releaseAssignment, myAssignments, handoffTask, startAutoRenew
};
