/**
 * Mock Peripheral Driver — Pillar 3 (mock-only, no real hardware).
 *
 * Simulates a small mixed fleet across all three risk classes so the PAL and its
 * safety routing can be exercised end-to-end without any physical device or
 * external protocol. Pure functions + in-module simulated state; NO import side
 * effects (no disk, no timers, no network).
 *
 *   Class A (high-risk actuator) : mock-lock-01   — lock / unlock
 *   Class B (safe actuator)      : mock-light-01  — on / off / brightness
 *   Class C (sensor, read-only)  : mock-temp-01   — read
 */

'use strict';

const DRIVER_ID = 'mock';

/** Canonical device definitions (deep-copied on discover). */
const DEVICE_DEFS = Object.freeze({
  'mock-lock-01': {
    id: 'mock-lock-01', name: 'Front Door Smart Lock', class: 'A', kind: 'lock',
    capabilities: ['lock', 'unlock', 'status'], state: { locked: true }, powerW: 6
  },
  'mock-light-01': {
    id: 'mock-light-01', name: 'Living Room Smart Light', class: 'B', kind: 'light',
    capabilities: ['on', 'off', 'brightness', 'status'], state: { power: 'off', brightness: 0 }, powerW: 10
  },
  'mock-temp-01': {
    id: 'mock-temp-01', name: 'Bedroom Temperature Sensor', class: 'C', kind: 'sensor',
    capabilities: ['read', 'status'], state: { celsius: 21.5, humidity: 44 }, powerW: 1
  }
});

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

/** The mock driver is always available (first-class test driver). */
function isAvailable() { return true; }

/**
 * Discover the mock fleet. Returns fresh device records (with driver tag).
 * @returns {object[]}
 */
function discover() {
  return Object.values(DEVICE_DEFS).map((d) => ({ ...clone(d), driver: DRIVER_ID }));
}

/**
 * Simulate performing an action on a device. Deterministic + pure: returns a
 * result + the new state patch. Does NOT enforce safety (the PAL does that).
 *
 * @param {object} device registry device record
 * @param {string} action
 * @param {object} [params]
 * @returns {{ ok: boolean, action: string, state: object, result: string, reason?: string }}
 */
function perform(device, action, params = {}) {
  const def = DEVICE_DEFS[device && device.id];
  const act = String(action || '').trim().toLowerCase();
  if (!def) return { ok: false, action: act, state: {}, reason: 'unknown-device' };
  if (!def.capabilities.includes(act)) {
    return { ok: false, action: act, state: {}, reason: 'unsupported-action' };
  }

  const state = { ...(device.state || def.state) };
  switch (act) {
    case 'lock': state.locked = true; break;
    case 'unlock': state.locked = false; break;
    case 'on': state.power = 'on'; if (!state.brightness) state.brightness = 100; break;
    case 'off': state.power = 'off'; state.brightness = 0; break;
    case 'brightness': {
      const b = Math.max(0, Math.min(100, Number(params.level)));
      state.brightness = Number.isFinite(b) ? b : state.brightness;
      state.power = state.brightness > 0 ? 'on' : 'off';
      break;
    }
    case 'read':
    case 'status':
      // read-only: no state mutation
      break;
    default:
      return { ok: false, action: act, state: {}, reason: 'unsupported-action' };
  }
  return { ok: true, action: act, state, result: `mock:${device.id}:${act}` };
}

/**
 * Optional event stream. The mock driver does NOT push readings on its own
 * (no timers), but exposes a no-op start()/stop() so it satisfies the driver
 * interface. Tests drive the event-driven monitor via PAL.ingestSensorReading.
 * @param {(reading:object)=>void} _emit
 * @returns {() => void}
 */
function start(_emit) {
  return () => {};
}

/**
 * Helper: synthesize a sensor reading payload (real-driver parity for tests).
 * @param {string} id
 * @param {object} metrics
 * @returns {{ id:string, metrics:object, at:string }}
 */
function makeReading(id, metrics) {
  return { id, metrics: { ...metrics }, at: new Date().toISOString() };
}

module.exports = { DRIVER_ID, isAvailable, discover, perform, start, makeReading, DEVICE_DEFS };
