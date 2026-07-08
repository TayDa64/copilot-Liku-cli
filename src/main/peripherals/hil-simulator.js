/**
 * Hardware-in-the-Loop (HIL) Simulator — Pillar 3 (Phase 10).
 *
 * A tiny, timer-free, in-memory transport that real drivers route to when HIL
 * mode is enabled (LIKU_PERIPHERAL_HIL=1). It lets the serial / BLE / MQTT
 * drivers run end-to-end in CI and tests WITHOUT any physical hardware, while
 * keeping the full DCP + class-gate + pending/confirm safety chain intact (the
 * PAL still gates every command before the driver ever calls the simulator).
 *
 * ISOLATION: HIL is OFF by default. When off, real drivers use their real
 * transport and this module is never consulted. HIL never touches real hardware.
 */

'use strict';

const HIL_FLAG = 'LIKU_PERIPHERAL_HIL';

/** True when HIL simulation mode is enabled. */
function isEnabled() {
  return String(process.env[HIL_FLAG] || '').trim() === '1';
}

// Simulated per-device state (in-memory only; never persisted).
const _state = Object.create(null);
// Last command per device (diagnostics/inspection).
const _lastCommand = Object.create(null);

function _norm(action) { return String(action || '').trim().toLowerCase(); }

/**
 * Simulate performing an action. Deterministic + pure-ish (mutates in-memory
 * state only). Mirrors the mock driver's semantics so gating/tests are stable.
 * @param {object} device
 * @param {string} action
 * @param {object} [params]
 * @returns {{ ok:boolean, action:string, state:object, result:string, simulated:true }}
 */
function perform(device, action, params = {}) {
  const id = device && device.id;
  const act = _norm(action);
  const state = { ...(_state[id] || {}) };
  switch (act) {
    case 'on': state.power = 'on'; if (!state.brightness) state.brightness = 100; break;
    case 'off': state.power = 'off'; state.brightness = 0; break;
    case 'brightness': {
      const b = Math.max(0, Math.min(100, Number(params && params.level)));
      state.brightness = Number.isFinite(b) ? b : state.brightness;
      state.power = state.brightness > 0 ? 'on' : 'off';
      break;
    }
    case 'lock': state.locked = true; break;
    case 'unlock': state.locked = false; break;
    case 'open': state.open = true; break;
    case 'close': state.open = false; break;
    default: break; // read/status/custom → no mutation
  }
  _state[id] = state;
  _lastCommand[id] = { action: act, params: params || {}, at: new Date().toISOString() };
  return { ok: true, action: act, state, result: `hil:${id}:${act}`, simulated: true };
}

/** Inspect a simulated device's state. */
function getState(id) { return { ...(_state[id] || {}) }; }

/** Inspect the last simulated command for a device. */
function getLastCommand(id) { return _lastCommand[id] ? { ..._lastCommand[id] } : null; }

/** Reset all simulated state (tests). */
function reset() {
  for (const k of Object.keys(_state)) delete _state[k];
  for (const k of Object.keys(_lastCommand)) delete _lastCommand[k];
}

module.exports = { HIL_FLAG, isEnabled, perform, getState, getLastCommand, reset };
