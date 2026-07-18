/**
 * Power Forecasting — seasonal (per-hour-of-day) baselines + short-horizon
 * forecast from the rolling power history (Pillar 3, Phase 19).
 *
 * PURE OBSERVATION → PREDICTION. It reads power-history samples and computes:
 *   - per-hour-of-day baselines (mean / peak / count) for the total draw and
 *     per device, and
 *   - a short-horizon forecast for the upcoming hours, plus an EARLY-WARNING
 *     list of upcoming hours whose predicted draw would exceed a budget.
 *
 * Everything here is advisory: forecasts feed smarter (still human-confirmed)
 * schedule suggestions and earlier anomaly warnings. It NEVER actuates and is
 * flag-gated (LIKU_ENABLE_PERIPHERALS=1) + corruption-tolerant.
 *
 * Phase 20 adds CONFIDENCE INTERVALS (per-hour standard deviation → low/high
 * band + a high/medium/low confidence label) and LONGER HORIZONS (up to a full
 * day ahead, wrapping the per-hour-of-day baselines), plus MULTI-DEVICE
 * contributor analysis so the schedule advisor can coordinate caps across the
 * several devices that jointly drive an upcoming budget breach.
 *
 * Config:
 *   LIKU_PERIPHERAL_FORECAST_HORIZON_HOURS  default 3   (1..24)
 *   LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES    default 6
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const MAX_HORIZON_HOURS = 24; // day-ahead ceiling (per-hour-of-day baselines wrap)
const CONF_Z = 1.28; // ~80% one-sided band from the per-hour stddev

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _round(n) { return Math.round(n * 100) / 100; }
function _hourOf(at) { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).getHours() : null; }
function _std(values, mean) {
  if (!values || values.length < 2) return 0;
  const v = values.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (values.length - 1);
  return Math.sqrt(v);
}

/**
 * Qualitative confidence from the sample count + coefficient of variation, then
 * decayed by how many hours ahead the estimate is (farther = less certain).
 * @private
 */
function _confidence(count, std, mean, stepsAhead = 1) {
  if (!count || count < 2) return 'low';
  const cv = mean > 0 ? std / mean : 1;
  let label = 'low';
  if (count >= 5 && cv <= 0.25) label = 'high';
  else if (count >= 3 && cv <= 0.5) label = 'medium';
  // Decay one level per full day of extra distance (24 per-hour cycles).
  if (stepsAhead > 12 && label === 'high') label = 'medium';
  if (stepsAhead > 24 && label !== 'low') label = 'low';
  return label;
}

function _loadSamples(opts) {
  if (Array.isArray(opts.samples)) return opts.samples;
  try { return require('./power-history').query({ sinceMs: opts.sinceMs }); }
  catch { return []; }
}

/**
 * Per-hour-of-day baseline for TOTAL draw.
 * @returns {{ [hour:number]: { mean:number, peak:number, count:number } }}
 */
function hourlyBaselines(opts = {}) {
  if (!enabled()) return {};
  const samples = _loadSamples(opts);
  const buckets = {};
  for (const s of samples) {
    const h = _hourOf(s && s.at);
    if (h == null) continue;
    const w = Number(s.totalW) || 0;
    const b = buckets[h] || (buckets[h] = { values: [], sum: 0, peak: 0, count: 0 });
    b.values.push(w); b.sum += w; b.peak = Math.max(b.peak, w); b.count += 1;
  }
  const out = {};
  for (const [h, b] of Object.entries(buckets)) {
    const mean = b.sum / b.count;
    out[h] = { mean: _round(mean), peak: _round(b.peak), count: b.count, std: _round(_std(b.values, mean)) };
  }
  return out;
}

/**
 * Per-device per-hour baseline (mean loadW).
 * @returns {{ [deviceId:string]: { [hour:number]: { mean:number, peak:number, count:number } } }}
 */
function deviceHourlyBaselines(opts = {}) {
  if (!enabled()) return {};
  const samples = _loadSamples(opts);
  const dev = {};
  for (const s of samples) {
    const h = _hourOf(s && s.at);
    if (h == null) continue;
    for (const d of (s.devices || [])) {
      const id = d.id;
      const w = Number(d.loadW) || 0;
      const perDev = dev[id] || (dev[id] = {});
      const b = perDev[h] || (perDev[h] = { sum: 0, peak: 0, count: 0 });
      b.sum += w; b.peak = Math.max(b.peak, w); b.count += 1;
    }
  }
  const out = {};
  for (const [id, hours] of Object.entries(dev)) {
    out[id] = {};
    for (const [h, b] of Object.entries(hours)) out[id][h] = { mean: _round(b.sum / b.count), peak: _round(b.peak), count: b.count };
  }
  return out;
}

/**
 * Short-horizon forecast for the upcoming hours using the per-hour baseline.
 * @param {{ samples?:object[], sinceMs?:number, horizonHours?:number, now?:number }} [opts]
 * @returns {{ ok:boolean, horizon:object[], basis:string, samples:number }}
 */
function forecast(opts = {}) {
  if (!enabled()) return { ok: false, horizon: [], basis: 'disabled', samples: 0 };
  const samples = _loadSamples(opts);
  const minSamples = Number(process.env.LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES) || 6;
  const horizonHours = Number.isFinite(opts.horizonHours) ? opts.horizonHours
    : (Number(process.env.LIKU_PERIPHERAL_FORECAST_HORIZON_HOURS) || 3);
  if (samples.length < minSamples) return { ok: false, horizon: [], basis: 'insufficient-history', samples: samples.length };
  const boundedHorizon = Math.max(1, Math.min(MAX_HORIZON_HOURS, Math.floor(horizonHours)));
  const baselines = hourlyBaselines({ samples });
  const totals = samples.map((s) => Number(s.totalW) || 0);
  const overallMean = _round(totals.reduce((a, b) => a + b, 0) / totals.length);
  const overallStd = _round(_std(totals, overallMean));
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const startHour = new Date(now).getHours();
  const horizon = [];
  for (let i = 1; i <= boundedHorizon; i++) {
    const hour = (startHour + i) % 24;
    const b = baselines[hour];
    const mean = b ? b.mean : overallMean;
    const std = b ? b.std : overallStd;
    const count = b ? b.count : totals.length;
    const margin = _round(CONF_Z * std);
    horizon.push({
      hour,
      stepsAhead: i,
      predictedW: mean,
      peakW: b ? b.peak : overallMean,
      lowW: _round(Math.max(0, mean - margin)),
      highW: _round(mean + margin),
      stdW: _round(std),
      confidence: _confidence(count, std, mean, i),
      basis: b ? 'hourly-baseline' : 'overall-mean'
    });
  }
  return { ok: true, horizon, basis: 'per-hour-of-day', samples: samples.length, overallMean, horizonHours: boundedHorizon };
}

/**
 * EARLY WARNING: upcoming hours whose predicted (or historic peak) draw would
 * exceed the given budget. Advisory only.
 * @param {{ budgetW:number, samples?:object[], sinceMs?:number, horizonHours?:number, now?:number }} opts
 * @returns {object[]} warnings
 */
function forecastExceedsBudget(opts = {}) {
  const budgetW = Number(opts.budgetW);
  if (!enabled() || !Number.isFinite(budgetW) || budgetW <= 0) return [];
  const f = forecast(opts);
  if (!f.ok) return [];
  return f.horizon
    .filter((h) => h.predictedW > budgetW || h.peakW > budgetW)
    .map((h) => ({
      hour: h.hour,
      predictedW: h.predictedW,
      peakW: h.peakW,
      lowW: h.lowW,
      highW: h.highW,
      confidence: h.confidence,
      budgetW,
      advisory: `forecast: hour ${h.hour}:00 may reach ${h.predictedW}W (peak ${h.peakW}W, ${h.confidence} confidence) vs budget ${budgetW}W`
    }));
}

/**
 * MULTI-DEVICE CONTRIBUTOR ANALYSIS for a given hour-of-day. Ranks the devices
 * by their per-hour baseline peak and reports whether their COMBINED typical
 * draw exceeds a budget — the signal the advisor uses to coordinate caps across
 * more than one device. PURE observation.
 * @param {{ hour:number, budgetW:number, samples?:object[], sinceMs?:number }} opts
 * @returns {{ hour:number, budgetW:number, totalPeakW:number, exceeds:boolean, contributors:object[] }}
 */
function contributorsAtHour(opts = {}) {
  const hour = Number(opts.hour);
  const budgetW = Number(opts.budgetW) || 0;
  if (!enabled() || !Number.isFinite(hour)) return { hour: null, budgetW, totalPeakW: 0, exceeds: false, contributors: [] };
  const dev = deviceHourlyBaselines({ samples: opts.samples, sinceMs: opts.sinceMs });
  const contributors = [];
  let totalPeakW = 0;
  for (const [id, hours] of Object.entries(dev)) {
    const b = hours[hour];
    if (!b || b.peak <= 0) continue;
    contributors.push({ deviceId: id, peakW: b.peak, meanW: b.mean, count: b.count });
    totalPeakW += b.peak;
  }
  contributors.sort((a, b) => b.peakW - a.peakW);
  return { hour, budgetW, totalPeakW: _round(totalPeakW), exceeds: budgetW > 0 && totalPeakW > budgetW, contributors };
}

module.exports = {
  FLAG, MAX_HORIZON_HOURS, enabled,
  hourlyBaselines, deviceHourlyBaselines, forecast, forecastExceedsBudget, contributorsAtHour
};
