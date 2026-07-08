/**
 * Supervisor Task + Notification Store — durable, atomic persistence (Phase 9).
 *
 * Persists the Supervisor's peripheral NOTIFICATIONS and human-gated TASKS under
 * ~/.liku/supervisor-tasks.json so they survive process restarts. Mirrors the
 * atomic-write + corruption-tolerant discipline of peripheral-registry.js and
 * system-context-manager.js.
 *
 * FEATURE-FLAG GATED: like the PAL, this store only touches disk when
 * LIKU_ENABLE_PERIPHERALS=1. When the flag is off, load() returns empty and
 * save() is a no-op — so normal coding/agent flows NEVER write this file and the
 * default behaviour is unchanged.
 *
 * RETENTION / ESCALATION: on every load+save the store prunes stale entries with
 * per-severity retention windows (critical/high are kept longer than low), and
 * resolved tasks expire faster than open ones. Everything is bounded + sanitized.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const FLAG = 'LIKU_ENABLE_PERIPHERALS';
const STORE_FILE = path.join(LIKU_HOME, 'supervisor-tasks.json');
const SCHEMA_VERSION = '1.0.0';

const MAX_NOTIFICATIONS = 50;
const MAX_TASKS = 20;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Per-severity retention windows for OPEN entries (pending-review / unacknowledged).
const OPEN_RETENTION_MS = Object.freeze({
  critical: 7 * DAY,
  high: 7 * DAY,
  warning: 1 * DAY,
  medium: 1 * DAY,
  low: 6 * HOUR,
  info: 6 * HOUR
});
// Resolved / acknowledged entries are kept only briefly for audit.
const RESOLVED_RETENTION_MS = 6 * HOUR;

function enabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

function nowMs() { return Date.now(); }

function _parseTime(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Retention window for an entry given its severity + resolved state. @private */
function _retentionMs(severity, resolved) {
  if (resolved) return RESOLVED_RETENTION_MS;
  const key = String(severity || 'info').toLowerCase();
  return OPEN_RETENTION_MS[key] != null ? OPEN_RETENTION_MS[key] : OPEN_RETENTION_MS.info;
}

function _isTaskExpired(task, now) {
  const resolved = task.status && task.status !== 'pending-review';
  const anchor = _parseTime(task.resolvedAt) || _parseTime(task.lastSeenAt) || _parseTime(task.createdAt) || now;
  const sev = task.priority === 'high' ? 'high' : (task.priority === 'medium' ? 'warning' : 'low');
  return now - anchor > _retentionMs(sev, resolved);
}

function _isNotificationExpired(n, now) {
  const resolved = !!n.acknowledged;
  const anchor = _parseTime(n.receivedAt) || _parseTime(n.at) || now;
  return now - anchor > _retentionMs(n.severity, resolved);
}

/** Coerce to a JSON-safe, size-bounded plain object. @private */
function _safeObject(o, maxKeys = 40) {
  if (!o || typeof o !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n++ >= maxKeys) break;
    const t = typeof v;
    if (t === 'number' && Number.isFinite(v)) out[k] = v;
    else if (t === 'boolean') out[k] = v;
    else if (t === 'string') out[k] = v.slice(0, 500);
    else if (v && t === 'object') out[k] = _safeObject(v, maxKeys);
  }
  return out;
}

/**
 * Load persisted notifications + tasks (with retention pruning applied).
 * Corruption / absence / flag-off all yield empty arrays (never throws).
 * @returns {{ notifications: object[], tasks: object[] }}
 */
function load() {
  const empty = { notifications: [], tasks: [] };
  if (!enabled()) return empty;
  try {
    if (!fs.existsSync(STORE_FILE)) return empty;
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    const now = nowMs();
    const notifications = (Array.isArray(raw && raw.notifications) ? raw.notifications : [])
      .filter((n) => n && typeof n === 'object' && !_isNotificationExpired(n, now))
      .slice(-MAX_NOTIFICATIONS);
    const tasks = (Array.isArray(raw && raw.tasks) ? raw.tasks : [])
      .filter((t) => t && typeof t === 'object' && !_isTaskExpired(t, now))
      .slice(-MAX_TASKS);
    return { notifications, tasks };
  } catch (err) {
    console.warn('[SupervisorStore] Failed to load (non-fatal):', err.message);
    return empty;
  }
}

/**
 * Atomically persist notifications + tasks (tmp + rename). Applies retention
 * pruning + caps first. No-op + no disk touched when the flag is off.
 * @param {{ notifications?: object[], tasks?: object[] }} state
 * @returns {boolean}
 */
function save(state = {}) {
  if (!enabled()) return false;
  try {
    const now = nowMs();
    const notifications = (Array.isArray(state.notifications) ? state.notifications : [])
      .filter((n) => n && typeof n === 'object' && !_isNotificationExpired(n, now))
      .slice(-MAX_NOTIFICATIONS)
      .map((n) => _safeObject(n));
    const tasks = (Array.isArray(state.tasks) ? state.tasks : [])
      .filter((t) => t && typeof t === 'object' && !_isTaskExpired(t, now))
      .slice(-MAX_TASKS)
      .map((t) => _safeObject(t));

    if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
    const payload = { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), notifications, tasks };
    atomicWriteFileSync(STORE_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn('[SupervisorStore] Failed to persist (non-fatal):', err.message);
    return false;
  }
}

/** Remove the store file (governance/test). No-op when disabled. */
function clear() {
  if (!enabled()) return false;
  try { if (fs.existsSync(STORE_FILE)) fs.rmSync(STORE_FILE); return true; }
  catch { return false; }
}

module.exports = {
  FLAG,
  STORE_FILE,
  SCHEMA_VERSION,
  MAX_NOTIFICATIONS,
  MAX_TASKS,
  OPEN_RETENTION_MS,
  RESOLVED_RETENTION_MS,
  enabled,
  load,
  save,
  clear
};
