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

// ── Phase 30: TASK INBOX REBALANCING (best-effort, advisory) ────────────────
// Reassign STALE or UNCLAIMED open tasks to a less-loaded node so work does not
// pile up on (or get stuck behind) a node that never picked it up. Rebalancing
// only rewrites the advisory ASSIGNMENT intent — it NEVER claims on behalf of
// another node and NEVER actuates. Exclusivity still comes from the claim (lease),
// so a rebalance can never create double ownership. Deterministic heuristic:
// least-loaded node wins (tie broken by nodeId); a stale assignee is avoided.

const _OPEN_STATUSES = new Set(['pending-review', 'escalate', 'open']);

function _isOpenStatus(status) { return _OPEN_STATUSES.has(String(status || 'pending-review')); }

function _staleMs(opts) {
  if (opts && Number.isFinite(opts.staleMs) && opts.staleMs > 0) return opts.staleMs;
  const v = Number(process.env.LIKU_PERIPHERAL_TASK_STALE_MS);
  return Number.isFinite(v) && v > 0 ? v : 600000; // 10 min unclaimed → stale
}

// Phase 32: FAIRNESS weighting. A task's "weight" reflects its severity/priority
// (a critical task costs a node more capacity than an info task). A node's
// "capacity" (LIKU_PERIPHERAL_NODE_CAPACITY = JSON { nodeId: weight }, default 1)
// scales how much weighted load it can carry. Target score = weightedLoad /
// capacity (LOWER is a better target). Higher-severity tasks are placed FIRST so
// they get first pick of the lowest-scored (most available) node.
const _SEVERITY_WEIGHT = Object.freeze({ critical: 3, high: 3, warning: 2, medium: 2, info: 1, low: 1 });

function _taskWeight(t) {
  const sev = t && (t.severity || (t.priority === 'high' ? 'critical' : (t.priority === 'medium' ? 'warning' : (t.priority === 'low' ? 'low' : 'info'))));
  return _SEVERITY_WEIGHT[sev] || _SEVERITY_WEIGHT[t && t.priority] || 1;
}

function _nodeCapacity(nodeId) {
  try {
    const raw = JSON.parse(process.env.LIKU_PERIPHERAL_NODE_CAPACITY || '{}');
    const c = Number(raw && raw[nodeId]);
    return Number.isFinite(c) && c > 0 ? c : 1;
  } catch { return 1; }
}

// Phase 33: ANTI-FLAPPING. Two deterministic guards stop a task bouncing between
// nodes on small load changes: (1) a HYSTERESIS margin — an ALREADY-assigned task
// only moves when the best target's score is better than its current assignee's
// score by at least this margin; (2) a MIN-RESIDENCY window — a task placed less
// than this long ago is left to settle. Both default OFF (0) → Phase-32 behaviour.
function _hysteresis(opts) {
  if (opts && Number.isFinite(opts.hysteresis) && opts.hysteresis >= 0) return opts.hysteresis;
  const v = Number(process.env.LIKU_PERIPHERAL_REBALANCE_HYSTERESIS);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}
function _minResidencyMs(opts) {
  if (opts && Number.isFinite(opts.minResidencyMs) && opts.minResidencyMs >= 0) return opts.minResidencyMs;
  const v = Number(process.env.LIKU_PERIPHERAL_REBALANCE_MIN_RESIDENCY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

// Phase 34: OPTIONAL node-health signal. A node may publish a simple health score
// (0..1, 1 = healthy) to the shared `node-health` kind; when
// `LIKU_PERIPHERAL_REBALANCE_USE_HEALTH=1` the rebalance score becomes
// weightedLoad / (capacity · healthFactor), so a less-healthy node is a WORSE
// target (higher score). Default OFF / no data → factor 1 → Phase-33 behaviour.
function _useHealth(opts) {
  if (opts && opts.useHealth === true) return true;
  return String(process.env.LIKU_PERIPHERAL_REBALANCE_USE_HEALTH || '').trim() === '1';
}

function _healthFactor(nodeId, opts) {
  if (!_useHealth(opts)) return 1;
  try {
    const coord = _coord();
    if (!coord.clusterEnabled()) return 1;
    const rec = coord.getShared('node-health', nodeId);
    const score = rec && Number(rec.score);
    if (!Number.isFinite(score)) return 1;
    return Math.min(1, Math.max(0.01, score)); // clamp so a 0 score never divides by zero
  } catch { return 1; }
}

/**
 * Publish THIS node's health score (0..1, 1 = healthy) to the shared cluster
 * store so peers can weight it into rebalancing. Cluster off → inert. Advisory
 * observation only — it never actuates. @param {number} score
 */
function publishNodeHealth(score, opts = {}) {
  if (!enabled()) return { published: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { published: false, local: true };
  const s = Math.min(1, Math.max(0, Number(score)));
  if (!Number.isFinite(s)) return { published: false, reason: 'invalid-score' };
  try {
    const ok = coord.putShared('node-health', coord.nodeId(), { score: s, at: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString() });
    return { published: !!ok, nodeId: coord.nodeId(), score: s };
  } catch { return { published: false }; }
}

/**
 * Phase 35/36 — AUTO-DERIVE a node-health score (0..1) from real, already-tracked
 * operational signals. Deterministic + bounded. By DEFAULT (single-signal) it uses
 * only the advisory file-lock CONTENTION RATE (`health = 1 − contentionRate`) —
 * byte-compatible with Phase 35. When MULTI-SIGNAL is enabled (`opts.multi` or
 * `LIKU_PERIPHERAL_NODE_HEALTH_MULTI=1`) it ALSO folds a self-heal TICK signal
 * (a stalled tick, or a tick slower than the latency budget) so a struggling node
 * scores lower: `penalty = 0.6·contention + 0.4·tick`, `health = 1 − penalty`.
 * PURE OBSERVATION of local counters — reads only, never actuates.
 * @param {{ now?:number, metrics?:object, tick?:object, multi?:boolean }} [opts]
 */
function deriveNodeHealth(opts = {}) {
  let m = { acquired: 0, contended: 0 };
  if (opts && opts.metrics && typeof opts.metrics === 'object') m = opts.metrics;
  else { try { m = require('../../shared/atomic-file').getLockMetrics() || m; } catch { /* best-effort */ } }
  const acquired = Number(m.acquired) || 0;
  const contended = Number(m.contended) || 0;
  const contentionRate = acquired > 0 ? Math.min(1, contended / acquired) : 0;
  const multi = (opts && opts.multi === true) || String(process.env.LIKU_PERIPHERAL_NODE_HEALTH_MULTI || '').trim() === '1';
  if (!multi) {
    const score = Math.min(1, Math.max(0, 1 - contentionRate));
    return { score: Math.round(score * 1000) / 1000, contentionRate: Math.round(contentionRate * 1000) / 1000, acquired, contended, signals: { contention: Math.round(contentionRate * 1000) / 1000 } };
  }
  // Multi-signal: fold the self-heal TICK latency / stall indicator.
  let tickPenalty = 0;
  let tick = (opts && opts.tick && typeof opts.tick === 'object') ? opts.tick : null;
  if (!tick) { try { const st = require('./self-heal-status').read(); tick = { durationMs: st.lastRun ? st.lastRun.durationMs : 0, stalled: !!st.stalled }; } catch { tick = null; } }
  if (tick) {
    if (tick.stalled) tickPenalty = 1;
    else { const budget = _healthLatencyBudgetMs(); tickPenalty = budget > 0 ? Math.min(1, (Number(tick.durationMs) || 0) / budget) : 0; }
  }
  const penalty = Math.min(1, 0.6 * contentionRate + 0.4 * tickPenalty);
  const score = Math.min(1, Math.max(0, 1 - penalty));
  return {
    score: Math.round(score * 1000) / 1000,
    contentionRate: Math.round(contentionRate * 1000) / 1000,
    tickPenalty: Math.round(tickPenalty * 1000) / 1000,
    acquired, contended,
    signals: { contention: Math.round(contentionRate * 1000) / 1000, tick: Math.round(tickPenalty * 1000) / 1000 }
  };
}

function _healthLatencyBudgetMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_NODE_HEALTH_LATENCY_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 5000; // a tick slower than 5s is fully penalised
}

/** Phase 35 — derive + publish this node's health in one call (best-effort, cluster-gated). */
function publishDerivedNodeHealth(opts = {}) {
  if (!enabled()) return { published: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { published: false, local: true };
  const d = deriveNodeHealth(opts);
  return { ...publishNodeHealth(d.score, opts), derived: true, contentionRate: d.contentionRate };
}

// ── Phase 36: TICK-HEALTH cluster status mirror (pure observation) ──────────
// Mirror this node's self-heal tick-health state (stalled true/false) to the
// shared `tick-health` kind so peers can see when a node's cadence has stalled or
// recovered. Cluster off → inert. Advisory observation only — never actuates.

function publishTickHealth(stalled, opts = {}) {
  if (!enabled()) return { published: false };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { published: false, local: true };
  try {
    const at = new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString();
    const rec = { stalled: !!stalled, at };
    if (stalled) rec.stalledAt = at; else rec.recoveredAt = at;
    const ok = coord.putShared('tick-health', coord.nodeId(), rec);
    return { published: !!ok, nodeId: coord.nodeId(), stalled: !!stalled };
  } catch { return { published: false }; }
}

/** Cluster-wide per-node tick-health state (which nodes are currently stalled). */
function clusterTickHealth(opts = {}) {
  if (!enabled()) return { mode: 'single-machine', nodes: 0, stalled: 0, perNode: [] };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { mode: 'single-machine', nodes: 0, stalled: 0, perNode: [] };
  try {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const recs = coord.listShared('tick-health', { now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : 3600000 });
    const perNode = recs.map((r) => ({ nodeId: r.nodeId, stalled: !!r.stalled, at: r.at }));
    return { mode: 'cluster', nodes: perNode.length, stalled: perNode.filter((n) => n.stalled).length, perNode };
  } catch { return { mode: 'cluster', nodes: 0, stalled: 0, perNode: [] }; }
}

/**
 * Pick the best target node: LOWEST weighted-load / (capacity · healthFactor)
 * score. Deterministic (tie broken by nodeId). Avoids `exclude` (the stale
 * assignee) when another node exists. @private
 */
function _bestTarget(load, exclude, opts) {
  const nodes = Object.keys(load).sort();
  let best = null; let bestScore = Infinity;
  for (const n of nodes) {
    if (exclude && n === exclude && nodes.length > 1) continue;
    const score = load[n] / (_nodeCapacity(n) * _healthFactor(n, opts));
    if (score < bestScore) { bestScore = score; best = n; }
  }
  if (!best && exclude) best = exclude; // exclude was the only known node
  return best;
}

/**
 * Rebalance stale / unclaimed open tasks across the fleet. A task is a candidate
 * when it is OPEN, currently UNOWNED (no live claim), and either UNASSIGNED or its
 * assignment is older than `staleMs` (the assignee never claimed it). Candidates
 * are placed HIGHEST-SEVERITY-FIRST onto the node with the lowest weighted-load /
 * capacity score (fairness weighting). Rebalancing only rewrites the advisory
 * ASSIGNMENT intent — it NEVER claims for another node and NEVER actuates, so it
 * can never create double ownership. Cluster off → inert. Best-effort / non-fatal.
 * @param {{ now?:number, staleMs?:number, maxAgeMs?:number }} [opts]
 * @returns {{ rebalanced:Array<{taskId:string, from:string|null, to:string, weight:number}>, local?:boolean }}
 */
function rebalance(opts = {}) {
  if (!enabled()) return { rebalanced: [] };
  const coord = _coord();
  if (!coord.clusterEnabled()) return { rebalanced: [], local: true };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const staleMs = _staleMs(opts);
  const tasks = listTasks({ now, maxAgeMs: opts.maxAgeMs });
  let assignments = [];
  try { assignments = coord.listShared(ASSIGN_KIND, { now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : _assignTtlMs(opts) }); }
  catch { assignments = []; }
  const assignByTask = {};
  for (const a of assignments) if (a && a.taskId) assignByTask[a.taskId] = a;
  // Known nodes + per-node WEIGHTED load. Load = Σ severity-weight of open tasks a
  // node OWNS or is ASSIGNED (heavier tasks consume more of a node's capacity).
  const load = { [coord.nodeId()]: 0 };
  for (const a of assignments) { if (a.assignee && !(a.assignee in load)) load[a.assignee] = 0; if (a.assignedBy && !(a.assignedBy in load)) load[a.assignedBy] = 0; }
  for (const t of tasks) {
    if (!t.id || !_isOpenStatus(t.status)) continue;
    const w = _taskWeight(t);
    const owner = taskOwner(t.id, now);
    if (owner) { load[owner] = (load[owner] || 0) + w; continue; }
    const a = assignByTask[t.id];
    if (a && a.assignee) load[a.assignee] = (load[a.assignee] || 0) + w;
  }
  // Candidate stale tasks, HIGHEST SEVERITY FIRST (deterministic tiebreak by id).
  const candidates = [];
  for (const t of tasks) {
    if (!t.id || !_isOpenStatus(t.status)) continue;
    if (taskOwner(t.id, now)) continue; // actively owned → leave it
    const a = assignByTask[t.id];
    const assignedAtMs = a ? (Date.parse(a.assignedAt || a.updatedAt) || 0) : 0;
    const isStale = a ? (now - assignedAtMs) >= staleMs : true; // unassigned counts as stale
    if (!isStale) continue;
    candidates.push({ t, staleAssignee: a ? a.assignee : null, assignedAtMs, weight: _taskWeight(t) });
  }
  candidates.sort((x, y) => (y.weight - x.weight) || String(x.t.id).localeCompare(String(y.t.id)));
  const hysteresis = _hysteresis(opts);
  const minResidencyMs = _minResidencyMs(opts);
  const rebalanced = [];
  for (const c of candidates) {
    const target = _bestTarget(load, c.staleAssignee, opts);
    if (!target) continue;
    if (target === c.staleAssignee) continue; // nowhere better to move it
    // Phase 33 ANTI-FLAP: for an already-assigned task, hold it unless the target
    // is meaningfully better (hysteresis margin) AND it has served a minimum
    // residency. UNASSIGNED tasks always place (no current node → no flap risk).
    if (c.staleAssignee) {
      if (minResidencyMs > 0 && c.assignedAtMs && (now - c.assignedAtMs) < minResidencyMs) continue;
      if (hysteresis > 0) {
        const curScore = (load[c.staleAssignee] || 0) / (_nodeCapacity(c.staleAssignee) * _healthFactor(c.staleAssignee, opts));
        const tgtScore = (load[target] || 0) / (_nodeCapacity(target) * _healthFactor(target, opts));
        if ((curScore - tgtScore) < hysteresis) continue; // improvement too small → don't flap
      }
    }
    assignTask(c.t.id, target, { now });
    if (c.staleAssignee && c.staleAssignee in load) load[c.staleAssignee] = Math.max(0, load[c.staleAssignee] - c.weight);
    load[target] = (load[target] || 0) + c.weight;
    rebalanced.push({ taskId: c.t.id, from: c.staleAssignee, to: target, weight: c.weight });
  }
  return { rebalanced };
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
  assignTask, assignmentFor, releaseAssignment, myAssignments, handoffTask, startAutoRenew,
  rebalance, publishNodeHealth, deriveNodeHealth, publishDerivedNodeHealth,
  publishTickHealth, clusterTickHealth
};
