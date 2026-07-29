/**
 * Fleet Degradation Notifier — advisory, human-gated fleet-health alerts (Phase 40).
 *
 * Pipeline (all PURE OBSERVATION → proposal, never actuation):
 *   fleet-snapshot.degradation()  (trend over the persisted snapshot history)
 *     → buildDegradationNotification()  (bounded, advisory-only)
 *       → cluster publishNotification (fleet-visible, cluster-gated, best-effort)
 *         → SupervisorAgent.createPeripheralTask()  (human-gated, deduped/cooldown)
 *
 * SAFETY:
 *   - DEFAULT OFF: gated by LIKU_PERIPHERAL_FLEET_DEGRADE_ALERTS=1 (or options.enabled)
 *     AND the fleet-snapshot store must itself be enabled (opt-in persistence). No
 *     snapshots → no history → no alert.
 *   - PURE OBSERVATION + ADVISORY: the notification carries autonomousAction:false on
 *     a read-only synthetic device; it NEVER actuates, NEVER rebalances, and NEVER
 *     suppresses a critical recovery path. It only asks a human to look.
 *   - Deduped per signal-set with a cooldown so a sustained degradation does not
 *     re-page. Cluster-gated mirroring is best-effort; single-machine still works.
 */

'use strict';

const { AgentRole } = require('./base-agent');

const DEFAULT_COOLDOWN_MS = 3600000; // 1h per degradation signature

function alertsEnabled(options = {}) {
  if (options && options.enabled === true) return true;
  return String(process.env.LIKU_PERIPHERAL_FLEET_DEGRADE_ALERTS || '').trim() === '1';
}

/** Build a bounded, advisory notification describing a fleet-health degradation. */
function buildDegradationNotification(degradation, opts = {}) {
  const d = degradation || {};
  const at = Number.isFinite(opts.now) ? new Date(opts.now).toISOString() : new Date().toISOString();
  const names = (d.signals || []).map((s) => s.name);
  const advisory = `fleet health degraded (${names.join(', ') || 'signals'}) over the recent window — review node health / contention (advisory only)`;
  return {
    id: `fleet-degrade-${names.join('-') || 'signal'}-${Date.now()}`,
    at,
    source: 'fleet-degradation',
    kind: 'fleet-degradation',
    // Read-only synthetic device so the task machinery treats it as non-actuating.
    device: { id: 'fleet', class: 'C', kind: 'fleet' },
    breach: { metric: 'fleet-health', level: d.severity || 'warning', value: names.length, threshold: null },
    severity: d.severity === 'high' ? 'high' : 'warning',
    advisory,
    requiresHuman: true,
    autonomousAction: false,
    safety: 'observation-only-no-actuation',
    anomalyType: null,
    fleetDegradation: { signals: d.signals || [], points: d.points, windowFrom: d.windowFrom, windowTo: d.windowTo },
    dedupeKey: `fleet-degradation:${names.sort().join(',')}:${d.severity || 'warning'}`
  };
}

/**
 * Attach a fleet-degradation notifier to an orchestrator. Returns a `tick(now)` you
 * invoke to evaluate the persisted fleet-snapshot history and raise a human-gated
 * task when fleet health has declined. Default OFF.
 * @param {object} orchestrator EventEmitter with an `agents` map.
 * @param {object} [options]
 * @param {object} [options.snapshot] Override the fleet-snapshot module (tests).
 * @param {() => object} [options.getSupervisor] Override supervisor lookup.
 * @param {boolean} [options.enabled] Force-enable (overrides the env flag).
 * @param {object} [options.detect] Detection thresholds passed to degradation().
 * @param {number} [options.cooldownMs] Per-signature dedup cooldown.
 * @param {() => number} [options.now] Injectable clock (tests).
 * @returns {{ tick:(now?:Date|number)=>object, detach:()=>void }}
 */
function attachFleetDegradationNotifier(orchestrator, options = {}) {
  if (!orchestrator || typeof orchestrator.on !== 'function') {
    return { tick: () => ({ created: [] }), detach: () => {} };
  }
  const snapshot = options.snapshot || require('../peripherals/fleet-snapshot');
  const getSupervisor = typeof options.getSupervisor === 'function'
    ? options.getSupervisor
    : () => (orchestrator.agents && typeof orchestrator.agents.get === 'function'
        ? orchestrator.agents.get(AgentRole.SUPERVISOR)
        : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Number(options.cooldownMs)
    : (Number(process.env.LIKU_PERIPHERAL_FLEET_DEGRADE_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS);
  const lastSeen = new Map(); // dedupeKey → last-emitted ms

  function tick(when) {
    if (!alertsEnabled(options)) return { created: [] };
    if (typeof snapshot.enabled === 'function' && !snapshot.enabled()) return { created: [] };
    const at = when instanceof Date ? when.getTime() : (Number.isFinite(when) ? when : now());
    let deg = null;
    try { deg = snapshot.degradation(options.detect || {}); } catch { deg = null; }
    if (!deg || !deg.degraded) return { created: [] };
    const notification = buildDegradationNotification(deg, { now: at });
    const key = notification.dedupeKey;
    const prev = lastSeen.get(key);
    if (cooldownMs > 0 && prev != null && (at - prev) < cooldownMs) return { created: [] };
    lastSeen.set(key, at);
    const created = [];
    // Fleet-visible advisory notification (compact, cluster-gated, best-effort).
    try { require('../peripherals/cluster-tasks').publishNotification(notification); } catch { /* non-fatal */ }
    const supervisor = getSupervisor();
    if (supervisor && typeof supervisor.receiveNotification === 'function') {
      try { supervisor.receiveNotification(notification); } catch { /* non-fatal */ }
    }
    let task = null;
    if (supervisor && typeof supervisor.createPeripheralTask === 'function') {
      task = supervisor.createPeripheralTask(notification, { source: 'fleet-degradation' });
    }
    if (task) {
      created.push(task);
      try { orchestrator.emit('supervisor:task', task); } catch { /* non-fatal */ }
    }
    return { created, notification };
  }

  return { tick, detach: () => {} };
}

module.exports = { attachFleetDegradationNotifier, buildDegradationNotification, alertsEnabled };
