/**
 * Peripheral Abstraction Layer (PAL) — Pillar 3 (mock-only, feature-flagged).
 *
 * Unified, driver-agnostic interface for peripheral devices:
 *   scan()                      → discover + register devices
 *   get(id)                     → a registered device
 *   execute(id, action, params) → perform an action (SAFETY GATED)
 *   subscribe(cb)               → device event stream (returns unsubscribe)
 *
 * SAFETY MODEL — every physical action is routed through the existing cognitive
 * substrate confidence + pending/confirm system (system-context-manager.js):
 *   Class C (sensor, read-only) : allowed immediately, no gating.
 *   Class B (safe actuator)     : gated proposeUpdate at high confidence → auto
 *                                 approved (logged/reversible, non-guard key).
 *   Class A (high-risk actuator): gated proposeUpdate to a guard.* key at LOW
 *                                 confidence → QUEUES for human confirmation.
 *                                 The action is refused until the user runs
 *                                 `liku system-context confirm <guardKey> --apply`.
 *                                 Class A can NEVER bypass confirmation.
 *
 * FEATURE FLAG — LIKU_ENABLE_PERIPHERALS must equal '1'. The flag is checked on
 * EVERY entry point (not just at startup). When off, every method is inert: it
 * returns an { enabled: false } shape and performs NO disk / registry / driver
 * work whatsoever. This module has zero import side effects.
 */

'use strict';

const FLAG = 'LIKU_ENABLE_PERIPHERALS';

/** Strict flag check — evaluated on every PAL operation. */
function isPeripheralsEnabled() {
  return String(process.env[FLAG] || '').trim() === '1';
}

const EventEmitter = require('events');

// Lazy accessors so nothing (disk/registry/driver) is touched unless the flag is
// on and a method is actually invoked.
function registry() { return require('./peripheral-registry').getInstance(); }
function systemContext() { return require('../system-context-manager'); }
function policy() { return require('./peripheral-policy'); }

// ── Driver registry ──────────────────────────────────────────
// The mock driver is ALWAYS available (first-class test driver). Real drivers
// (e.g. mqtt) are used only when they report isAvailable() — otherwise the mock
// remains the default. All drivers share the same interface:
//   id, isAvailable(), discover(), perform(device, action, params), start(emit)
const DRIVER_IDS = Object.freeze(['mock', 'mqtt', 'serial']);
const _driverCache = {};
function _driver(id) {
  if (!(id in _driverCache)) {
    try {
      if (id === 'mock') _driverCache[id] = require('./drivers/mock-driver');
      else if (id === 'mqtt') _driverCache[id] = require('./drivers/mqtt-driver');
      else if (id === 'serial') _driverCache[id] = require('./drivers/serial-driver');
      else _driverCache[id] = null;
    } catch { _driverCache[id] = null; }
  }
  return _driverCache[id] || null;
}
function availableDrivers() {
  return DRIVER_IDS.map(_driver).filter((d) => d && (typeof d.isAvailable !== 'function' || d.isAvailable()));
}
function driverFor(device) {
  return _driver(device && device.driver) || _driver('mock');
}

// ── Event bus (event-driven monitoring) ──────────────────────
const _bus = new EventEmitter();
_bus.setMaxListeners(100);
function _emit(event) {
  try {
    _bus.emit('event', event);
    if (event && event.type) _bus.emit(event.type, event);
  } catch { /* listener errors are non-fatal */ }
}

/**
 * Discover devices across all available drivers and register them. The mock
 * driver is always included; real drivers only when configured/available.
 * @returns {{ enabled: boolean, devices: object[] }}
 */
function scan() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  const reg = registry();
  let count = 0;
  for (const d of availableDrivers()) {
    try {
      for (const dev of d.discover()) { reg.register(dev); count++; }
    } catch { /* one bad driver never breaks the scan */ }
  }
  _emit({ type: 'scan', count, at: new Date().toISOString() });
  return { enabled: true, devices: reg.list() };
}

/**
 * Get a registered device by id.
 * @param {string} id
 * @returns {object|null}
 */
function get(id) {
  if (!isPeripheralsEnabled()) return null;
  return registry().get(id);
}

/**
 * List devices (optionally by class).
 * @param {{class?:string}} [filter]
 * @returns {{ enabled: boolean, devices: object[] }}
 */
function list(filter = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  return { enabled: true, devices: registry().list(filter) };
}

/** List available driver ids. */
function listDrivers() {
  if (!isPeripheralsEnabled()) return { enabled: false, drivers: [] };
  return { enabled: true, drivers: availableDrivers().map((d) => d.DRIVER_ID) };
}

/** Build the guard key that authorizes a specific Class A device. @private */
function _authKey(device) {
  return `guard.peripheral.${String(device.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Read the optional global power budget from the substrate. @private */
function _powerBudgetW() {
  try {
    const v = Number(systemContext().getInstance().get('guard.peripherals.max_total_power_w'));
    return Number.isFinite(v) ? v : undefined;
  } catch { return undefined; }
}

/**
 * Sum the CURRENT continuous draw (watts) of all registered devices except the
 * given id. Used for live cumulative power budgeting. @private
 */
function _currentLoadW(excludeId) {
  try {
    const P = policy();
    let sum = 0;
    for (const d of registry().list()) {
      if (excludeId && d.id === excludeId) continue;
      sum += P.estimateDeviceLoadW(d);
    }
    return Math.round(sum * 100) / 100;
  } catch { return 0; }
}

/**
 * Live power budget status: total budget, current cumulative draw, headroom and
 * a per-device breakdown. Inert when peripherals are disabled.
 * @returns {object}
 */
function powerStatus() {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const P = policy();
  const budgetW = _powerBudgetW();
  const effectiveBudgetW = Number.isFinite(budgetW) ? budgetW : P.DEFAULT_MAX_TOTAL_POWER_W;
  const devices = registry().list().map((d) => ({
    id: d.id, class: d.class, kind: d.kind,
    loadW: P.estimateDeviceLoadW(d), active: P.isDeviceActive(d)
  }));
  const currentW = Math.round(devices.reduce((s, d) => s + d.loadW, 0) * 100) / 100;
  return {
    enabled: true,
    budgetW: effectiveBudgetW,
    currentW,
    headroomW: Math.round((effectiveBudgetW - currentW) * 100) / 100,
    overBudget: currentW > effectiveBudgetW,
    devices
  };
}

/**
 * Decide whether a physical action may proceed. First runs the DCP host-side
 * dry-run (capability scoping + param validation + power budget), then routes
 * through the gated proposeUpdate + pending/confirm system.
 *
 * @param {object} device
 * @param {string} action
 * @param {object} [params]
 * @returns {object} decision
 */
function isPhysicalActionAllowed(device, action, params = {}) {
  const P = policy();
  // DCP host-side rejection of malformed / out-of-scope / over-budget commands.
  const evalRes = P.evaluateCommand(device, action, params, {
    maxTotalPowerW: _powerBudgetW(),
    otherDevicesLoadW: _currentLoadW(device && device.id)
  });
  if (!evalRes.ok) {
    return { allowed: false, rejected: true, code: evalRes.code, reason: evalRes.reason, klass: device.class, power: evalRes.power };
  }
  const act = evalRes.normalized.action;
  const pol = evalRes.policy;
  const klass = pol.class;

  // Class C or read-only → allowed immediately.
  if (evalRes.readOnly || klass === 'C') {
    return { allowed: true, klass, reason: 'read-only', normalized: evalRes.normalized };
  }

  const sc = systemContext();

  // Class B (safe actuator) → gated proposeUpdate at high confidence → applies.
  if (klass === 'B') {
    sc.proposeUpdate(`cap.peripheral.${device.id}.lastAction`, act, { source: 'hook', confidence: 0.95 });
    return { allowed: true, klass, reason: 'safe-actuator-gated', normalized: evalRes.normalized };
  }

  // Class A (high-risk) → require a CONFIRMED guard authorization for this action.
  const authKey = _authKey(device);
  const authorized = sc.getInstance().get(authKey);
  if (authorized === act) {
    return { allowed: true, klass, reason: 'confirmed', normalized: evalRes.normalized, authKey };
  }
  // Not authorized → propose to a guard.* key at LOW confidence with a TTL so it
  // queues for human confirmation and auto-expires. Never auto-applies.
  const ttl = pol.confirmationTtlSec > 0 ? pol.confirmationTtlSec : undefined;
  sc.proposeUpdate(authKey, act, { source: 'system', confidence: 0.5, ttl });
  _emit({ type: 'pending-confirmation', id: device.id, action: act, confirmKey: authKey, ttlSec: ttl });
  return { allowed: false, pending: true, confirmKey: authKey, klass, reason: 'confirmation-required', normalized: evalRes.normalized };
}

/**
 * Execute an action on a device (DCP-validated + safety gated + driver-dispatched).
 * @param {string} id
 * @param {string} action
 * @param {object} [params]
 * @returns {object}
 */
function execute(id, action, params = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  if (!device) return { enabled: true, ok: false, reason: 'device-not-found' };

  const decision = isPhysicalActionAllowed(device, action, params);
  if (!decision.allowed) {
    _emit({ type: 'blocked', id, action, code: decision.code, confirmKey: decision.confirmKey });
    return {
      enabled: true, ok: false, pending: !!decision.pending, rejected: !!decision.rejected,
      code: decision.code, confirmKey: decision.confirmKey, klass: decision.klass, reason: decision.reason,
      power: decision.power
    };
  }

  const drv = driverFor(device);
  const result = drv.perform(device, decision.normalized.action, decision.normalized.params);
  if (result.ok && result.state) registry().updateState(id, result.state);

  // Class A one-shot: consume the authorization after a successful use so each
  // confirmation grants exactly one action (TTL is the time-based backstop).
  if (decision.klass === 'A' && result.ok && decision.authKey) {
    try { systemContext().pruneKey(decision.authKey); } catch { /* non-fatal */ }
  }

  _emit({ type: 'action', id, action: decision.normalized.action, klass: decision.klass, result });
  return { enabled: true, ok: result.ok, klass: decision.klass, result, reason: result.reason };
}

/**
 * Convenience: grant a Class A authorization (wraps the system-context confirm
 * flow). The human running this command IS the confirmation act. Returns the
 * granted auth + its TTL; the action itself is still performed via execute().
 * @param {string} id
 * @param {string} action
 * @returns {object}
 */
function authorize(id, action) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  if (!device) return { enabled: true, ok: false, reason: 'device-not-found' };

  const P = policy();
  const evalRes = P.evaluateCommand(device, action, {}, {
    maxTotalPowerW: _powerBudgetW(),
    otherDevicesLoadW: _currentLoadW(device && device.id)
  });
  if (!evalRes.ok) return { enabled: true, ok: false, code: evalRes.code, reason: evalRes.reason };

  const act = evalRes.normalized.action;
  if (device.class !== 'A') {
    return { enabled: true, ok: true, granted: true, klass: device.class, reason: 'no-confirmation-required' };
  }
  const sc = systemContext();
  const authKey = _authKey(device);
  const ttl = evalRes.policy.confirmationTtlSec > 0 ? evalRes.policy.confirmationTtlSec : undefined;
  // Queue a fresh authorization for THIS action, then confirm it.
  sc.proposeUpdate(authKey, act, { source: 'system', confidence: 0.5, ttl });
  const res = sc.confirmPending(authKey, 'apply');
  return { enabled: true, ok: !!res.ok, granted: !!res.ok, authKey, action: act, ttlSec: ttl, klass: 'A' };
}

/**
 * Ingest an inbound sensor reading (event-driven). Real drivers call this on
 * incoming messages; it updates last-known state (read-only) and emits a
 * 'reading' event that the PeripheralMonitor consumes.
 * @param {string} id
 * @param {object} metrics
 * @returns {object}
 */
function ingestSensorReading(id, metrics = {}) {
  if (!isPeripheralsEnabled()) return { enabled: false };
  const device = registry().get(id);
  if (!device) return { enabled: true, ok: false, reason: 'device-not-found' };
  const patch = {};
  for (const [k, v] of Object.entries(metrics || {})) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') patch[k] = v;
  }
  registry().updateState(id, patch);
  const reading = { type: 'reading', id, klass: device.class, metrics: patch, at: new Date().toISOString() };
  _emit(reading);
  return { enabled: true, ok: true, reading };
}

/**
 * Start real-driver event streams (drivers push readings via ingestSensorReading).
 * Returns a stop() that tears down all streams. No-op when disabled.
 * @returns {() => void}
 */
function startStreaming() {
  if (!isPeripheralsEnabled()) return () => {};
  const stops = [];
  for (const d of availableDrivers()) {
    if (typeof d.start === 'function') {
      try { stops.push(d.start((reading) => ingestSensorReading(reading.id, reading.metrics))); } catch { /* non-fatal */ }
    }
  }
  return () => { for (const s of stops) { try { s(); } catch { /* ignore */ } } };
}

/**
 * Subscribe to ALL device events. Returns an unsubscribe function.
 * @param {(event:object)=>void} cb
 * @returns {() => void}
 */
function subscribe(cb) {
  if (!isPeripheralsEnabled() || typeof cb !== 'function') return () => {};
  _bus.on('event', cb);
  return () => _bus.off('event', cb);
}

/**
 * Subscribe to a specific event type ('reading' | 'action' | 'blocked' |
 * 'pending-confirmation' | 'scan'). Returns an unsubscribe function.
 * @param {string} eventType
 * @param {(event:object)=>void} cb
 * @returns {() => void}
 */
function on(eventType, cb) {
  if (!isPeripheralsEnabled() || typeof cb !== 'function') return () => {};
  _bus.on(eventType, cb);
  return () => _bus.off(eventType, cb);
}

module.exports = {
  FLAG,
  isPeripheralsEnabled,
  scan,
  get,
  list,
  listDrivers,
  execute,
  authorize,
  ingestSensorReading,
  startStreaming,
  subscribe,
  on,
  isPhysicalActionAllowed,
  powerStatus
};

