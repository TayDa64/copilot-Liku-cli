/**
 * Serial / ESP32 Peripheral Driver — Pillar 3 REAL driver example (Phase 6).
 *
 * Second real driver, validating the driver interface is protocol-agnostic:
 *   id, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * AVAILABILITY + SAFETY (identical discipline to the MQTT driver):
 *   - "available" only when configured via env (LIKU_SERIAL_PORT) AND devices
 *     are declared (LIKU_SERIAL_DEVICES). Otherwise the mock stays the default.
 *   - The optional `serialport` package is required LAZILY at connect time, so
 *     discover() (and therefore PAL/DCP safety gating) works without it.
 *   - perform() writes a newline-delimited command; if not connected it returns
 *     { ok:false, reason:'not-connected' } — but the PAL has ALREADY enforced
 *     the class-based safety gate, so a Class A action still requires
 *     confirmation regardless of connectivity.
 *
 * Device config (JSON in env LIKU_SERIAL_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW }
 */

'use strict';

const hil = require('../hil-simulator');

const DRIVER_ID = 'serial';
// Serial is a LOCAL wired link (trusted) — may run in unsigned mode for
// convenience even when a DCP secret is configured (Phase 9).
const REMOTE = false;
const SUPPORTS_HIL = true;
// Framing guard: newline-delimited JSON with a bounded buffer so a noisy or
// malicious device can never grow memory without bound (Phase 10).
const MAX_LINE_BYTES = 64 * 1024;

function portPath() {
  return String(process.env.LIKU_SERIAL_PORT || '').trim();
}

function baudRate() {
  const n = Number(process.env.LIKU_SERIAL_BAUD);
  return Number.isFinite(n) && n > 0 ? n : 115200;
}

/** Parse declared device config from env (safe, never throws). */
function loadDeviceConfig() {
  try {
    const raw = process.env.LIKU_SERIAL_DEVICES;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d && typeof d === 'object' && d.id && ['A', 'B', 'C'].includes(d.class))
      .map((d) => ({
        id: String(d.id),
        name: String(d.name || d.id),
        class: d.class,
        kind: String(d.kind || 'device'),
        capabilities: Array.isArray(d.capabilities) ? d.capabilities.map((c) => String(c)) : [],
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

/** Lazily require the optional serialport package (null if not installed). */
function loadSerialLib() {
  try { return require('serialport'); } catch { return null; }
}

/** Available when a port is configured AND at least one device is declared — or
 * in HIL mode (no real port required, for CI/testing). */
function isAvailable() {
  if (loadDeviceConfig().length === 0) return false;
  return hil.isEnabled() || !!portPath();
}

/** Declared devices (no connection required). @returns {object[]} */
function discover() {
  return loadDeviceConfig().map((d) => ({
    id: d.id, name: d.name, class: d.class, kind: d.kind,
    capabilities: d.capabilities, state: {}, powerW: d.powerW, driver: DRIVER_ID
  }));
}

let _port = null;

function _ensureOpen() {
  if (_port && _port.isOpen) return _port;
  const lib = loadSerialLib();
  const path = portPath();
  if (!lib || !path) return null;
  try {
    const SerialPort = lib.SerialPort || lib;
    _port = new SerialPort({ path, baudRate: baudRate(), autoOpen: true });
    return _port;
  } catch {
    return null;
  }
}

/**
 * Send a command line to the device. The PAL has already enforced the
 * class-based safety gate before this is called.
 * @param {object} device
 * @param {string} action
 * @param {object} [params]
 */
function perform(device, action, params = {}) {
  const cfg = loadDeviceConfig().find((d) => d.id === (device && device.id));
  const act = String(action || '').trim().toLowerCase();
  if (!cfg) return { ok: false, action: act, state: {}, reason: 'unknown-device' };
  if (!cfg.capabilities.map((c) => c.toLowerCase()).includes(act)) {
    return { ok: false, action: act, state: {}, reason: 'unsupported-action' };
  }
  // DCP wire format (Phase 8): build a versioned, capability-scoped envelope.
  const dcp = require('../dcp-protocol');
  const token = dcp.issueCapabilityToken({ deviceId: cfg.id, actions: [act], ttlSec: 60 });
  const envelope = dcp.buildCommandEnvelope({ device: cfg, action: act, params, token });

  // HIL simulation path — no real port touched (CI/testing).
  if (hil.isEnabled()) {
    const r = hil.perform(cfg, act, params);
    return { ...r, result: `serial:${cfg.id}:${act}`, envelope, simulated: true };
  }

  const port = _ensureOpen();
  if (!port) return { ok: false, action: act, state: {}, reason: 'not-connected' };
  try {
    port.write(`${JSON.stringify(envelope)}\n`);
    return { ok: true, action: act, state: { lastCommand: act }, result: `serial:${cfg.id}:${act}`, envelope };
  } catch (err) {
    return { ok: false, action: act, state: {}, reason: `write-failed: ${err.message}` };
  }
}

/**
 * Stream inbound sensor lines; invoke emit(reading) per JSON line.
 * Returns a stop() that closes the port. No-op when unavailable.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const port = _ensureOpen();
  if (!port) return () => {};
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString();
    // Framing guard: drop an over-long line with no delimiter (bounded memory).
    if (buffer.length > MAX_LINE_BYTES && buffer.indexOf('\n') < 0) {
      buffer = '';
      return;
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.length > MAX_LINE_BYTES) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.id) emit({ id: String(msg.id), metrics: msg.metrics || {}, at: new Date().toISOString() });
      } catch { /* ignore malformed line */ }
    }
  };
  try { port.on('data', onData); } catch { /* non-fatal */ }
  return () => { try { port.off('data', onData); port.close(); } catch { /* ignore */ } _port = null; };
}

module.exports = { DRIVER_ID, REMOTE, SUPPORTS_HIL, isAvailable, discover, perform, start, loadDeviceConfig };
