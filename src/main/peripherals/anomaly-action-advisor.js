/**
 * Anomaly → Action Advisor — advisory PROACTIVE self-healing suggestions for a
 * PERSISTENTLY anomalous device (Pillar 3, Phase 20). STRICTLY ADVISORY +
 * HUMAN-GATED.
 *
 * When the same device keeps tripping power anomalies within a window, this
 * advisor escalates a suggestion up a fixed ladder of increasingly firm (but
 * always SAFE, non-actuating) operations:
 *
 *   3x  → reduce-schedule : cap the device's power via a confirmed schedule.
 *   6x  → rotate-token    : security hygiene — rotate the device's capability
 *                           token generation (pure crypto, no actuation).
 *   10x → unpair          : remove the misbehaving device's pairing (transport
 *                           bookkeeping; the device simply stops receiving until
 *                           it is deliberately re-paired). No physical actuation.
 *
 * SAFETY CONTRACT (non-negotiable):
 *   - Every suggestion is a REVIEWABLE proposal. `confirm()` records the human's
 *     approval and RETURNS the exact command to run — it NEVER executes the
 *     action itself. There is no autonomous actuation path here.
 *   - None of the ladder operations actuate the physical device (turn on/off,
 *     move, etc.). They only restrict power, rotate a token, or tear down
 *     pairing — all already human-gated CLI operations.
 *   - FEATURE-FLAG GATED (LIKU_ENABLE_PERIPHERALS=1) — no disk touched otherwise.
 *   - Atomic + locked writes, corruption-tolerant reads (never throws).
 *   - Only REAL devices get action suggestions (the synthetic 'power-budget'
 *     aggregate is skipped).
 *
 * Config:
 *   LIKU_PERIPHERAL_ACTION_WINDOW_MS  default 86400000 (24h occurrence window)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const STORE_FILE = path.join(LIKU_HOME, 'anomaly-actions.json');
const POLICIES_FILE = path.join(LIKU_HOME, 'autoheal-policies.json');
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
const MAX_TRACKED = 50;

/**
 * Escalating advisory action ladder. Ordered least→most firm; `proposeActions`
 * always surfaces the HIGHEST rung whose occurrence threshold is met.
 */
const ACTION_LADDER = Object.freeze([
  { rung: 0, minOccurrences: 3, action: 'reduce-schedule', severity: 'warning', directive: (id) => `liku peripherals suggestions   # then: liku peripherals apply-schedule <id> for ${id}` },
  { rung: 1, minOccurrences: 6, action: 'rotate-token', severity: 'warning', directive: (id) => `liku peripherals token rotate ${id}` },
  { rung: 2, minOccurrences: 10, action: 'unpair', severity: 'critical', directive: (id) => `liku peripherals unpair ${id}` }
]);

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function _windowMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_ACTION_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_MS;
}

function _rungIndex(action) {
  return ACTION_LADDER.findIndex((r) => r.action === action);
}

// ── Phase 24: per-device AUTO-HEAL policies ─────────────────────────────────
// Configurable per-device occurrence thresholds for when each ladder action is
// proposed. Sources (later overrides earlier): default ladder → env
// LIKU_PERIPHERAL_AUTOHEAL_POLICIES → the confirmed store. A '*' key sets a
// fleet-wide default. Policies only change WHEN a proposal is surfaced — they
// never make an action autonomous.

function _loadPolicyStore() {
  if (!enabled()) return {};
  try {
    if (!fs.existsSync(POLICIES_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(POLICIES_FILE, 'utf-8'));
    return (raw && typeof raw.policies === 'object') ? raw.policies : {};
  } catch { return {}; }
}

function _savePolicyStore(policies) {
  if (!enabled()) return false;
  try {
    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(POLICIES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), policies }, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Merged policy map (env overlaid by the confirmed store). @private */
function _loadPolicies() {
  const out = {};
  try {
    const raw = process.env.LIKU_PERIPHERAL_AUTOHEAL_POLICIES;
    if (raw) { const p = JSON.parse(raw); if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) out[k] = { ...v }; }
  } catch { /* env policy is best-effort */ }
  const store = _loadPolicyStore();
  for (const [k, v] of Object.entries(store)) out[k] = { ...(out[k] || {}), ...v };
  return out;
}

/** The ladder for a device with per-device / '*' threshold overrides applied. @private */
function _policyLadder(deviceId) {
  const pol = _loadPolicies();
  const dev = pol[deviceId] || {};
  const star = pol['*'] || {};
  return ACTION_LADDER.map((r) => {
    const raw = dev[r.action] != null ? Number(dev[r.action]) : (star[r.action] != null ? Number(star[r.action]) : null);
    const minOccurrences = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : r.minOccurrences;
    return { ...r, minOccurrences };
  });
}

/** Set a device's auto-heal thresholds (persisted). Human-configured governance. */
function setPolicy(deviceId, thresholds) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  if (!deviceId || !thresholds || typeof thresholds !== 'object') return { ok: false, reason: 'invalid' };
  const store = _loadPolicyStore();
  const clean = {};
  for (const action of ACTION_LADDER.map((r) => r.action)) {
    if (thresholds[action] != null && Number.isFinite(Number(thresholds[action]))) clean[action] = Math.max(1, Math.floor(Number(thresholds[action])));
  }
  if (!Object.keys(clean).length) return { ok: false, reason: 'no-valid-thresholds' };
  store[deviceId] = { ...(store[deviceId] || {}), ...clean };
  _savePolicyStore(store);
  return { ok: true, deviceId, policy: store[deviceId] };
}

/** Effective thresholds for a device ({ action: minOccurrences }). */
function getPolicy(deviceId) {
  const ladder = _policyLadder(deviceId);
  const out = {};
  for (const r of ladder) out[r.action] = r.minOccurrences;
  return out;
}

/** All configured policies (merged env + store). */
function listPolicies() { return _loadPolicies(); }

/** Remove the policy store (governance/tests). No-op when disabled. */
function clearPolicies() {
  if (!enabled()) return false;
  try { if (fs.existsSync(POLICIES_FILE)) fs.rmSync(POLICIES_FILE); return true; }
  catch { return false; }
}

function _load() {
  const empty = { occurrences: {}, proposed: {} };
  if (!enabled()) return empty;
  try {
    if (!fs.existsSync(STORE_FILE)) return empty;
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
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
    atomicWriteFileSync(STORE_FILE, JSON.stringify({
      updatedAt: new Date().toISOString(), occurrences: state.occurrences, proposed: state.proposed
    }, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Record an anomaly occurrence against a REAL device. The synthetic aggregate
 * 'power-budget' is ignored (there is no single device to act on).
 * @param {{ device?:string, attributedDevice?:string, type?:string }} anomaly
 * @param {number} [now]
 */
function recordAnomaly(anomaly, now = Date.now()) {
  if (!enabled() || !anomaly) return;
  const deviceId = String(anomaly.device || anomaly.attributedDevice || 'power-budget');
  if (!deviceId || deviceId === 'power-budget') return;
  const st = _load();
  const cutoff = now - _windowMs();
  const list = (st.occurrences[deviceId] || []).filter((o) => o.at >= cutoff);
  list.push({ at: now, type: String(anomaly.type || 'anomaly') });
  st.occurrences[deviceId] = list.slice(-MAX_TRACKED);
  _save(st);
}

/**
 * Propose advisory actions for any device whose recurring anomalies crossed a
 * ladder threshold within the window. Deduplicated + monotonic: one open
 * proposal per device, superseded only when the device escalates to a HIGHER
 * rung. Never auto-applies.
 * @param {object} [opts]
 * @param {number} [now]
 * @returns {object[]} proposed action suggestions
 */
function proposeActions(opts = {}, now = Date.now()) {
  if (!enabled()) return [];
  const st = _load();
  const cutoff = now - _windowMs();
  const out = [];
  let changed = false;
  for (const [deviceId, occs] of Object.entries(st.occurrences)) {
    const recent = (occs || []).filter((o) => o.at >= cutoff);
    // Highest ladder rung whose threshold is met (per-device policy thresholds).
    const ladder = _policyLadder(deviceId);
    let rung = null;
    for (const r of ladder) if (recent.length >= r.minOccurrences) rung = r;
    if (!rung) continue;
    const existing = st.proposed[deviceId];
    if (existing && existing.status === 'proposed' && _rungIndex(existing.action) >= rung.rung) {
      out.push(existing); continue; // already at-or-above the current rung
    }
    if (existing && (existing.status === 'confirmed' || existing.status === 'dismissed') && _rungIndex(existing.action) >= rung.rung) {
      continue; // human already handled this or a firmer action
    }
    const suggestion = {
      id: `anom-act-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      deviceId,
      action: rung.action,
      severity: rung.severity,
      occurrences: recent.length,
      reason: `${deviceId} anomalous ${recent.length}x within window → advisory ${rung.action}`,
      directive: rung.directive(deviceId),
      status: 'proposed',
      proposed: true,
      requiresHuman: true,
      autonomousAction: false,
      createdAt: new Date().toISOString()
    };
    st.proposed[deviceId] = suggestion;
    out.push(suggestion);
    changed = true;
  }
  if (changed) _save(st);
  return out;
}

/** All open (proposed) action suggestions. */
function listProposed() {
  return Object.values(_load().proposed).filter((s) => s.status === 'proposed');
}

/**
 * Phase 23 — FLEET-WIDE action. When MULTIPLE distinct devices are persistently
 * anomalous within the window, propose a single advisory "rotate-all" (fleet-wide
 * token rotation) — a human-gated security response reusing the escalation
 * pipeline. Deduplicated: one open fleet proposal at a time.
 * @param {{ minDevices?:number, minOccurrences?:number }} [opts]
 * @param {number} [now]
 * @returns {object|null}
 */
function proposeFleetAction(opts = {}, now = Date.now()) {
  if (!enabled()) return null;
  const st = _load();
  const cutoff = now - _windowMs();
  const minDevices = Number.isFinite(opts.minDevices)
    ? opts.minDevices
    : (Number(process.env.LIKU_PERIPHERAL_FLEET_MIN_DEVICES) || 3);
  const minOcc = Number.isFinite(opts.minOccurrences) ? opts.minOccurrences : ACTION_LADDER[0].minOccurrences;
  const anomalous = [];
  for (const [deviceId, occs] of Object.entries(st.occurrences)) {
    const recent = (occs || []).filter((o) => o.at >= cutoff);
    if (recent.length >= minOcc) anomalous.push(deviceId);
  }
  if (anomalous.length < minDevices) return null;
  const key = 'fleet:rotate-all';
  const existing = st.proposed[key];
  if (existing && existing.status === 'proposed') return existing;
  if (existing && (existing.status === 'confirmed' || existing.status === 'dismissed')) return null;
  const suggestion = {
    id: `fleet-act-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    deviceId: null,
    scope: 'fleet',
    action: 'rotate-all',
    severity: 'critical',
    devices: anomalous.slice(),
    occurrences: anomalous.length,
    reason: `${anomalous.length} devices persistently anomalous → advisory fleet-wide token rotation`,
    directive: 'liku peripherals token rotate-all',
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

/**
 * EXPLICIT human confirmation. Records approval and RETURNS the exact command
 * to run — it deliberately does NOT execute the action (no autonomous actuation
 * path). The human runs the returned directive.
 * @param {string} suggestionId
 */
function confirm(suggestionId) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const st = _load();
  const key = Object.keys(st.proposed).find((k) => st.proposed[k].id === suggestionId);
  if (!key) return { ok: false, reason: 'not-found' };
  const entry = st.proposed[key];
  if (entry.status !== 'proposed') return { ok: false, reason: `already-${entry.status}` };
  entry.status = 'confirmed';
  entry.confirmedAt = new Date().toISOString();
  _save(st);
  return { ok: true, action: entry.action, deviceId: entry.deviceId, directive: entry.directive };
}

/** Dismiss a proposed action (human declined). */
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
  try { if (fs.existsSync(STORE_FILE)) fs.rmSync(STORE_FILE); return true; }
  catch { return false; }
}

module.exports = {
  FLAG, STORE_FILE, POLICIES_FILE, ACTION_LADDER,
  enabled, recordAnomaly, proposeActions, proposeFleetAction, listProposed, confirm, dismiss, clear,
  setPolicy, getPolicy, listPolicies, clearPolicies
};
