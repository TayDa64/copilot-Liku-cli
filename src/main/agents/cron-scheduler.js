/**
 * Cron Scheduler Consumer — productionizes cron device schedules (Pillar 3, Phase 22).
 *
 * device-schedule.js knows WHICH cron rules are due; this consumer turns a due
 * rule into a bounded, human-gated Supervisor task via the SAME escalation
 * machinery used by power anomalies (dedupe / coalesce / cooldown / persistence).
 *
 *   deviceSchedule.proposeCronTasks(now)
 *     → (per-device dedup + cooldown)
 *       → SupervisorAgent.createPeripheralTask()  (status: pending-review)
 *         → orchestrator.emit('supervisor:task' + 'supervisor:cron-task')
 *
 * SAFETY CONTRACT (non-negotiable):
 *   - A cron task is a REVIEWABLE work item — it is NEVER executed here. Actuating
 *     it still requires PAL.execute (DCP → class gate → pending/confirm); Class A
 *     stays confirm-gated. `autonomousAction` is always false.
 *   - TIMER-FREE by default: `tick(now)` is called on demand (CLI / an external
 *     scheduler). An optional interval is available but OFF unless requested, and
 *     its timer is unref'd so it never keeps the process alive.
 *   - Best-effort + non-blocking + strictly feature-flag gated.
 */

'use strict';

const { AgentRole } = require('./base-agent');

const DEFAULT_COOLDOWN_MS = 300000; // 5 min per device:action (avoid intra-minute dupes)

/**
 * Attach a cron scheduler to an orchestrator. Returns a `tick(now)` you invoke to
 * evaluate due cron rules and create human-gated Supervisor tasks.
 * @param {object} orchestrator EventEmitter with an `agents` map.
 * @param {object} [options]
 * @param {object} [options.deviceSchedule] Override the device-schedule module (tests).
 * @param {() => object} [options.getSupervisor] Override supervisor lookup.
 * @param {number} [options.cooldownMs] Per-device:action dedup cooldown.
 * @param {() => number} [options.now] Injectable clock (tests).
 * @param {number} [options.intervalMs] OPTIONAL background tick interval (off by default).
 * @returns {{ tick:(now?:Date|number)=>object, detach:()=>void }}
 */
function attachCronScheduler(orchestrator, options = {}) {
  if (!orchestrator || typeof orchestrator.on !== 'function') {
    return { tick: () => ({ created: [] }), detach: () => {} };
  }
  const deviceSchedule = options.deviceSchedule || require('../peripherals/device-schedule');
  const getSupervisor = typeof options.getSupervisor === 'function'
    ? options.getSupervisor
    : () => (orchestrator.agents && typeof orchestrator.agents.get === 'function'
        ? orchestrator.agents.get(AgentRole.SUPERVISOR)
        : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Number(options.cooldownMs)
    : (Number(process.env.LIKU_PERIPHERAL_CRON_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS);
  const lastSeen = new Map(); // deviceId:action → last-emitted ms (dedup guard)

  /** Build a bounded, advisory notification shaped for the task machinery. */
  function _notificationFor(cronTask) {
    return {
      id: cronTask.id,
      at: cronTask.proposedAt || new Date(now()).toISOString(),
      source: 'cron',
      kind: 'cron-schedule',
      device: { id: cronTask.deviceId, class: cronTask.klass || 'C', kind: 'cron' },
      breach: { metric: 'cron', level: cronTask.action, value: cronTask.cron, threshold: null },
      severity: cronTask.requiresHuman ? 'warning' : 'info',
      advisory: cronTask.advisory,
      requiresHuman: !!cronTask.requiresHuman,
      autonomousAction: false,
      safety: 'physical-actions-require-pal-gating',
      anomalyType: null
    };
  }

  function tick(when) {
    if (typeof deviceSchedule.enabled === 'function' && !deviceSchedule.enabled()) return { created: [] };
    const at = when instanceof Date ? when : (Number.isFinite(when) ? new Date(when) : new Date(now()));
    let due = [];
    try { due = deviceSchedule.proposeCronTasks(at) || []; } catch { due = []; }
    const created = [];
    const supervisor = getSupervisor();
    for (const cronTask of due) {
      const dedupeKey = `${cronTask.deviceId}:${cronTask.action}`;
      const prev = lastSeen.get(dedupeKey);
      if (cooldownMs > 0 && prev != null && (now() - prev) < cooldownMs) continue;
      lastSeen.set(dedupeKey, now());
      const notification = _notificationFor(cronTask);
      let task = null;
      if (supervisor && typeof supervisor.createPeripheralTask === 'function') {
        task = supervisor.createPeripheralTask(notification, {
          source: 'cron',
          proposedAction: { action: cronTask.action, params: cronTask.params || {} }
        });
      }
      if (task) {
        created.push(task);
        try { orchestrator.emit('supervisor:task', task); } catch { /* non-fatal */ }
        try { orchestrator.emit('supervisor:cron-task', task); } catch { /* non-fatal */ }
      }
    }
    return { created };
  }

  let timer = null;
  if (Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0) {
    timer = setInterval(() => { try { tick(); } catch { /* best-effort */ } }, Number(options.intervalMs));
    if (timer && typeof timer.unref === 'function') timer.unref(); // never keep the process alive
  }

  return {
    tick,
    detach: () => { if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; } }
  };
}

module.exports = { attachCronScheduler, DEFAULT_COOLDOWN_MS };
