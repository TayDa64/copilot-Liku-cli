/**
 * Power Schedule Advisor — advisory auto-schedule suggestions from recurring
 * anomalies (Pillar 3, Phase 18). STRICTLY ADVISORY + HUMAN-GATED.
 *
 * When the same power anomaly recurs enough times within a window, the advisor
 * PROPOSES a power schedule (a time-boxed budget) as a human-reviewable
 * suggestion. A suggestion is NEVER auto-applied — it only becomes an active
 * schedule (read by power-schedule.js) after an explicit `confirm()` (the
 * pending/confirm rail). Deduplication prevents a recurring anomaly from spamming
 * proposals.
 *
 * DISCIPLINE:
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) — no disk touched otherwise.
 *   - Atomic + locked writes, corruption-tolerant reads.
 *   - PURE observation → proposal. It NEVER actuates a device and a proposed
 *     schedule can only ever RESTRICT power once a human confirms it.
 *
 * Config:
 *   LIKU_PERIPHERAL_ADVISOR_WINDOW_MS      default 86400000 (24h occurrence window)
 *   LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES default 3
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');
const { CONFIRMED_FILE } = require('./power-schedule');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const SUGGEST_FILE = path.join(LIKU_HOME, 'schedule-suggestions.json');
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
const DEFAULT_MIN_OCCURRENCES = 3;
const MAX_OCCURRENCES_TRACKED = 50;

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _windowMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_ADVISOR_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_MS;
}
function _minOccurrences() {
  const v = Number(process.env.LIKU_PERIPHERAL_ADVISOR_MIN_OCCURRENCES);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MIN_OCCURRENCES;
}

function _load() {
  const empty = { occurrences: {}, proposed: {} };
  if (!enabled()) return empty;
  try {
    if (!fs.existsSync(SUGGEST_FILE)) return empty;
    const raw = JSON.parse(fs.readFileSync(SUGGEST_FILE, 'utf-8'));
    return {
      occurrences: (raw && typeof raw.occurrences === 'object') ? raw.occurrences : {},
      proposed: (raw && typeof raw.proposed === 'object') ? raw.proposed : {}
    };
  } catch { return empty; }
}

function _save(state) {
  if (!enabled()) return false;
  try {
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(SUGGEST_FILE, JSON.stringify({
      updatedAt: new Date().toISOString(), occurrences: state.occurrences, proposed: state.proposed
    }, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

function _modeHour(hours) {
  const counts = {};
  let best = hours[0] || 0;
  let bestN = 0;
  for (const h of hours) { counts[h] = (counts[h] || 0) + 1; if (counts[h] > bestN) { bestN = counts[h]; best = h; } }
  return best;
}

const _CONF_RANK = { low: 0, medium: 1, high: 2 };
/** Lowest confidence label across a set of forecast horizon entries. @private */
function _minConfidence(entries) {
  let min = 'high';
  for (const e of entries) {
    const c = (e && e.confidence) ? e.confidence : 'low';
    if ((_CONF_RANK[c] != null ? _CONF_RANK[c] : 0) < _CONF_RANK[min]) min = c;
  }
  return min;
}

/** Suggested cap = a fraction below the recurring anomaly's observed draw. @private */
function _suggestCapW(occs) {
  const budgets = occs.map((o) => Number(o.budgetW)).filter((n) => Number.isFinite(n) && n > 0);
  if (budgets.length) return Math.round(Math.min(...budgets)); // cap at the budget
  const values = occs.map((o) => Number(o.valueW)).filter((n) => Number.isFinite(n) && n > 0);
  if (!values.length) return 0;
  return Math.round(Math.min(...values) * 0.8); // 20% below the smallest observed
}

/**
 * Record an anomaly occurrence (bucketed by device + type). Bounded per key.
 * @param {{ device?:string, type?:string, valueW?:number, budgetW?:number }} anomaly
 * @param {number} [now]
 */
function recordAnomaly(anomaly, now = Date.now()) {
  if (!enabled() || !anomaly) return;
  const deviceId = String(anomaly.device || 'power-budget');
  const type = String(anomaly.type || 'anomaly');
  const key = `${deviceId}:${type}`;
  const st = _load();
  const cutoff = now - _windowMs();
  const list = (st.occurrences[key] || []).filter((o) => o.at >= cutoff);
  list.push({ at: now, hour: new Date(now).getHours(), valueW: anomaly.valueW, budgetW: anomaly.budgetW });
  st.occurrences[key] = list.slice(-MAX_OCCURRENCES_TRACKED);
  _save(st);
}

/**
 * Propose schedules for any recurring anomaly that crossed the occurrence
 * threshold within the window. Deduplicated: one open proposal per device+type.
 * @param {{ minOccurrences?:number }} [opts]
 * @param {number} [now]
 * @returns {object[]} proposed schedule suggestions
 */
function proposeSchedules(opts = {}, now = Date.now()) {
  if (!enabled()) return [];
  const st = _load();
  const minOcc = Number.isFinite(opts.minOccurrences) ? opts.minOccurrences : _minOccurrences();
  const cutoff = now - _windowMs();
  const out = [];
  let changed = false;
  for (const [key, occs] of Object.entries(st.occurrences)) {
    const recent = (occs || []).filter((o) => o.at >= cutoff);
    if (recent.length < minOcc) continue;
    // Dedup: keep one OPEN proposal per device:type until confirmed/dismissed.
    const existing = st.proposed[key];
    if (existing && existing.status === 'proposed') { out.push(existing); continue; }
    if (existing && (existing.status === 'confirmed' || existing.status === 'dismissed')) continue;
    const [deviceId, type] = key.split(':');
    const hour = _modeHour(recent.map((o) => o.hour));
    // Phase 19: use the device's per-hour-of-day baseline (forecast) to set a
    // SMARTER cap — the device's typical peak at that hour lets normal operation
    // continue while capping the anomalous excess. Falls back to a budget/value cap.
    let maxW = _suggestCapW(recent);
    let basis = 'anomaly-history';
    try {
      const devBase = require('./power-forecast').deviceHourlyBaselines();
      const b = devBase && devBase[deviceId] && devBase[deviceId][hour];
      if (b && Number.isFinite(b.peak) && b.peak > 0) { maxW = Math.round(b.peak); basis = 'forecast-baseline'; }
    } catch { /* forecast is best-effort */ }
    const suggestion = {
      id: `sched-sug-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      deviceId,
      anomalyType: type,
      fromHour: hour,
      toHour: (hour + 1) % 24,
      maxW,
      basis,
      occurrences: recent.length,
      reason: `recurring ${type} for ${deviceId} around ${hour}:00 (${recent.length}x)`,
      status: 'proposed',
      proposed: true,
      requiresHuman: true,
      autonomousAction: false,
      createdAt: new Date().toISOString()
    };
    st.proposed[key] = suggestion;
    out.push(suggestion);
    changed = true;
  }
  if (changed) _save(st);
  return out;
}

/** All open (proposed) suggestions. */
function listProposed() {
  return Object.values(_load().proposed).filter((s) => s.status === 'proposed');
}

/**
 * MULTI-DEVICE coordinated proposal (Phase 20). When a budget breach at a given
 * hour is jointly driven by MORE THAN ONE device, propose a coordinated set of
 * per-device caps that scale each contributor's baseline peak down so their SUM
 * fits under the budget. STRICTLY ADVISORY + human-gated: nothing activates until
 * `confirm()` writes the confirmed (restrict-only) rules. Deduplicated: one open
 * multi-device proposal per hour.
 * @param {{ budgetW:number, hour:number, samples?:object[] }} opts
 * @param {number} [now]
 * @returns {object|null} the proposal (or null when not multi-device / not exceeding)
 */
function proposeMultiDeviceSchedule(opts = {}, now = Date.now()) {
  if (!enabled()) return null;
  const budgetW = Number(opts.budgetW);
  const hour = Number(opts.hour);
  if (!Number.isFinite(budgetW) || budgetW <= 0 || !Number.isFinite(hour)) return null;
  let contrib;
  try { contrib = require('./power-forecast').contributorsAtHour({ hour, budgetW, samples: opts.samples }); }
  catch { return null; }
  // Multi-device coordination only applies when 2+ devices JOINTLY exceed budget.
  if (!contrib || !contrib.exceeds || !Array.isArray(contrib.contributors) || contrib.contributors.length < 2) return null;
  const st = _load();
  const key = `multi:${hour}`;
  const existing = st.proposed[key];
  if (existing && existing.status === 'proposed') return existing;
  if (existing && (existing.status === 'confirmed' || existing.status === 'dismissed')) return null;
  const total = contrib.totalPeakW || contrib.contributors.reduce((s, c) => s + c.peakW, 0);
  // Allocate each device a cap proportional to its share of the combined peak,
  // scaled so the caps SUM to (at most) the budget. Only ever RESTRICTS.
  const devices = contrib.contributors.map((c) => {
    const share = total > 0 ? c.peakW / total : 1 / contrib.contributors.length;
    const proposedMaxW = Math.max(1, Math.round(budgetW * share));
    return { deviceId: c.deviceId, currentPeakW: c.peakW, proposedMaxW };
  });
  const suggestion = {
    id: `multi-sched-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    type: 'multi-device',
    hour,
    fromHour: hour,
    toHour: (hour + 1) % 24,
    budgetW,
    totalPeakW: total,
    devices,
    occurrences: devices.length,
    reason: `coordinated cap for ${devices.length} devices at ${hour}:00 (combined ${total}W > budget ${budgetW}W)`,
    status: 'proposed',
    proposed: true,
    requiresHuman: true,
    autonomousAction: false,
    createdAt: new Date().toISOString()
  };
  st.proposed[key] = suggestion;
  _save(st);
  return suggestion;
}

/** Append a confirmed schedule to the store power-schedule.js reads. @private */
function _appendConfirmed(rule) {
  let existing = { schedules: [] };
  try { if (fs.existsSync(CONFIRMED_FILE)) existing = JSON.parse(fs.readFileSync(CONFIRMED_FILE, 'utf-8')); } catch { existing = { schedules: [] }; }
  const schedules = Array.isArray(existing.schedules) ? existing.schedules : [];
  schedules.push(rule);
  if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(CONFIRMED_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), schedules }, null, 2), { mode: 0o600 });
}

/**
 * EXPLICIT human confirmation: activate a proposed schedule. Writes it to the
 * confirmed schedule store (which power-schedule.js enforces). Nothing is applied
 * until this is called.
 * @param {string} suggestionId
 */
function confirm(suggestionId) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const st = _load();
  const key = Object.keys(st.proposed).find((k) => st.proposed[k].id === suggestionId);
  if (!key) return { ok: false, reason: 'not-found' };
  const entry = st.proposed[key];
  if (entry.status !== 'proposed') return { ok: false, reason: `already-${entry.status}` };
  if (Array.isArray(entry.devices)) {
    // Coordinated confirmation (multi-device OR multi-hour): write ONE
    // restrict-only rule per contributor across the proposal's window.
    for (const d of entry.devices) {
      _appendConfirmed({
        id: d.deviceId, fromHour: entry.fromHour, toHour: entry.toHour, maxW: d.proposedMaxW,
        source: `advisor-confirmed-${entry.type || 'multi'}`, suggestionId: entry.id, confirmedAt: new Date().toISOString()
      });
    }
  } else {
    // The confirmed rule governs the suggestion's target device (rule.id = deviceId).
    _appendConfirmed({
      id: entry.deviceId, fromHour: entry.fromHour, toHour: entry.toHour, maxW: entry.maxW,
      source: 'advisor-confirmed', suggestionId: entry.id, confirmedAt: new Date().toISOString()
    });
  }
  entry.status = 'confirmed';
  entry.confirmedAt = new Date().toISOString();
  _save(st);
  return { ok: true, schedule: { ...entry } };
}

/**
 * MULTI-HOUR coordinated proposal (Phase 23). Scans the forecast horizon for the
 * longest CONTIGUOUS run of hours whose confidence UPPER band exceeds the budget,
 * then proposes a single window [from..to] with per-device caps (allocated by
 * each contributor's share of the peak-hour draw). STRICTLY ADVISORY + human-gated;
 * dedup one open multi-hour proposal per window.
 * @param {{ budgetW:number, samples?:object[], horizonHours?:number, now?:number, seasonal?:boolean }} opts
 * @param {number} [now]
 * @returns {object|null}
 */
function proposeMultiHourSchedule(opts = {}, now = Date.now()) {
  if (!enabled()) return null;
  const budgetW = Number(opts.budgetW);
  if (!Number.isFinite(budgetW) || budgetW <= 0) return null;
  const effectiveNow = Number.isFinite(opts.now) ? opts.now : now;
  let forecastMod;
  let f;
  try {
    forecastMod = require('./power-forecast');
    f = opts.seasonal
      ? forecastMod.seasonalForecast({ budgetW, samples: opts.samples, horizonHours: opts.horizonHours, now: effectiveNow })
      : forecastMod.forecast({ budgetW, samples: opts.samples, horizonHours: opts.horizonHours, now: effectiveNow });
  } catch { return null; }
  if (!f || !f.ok || !Array.isArray(f.horizon)) return null;
  // Longest contiguous run where the confidence UPPER band exceeds budget.
  const over = f.horizon.map((h) => (h.highW > budgetW || h.predictedW > budgetW));
  let bestStart = -1; let bestLen = 0; let curStart = -1; let curLen = 0;
  for (let i = 0; i < over.length; i++) {
    if (over[i]) { if (curStart < 0) curStart = i; curLen++; if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; } }
    else { curStart = -1; curLen = 0; }
  }
  if (bestLen < 2) return null; // "multi-hour" requires a run of >= 2 hours
  const runEntries = f.horizon.slice(bestStart, bestStart + bestLen);
  const runHours = runEntries.map((h) => h.hour);
  const fromHour = runHours[0];
  const toHour = (runHours[runHours.length - 1] + 1) % 24;
  const peakEntry = runEntries.reduce((a, b) => (b.predictedW > a.predictedW ? b : a));
  const contrib = forecastMod.contributorsAtHour({ hour: peakEntry.hour, budgetW, samples: opts.samples });
  if (!contrib || !Array.isArray(contrib.contributors) || !contrib.contributors.length || !(contrib.totalPeakW > 0)) return null;
  // Phase 24: CONFIDENCE-WEIGHTED caps. Under LOW confidence we lean on each
  // device's PEAK (more headroom for volatile devices); under HIGH confidence we
  // lean on its MEAN (tighter). The reference draw = mean + w·(peak−mean), where
  // w grows as run confidence drops. Shares of the reference still sum to budget,
  // so the coordinated caps NEVER exceed the budget (restrict-only invariant).
  const runConfidence = _minConfidence(runEntries);
  const w = runConfidence === 'high' ? 0 : (runConfidence === 'medium' ? 0.5 : 1);
  const refs = contrib.contributors.map((c) => {
    const meanW = Number.isFinite(c.meanW) ? c.meanW : c.peakW;
    return { deviceId: c.deviceId, peakW: c.peakW, meanW, refW: meanW + w * (c.peakW - meanW) };
  });
  const totalRef = refs.reduce((s, r) => s + r.refW, 0) || 1;
  const devices = refs.map((r) => ({
    deviceId: r.deviceId, currentPeakW: r.peakW,
    proposedMaxW: Math.max(1, Math.round(budgetW * (r.refW / totalRef)))
  }));
  const key = `multihour:${fromHour}-${toHour}`;
  const st = _load();
  const existing = st.proposed[key];
  if (existing && existing.status === 'proposed') return existing;
  if (existing && (existing.status === 'confirmed' || existing.status === 'dismissed')) return null;
  const suggestion = {
    id: `multihour-sched-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    type: 'multi-hour', fromHour, toHour, hours: runHours, budgetW, devices, occurrences: devices.length,
    confidence: runConfidence,
    reason: `coordinated ${bestLen}h cap ${fromHour}:00→${toHour}:00 (forecast band > budget ${budgetW}W, ${runConfidence} confidence)`,
    status: 'proposed', proposed: true, requiresHuman: true, autonomousAction: false, createdAt: new Date().toISOString()
  };
  st.proposed[key] = suggestion;
  _save(st);
  return suggestion;
}

/**
 * Directly create a HUMAN-CONFIRMED restrict-only schedule for a device. Used
 * when a human confirms an anomaly→action `reduce-schedule` (the confirmation IS
 * the gate). The cap is derived from the device's forecast baseline peak (cap the
 * excess while allowing normal operation), falling back to an explicit maxW/budget.
 * @param {string} deviceId
 * @param {{ maxW?:number, budgetW?:number, fromHour?:number, toHour?:number, now?:number }} [opts]
 */
function createConfirmedSchedule(deviceId, opts = {}) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  if (!deviceId) return { ok: false, reason: 'no-device' };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const fromHour = Number.isFinite(opts.fromHour) ? opts.fromHour : new Date(now).getHours();
  const toHour = Number.isFinite(opts.toHour) ? opts.toHour : (fromHour + 1) % 24;
  let maxW = Number.isFinite(opts.maxW) ? Math.round(opts.maxW) : null;
  if (maxW == null) {
    try {
      const b = require('./power-forecast').deviceHourlyBaselines()[deviceId];
      const hb = b && b[fromHour];
      if (hb && hb.peak > 0) maxW = Math.round(hb.peak);
    } catch { /* forecast is best-effort */ }
  }
  if (maxW == null && Number.isFinite(opts.budgetW) && opts.budgetW > 0) maxW = Math.round(opts.budgetW);
  if (maxW == null) return { ok: false, reason: 'no-cap-basis' };
  _appendConfirmed({ id: deviceId, fromHour, toHour, maxW, source: 'anomaly-action-confirmed', confirmedAt: new Date().toISOString() });
  return { ok: true, rule: { id: deviceId, fromHour, toHour, maxW } };
}

/**
 * Phase 24 — directly create a HUMAN-CONFIRMED MULTI-DEVICE coordinated
 * reduce-schedule for the hour: when 2+ devices jointly exceed the budget, write
 * one restrict-only rule per contributor (caps proportional to peak share, sum ≤
 * budget). Used when a human confirms a reduce-schedule anomaly→action and the
 * breach is multi-device. Returns { ok:false, reason:'not-multi-device' } for a
 * single contributor (caller falls back to the single-device path).
 * @param {{ budgetW:number, hour?:number, samples?:object[], now?:number }} opts
 */
function createConfirmedMultiSchedule(opts = {}) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const budgetW = Number(opts.budgetW);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const hour = Number.isFinite(opts.hour) ? opts.hour : new Date(now).getHours();
  if (!Number.isFinite(budgetW) || budgetW <= 0) return { ok: false, reason: 'no-budget' };
  let contrib;
  try { contrib = require('./power-forecast').contributorsAtHour({ hour, budgetW, samples: opts.samples }); }
  catch { return { ok: false, reason: 'forecast-error' }; }
  if (!contrib || !Array.isArray(contrib.contributors) || contrib.contributors.length < 2 || !contrib.exceeds) {
    return { ok: false, reason: 'not-multi-device' };
  }
  const total = contrib.totalPeakW || contrib.contributors.reduce((s, c) => s + c.peakW, 0);
  const fromHour = hour;
  const toHour = (hour + 1) % 24;
  const devices = contrib.contributors.map((c) => {
    const share = total > 0 ? c.peakW / total : 1 / contrib.contributors.length;
    const maxW = Math.max(1, Math.round(budgetW * share));
    _appendConfirmed({ id: c.deviceId, fromHour, toHour, maxW, source: 'anomaly-action-confirmed-multi', confirmedAt: new Date().toISOString() });
    return { deviceId: c.deviceId, proposedMaxW: maxW };
  });
  return { ok: true, multiDevice: true, hour, fromHour, toHour, budgetW, devices };
}

/** Dismiss a proposed schedule (human declined). */
function dismiss(suggestionId) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const st = _load();
  const key = Object.keys(st.proposed).find((k) => st.proposed[k].id === suggestionId);
  if (!key) return { ok: false, reason: 'not-found' };
  st.proposed[key].status = 'dismissed';
  st.proposed[key].dismissedAt = new Date().toISOString();
  _save(st);
  return { ok: true };
}

/** Remove advisor state (governance/tests). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(SUGGEST_FILE)) fs.rmSync(SUGGEST_FILE); return true; }
  catch { return false; }
}

module.exports = {
  FLAG, SUGGEST_FILE,
  enabled, recordAnomaly, proposeSchedules, proposeMultiDeviceSchedule, proposeMultiHourSchedule,
  createConfirmedSchedule, createConfirmedMultiSchedule, listProposed, confirm, dismiss, clear
};
