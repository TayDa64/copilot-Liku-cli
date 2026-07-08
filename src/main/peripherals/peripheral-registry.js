/**
 * Peripheral Registry — Pillar 3 (Peripheral Abstraction Layer) foundation.
 *
 * A durable, atomic store of known peripheral devices under
 * ~/.liku/peripherals.json. Pure data layer: it holds device records and their
 * last-known state. All safety gating + the LIKU_ENABLE_PERIPHERALS feature flag
 * live in the PAL (peripheral-abstraction-layer.js), NOT here — but this module
 * has ZERO import side effects (no disk, no timers) so it is inert until the PAL
 * lazily instantiates it after a flag check.
 *
 * Device classes (risk tiers):
 *   A = high-risk actuator (locks, valves, motors) — human confirm required
 *   B = safe actuator (lights, displays)           — gated + auto-approved
 *   C = sensor (read-only)                          — free to read
 *
 * Follows the same atomic-write + sanitization discipline as the cognitive
 * substrate (system-context-manager.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { atomicWriteFileSync } = require('../../shared/atomic-file');

const PERIPHERALS_FILE = path.join(LIKU_HOME, 'peripherals.json');
const SCHEMA_VERSION = '1.0.0';
const VALID_CLASSES = Object.freeze(['A', 'B', 'C']);
const ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_STR = 120;

function nowIso() { return new Date().toISOString(); }

function sanitizeId(id) {
  const s = String(id || '').trim();
  return ID_PATTERN.test(s) ? s : null;
}

function sanitizeStr(v, max = MAX_STR) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

function sanitizeClass(c) {
  const s = String(c || '').trim().toUpperCase();
  return VALID_CLASSES.includes(s) ? s : null;
}

/** Coerce an arbitrary state object into a shallow, JSON-safe scalar map. */
function sanitizeState(state) {
  const out = {};
  if (!state || typeof state !== 'object') return out;
  for (const [k, v] of Object.entries(state)) {
    const key = sanitizeStr(k, 40);
    if (!key) continue;
    const t = typeof v;
    if (t === 'number' && Number.isFinite(v)) out[key] = v;
    else if (t === 'boolean') out[key] = v;
    else if (t === 'string') out[key] = v.slice(0, MAX_STR);
  }
  return out;
}

function sanitizeCapabilities(caps) {
  return Array.from(new Set((Array.isArray(caps) ? caps : [])
    .map((c) => sanitizeStr(c, 40))
    .filter(Boolean)));
}

class PeripheralRegistry {
  constructor() {
    /** @type {Record<string, object>} id → device record */
    this._devices = {};
    this._load();
  }

  /** Load from disk; corruption/absence is non-fatal (empty registry). @private */
  _load() {
    try {
      if (!fs.existsSync(PERIPHERALS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(PERIPHERALS_FILE, 'utf-8'));
      const devices = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
      for (const [id, dev] of Object.entries(devices)) {
        const rec = this._sanitizeDevice(dev, id);
        if (rec) this._devices[rec.id] = rec;
      }
    } catch (err) {
      console.warn('[Peripherals] Failed to load registry:', err.message);
    }
  }

  /** Atomic persist (tmp + rename, advisory-locked). Never throws. @private */
  _persist() {
    try {
      if (!fs.existsSync(LIKU_HOME)) fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
      const payload = { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), devices: this._devices };
      atomicWriteFileSync(PERIPHERALS_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
      return true;
    } catch (err) {
      console.warn('[Peripherals] Failed to persist registry:', err.message);
      return false;
    }
  }

  /** @private */
  _sanitizeDevice(device, fallbackId) {
    const id = sanitizeId(device && device.id) || sanitizeId(fallbackId);
    const cls = sanitizeClass(device && device.class);
    if (!id || !cls) return null;
    const rec = {
      id,
      name: sanitizeStr(device.name) || id,
      class: cls,
      driver: sanitizeStr(device.driver, 40) || 'unknown',
      kind: sanitizeStr(device.kind, 40) || 'device',
      capabilities: sanitizeCapabilities(device.capabilities),
      state: sanitizeState(device.state),
      registeredAt: sanitizeStr(device.registeredAt) || nowIso(),
      lastSeen: nowIso()
    };
    // Preserve the device's rated power draw (watts) for cumulative budgeting.
    if (Number.isFinite(Number(device && device.powerW))) rec.powerW = Number(device.powerW);
    return rec;
  }

  /**
   * Register (or refresh) a device. Returns the stored record or null if invalid.
   * @param {object} device
   */
  register(device) {
    const existing = this._devices[sanitizeId(device && device.id)];
    const rec = this._sanitizeDevice(device);
    if (!rec) return null;
    if (existing) rec.registeredAt = existing.registeredAt; // preserve first-seen
    this._devices[rec.id] = rec;
    this._persist();
    return { ...rec };
  }

  /** Remove a device. @returns {boolean} */
  unregister(id) {
    const safeId = sanitizeId(id);
    if (!safeId || !this._devices[safeId]) return false;
    delete this._devices[safeId];
    this._persist();
    return true;
  }

  /** Merge a state patch into a device. @returns {object|null} */
  updateState(id, patch) {
    const safeId = sanitizeId(id);
    const dev = safeId ? this._devices[safeId] : null;
    if (!dev) return null;
    dev.state = { ...dev.state, ...sanitizeState(patch) };
    dev.lastSeen = nowIso();
    this._persist();
    return { ...dev };
  }

  /** @returns {object|null} */
  get(id) {
    const safeId = sanitizeId(id);
    return safeId && this._devices[safeId] ? { ...this._devices[safeId] } : null;
  }

  /**
   * List devices, optionally filtered by class.
   * @param {{ class?: string }} [filter]
   * @returns {object[]}
   */
  list(filter = {}) {
    const cls = filter.class ? sanitizeClass(filter.class) : null;
    return Object.values(this._devices)
      .filter((d) => !cls || d.class === cls)
      .map((d) => ({ ...d }));
  }

  /** Group devices by class. @returns {{A:object[],B:object[],C:object[]}} */
  listByClass() {
    const out = { A: [], B: [], C: [] };
    for (const d of Object.values(this._devices)) {
      if (out[d.class]) out[d.class].push({ ...d });
    }
    return out;
  }

  /** Clear all devices (test/governance). */
  clear() {
    this._devices = {};
    this._persist();
  }

  get file() { return PERIPHERALS_FILE; }
}

let _instance = null;
function getInstance() {
  if (!_instance) _instance = new PeripheralRegistry();
  return _instance;
}

module.exports = {
  PeripheralRegistry,
  getInstance,
  PERIPHERALS_FILE,
  VALID_CLASSES,
  SCHEMA_VERSION
};
