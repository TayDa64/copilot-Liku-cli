/**
 * TaskContract store — durable, atomic persistence for CODING contracts (Phase 44).
 *
 * Deliberately SEPARATE from supervisor-task-store.js: coding contracts must NOT
 * pollute the peripheral ~/.liku/supervisor-tasks.json inbox (schema 1.0.0,
 * requiresHuman semantics). This store lives at ~/.liku/task-contracts.json.
 *
 * FEATURE-FLAG GATED: only touches disk when LIKU_PERSIST_TASK_CONTRACTS=1.
 * Default OFF, so normal coding flows never write this file. Bounded + sanitized
 * (max 20 tasks), reusing the shared atomic writer. Tests set LIKU_HOME_OVERRIDE.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');
const { isPersistEnabled, CAPS } = require('./task-contract');

const STORE_FILE = path.join(LIKU_HOME, 'task-contracts.json');
const SCHEMA_VERSION = '1.0.0';
const MAX_TASKS = 20;

function enabled() {
  return isPersistEnabled(process.env);
}

// Size-bounded, JSON-safe coercion mirroring the peripheral store discipline.
function _safeObject(o, maxKeys = 40, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return {};
  if (Array.isArray(o)) {
    return o.slice(0, CAPS.CAP_PATHS).map((v) =>
      v && typeof v === 'object' ? _safeObject(v, maxKeys, depth + 1) : (typeof v === 'string' ? v.slice(0, CAPS.CAP_PATH) : v)
    );
  }
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n++ >= maxKeys) break;
    const t = typeof v;
    if (t === 'number' && Number.isFinite(v)) out[k] = v;
    else if (t === 'boolean') out[k] = v;
    else if (t === 'string') out[k] = v.slice(0, CAPS.CAP_TEXT);
    else if (v && t === 'object') out[k] = _safeObject(v, maxKeys, depth + 1);
  }
  return out;
}

function load() {
  if (!enabled()) return { tasks: [] };
  try {
    if (!fs.existsSync(STORE_FILE)) return { tasks: [] };
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    const tasks = (Array.isArray(raw && raw.tasks) ? raw.tasks : [])
      .filter((t) => t && typeof t === 'object')
      .slice(-MAX_TASKS);
    return { tasks };
  } catch (err) {
    console.warn('[TaskContractStore] Failed to load (non-fatal):', err.message);
    return { tasks: [] };
  }
}

function save(tasks) {
  if (!enabled()) return false;
  try {
    const bounded = (Array.isArray(tasks) ? tasks : [])
      .slice(-MAX_TASKS)
      .map((t) => _safeObject(t));
    atomicWriteFileSync(STORE_FILE, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      tasks: bounded
    }, null, 2));
    return true;
  } catch (err) {
    console.warn('[TaskContractStore] Failed to save (non-fatal):', err.message);
    return false;
  }
}

module.exports = { enabled, load, save, STORE_FILE, SCHEMA_VERSION, MAX_TASKS };
