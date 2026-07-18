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
  // The confirmed rule governs the suggestion's target device (rule.id = deviceId).
  _appendConfirmed({
    id: entry.deviceId, fromHour: entry.fromHour, toHour: entry.toHour, maxW: entry.maxW,
    source: 'advisor-confirmed', suggestionId: entry.id, confirmedAt: new Date().toISOString()
  });
  entry.status = 'confirmed';
  entry.confirmedAt = new Date().toISOString();
  _save(st);
  return { ok: true, schedule: { ...entry } };
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
  enabled, recordAnomaly, proposeSchedules, listProposed, confirm, dismiss, clear
};
