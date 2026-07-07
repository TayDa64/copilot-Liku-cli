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

const DRIVER_ID = 'serial';
// Serial is a LOCAL wired link (trusted) — may run in unsigned mode for
// convenience even when a DCP secret is configured (Phase 9).
const REMOTE = false;

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

/** Available when a port is configured AND at least one device is declared. */
function isAvailable() {
  return !!portPath() && loadDeviceConfig().length > 0;
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
  const port = _ensureOpen();
  if (!port) return { ok: false, action: act, state: {}, reason: 'not-connected' };
  try {
    // DCP wire format (Phase 8): send a versioned, signed-capability envelope
    // instead of an ad-hoc payload. Backward compatible — the envelope is a
    // superset; the capability token is `unsigned` local-mode unless
    // LIKU_DCP_SECRET is configured.
    const dcp = require('../dcp-protocol');
    const token = dcp.issueCapabilityToken({ deviceId: cfg.id, actions: [act], ttlSec: 60 });
    const envelope = dcp.buildCommandEnvelope({ device: cfg, action: act, params, token });
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
  const port = _ensureOpen();
  if (!port || typeof emit !== 'function') return () => {};
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.id) emit({ id: String(msg.id), metrics: msg.metrics || {}, at: new Date().toISOString() });
      } catch { /* ignore malformed line */ }
    }
  };
  try { port.on('data', onData); } catch { /* non-fatal */ }
  return () => { try { port.off('data', onData); port.close(); } catch { /* ignore */ } _port = null; };
}

module.exports = { DRIVER_ID, isAvailable, discover, perform, start, loadDeviceConfig, REMOTE };
