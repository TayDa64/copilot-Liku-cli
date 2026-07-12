/**
 * Power Anomaly Consumer — turns advisory `power-anomaly` events into bounded,
 * human-gated Supervisor notifications + tasks (Pillar 3, Phase 14).
 *
 * The PAL emits a decoupled `power-anomaly` event (from power-anomaly.js via
 * recordPowerSample) when a spike / sustained deviation / over-budget condition
 * is detected in the rolling power history. This consumer is the SAFE bridge
 * from that observability signal into the existing escalation pipeline:
 *
 *   PAL 'power-anomaly' (advisory)
 *     → buildAnomalyNotification() (bounded, advisory-only)
 *       → SupervisorAgent.receiveNotification() (bounded inbox + channels)
 *         → orchestrator.emit('supervisor:notification')
 *           → (optional) SupervisorAgent.createPeripheralTask() (reviewable task)
 *             → orchestrator.emit('supervisor:task')
 *
 * SAFETY CONTRACT (non-negotiable):
 *   - Anomalies and any resulting tasks are STRICTLY ADVISORY. This module never
 *     actuates hardware and never calls the LLM. `autonomousAction` is always
 *     false; a task is a REVIEWABLE work item that never runs itself.
 *   - Consumer-level DEDUPLICATION + COOLDOWN prevent a flapping power signal
 *     from spamming the task queue (independent of the Supervisor's own cooldown).
 *   - Best-effort + non-blocking + strictly feature-flag gated (the PAL event bus
 *     is inert unless LIKU_ENABLE_PERIPHERALS=1).
 */

'use strict';

const { AgentRole } = require('./base-agent');

/**
 * Phase 15 — anomaly SEVERITY TIERS. Different anomaly types map to different
 * task behaviour: severity (→ Supervisor priority/escalation routing) and a
 * per-tier dedup/cooldown window. This is STRICTLY ADVISORY prioritisation —
 * no tier ever actuates hardware or bypasses the human gate.
 *
 *   over-budget → 'critical' : most visible (high priority, escalate), never
 *                              auto-acknowledged, shortest cooldown (surface fast).
 *   sustained   → 'warning'  : medium priority, longer cooldown (persistent →
 *                              don't re-page as often).
 *   spike       → 'warning'  : medium priority, standard cooldown.
 *   (other)     → 'info'     : low priority, longest cooldown.
 */
const ANOMALY_TIERS = Object.freeze({
  'over-budget': { severity: 'critical', cooldownMs: 15000 },
  'sustained': { severity: 'warning', cooldownMs: 90000 },
  'spike': { severity: 'warning', cooldownMs: 60000 }
});
const DEFAULT_TIER = Object.freeze({ severity: 'info', cooldownMs: 120000 });

/** Resolve the tier (severity + cooldown) for an anomaly type. @private */
function _tierFor(type) {
  return ANOMALY_TIERS[String(type || '').toLowerCase()] || DEFAULT_TIER;
}

/** Map an anomaly type to its tiered severity. Advisory only. @private */
function _severityFor(anomaly) {
  return _tierFor(anomaly && anomaly.type).severity;
}

/**
 * Build a bounded, advisory-only notification from a power anomaly. The shape
 * mirrors a peripheral alert so it reuses the Supervisor's task machinery
 * (dedupe, coalesce, escalation routing) without any actuation surface.
 */
function buildAnomalyNotification(event) {
  const ev = event || {};
  const anomaly = ev.anomaly || {};
  const type = String(anomaly.type || 'anomaly');
  const deviceId = anomaly.device || 'power-budget';
  return {
    id: `power-anom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: anomaly.at || ev.at || new Date().toISOString(),
    source: 'power-anomaly',
    kind: 'power-anomaly',
    // Represent the power budget as a read-only (Class C) synthetic device so the
    // task machinery treats it as non-actuation-capable.
    device: { id: deviceId, class: 'C', kind: 'power' },
    breach: {
      metric: 'power',
      level: type,
      value: anomaly.valueW,
      threshold: anomaly.thresholdW != null ? anomaly.thresholdW : anomaly.budgetW
    },
    severity: _severityFor(anomaly),
    advisory: anomaly.advisory || `power ${type}: ${anomaly.valueW}W (baseline ${ev.baselineW}W)`,
    // Power anomalies are advisory; a human reviews. Never requires a lock-style
    // human gate (that is reserved for Class A physical actions).
    requiresHuman: false,
    safety: 'physical-actions-require-pal-gating',
    autonomousAction: false,
    anomalyType: type,
    baselineW: ev.baselineW
  };
}

/**
 * Attach a consumer that turns PAL `power-anomaly` events into bounded,
 * human-gated Supervisor notifications + tasks. Best-effort + non-blocking.
 *
 * @param {object} orchestrator EventEmitter with an `agents` map.
 * @param {object} [options]
 * @param {object} [options.pal] Override the PAL module (tests).
 * @param {() => object} [options.getSupervisor] Override supervisor lookup.
 * @param {(n:object)=>void} [options.onAnomaly] Optional side-channel sink.
 * @param {boolean} [options.createTasks] Create tasks (default true).
 * @param {number} [options.cooldownMs] Consumer-level dedup cooldown.
 * @param {() => number} [options.now] Injectable clock (tests).
 * @returns {{ detach: () => void }}
 */
function attachPowerAnomalyConsumer(orchestrator, options = {}) {
  if (!orchestrator || typeof orchestrator.on !== 'function') {
    return { detach: () => {} };
  }
  const pal = options.pal || require('../peripherals/peripheral-abstraction-layer');
  if (typeof pal.on !== 'function') return { detach: () => {} };

  const getSupervisor = typeof options.getSupervisor === 'function'
    ? options.getSupervisor
    : () => (orchestrator.agents && typeof orchestrator.agents.get === 'function'
        ? orchestrator.agents.get(AgentRole.SUPERVISOR)
        : null);

  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // An explicit cooldown (option or env) overrides the per-tier defaults for ALL
  // tiers; otherwise each anomaly type uses its own tier cooldown window.
  const explicitCooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Number(options.cooldownMs)
    : (Number(process.env.LIKU_PERIPHERAL_ANOMALY_COOLDOWN_MS) || null);
  const cooldownForType = (type) => (explicitCooldownMs != null ? explicitCooldownMs : _tierFor(type).cooldownMs);
  const lastSeen = new Map(); // dedupeKey → last-emitted ms (flapping guard)

  const listener = (event) => {
    try {
      const notification = buildAnomalyNotification(event || {});
      // Consumer-level dedup/cooldown so a bouncing power signal cannot flood the
      // pipeline, independent of the Supervisor's own task cooldown. The window is
      // tier-specific (over-budget surfaces faster than a routine spike).
      const dedupeKey = `${notification.anomalyType}:${notification.device.id}`;
      const cd = cooldownForType(notification.anomalyType);
      const prev = lastSeen.get(dedupeKey);
      if (cd > 0 && prev != null && (now() - prev) < cd) return;
      lastSeen.set(dedupeKey, now());

      let delivered = null;
      const supervisor = getSupervisor();
      if (supervisor && typeof supervisor.receiveNotification === 'function') {
        delivered = supervisor.receiveNotification(notification);
      }
      const finalNotification = delivered || notification;
      try { orchestrator.emit('supervisor:notification', finalNotification); } catch { /* non-fatal */ }

      const createTasks = options.createTasks !== false
        && String(process.env.LIKU_PERIPHERAL_CREATE_TASKS || '1') !== '0';
      if (createTasks && supervisor && typeof supervisor.createPeripheralTask === 'function') {
        const task = supervisor.createPeripheralTask(finalNotification, { source: 'power-anomaly' });
        if (task) { try { orchestrator.emit('supervisor:task', task); } catch { /* non-fatal */ } }
      }

      if (typeof options.onAnomaly === 'function') {
        try { options.onAnomaly(finalNotification); } catch { /* non-fatal */ }
      }
    } catch { /* consumption is best-effort + non-blocking */ }
  };

  const off = pal.on('power-anomaly', listener);
  return { detach: () => { try { if (typeof off === 'function') off(); } catch { /* ignore */ } } };
}

module.exports = { attachPowerAnomalyConsumer, buildAnomalyNotification, ANOMALY_TIERS };
