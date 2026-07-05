/**
 * PeripheralMonitor Agent Role — Pillar 3 × Multi-Agent integration (Phase 6).
 *
 * Makes the peripheral layer a FIRST-CLASS participant in the multi-agent system
 * while keeping the low-level PeripheralMonitor fully decoupled from the
 * Supervisor's internals.
 *
 * INTEGRATION PATTERN — event-driven notification (NOT direct Supervisor calls,
 * NOT auto-execution):
 *   PAL 'reading' → PeripheralMonitor threshold breach → onSupervisorWake(event)
 *     → PeripheralMonitorAgent builds a rich context + emits 'peripheral:alert'
 *       on the orchestrator (an EventEmitter).
 *   The orchestrator / Supervisor decides what to do with the alert. NOTHING is
 *   auto-actuated: any physical response still flows through the PAL's gated
 *   proposeUpdate + pending/confirm machinery.
 *
 * RESPONSIBILITIES:
 *   1. Monitor significant peripheral events (event-driven, best-effort).
 *   2. Ground sensor data into the cognitive substrate (via PeripheralMonitor).
 *   3. Surface alerts / hand a structured context to the Supervisor on breach.
 *
 * SAFETY: best-effort + non-blocking + feature-flag gated. The agent never
 * performs a physical action itself; it only OBSERVES and NOTIFIES.
 */

'use strict';

const EventEmitter = require('events');
const { AgentRole } = require('./base-agent');

const RESPONSIBILITIES = Object.freeze([
  'Monitor significant peripheral events (thresholds, state changes) event-driven.',
  'Ground sensor.* facts into the cognitive substrate via gated proposeUpdate.',
  'Surface alerts and hand a structured context to the Supervisor on breach.',
  'Never actuate hardware directly — all physical actions go through PAL gating.'
]);

const CAPABILITIES = Object.freeze(['monitor', 'sensor_grounding', 'alert', 'handoff']);

class PeripheralMonitorAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = options.id || `peripheral-monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.role = AgentRole.PERIPHERAL_MONITOR;
    this.name = 'peripheral-monitor';
    this.description = 'Observes peripheral sensor events, grounds sensor data, and surfaces alerts to the Supervisor. Read-only / observe-and-notify.';
    this.responsibilities = RESPONSIBILITIES;
    this.capabilities = CAPABILITIES;

    this.orchestrator = options.orchestrator || null;
    this.pal = options.pal || require('../peripherals/peripheral-abstraction-layer');
    this.thresholds = options.thresholds || {};
    this.cooldownMs = options.cooldownMs;
    this.hysteresisFraction = options.hysteresisFraction;
    this._monitor = null;
    this._started = false;
  }

  /** Advisory-only suggested action (never auto-executed). @private */
  _suggestAction(device, breach) {
    if (!breach) return null;
    return {
      kind: 'advisory',
      message: `${device.kind || 'device'} ${device.id}: ${breach.metric} ${breach.level} `
        + `(${breach.value} vs threshold ${breach.threshold})`,
      requiresHuman: device.class === 'A'
    };
  }

  /**
   * Build the structured context handed to the Supervisor on a significant event.
   * @private
   */
  _buildWakeContext(event) {
    const device = (this.pal.get && this.pal.get(event.id)) || { id: event.id };
    const groundedFacts = {};
    for (const [k, v] of Object.entries(event.metrics || {})) {
      groundedFacts[`sensor.${event.id}.${k}`] = v;
    }
    return {
      type: 'peripheral-alert',
      at: event.at || new Date().toISOString(),
      device: { id: device.id, class: device.class, kind: device.kind, name: device.name },
      breach: event.breach,
      groundedFacts,
      suggestedAction: this._suggestAction(device, event.breach),
      // Explicit safety contract for any downstream consumer.
      safety: 'physical-actions-require-pal-gating'
    };
  }

  /** Bridge PeripheralMonitor → orchestrator (decoupled, event-only). @private */
  _onWake(event) {
    let context;
    try { context = this._buildWakeContext(event); }
    catch { context = { type: 'peripheral-alert', at: new Date().toISOString(), device: { id: event && event.id }, breach: event && event.breach }; }
    // Local listeners.
    try { this.emit('peripheral:alert', context); } catch { /* non-fatal */ }
    // Decoupled notification to the multi-agent orchestrator (event only).
    if (this.orchestrator && typeof this.orchestrator.emit === 'function') {
      try { this.orchestrator.emit('peripheral:alert', context); } catch { /* non-fatal */ }
    }
    return context;
  }

  attach(orchestrator) { this.orchestrator = orchestrator; return this; }

  /** Start monitoring. No-op (returns false) when peripherals are disabled. */
  start() {
    if (this._started) return true;
    if (!this.pal.isPeripheralsEnabled || !this.pal.isPeripheralsEnabled()) return false;
    const { PeripheralMonitor } = require('../peripherals/peripheral-monitor');
    this._monitor = new PeripheralMonitor({
      pal: this.pal,
      thresholds: this.thresholds,
      cooldownMs: this.cooldownMs,
      hysteresisFraction: this.hysteresisFraction,
      onSupervisorWake: (event) => this._onWake(event)
    });
    this._started = !!this._monitor.start();
    return this._started;
  }

  stop() {
    if (this._monitor) { try { this._monitor.stop(); } catch { /* ignore */ } this._monitor = null; }
    this._started = false;
  }

  /** Role descriptor for the agent roster / state manager. */
  getRoleDescriptor() {
    return {
      id: this.id, role: this.role, name: this.name, description: this.description,
      responsibilities: this.responsibilities, capabilities: this.capabilities
    };
  }

  reset() { /* no persistent per-session state to reset */ }
}

/**
 * Attach a PeripheralMonitorAgent to an orchestrator: register it as a
 * first-class role (state manager + agents map), then start it. Best-effort and
 * non-blocking — failures never break the orchestrator.
 *
 * @param {object} orchestrator
 * @param {object} [options] { thresholds }
 * @returns {{ agent: PeripheralMonitorAgent, started: boolean, detach: () => void }}
 */
function attachPeripheralMonitor(orchestrator, options = {}) {
  const agent = new PeripheralMonitorAgent({ ...options, orchestrator });
  try {
    if (orchestrator && orchestrator.stateManager && typeof orchestrator.stateManager.registerAgent === 'function') {
      orchestrator.stateManager.registerAgent(agent.id, agent.role, agent.capabilities);
    }
    if (orchestrator && orchestrator.agents && typeof orchestrator.agents.set === 'function') {
      orchestrator.agents.set(agent.role, agent);
    }
  } catch { /* registration is best-effort */ }
  let started = false;
  try { started = agent.start(); } catch { started = false; }
  return { agent, started, detach: () => { try { agent.stop(); } catch { /* ignore */ } } };
}

module.exports = { PeripheralMonitorAgent, attachPeripheralMonitor, RESPONSIBILITIES, CAPABILITIES };
