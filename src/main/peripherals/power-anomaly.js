/**
 * Power Anomaly Detection — rolling-baseline spike/sustained-deviation detector
 * (Pillar 3, Phase 13). PURE OBSERVATION — advisory only.
 *
 * Reads the power-history samples (power-history.js) and flags:
 *   - SPIKE: the latest total draw jumps far above a rolling baseline
 *     (> baselineMean * spikeFactor AND > baselineMean + k·stddev), with a
 *     minimum absolute delta so tiny loads don't trip false positives.
 *   - SUSTAINED: the last N samples are ALL well above the baseline
 *     (> baselineMean * sustainedFactor) — a persistent deviation.
 *   - OVER_BUDGET: the latest sample exceeds its recorded budget.
 *
 * SAFETY: detection never actuates anything. It only surfaces advisory signals
 * for the CLI / an escalation consumer to display. Feature-flag gated + fully
 * additive; with no history (or the flag off) it returns no anomalies.
 *
 * Config (all optional):
 *   LIKU_PERIPHERAL_ANOMALY_SPIKE_FACTOR      default 1.5  (×baseline mean)
 *   LIKU_PERIPHERAL_ANOMALY_SIGMA             default 3    (×stddev above mean)
 *   LIKU_PERIPHERAL_ANOMALY_MIN_DELTA_W       default 10   (min absolute jump)
 *   LIKU_PERIPHERAL_ANOMALY_SUSTAINED_FACTOR  default 1.25 (×baseline mean)
 *   LIKU_PERIPHERAL_ANOMALY_SUSTAINED_N       default 3    (consecutive samples)
 *   LIKU_PERIPHERAL_ANOMALY_MIN_SAMPLES       default 5    (min history to judge)
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _num(envKey, dflt) {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) ? v : dflt;
}

function _config() {
  return {
    spikeFactor: _num('LIKU_PERIPHERAL_ANOMALY_SPIKE_FACTOR', 1.5),
    sigma: _num('LIKU_PERIPHERAL_ANOMALY_SIGMA', 3),
    minDeltaW: _num('LIKU_PERIPHERAL_ANOMALY_MIN_DELTA_W', 10),
    sustainedFactor: _num('LIKU_PERIPHERAL_ANOMALY_SUSTAINED_FACTOR', 1.25),
    sustainedN: Math.max(2, Math.floor(_num('LIKU_PERIPHERAL_ANOMALY_SUSTAINED_N', 3))),
    minSamples: Math.max(3, Math.floor(_num('LIKU_PERIPHERAL_ANOMALY_MIN_SAMPLES', 5)))
  };
}

function _mean(xs) { return xs.reduce((s, x) => s + x, 0) / (xs.length || 1); }
function _std(xs, mean) {
  if (xs.length < 2) return 0;
  const v = xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function _round(n) { return Math.round(n * 100) / 100; }

/**
 * Detect power anomalies from history. Accepts an optional pre-fetched sample
 * array (tests) — otherwise it lazily reads power-history.
 * @param {{ samples?: object[], sinceMs?: number }} [opts]
 * @returns {{ anomalies: object[], baselineW: number, currentW: number, samples: number }}
 */
function detect(opts = {}) {
  if (!enabled()) return { anomalies: [], baselineW: 0, currentW: 0, samples: 0 };
  let samples = Array.isArray(opts.samples) ? opts.samples : null;
  if (!samples) {
    try { samples = require('./power-history').query({ sinceMs: opts.sinceMs }); }
    catch { samples = []; }
  }
  const totals = samples.map((s) => Number(s && s.totalW) || 0);
  const cfg = _config();
  const empty = { anomalies: [], baselineW: 0, currentW: totals.length ? totals[totals.length - 1] : 0, samples: totals.length };
  if (totals.length < cfg.minSamples) return empty;

  const latest = samples[samples.length - 1];
  const latestW = totals[totals.length - 1];
  // Baseline = everything except the most recent sample (the one under test).
  const baseline = totals.slice(0, -1);
  const mean = _mean(baseline);
  const std = _std(baseline, mean);
  const anomalies = [];

  // SPIKE — latest jumps far above baseline.
  const spikeThreshold = Math.max(mean * cfg.spikeFactor, mean + cfg.sigma * std);
  if (latestW > spikeThreshold && (latestW - mean) >= cfg.minDeltaW) {
    anomalies.push({
      type: 'spike', at: latest.at, valueW: _round(latestW), baselineW: _round(mean),
      thresholdW: _round(spikeThreshold), deltaW: _round(latestW - mean),
      advisory: `power spike: ${_round(latestW)}W vs baseline ${_round(mean)}W`
    });
  }

  // SUSTAINED — the last N samples all sit above the sustained factor.
  if (totals.length >= cfg.sustainedN + 1) {
    const tail = totals.slice(-cfg.sustainedN);
    const priorMean = _mean(totals.slice(0, -cfg.sustainedN));
    const sustainedThreshold = priorMean * cfg.sustainedFactor;
    if (priorMean > 0 && tail.every((w) => w > sustainedThreshold) && (Math.min(...tail) - priorMean) >= cfg.minDeltaW) {
      anomalies.push({
        type: 'sustained', at: latest.at, valueW: _round(latestW), baselineW: _round(priorMean),
        thresholdW: _round(sustainedThreshold), samples: cfg.sustainedN,
        advisory: `sustained high power: ${cfg.sustainedN} samples above ${_round(sustainedThreshold)}W`
      });
    }
  }

  // OVER_BUDGET — latest exceeded its recorded budget.
  if (latest && latest.overBudget) {
    anomalies.push({
      type: 'over-budget', at: latest.at, valueW: _round(latestW),
      budgetW: latest.budgetW != null ? Number(latest.budgetW) : null,
      advisory: `over budget: ${_round(latestW)}W > ${latest.budgetW}W`
    });
  }

  return { anomalies, baselineW: _round(mean), currentW: _round(latestW), samples: totals.length };
}

module.exports = { FLAG, enabled, detect };
