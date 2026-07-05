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
 *
 * SIGNAL QUALITY (Phase 7): raw readings are noisy, so alerts are filtered by:
 *   1. Hysteresis (deadband) — once a metric is breached we do NOT re-alert on
 *      every subsequent breached reading; we hold the "active breach" state
 *      until the value returns safely past a margin below/above the threshold.
 *      This stops flapping when a value hovers right at the threshold.
 *   2. Per-device+metric cooldown (debounce) — even distinct breach transitions
 *      are rate-limited so a rapidly oscillating sensor cannot flood the
 *      Supervisor. Both are configurable (constructor options or env).
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
const DEFAULT_COOLDOWN_MS = 60000; // min gap between alerts for the same device+metric
const DEFAULT_HYSTERESIS_FRACTION = 0.05; // deadband as a fraction of the threshold magnitude

function _numOr(value, fallback) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

class PeripheralMonitor {
  constructor(options = {}) {
    this.pal = options.pal || require('./peripheral-abstraction-layer');
    this.systemContext = options.systemContext || require('../system-context-manager');
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.onSupervisorWake = typeof options.onSupervisorWake === 'function' ? options.onSupervisorWake : null;

    // Signal-quality controls (configurable via options or env).
    this.cooldownMs = _numOr(
      options.cooldownMs,
      _numOr(process.env.LIKU_PERIPHERAL_ALERT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS)
    );
    this.hysteresisFraction = _numOr(
      options.hysteresisFraction,
      _numOr(process.env.LIKU_PERIPHERAL_HYSTERESIS_FRACTION, DEFAULT_HYSTERESIS_FRACTION)
    );
    // Injectable clock for deterministic tests.
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();

    // Per-device+metric state machines: which metrics are currently "in breach"
    // (for hysteresis) and when we last alerted (for cooldown/debounce).
    this._activeBreaches = new Map(); // key `${id}:${metric}` → level ('high'|'low')
    this._lastAlertAt = new Map();    // key `${id}:${metric}` → epoch ms of last alert

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
      //    Grounding happens for EVERY reading — only the *alert* is filtered.
      const delta = {};
      for (const [k, v] of Object.entries(metrics)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          delta[`sensor.${id}.${k}`] = v;
        }
      }
      if (Object.keys(delta).length) {
        this.systemContext.proposeUpdate(delta, { source: 'telemetry', confidence: 0.95, ttl: FACT_TTL_SEC });
      }

      // 2) Significance-filtered threshold evaluation (debounce + hysteresis).
      const breach = this._evaluateSignificant(id, metrics);
      if (breach) {
        // hardware.* alert IS injected (the model should be aware of it).
        this.systemContext.proposeUpdate(`hardware.${id}.alert`, `${breach.metric}:${breach.level}`, {
          source: 'telemetry', confidence: 0.95, ttl: FACT_TTL_SEC
        });
        this._wakeSupervisor({ id, breach, metrics });
      }
    } catch { /* a bad reading must never crash monitoring */ }
  }

  /** Hysteresis deadband margin for a threshold. @private */
  _marginFor(t, thresholdValue) {
    if (t && Number.isFinite(t.hysteresis)) return Math.abs(t.hysteresis);
    if (!Number.isFinite(thresholdValue)) return 0;
    return Math.abs(thresholdValue) * this.hysteresisFraction;
  }

  /**
   * Return the first SIGNIFICANT threshold breach in a reading, or null. A breach
   * is significant only when it is a NEW state transition (hysteresis) and not
   * within the per-device+metric cooldown window (debounce). Updates internal
   * breach state for all metrics even when returning early.
   * @private
   */
  _evaluateSignificant(id, metrics) {
    let firstFired = null;
    for (const [metric, value] of Object.entries(metrics || {})) {
      if (typeof value !== 'number') continue;
      const t = this.thresholds[metric];
      if (!t) continue;
      const key = `${id}:${metric}`;
      const active = this._activeBreaches.get(key);

      // Raw breach for this reading.
      let level = null;
      let threshold = null;
      if (Number.isFinite(t.high) && value > t.high) { level = 'high'; threshold = t.high; }
      else if (Number.isFinite(t.low) && value < t.low) { level = 'low'; threshold = t.low; }

      if (level) {
        // Already alerting at this level → hysteresis suppresses re-alert.
        if (active === level) continue;
        // New breach (or level change). Record active state regardless of cooldown
        // so we never emit a second alert until the value recovers.
        this._activeBreaches.set(key, level);
        const now = this._now();
        const last = this._lastAlertAt.get(key);
        // Cooldown only applies once we have alerted before — the first alert
        // for a device+metric always fires.
        if (last !== undefined && now - last < this.cooldownMs) continue; // debounced — too soon
        this._lastAlertAt.set(key, now);
        if (!firstFired) firstFired = { metric, value, level, threshold };
      } else if (active) {
        // Not breached now; clear only when safely past the hysteresis deadband.
        const hi = t.high;
        const lo = t.low;
        const highClear = !Number.isFinite(hi) || value <= hi - this._marginFor(t, hi);
        const lowClear = !Number.isFinite(lo) || value >= lo + this._marginFor(t, lo);
        if (highClear && lowClear) this._activeBreaches.delete(key);
        // else: hold state within the deadband (no re-alert, no clear).
      }
    }
    return firstFired;
  }

  /**
   * Return the first threshold breach found in a reading, or null. Stateless —
   * ignores hysteresis/cooldown. Retained for callers that want a raw check.
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
