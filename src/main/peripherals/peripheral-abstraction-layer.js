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

// Lazy accessors so nothing (disk/registry) is touched unless the flag is on
// and a method is actually invoked.
function registry() { return require('./peripheral-registry').getInstance(); }
function mockDriver() { return require('./drivers/mock-driver'); }
function systemContext() { return require('../system-context-manager'); }

/** In-memory subscribers (only used while enabled). */
const _subscribers = new Set();

function _emit(event) {
  for (const cb of _subscribers) {
    try { cb(event); } catch { /* subscriber errors are non-fatal */ }
  }
}

/**
 * Discover devices via the mock driver and register them.
 * @returns {{ enabled: boolean, devices: object[] }}
 */
function scan() {
  if (!isPeripheralsEnabled()) return { enabled: false, devices: [] };
  const reg = registry();
  const found = mockDriver().discover();
  for (const d of found) reg.register(d);
  _emit({ type: 'scan', count: found.length, at: new Date().toISOString() });
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

/**
 * Build the guard key that authorizes a specific Class A action.
 * @private
 */
function _authKey(device) {
  return `guard.peripheral.${String(device.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

const READ_ONLY_ACTIONS = new Set(['read', 'status']);

/**
 * Decide whether a physical action may proceed, routing through the gated
 * proposeUpdate + pending/confirm system. Returns a decision object.
 *
 * @param {object} device
 * @param {string} action
 * @param {object} [params]
 * @returns {{ allowed: boolean, pending?: boolean, confirmKey?: string, klass: string, reason?: string }}
 */
function isPhysicalActionAllowed(device, action, params = {}) {
  const klass = device.class;
  const act = String(action || '').trim().toLowerCase();

  // Class C or any read-only action → always allowed (no state change).
  if (klass === 'C' || READ_ONLY_ACTIONS.has(act)) {
    return { allowed: true, klass, reason: 'read-only' };
  }

  const sc = systemContext();

  // Class B (safe actuator) → gated proposeUpdate at high confidence → applies.
  if (klass === 'B') {
    sc.proposeUpdate(`cap.peripheral.${device.id}.lastAction`, act, { source: 'hook', confidence: 0.95 });
    return { allowed: true, klass, reason: 'safe-actuator-gated' };
  }

  // Class A (high-risk) → require a CONFIRMED guard authorization for this action.
  const authKey = _authKey(device);
  const authorized = sc.getInstance ? sc.getInstance().get(authKey) : undefined;
  if (authorized === act) {
    return { allowed: true, klass, reason: 'confirmed' };
  }
  // Not yet authorized → propose to a guard.* key at LOW confidence so it queues
  // for human confirmation (guard.* threshold is 0.9). Never auto-applies.
  sc.proposeUpdate(authKey, act, { source: 'system', confidence: 0.5 });
  return { allowed: false, pending: true, confirmKey: authKey, klass, reason: 'confirmation-required' };
}

/**
 * Execute an action on a device (safety gated).
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
    _emit({ type: 'blocked', id, action, confirmKey: decision.confirmKey });
    return {
      enabled: true, ok: false, pending: !!decision.pending,
      confirmKey: decision.confirmKey, klass: decision.klass, reason: decision.reason
    };
  }

  const result = mockDriver().perform(device, action, params);
  if (result.ok && result.state) registry().updateState(id, result.state);
  _emit({ type: 'action', id, action, result });
  return { enabled: true, ok: result.ok, klass: decision.klass, result, reason: result.reason };
}

/**
 * Subscribe to device events. Returns an unsubscribe function.
 * @param {(event:object)=>void} cb
 * @returns {() => void}
 */
function subscribe(cb) {
  if (!isPeripheralsEnabled() || typeof cb !== 'function') return () => {};
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

module.exports = {
  FLAG,
  isPeripheralsEnabled,
  scan,
  get,
  list,
  execute,
  subscribe,
  isPhysicalActionAllowed
};
