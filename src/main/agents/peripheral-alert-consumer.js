/**
 * Peripheral Alert Consumer — closes the peripheral loop (Pillar 3, Phase 7).
 *
 * The PeripheralMonitorAgent EMITS a decoupled `peripheral:alert` event on the
 * orchestrator when a significant, debounced threshold breach occurs. This
 * consumer is the SAFE, human-gated CONSUMER of that event:
 *
 *   orchestrator 'peripheral:alert' (structured context)
 *     → buildSupervisorNotification() (bounded, advisory-only)
 *       → SupervisorAgent.receiveNotification() (bounded inbox, human-gated)
 *         → orchestrator.emit('supervisor:notification', ...) (for CLI/UI/telemetry)
 *
 * SAFETY CONTRACT (non-negotiable):
 *   - This module NEVER actuates hardware and NEVER calls the LLM autonomously.
 *   - The notification is ADVISORY. `requiresHuman` is always true for Class A
 *     devices and `autonomousAction` is always false.
 *   - Any physical response a human later approves still flows through the PAL:
 *       PAL.execute() → DCP evaluateCommand → class gate → pending/confirm.
 *   - Consumption is best-effort + non-blocking: a failure here never breaks the
 *     orchestrator or the monitor.
 */

'use strict';

const { AgentRole } = require('./base-agent');

/** Map a breach context to a coarse severity. @private */
function _severityFor(context) {
  const cls = context && context.device && context.device.class;
  const level = context && context.breach && context.breach.level;
  if (cls === 'A') return 'critical'; // physical/actuation-capable devices
  return level === 'high' || level === 'low' ? 'warning' : 'info';
}

/**
 * Build the bounded, advisory-only notification handed to the Supervisor.
 * The shape is intentionally small (no raw payloads, no executable actions) so
 * it cannot overwhelm the Supervisor or leak an actuation path.
 */
function buildSupervisorNotification(context) {
  const ctx = context || {};
  const device = ctx.device || {};
  const breach = ctx.breach || {};
  // Class A (actuation-capable / lock-like) always requires a human in the loop.
  const requiresHuman = device.class === 'A';
  const advisory = ctx.suggestedAction && ctx.suggestedAction.message
    ? ctx.suggestedAction.message
    : `${device.kind || 'device'} ${device.id || '(unknown)'}: `
      + `${breach.metric || 'signal'} ${breach.level || 'threshold'}`;

  return {
    id: `periph-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: ctx.at || new Date().toISOString(),
    source: 'peripheral-monitor',
    kind: 'peripheral-alert',
    device: { id: device.id, class: device.class, kind: device.kind, name: device.name },
    breach: {
      metric: breach.metric,
      level: breach.level,
      value: breach.value,
      threshold: breach.threshold
    },
    severity: _severityFor(ctx),
    // ADVISORY ONLY — a human-readable suggestion, never an executable command.
    advisory,
    requiresHuman,
    // Explicit safety contract carried end-to-end for any downstream consumer.
    safety: 'physical-actions-require-pal-gating',
    autonomousAction: false,
    groundedFacts: ctx.groundedFacts || {}
  };
}

/**
 * Attach a consumer that turns `peripheral:alert` events into bounded,
 * human-gated Supervisor notifications. Best-effort + non-blocking.
 *
 * @param {object} orchestrator EventEmitter with an `agents` map.
 * @param {object} [options]
 * @param {() => object} [options.getSupervisor] Override supervisor lookup.
 * @param {(n: object) => void} [options.onNotification] Optional side-channel sink.
 * @returns {{ detach: () => void }}
 */
function attachPeripheralAlertConsumer(orchestrator, options = {}) {
  if (!orchestrator || typeof orchestrator.on !== 'function') {
    return { detach: () => {} };
  }

  const getSupervisor = typeof options.getSupervisor === 'function'
    ? options.getSupervisor
    : () => (orchestrator.agents && typeof orchestrator.agents.get === 'function'
        ? orchestrator.agents.get(AgentRole.SUPERVISOR)
        : null);

  const listener = (context) => {
    try {
      const notification = buildSupervisorNotification(context || {});

      // Deliver into the Supervisor's bounded, human-gated inbox (if present).
      let delivered = null;
      const supervisor = getSupervisor();
      if (supervisor && typeof supervisor.receiveNotification === 'function') {
        delivered = supervisor.receiveNotification(notification);
      }

      // Re-emit a decoupled event so CLI / chat UI / telemetry can react too.
      try { orchestrator.emit('supervisor:notification', delivered || notification); } catch { /* non-fatal */ }

      if (typeof options.onNotification === 'function') {
        try { options.onNotification(delivered || notification); } catch { /* non-fatal */ }
      }
    } catch { /* consumption is best-effort + non-blocking */ }
  };

  orchestrator.on('peripheral:alert', listener);
  return {
    detach: () => { try { orchestrator.removeListener('peripheral:alert', listener); } catch { /* ignore */ } }
  };
}

module.exports = { attachPeripheralAlertConsumer, buildSupervisorNotification };
