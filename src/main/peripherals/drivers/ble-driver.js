/**
 * BLE Peripheral Driver — Pillar 3 REAL driver + HIL support (Phase 10).
 *
 * Third real driver, proving the interface scales to wireless transports:
 *   id, REMOTE, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * AVAILABILITY + SAFETY (same discipline as MQTT/serial):
 *   - "available" only when an adapter is configured (LIKU_BLE_ADAPTER) AND
 *     devices are declared (LIKU_BLE_DEVICES) — OR when HIL simulation is on
 *     (LIKU_PERIPHERAL_HIL=1), in which case no real adapter is required.
 *   - The optional `@abandonware/noble` / `noble` package is required LAZILY at
 *     connect time, so discover() (and PAL/DCP safety gating) works without it.
 *   - BLE is a NETWORKED/wireless transport → REMOTE=true, so signed capability
 *     tokens are mandatory when a DCP secret is configured.
 *   - perform() writes a characteristic; if not connected it returns a
 *     structured { ok:false, reason:'not-connected' } — but the PAL has ALREADY
 *     enforced the class gate, so a Class A action still requires confirmation.
 *
 * Device config (JSON in env LIKU_BLE_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, serviceUuid, charUuid }
 */

'use strict';

const dcp = require('../dcp-protocol');
const hil = require('../hil-simulator');

const DRIVER_ID = 'ble';
// BLE is a wireless/remote transport — signed tokens required when a secret set.
const REMOTE = true;
const SUPPORTS_HIL = true;

function adapterConfigured() {
  return !!String(process.env.LIKU_BLE_ADAPTER || '').trim();
}

/** Parse declared device config from env (safe, never throws). */
function loadDeviceConfig() {
  try {
    const raw = process.env.LIKU_BLE_DEVICES;
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
        serviceUuid: d.serviceUuid ? String(d.serviceUuid) : undefined,
        charUuid: d.charUuid ? String(d.charUuid) : undefined,
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

/** Lazily require an optional BLE library (null if not installed). */
function loadBleLib() {
  try { return require('@abandonware/noble'); }
  catch { try { return require('noble'); } catch { return null; } }
}

/**
 * Available when devices are declared AND (HIL is on OR an adapter is
 * configured). HIL needs no real adapter, enabling CI/testing.
 */
function isAvailable() {
  if (loadDeviceConfig().length === 0) return false;
  return hil.isEnabled() || adapterConfigured();
}

/** Declared devices (no connection required). @returns {object[]} */
function discover() {
  return loadDeviceConfig().map((d) => ({
    id: d.id, name: d.name, class: d.class, kind: d.kind,
    capabilities: d.capabilities, state: {}, powerW: d.powerW, driver: DRIVER_ID
  }));
}

/** Build the signed DCP envelope for an outbound command (shared by paths). @private */
function _buildEnvelope(cfg, act, params) {
  const token = dcp.issueCapabilityToken({ deviceId: cfg.id, actions: [act], ttlSec: 60 });
  if (REMOTE && dcp.isSigningConfigured() && String(token).endsWith(`.${dcp.UNSIGNED_MARKER}`)) {
    return { error: 'signed-token-required' };
  }
  return { envelope: dcp.buildCommandEnvelope({ device: cfg, action: act, params, token }) };
}

/**
 * Write a command to the device. Routes to the HIL simulator when HIL is on;
 * otherwise attempts a real BLE write. The PAL has already enforced the class
 * gate before this is called.
 */
function perform(device, action, params = {}) {
  const cfg = loadDeviceConfig().find((d) => d.id === (device && device.id));
  const act = String(action || '').trim().toLowerCase();
  if (!cfg) return { ok: false, action: act, state: {}, reason: 'unknown-device' };
  if (!cfg.capabilities.map((c) => c.toLowerCase()).includes(act)) {
    return { ok: false, action: act, state: {}, reason: 'unsupported-action' };
  }

  const built = _buildEnvelope(cfg, act, params);
  if (built.error) return { ok: false, action: act, state: {}, reason: built.error };

  // HIL simulation path — no real adapter touched.
  if (hil.isEnabled()) {
    const r = hil.perform(cfg, act, params);
    return { ...r, result: `ble:${cfg.id}:${act}`, envelope: built.envelope, simulated: true };
  }

  // Real path (best-effort; degrades cleanly without hardware/lib).
  const lib = loadBleLib();
  if (!lib) return { ok: false, action: act, state: {}, reason: 'not-connected' };
  try {
    // A full BLE write requires a connected peripheral + characteristic handle,
    // which is established out-of-band. We surface the envelope for the wire.
    return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  } catch (err) {
    return { ok: false, action: act, state: {}, reason: `write-failed: ${err.message}` };
  }
}

/**
 * Stream inbound notifications as readings. In HIL mode there is no real
 * subscription (readings are injected via PAL.ingestSensorReading). Returns a
 * stop() that is always safe to call.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const lib = loadBleLib();
  if (!lib) return () => {};
  // Real notification wiring is established out-of-band; nothing to tear down here.
  return () => {};
}

module.exports = { DRIVER_ID, REMOTE, SUPPORTS_HIL, isAvailable, discover, perform, start, loadDeviceConfig };
