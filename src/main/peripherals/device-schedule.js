/**
 * Cron-Based Device Scheduling (Pillar 3, Phase 21 — STRETCH, ADDITIVE + OFF by default).
 *
 * Extends the schedule system with optional 5-field CRON expressions for
 * RECURRING device actions (on / off / check / status …). A cron trigger NEVER
 * actuates a device: it only produces an ADVISORY, human-gated PROPOSED TASK
 * that flows through the existing pending/confirm rail. A human reviews the
 * proposal and (for a real actuation) runs `execute`, which still traverses the
 * full PAL safety chain — Class A remains confirm-gated.
 *
 * SECURITY (non-negotiable):
 *   - The cron parser is a SMALL, SELF-CONTAINED validator: split → bounded
 *     numeric ranges only. No eval, no dynamic code, no catastrophic-backtracking
 *     regex. Every field is strictly range-checked; anything malformed is
 *     rejected (the rule is dropped). No new attack surface.
 *   - Only an ALLOW-LISTED set of actions is accepted.
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1). Env-only by default (no
 *     disk); a human-confirmed store is additive.
 *
 * Backward compatibility: existing time-boxed power schedules (power-schedule.js)
 * are untouched. This is a separate, optional layer.
 *
 * Config:
 *   LIKU_DEVICE_CRON  JSON array of { id?, deviceId, action, cron, params? }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const CRON_FILE = path.join(LIKU_HOME, 'device-cron.json');
// Conservative allow-list — recurring, low-risk actions only.
const ALLOWED_ACTIONS = new Set(['on', 'off', 'toggle', 'lock', 'unlock', 'open', 'close', 'check', 'status']);

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

/**
 * Parse ONE cron field into a Set of allowed integers, or null when malformed.
 * Supports `*`, `a`, `a-b`, `a-b/n`, `* /n`, and comma lists. Bounded loops only.
 * @private
 */
function _parseField(field, min, max) {
  const values = new Set();
  const parts = String(field).split(',');
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (part === '') return null;
    let step = 1;
    let range = part;
    if (part.includes('/')) {
      const bits = part.split('/');
      if (bits.length !== 2) return null;
      step = Number(bits[1]);
      if (!Number.isInteger(step) || step <= 0 || step > (max - min + 1)) return null;
      range = bits[0];
    }
    let lo;
    let hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const rb = range.split('-');
      if (rb.length !== 2) return null;
      lo = Number(rb[0]); hi = Number(rb[1]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = Number(range); hi = lo;
      if (!Number.isInteger(lo)) return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size ? values : null;
}

/** Parse a 5-field cron expression into matcher sets, or null when invalid. */
function parse(cronExpr) {
  if (typeof cronExpr !== 'string') return null;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = _parseField(fields[0], 0, 59);
  const hour = _parseField(fields[1], 0, 23);
  const dom = _parseField(fields[2], 1, 31);
  const month = _parseField(fields[3], 1, 12);
  const dow = _parseField(fields[4], 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow, domRestricted: fields[2] !== '*', dowRestricted: fields[4] !== '*' };
}

/** True when a cron expression is syntactically valid. */
function validate(cronExpr) { return parse(cronExpr) != null; }

/** True when a cron expression matches a given date (to the minute). */
function matches(cronExpr, date = new Date()) {
  const p = parse(cronExpr);
  if (!p) return false;
  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;
  const domMatch = p.dom.has(date.getDate());
  const dowMatch = p.dow.has(date.getDay());
  // Vixie-cron semantics: when BOTH day-of-month and day-of-week are restricted,
  // the rule fires if EITHER matches; otherwise both must match.
  if (p.domRestricted && p.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

function _normalize(r, idx) {
  return {
    id: String(r.id || `cron-${idx}-${r.deviceId}-${r.action}`),
    deviceId: String(r.deviceId),
    action: String(r.action).toLowerCase(),
    cron: String(r.cron),
    params: (r.params && typeof r.params === 'object') ? r.params : {},
    source: r.source || 'env'
  };
}

function _validRule(r) {
  return r && typeof r === 'object' && r.deviceId && r.action
    && ALLOWED_ACTIONS.has(String(r.action).toLowerCase())
    && validate(r.cron);
}

/** Env-declared cron rules (LIKU_DEVICE_CRON). @private */
function _envRules() {
  try {
    const raw = process.env.LIKU_DEVICE_CRON;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(_validRule).map(_normalize);
  } catch { return []; }
}

/** Human-confirmed cron rules from disk (corruption-tolerant). @private */
function _confirmedRules() {
  try {
    if (!fs.existsSync(CRON_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(CRON_FILE, 'utf-8'));
    const list = Array.isArray(raw && raw.rules) ? raw.rules : [];
    return list.filter(_validRule).map((r, i) => _normalize({ ...r, source: 'confirmed' }, i));
  } catch { return []; }
}

/** All active cron rules = env-declared + human-confirmed. */
function loadRules() {
  if (!enabled()) return [];
  return [..._envRules(), ..._confirmedRules()];
}

/** Cron rules whose expression matches `now` (to the minute). */
function dueTriggers(now = new Date()) {
  if (!enabled()) return [];
  return loadRules().filter((r) => matches(r.cron, now));
}

/**
 * Build ADVISORY proposed tasks for every cron rule due at `now`. The task is a
 * reviewable work item — it is NEVER executed here. Class A devices are flagged
 * requiresHuman (and remain confirm-gated at execute time regardless).
 * @param {Date} [now]
 * @returns {object[]}
 */
function proposeCronTasks(now = new Date()) {
  if (!enabled()) return [];
  let registry = null;
  try { registry = require('./peripheral-registry').getInstance(); } catch { registry = null; }
  return dueTriggers(now).map((r) => {
    let klass = null;
    try { const d = registry && registry.get(r.deviceId); klass = d ? d.class : null; } catch { klass = null; }
    return {
      id: `cron-task-${Date.parse(new Date(now).toISOString())}-${r.id}`,
      source: 'cron',
      kind: 'cron-schedule',
      deviceId: r.deviceId,
      action: r.action,
      params: r.params,
      cron: r.cron,
      klass,
      status: 'pending-review',
      requiresHuman: klass === 'A',
      autonomousAction: false,
      safety: 'physical-actions-require-pal-gating',
      advisory: `cron ${r.cron} → advisory: ${r.action} ${r.deviceId}${klass ? ` (class ${klass})` : ''}`,
      proposedAt: new Date(now).toISOString()
    };
  });
}

/** Describe configured cron rules + validity (CLI). */
function describe() {
  return loadRules().map((r) => ({ id: r.id, deviceId: r.deviceId, action: r.action, cron: r.cron, valid: validate(r.cron), source: r.source }));
}

module.exports = {
  FLAG, CRON_FILE, ALLOWED_ACTIONS,
  enabled, parse, validate, matches, loadRules, dueTriggers, proposeCronTasks, describe
};
