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
 * Config:
 *   LIKU_PERIPHERAL_FORECAST_HORIZON_HOURS  default 3
 *   LIKU_PERIPHERAL_FORECAST_MIN_SAMPLES    default 6
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _round(n) { return Math.round(n * 100) / 100; }
function _hourOf(at) { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).getHours() : null; }

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
    const b = buckets[h] || (buckets[h] = { sum: 0, peak: 0, count: 0 });
    b.sum += w; b.peak = Math.max(b.peak, w); b.count += 1;
  }
  const out = {};
  for (const [h, b] of Object.entries(buckets)) out[h] = { mean: _round(b.sum / b.count), peak: _round(b.peak), count: b.count };
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
  const baselines = hourlyBaselines({ samples });
  const totals = samples.map((s) => Number(s.totalW) || 0);
  const overallMean = _round(totals.reduce((a, b) => a + b, 0) / totals.length);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const startHour = new Date(now).getHours();
  const horizon = [];
  for (let i = 1; i <= horizonHours; i++) {
    const hour = (startHour + i) % 24;
    const b = baselines[hour];
    horizon.push({
      hour,
      predictedW: b ? b.mean : overallMean,
      peakW: b ? b.peak : overallMean,
      basis: b ? 'hourly-baseline' : 'overall-mean'
    });
  }
  return { ok: true, horizon, basis: 'per-hour-of-day', samples: samples.length, overallMean };
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
      budgetW,
      advisory: `forecast: hour ${h.hour}:00 may reach ${h.predictedW}W (peak ${h.peakW}W) vs budget ${budgetW}W`
    }));
}

module.exports = { FLAG, enabled, hourlyBaselines, deviceHourlyBaselines, forecast, forecastExceedsBudget };
