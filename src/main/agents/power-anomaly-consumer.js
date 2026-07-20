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
  // Phase 19: prefer the ATTRIBUTED device (the likely driver) so tasks +
  // schedule suggestions target a real device rather than the aggregate budget.
  const deviceId = anomaly.attributedDevice || anomaly.device || 'power-budget';
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
  const emittedProposals = new Set(); // proposed-schedule ids already surfaced
  const emittedActions = new Set(); // proposed anomaly-action ids already surfaced
  const advisor = options.advisor || (() => { try { return require('../peripherals/power-schedule-advisor'); } catch { return null; } })();
  const actionAdvisor = options.actionAdvisor || (() => { try { return require('../peripherals/anomaly-action-advisor'); } catch { return null; } })();

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

      // Phase 18: feed the schedule advisor. When an anomaly RECURS enough times
      // the advisor PROPOSES a power schedule — surfaced here as an advisory,
      // human-gated suggestion. It is NEVER auto-applied; a human must confirm it
      // (via `power-schedule-advisor.confirm`) before it becomes an active rule.
      if (advisor && typeof advisor.recordAnomaly === 'function') {
        try {
          advisor.recordAnomaly({
            device: finalNotification.device.id,
            type: finalNotification.anomalyType,
            valueW: finalNotification.breach.value,
            budgetW: finalNotification.breach.threshold
          });
          const proposals = advisor.proposeSchedules();
          for (const p of proposals) {
            if (p && p.status === 'proposed' && !emittedProposals.has(p.id)) {
              emittedProposals.add(p.id);
              try { orchestrator.emit('supervisor:schedule-suggestion', p); } catch { /* non-fatal */ }
            }
          }
          // Phase 20: when an OVER-BUDGET breach at this hour is jointly driven by
          // MULTIPLE devices, propose a coordinated multi-device cap (advisory,
          // human-gated). Only fires when 2+ contributors exceed the budget.
          if (finalNotification.anomalyType === 'over-budget' && typeof advisor.proposeMultiDeviceSchedule === 'function') {
            const budgetW = Number(finalNotification.breach && finalNotification.breach.threshold);
            if (Number.isFinite(budgetW) && budgetW > 0) {
              const hour = new Date(finalNotification.at || Date.now()).getHours();
              const multi = advisor.proposeMultiDeviceSchedule({ budgetW, hour });
              if (multi && multi.status === 'proposed' && !emittedProposals.has(multi.id)) {
                emittedProposals.add(multi.id);
                try { orchestrator.emit('supervisor:schedule-suggestion', multi); } catch { /* non-fatal */ }
              }
              // Phase 23: when the forecast band shows a CONTIGUOUS multi-hour
              // over-budget run, propose a coordinated multi-hour window cap.
              if (typeof advisor.proposeMultiHourSchedule === 'function') {
                const mh = advisor.proposeMultiHourSchedule({ budgetW });
                if (mh && mh.status === 'proposed' && !emittedProposals.has(mh.id)) {
                  emittedProposals.add(mh.id);
                  try { orchestrator.emit('supervisor:schedule-suggestion', mh); } catch { /* non-fatal */ }
                }
              }
            }
          }
        } catch { /* advisory pipeline is best-effort */ }
      }

      // Phase 20: advisory anomaly→action patterns for proactive self-healing.
      // When a REAL device keeps tripping anomalies, escalate an advisory action
      // suggestion (reduce-schedule → rotate-token → unpair). STRICTLY ADVISORY:
      // confirmation returns a command for a human to run — never auto-executed.
      if (actionAdvisor && typeof actionAdvisor.recordAnomaly === 'function') {
        try {
          actionAdvisor.recordAnomaly({
            device: finalNotification.device.id,
            type: finalNotification.anomalyType
          });
          const actions = actionAdvisor.proposeActions();
          for (const a of actions) {
            if (a && a.status === 'proposed' && !emittedActions.has(a.id)) {
              emittedActions.add(a.id);
              try { orchestrator.emit('supervisor:anomaly-action', a); } catch { /* non-fatal */ }
            }
          }
          // Phase 23: FLEET-WIDE action — when several distinct devices are
          // persistently anomalous, propose a single advisory rotate-all (still
          // human-gated). Reuses the same escalation event.
          if (typeof actionAdvisor.proposeFleetAction === 'function') {
            const fleet = actionAdvisor.proposeFleetAction();
            if (fleet && fleet.status === 'proposed' && !emittedActions.has(fleet.id)) {
              emittedActions.add(fleet.id);
              try { orchestrator.emit('supervisor:anomaly-action', fleet); } catch { /* non-fatal */ }
            }
          }
        } catch { /* action advisory pipeline is best-effort */ }
      }
    } catch { /* consumption is best-effort + non-blocking */ }
  };

  const off = pal.on('power-anomaly', listener);
  return { detach: () => { try { if (typeof off === 'function') off(); } catch { /* ignore */ } } };
}

module.exports = { attachPowerAnomalyConsumer, buildAnomalyNotification, ANOMALY_TIERS };
