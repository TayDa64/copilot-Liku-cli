/**
 * PeripheralMonitor — event-driven sensor intelligence (Pillar 3, Phase 5).
 *
 * Subscribes to PAL 'reading' events (event-driven, not polling) and:
 *   1. Feeds grounded sensor.* facts back into the cognitive substrate via the
 *      gated proposeUpdate() (source 'telemetry', TTL'd, evidence-excluded from
 *      the default fragment but queryable).
 *   2. Evaluates thresholds; on a significant breach it records a hardware.*
 *      alert (injected) and "wakes the Supervisor" through an injectable hook.
 *
 * Fully feature-flag aware (via the PAL) and defensive: every callback is
 * wrapped so a bad reading can never crash the process. No timers of its own —
 * it reacts to driver-pushed readings (real drivers) or PAL.ingestSensorReading
 * (mock/test), which is what makes it genuinely event-driven.
 */

'use strict';

/** Default per-metric thresholds. Overridable via constructor options. */
const DEFAULT_THRESHOLDS = Object.freeze({
  celsius: { high: 30, low: 2 },
  humidity: { high: 80 },
  ppm: { high: 1000 },
  battery: { low: 15 }
});

const FACT_TTL_SEC = 3600; // sensor/alert facts are transient by nature

class PeripheralMonitor {
  constructor(options = {}) {
    this.pal = options.pal || require('./peripheral-abstraction-layer');
    this.systemContext = options.systemContext || require('../system-context-manager');
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.onSupervisorWake = typeof options.onSupervisorWake === 'function' ? options.onSupervisorWake : null;
    this._unsub = null;
  }

  /** Begin listening for 'reading' events. No-op when peripherals are disabled. */
  start() {
    if (!this.pal.isPeripheralsEnabled()) return false;
    if (this._unsub) return true;
    this._unsub = this.pal.on('reading', (ev) => this._onReading(ev));
    return true;
  }

  /** Stop listening. */
  stop() {
    if (this._unsub) { try { this._unsub(); } catch { /* ignore */ } this._unsub = null; }
  }

  /**
   * Handle one sensor reading: ground facts + evaluate thresholds.
   * @private
   */
  _onReading(ev) {
    try {
      const id = ev && ev.id;
      const metrics = (ev && ev.metrics) || {};
      if (!id) return;

      // 1) Ground sensor.* facts (evidence-excluded from default fragment).
      const delta = {};
      for (const [k, v] of Object.entries(metrics)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          delta[`sensor.${id}.${k}`] = v;
        }
      }
      if (Object.keys(delta).length) {
        this.systemContext.proposeUpdate(delta, { source: 'telemetry', confidence: 0.95, ttl: FACT_TTL_SEC });
      }

      // 2) Threshold evaluation → significant event.
      const breach = this._evaluate(metrics);
      if (breach) {
        // hardware.* alert IS injected (the model should be aware of it).
        this.systemContext.proposeUpdate(`hardware.${id}.alert`, `${breach.metric}:${breach.level}`, {
          source: 'telemetry', confidence: 0.95, ttl: FACT_TTL_SEC
        });
        this._wakeSupervisor({ id, breach, metrics });
      }
    } catch { /* a bad reading must never crash monitoring */ }
  }

  /**
   * Return the first threshold breach found in a reading, or null.
   * @private
   */
  _evaluate(metrics) {
    for (const [metric, value] of Object.entries(metrics || {})) {
      if (typeof value !== 'number') continue;
      const t = this.thresholds[metric];
      if (!t) continue;
      if (Number.isFinite(t.high) && value > t.high) return { metric, value, level: 'high', threshold: t.high };
      if (Number.isFinite(t.low) && value < t.low) return { metric, value, level: 'low', threshold: t.low };
    }
    return null;
  }

  /**
   * Wake the Supervisor with a peripheral alert. The hook is injectable so the
   * multi-agent orchestrator can subscribe without this module depending on it.
   * @private
   */
  _wakeSupervisor(payload) {
    const event = { type: 'peripheral-alert', ...payload, at: new Date().toISOString() };
    if (this.onSupervisorWake) {
      try { this.onSupervisorWake(event); } catch { /* hook errors are non-fatal */ }
    }
    return event;
  }
}

let _instance = null;
function getInstance(options) {
  if (!_instance) _instance = new PeripheralMonitor(options);
  return _instance;
}

module.exports = { PeripheralMonitor, getInstance, DEFAULT_THRESHOLDS };
