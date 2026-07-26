/**
 * Schedule-Expiry Notifier — surfaces UPCOMING or JUST-EXPIRED confirmed power
 * schedules as bounded, human-gated Supervisor notifications + tasks (Pillar 3,
 * Phase 30).
 *
 * A confirmed restrict-only schedule may be TIME-BOXED (Phase 29 `expiresAt`).
 * When such a cap is about to lapse (or has just lapsed) an operator should SEE
 * it and decide whether to re-confirm / adjust it. This consumer turns that
 * observation into the SAME escalation pipeline used by power anomalies + cron:
 *
 *   power-schedule-advisor.expiringSchedules(now)
 *     → (per rule:state dedup)
 *       → SupervisorAgent.createPeripheralTask()  (status: pending-review)
 *         → orchestrator.emit('supervisor:task' + 'supervisor:schedule-expiry')
 *           → cluster-tasks.publishTask/publishNotification (fleet-visible)
 *
 * SAFETY CONTRACT (non-negotiable):
 *   - STRICTLY ADVISORY. This module NEVER re-creates, extends, or mutates a
 *     schedule — it only NOTIFIES. Re-confirming a cap remains an explicit human
 *     action (`createConfirmedSchedule` with a fresh expiry). `autonomousAction`
 *     is always false.
 *   - TIMER-FREE by default: `tick(now)` is called on demand. An optional interval
 *     is available but OFF unless requested, and its timer is unref'd.
 *   - Best-effort + non-blocking + strictly feature-flag gated.
 *
 * Config:
 *   LIKU_PERIPHERAL_SCHEDULE_EXPIRY_WARN_MS   default 3600000 (1h look-ahead)
 *   LIKU_PERIPHERAL_SCHEDULE_EXPIRY_GRACE_MS  default 3600000 (1h just-expired grace)
 *   LIKU_PERIPHERAL_EXPIRY_NOTIFY_COOLDOWN_MS default 3600000 (per rule:state dedup)
 */

'use strict';

const { AgentRole } = require('./base-agent');

const DEFAULT_COOLDOWN_MS = 3600000; // 1h per rule:state (avoid re-paging the same lapse)

/** Build a bounded, advisory notification for an expiring/expired schedule. */
function buildExpiryNotification(rule, opts = {}) {
  const r = rule || {};
  const state = r.state === 'expired' ? 'expired' : 'upcoming';
  const at = Number.isFinite(opts.now) ? new Date(opts.now).toISOString() : new Date().toISOString();
  const advisory = state === 'expired'
    ? `schedule cap for ${r.id} (${r.fromHour}:00→${r.toHour}:00 ≤${r.maxW}W) has LAPSED — re-confirm to keep restricting`
    : `schedule cap for ${r.id} (${r.fromHour}:00→${r.toHour}:00 ≤${r.maxW}W) expires soon — re-confirm to keep restricting`;
  return {
    id: `sched-expiry-${r.id}-${r.fromHour}-${r.toHour}-${state}-${Date.now()}`,
    at,
    source: 'schedule-expiry',
    kind: 'schedule-expiry',
    // Read-only synthetic device so the task machinery treats it as non-actuating.
    device: { id: r.id, class: 'C', kind: 'schedule' },
    breach: { metric: 'schedule-expiry', level: state, value: r.maxW, threshold: null },
    severity: state === 'expired' ? 'warning' : 'info',
    advisory,
    requiresHuman: false,
    autonomousAction: false,
    safety: 'physical-actions-require-pal-gating',
    anomalyType: null,
    scheduleExpiry: { id: r.id, fromHour: r.fromHour, toHour: r.toHour, maxW: r.maxW, expiresAt: r.expiresAt, state, expiresInMs: r.expiresInMs },
    dedupeKey: `schedule-expiry:${r.id}:${r.fromHour}:${r.toHour}:${state}`
  };
}

/**
 * Attach a schedule-expiry notifier to an orchestrator. Returns a `tick(now)` you
 * invoke to evaluate expiring/expired schedules and create human-gated tasks.
 * @param {object} orchestrator EventEmitter with an `agents` map.
 * @param {object} [options]
 * @param {object} [options.advisor] Override the power-schedule-advisor module (tests).
 * @param {() => object} [options.getSupervisor] Override supervisor lookup.
 * @param {number} [options.cooldownMs] Per rule:state dedup cooldown.
 * @param {number} [options.withinMs] Upcoming look-ahead window.
 * @param {number} [options.graceMs] Just-expired grace window.
 * @param {() => number} [options.now] Injectable clock (tests).
 * @param {number} [options.intervalMs] OPTIONAL background tick interval (off by default).
 * @returns {{ tick:(now?:Date|number)=>object, detach:()=>void }}
 */
function attachScheduleExpiryNotifier(orchestrator, options = {}) {
  if (!orchestrator || typeof orchestrator.on !== 'function') {
    return { tick: () => ({ created: [] }), detach: () => {} };
  }
  const advisor = options.advisor || require('../peripherals/power-schedule-advisor');
  const getSupervisor = typeof options.getSupervisor === 'function'
    ? options.getSupervisor
    : () => (orchestrator.agents && typeof orchestrator.agents.get === 'function'
        ? orchestrator.agents.get(AgentRole.SUPERVISOR)
        : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Number(options.cooldownMs)
    : (Number(process.env.LIKU_PERIPHERAL_EXPIRY_NOTIFY_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS);
  const lastSeen = new Map(); // dedupeKey → last-emitted ms

  function tick(when) {
    if (typeof advisor.enabled === 'function' && !advisor.enabled()) return { created: [] };
    const at = when instanceof Date ? when.getTime() : (Number.isFinite(when) ? when : now());
    let expiring = [];
    try { expiring = advisor.expiringSchedules({ now: at, withinMs: options.withinMs, graceMs: options.graceMs }) || []; }
    catch { expiring = []; }
    const created = [];
    const supervisor = getSupervisor();
    for (const rule of expiring) {
      const notification = buildExpiryNotification(rule, { now: at });
      const key = notification.dedupeKey;
      const prev = lastSeen.get(key);
      if (cooldownMs > 0 && prev != null && (at - prev) < cooldownMs) continue;
      lastSeen.set(key, at);
      // Fleet-visible advisory notification (compact, cluster-gated, best-effort).
      try { require('../peripherals/cluster-tasks').publishNotification(notification); } catch { /* non-fatal */ }
      let task = null;
      if (supervisor && typeof supervisor.receiveNotification === 'function') {
        try { supervisor.receiveNotification(notification); } catch { /* non-fatal */ }
      }
      if (supervisor && typeof supervisor.createPeripheralTask === 'function') {
        task = supervisor.createPeripheralTask(notification, { source: 'schedule-expiry' });
      }
      if (task) {
        created.push(task);
        try { orchestrator.emit('supervisor:task', task); } catch { /* non-fatal */ }
        try { orchestrator.emit('supervisor:schedule-expiry', task); } catch { /* non-fatal */ }
        try { require('../peripherals/cluster-tasks').publishTask(task); } catch { /* non-fatal */ }
      }
      if (typeof options.onExpiry === 'function') { try { options.onExpiry(notification); } catch { /* non-fatal */ } }
    }
    return { created };
  }

  let timer = null;
  if (Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0) {
    timer = setInterval(() => { try { tick(); } catch { /* best-effort */ } }, Number(options.intervalMs));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    tick,
    detach() { if (timer) { clearInterval(timer); timer = null; } }
  };
}

module.exports = { attachScheduleExpiryNotifier, buildExpiryNotification };
