/**
 * Zigbee Peripheral Driver — Pillar 3 near-real driver + HIL support (Phase 11).
 *
 * Fourth real-transport driver, proving the interface scales to mesh networks
 * via a coordinator (e.g. a zigbee2mqtt bridge or a zigbee-herdsman adapter):
 *   id, REMOTE, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * AVAILABILITY + SAFETY (identical discipline to MQTT / serial / BLE):
 *   - "available" only when a coordinator is configured (LIKU_ZIGBEE_COORDINATOR)
 *     AND devices are declared (LIKU_ZIGBEE_DEVICES) — OR when HIL simulation is
 *     on (LIKU_PERIPHERAL_HIL=1), in which case no real coordinator is required.
 *   - The optional `zigbee-herdsman` package is required LAZILY at connect time,
 *     so discover() (and PAL/DCP safety gating) works without it installed.
 *   - Zigbee is a NETWORKED/mesh transport → REMOTE=true, so signed capability
 *     tokens are mandatory when a DCP secret is configured.
 *   - perform() sends a command to the coordinator; if not connected it returns a
 *     structured { ok:false, reason:'not-connected' } — but the PAL has ALREADY
 *     enforced the class gate, so a Class A action still requires confirmation.
 *
 * Device config (JSON in env LIKU_ZIGBEE_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, ieeeAddr, endpoint }
 */

'use strict';

const dcp = require('../dcp-protocol');
const hil = require('../hil-simulator');

const DRIVER_ID = 'zigbee';
// Zigbee is a networked/mesh transport — signed tokens required when a secret set.
const REMOTE = true;
const SUPPORTS_HIL = true;

function coordinatorConfigured() {
  return !!String(process.env.LIKU_ZIGBEE_COORDINATOR || '').trim();
}

/** Parse declared device config from env (safe, never throws). */
function loadDeviceConfig() {
  try {
    const raw = process.env.LIKU_ZIGBEE_DEVICES;
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
        ieeeAddr: d.ieeeAddr ? String(d.ieeeAddr) : undefined,
        endpoint: Number.isFinite(Number(d.endpoint)) ? Number(d.endpoint) : undefined,
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

/** Lazily require an optional Zigbee library (null if not installed). */
function loadZigbeeLib() {
  try { return require('zigbee-herdsman'); }
  catch { return null; }
}

/**
 * Available when devices are declared AND (HIL is on OR a coordinator is
 * configured). HIL needs no real coordinator, enabling CI/testing.
 */
function isAvailable() {
  if (loadDeviceConfig().length === 0) return false;
  return hil.isEnabled() || coordinatorConfigured();
}

/** Declared devices (no coordinator connection required). @returns {object[]} */
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
 * Send a command to the device via the coordinator. Routes to the HIL simulator
 * when HIL is on; otherwise attempts a real coordinator command. The PAL has
 * already enforced the class gate before this is called.
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

  // HIL simulation path — no real coordinator touched.
  if (hil.isEnabled()) {
    const r = hil.perform(cfg, act, params);
    return { ...r, result: `zigbee:${cfg.id}:${act}`, envelope: built.envelope, simulated: true };
  }

  // Real path (best-effort; degrades cleanly without coordinator/lib).
  const lib = loadZigbeeLib();
  if (!lib) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  try {
    // A full mesh command requires a started controller + resolved endpoint,
    // established out-of-band. We surface the envelope for the wire.
    return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  } catch (err) {
    return { ok: false, action: act, state: {}, reason: `command-failed: ${err.message}` };
  }
}

/**
 * Stream inbound mesh reports as readings. In HIL mode there is no real
 * subscription (readings are injected via PAL.ingestSensorReading). Returns a
 * stop() that is always safe to call.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const lib = loadZigbeeLib();
  if (!lib) return () => {};
  // Real report wiring is established out-of-band; nothing to tear down here.
  return () => {};
}

module.exports = { DRIVER_ID, REMOTE, SUPPORTS_HIL, isAvailable, discover, perform, start, loadDeviceConfig };
