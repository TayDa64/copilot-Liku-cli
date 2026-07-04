/**
 * MQTT Peripheral Driver — Pillar 3 REAL driver example (Phase 5).
 *
 * Demonstrates the real-driver extension point using the same interface as the
 * mock driver: id, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * SAFETY + AVAILABILITY:
 *   - Only "available" when explicitly configured via env (LIKU_MQTT_URL) AND
 *     the optional `mqtt` package is installed. Otherwise the PAL falls back to
 *     the mock driver — the mock remains the default.
 *   - Connection is LAZY: nothing connects on import. discover() returns the
 *     DECLARED device config so the PAL/DCP can validate + safety-gate commands
 *     even before a broker connection exists.
 *   - perform() publishes a command over MQTT; if not connected it returns a
 *     structured { ok:false, reason:'not-connected' } — but the PAL has ALREADY
 *     enforced the class-based safety gate before calling perform(), so a
 *     Class A action still requires confirmation regardless of connectivity.
 *
 * Device config (JSON in env LIKU_MQTT_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], cmdTopic, stateTopic, powerW }
 */

'use strict';

const DRIVER_ID = 'mqtt';

function brokerUrl() {
  return String(process.env.LIKU_MQTT_URL || '').trim();
}

/** Parse declared device config from env (safe, never throws). */
function loadDeviceConfig() {
  try {
    const raw = process.env.LIKU_MQTT_DEVICES;
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
        cmdTopic: String(d.cmdTopic || `liku/${d.id}/cmd`),
        stateTopic: String(d.stateTopic || `liku/${d.id}/state`),
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

/** Lazily require the optional mqtt package (null if not installed). */
function loadMqttLib() {
  try { return require('mqtt'); } catch { return null; }
}

/**
 * Available only when a broker URL is configured AND at least one device is
 * declared. The mqtt package is checked at connect time so discover() (and thus
 * safety gating) works even before the lib/broker is present.
 */
function isAvailable() {
  return !!brokerUrl() && loadDeviceConfig().length > 0;
}

/** Declared devices (no connection required). @returns {object[]} */
function discover() {
  return loadDeviceConfig().map((d) => ({
    id: d.id, name: d.name, class: d.class, kind: d.kind,
    capabilities: d.capabilities, state: {}, powerW: d.powerW, driver: DRIVER_ID
  }));
}

let _client = null;

function _ensureConnected() {
  if (_client && _client.connected) return _client;
  const mqtt = loadMqttLib();
  const url = brokerUrl();
  if (!mqtt || !url) return null;
  try {
    _client = mqtt.connect(url, { connectTimeout: 2000, reconnectPeriod: 0 });
    return _client;
  } catch {
    return null;
  }
}

/**
 * Publish a command to the device's command topic. The PAL has already enforced
 * the class-based safety gate before this is called.
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
  const client = _ensureConnected();
  if (!client) return { ok: false, action: act, state: {}, reason: 'not-connected' };
  try {
    client.publish(cfg.cmdTopic, JSON.stringify({ action: act, params }));
    return { ok: true, action: act, state: { lastCommand: act }, result: `mqtt:${cfg.id}:${act}` };
  } catch (err) {
    return { ok: false, action: act, state: {}, reason: `publish-failed: ${err.message}` };
  }
}

/**
 * Subscribe to device state topics; invoke emit(reading) on each message.
 * Returns a stop() that unsubscribes/disconnects. No-op when unavailable.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  const client = _ensureConnected();
  if (!client || typeof emit !== 'function') return () => {};
  const cfgs = loadDeviceConfig();
  try {
    for (const c of cfgs) client.subscribe(c.stateTopic);
    client.on('message', (topic, payload) => {
      const cfg = cfgs.find((c) => c.stateTopic === topic);
      if (!cfg) return;
      let metrics = {};
      try { metrics = JSON.parse(payload.toString()); } catch { metrics = { raw: payload.toString().slice(0, 120) }; }
      try { emit({ id: cfg.id, metrics, at: new Date().toISOString() }); } catch { /* non-fatal */ }
    });
  } catch { /* non-fatal */ }
  return () => { try { client.end(true); } catch { /* ignore */ } _client = null; };
}

module.exports = { DRIVER_ID, isAvailable, discover, perform, start, loadDeviceConfig };
