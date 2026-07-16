/**
 * BLE Peripheral Driver — REAL bidirectional transport + HIL support
 * (Pillar 3, Phase 10 discovery/HIL → Phase 12 real connect/notify/write).
 *
 * Interface (shared with mock/mqtt/serial/zigbee):
 *   id, REMOTE, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * REAL TRANSPORT (Phase 12):
 *   - A BleCentral connection manager scans for declared peripherals, connects,
 *     resolves a WRITE characteristic (for perform) and subscribes to a NOTIFY
 *     characteristic whose inbound value-changes are parsed and forwarded to
 *     emit({ id, metrics }) — i.e. into PAL.ingestSensorReading(), so they
 *     participate in the normal grounding + escalation pipeline.
 *   - perform() writes the signed DCP envelope bytes to the connected write
 *     characteristic. Until a connection exists it kicks off a lazy connect and
 *     returns a structured { ok:false, reason:'not-connected' } — but the PAL
 *     has ALREADY enforced the class gate, so a Class A action still requires
 *     confirmation regardless of connectivity.
 *
 * SAFETY + ISOLATION:
 *   - BLE is a wireless/remote transport → REMOTE=true, so signed capability
 *     tokens are mandatory when a DCP secret (LIKU_DCP_SECRET) is configured.
 *   - The optional `@abandonware/noble` / `noble` package is required LAZILY, so
 *     discover() (and PAL/DCP safety gating) works without it installed.
 *   - HIL simulation (LIKU_PERIPHERAL_HIL=1) is fully isolated: when HIL is on
 *     the real transport is NEVER used; when off, HIL is never consulted.
 *
 * Device config (JSON in env LIKU_BLE_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW,
 *     peripheralId?, address?, serviceUuid?, writeCharUuid?, notifyCharUuid? }
 */

'use strict';

const dcp = require('../dcp-protocol');
const hil = require('../hil-simulator');
const { createPairingState } = require('../pairing');
const { createDriverPairing } = require('../driver-pairing');

const DRIVER_ID = 'ble';
// BLE is a wireless/remote transport — signed tokens required when a secret set.
const REMOTE = true;
const SUPPORTS_HIL = true;

// ── Optional-library loading + test seam ─────────────────────────────────────
let _injectedLib = null; // real path uses require(); tests inject a fake noble.
let _central = null;     // singleton connection manager (per-process)

/** TEST-ONLY: inject a fake noble-like library and reset the central. */
function _setBleLibForTest(lib) { _injectedLib = lib; _central = null; }

/** Lazily obtain the BLE library (injected fake in tests, real noble otherwise). */
function loadBleLib() {
  if (_injectedLib) return _injectedLib;
  try { return require('@abandonware/noble'); }
  catch { try { return require('noble'); } catch { return null; } }
}

function adapterConfigured() {
  return !!String(process.env.LIKU_BLE_ADAPTER || '').trim();
}

/** Normalize a BLE UUID for comparison (lowercase, strip dashes). @private */
function _uuidEq(a, b) {
  if (!a || !b) return false;
  const n = (x) => String(x).toLowerCase().replace(/-/g, '');
  return n(a) === n(b);
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
        peripheralId: d.peripheralId ? String(d.peripheralId) : undefined,
        address: d.address ? String(d.address) : undefined,
        serviceUuid: d.serviceUuid ? String(d.serviceUuid) : undefined,
        writeCharUuid: d.writeCharUuid ? String(d.writeCharUuid) : (d.charUuid ? String(d.charUuid) : undefined),
        notifyCharUuid: d.notifyCharUuid ? String(d.notifyCharUuid) : undefined,
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

function _libState(lib) {
  try { return lib && lib.state; } catch { return undefined; }
}

// ── Real BLE connection manager (Phase 12) ───────────────────────────────────
/**
 * Manages scan → match → connect → characteristic resolution for declared BLE
 * peripherals, and bridges inbound notifications to a reading emitter. Every
 * interaction with the (async, event-driven) BLE library is wrapped so a failure
 * degrades to "not connected" rather than throwing.
 */
class BleCentral {
  constructor(lib) {
    this.lib = lib;
    this.ready = _libState(lib) === 'poweredOn';
    this.conns = new Map();   // deviceId → { peripheral, writeChar, notifyChar }
    this.wanted = new Map();  // deviceId → cfg (devices we want connected)
    this.emit = null;         // reading sink (set by start())
    // Phase 16: pairing state machine (retry + backoff) for the connect flow.
    this.pairing = createPairingState({
      maxAttempts: Number(process.env.LIKU_BLE_PAIR_MAX_ATTEMPTS),
      baseBackoffMs: Number(process.env.LIKU_BLE_PAIR_BACKOFF_MS)
    });
    this._wire();
  }

  _wire() {
    try {
      if (typeof this.lib.on === 'function') {
        this.lib.on('stateChange', (s) => { this.ready = (s === 'poweredOn'); if (this.ready) this._scan(); });
        this.lib.on('discover', (p) => this._onDiscover(p));
      }
    } catch { /* non-fatal */ }
  }

  _scan() {
    try { if (typeof this.lib.startScanning === 'function') this.lib.startScanning([], false); }
    catch { /* non-fatal */ }
  }

  /** Register a device we want connected + (re)start scanning if ready. */
  ensureConnect(cfg) {
    if (!cfg || !cfg.id) return;
    if (!this.wanted.has(cfg.id)) this.wanted.set(cfg.id, cfg);
    if (this.ready) this._scan();
  }

  /** Begin streaming inbound notifications as readings. */
  startNotifications(emit, cfgs) {
    this.emit = emit;
    for (const c of cfgs || []) this.ensureConnect(c);
    if (this.ready) this._scan();
  }

  _matchCfg(peripheral) {
    const pid = peripheral && peripheral.id;
    const addr = peripheral && peripheral.address;
    const name = peripheral && peripheral.advertisement && peripheral.advertisement.localName;
    for (const cfg of this.wanted.values()) {
      if (cfg.peripheralId && cfg.peripheralId === pid) return cfg;
      if (cfg.address && addr && cfg.address.toLowerCase() === String(addr).toLowerCase()) return cfg;
      if (cfg.name && name && cfg.name === name) return cfg;
    }
    return null;
  }

  _onDiscover(peripheral) {
    const cfg = this._matchCfg(peripheral);
    if (!cfg || this.conns.has(cfg.id)) return;
    // Phase 16: only attempt to pair when the backoff window allows.
    if (!this.pairing.canAttempt(cfg.id)) return;
    this.pairing.begin(cfg.id);
    try {
      peripheral.connect((err) => {
        if (err) { this.pairing.fail(cfg.id, err.message || 'connect-failed'); return; }
        const svc = cfg.serviceUuid ? [cfg.serviceUuid] : [];
        const chs = [cfg.writeCharUuid, cfg.notifyCharUuid].filter(Boolean);
        try {
          peripheral.discoverSomeServicesAndCharacteristics(svc, chs, (e2, _services, characteristics) => {
            if (e2) { this.pairing.fail(cfg.id, e2.message || 'discover-failed'); return; }
            const chars = characteristics || [];
            const writeChar = chars.find((ch) => _uuidEq(ch.uuid, cfg.writeCharUuid)) || chars[0] || null;
            const notifyChar = cfg.notifyCharUuid
              ? (chars.find((ch) => _uuidEq(ch.uuid, cfg.notifyCharUuid)) || null)
              : null;
            this.conns.set(cfg.id, { peripheral, writeChar, notifyChar });
            this.pairing.succeed(cfg.id);
            if (notifyChar) this._subscribe(cfg, notifyChar);
          });
        } catch (e3) { this.pairing.fail(cfg.id, e3.message || 'discover-threw'); }
      });
    } catch (err) { this.pairing.fail(cfg.id, err.message || 'connect-threw'); }
  }

  _subscribe(cfg, ch) {
    try {
      if (typeof ch.subscribe === 'function') ch.subscribe(() => {});
      if (typeof ch.on === 'function') {
        ch.on('data', (data) => {
          let metrics = {};
          const text = Buffer.isBuffer(data) ? data.toString() : String(data == null ? '' : data);
          try { metrics = JSON.parse(text); } catch { metrics = { raw: text.slice(0, 120) }; }
          if (this.emit) { try { this.emit({ id: cfg.id, metrics, at: new Date().toISOString() }); } catch { /* non-fatal */ } }
        });
      }
    } catch { /* non-fatal */ }
  }

  connectionFor(id) { return this.conns.get(id) || null; }

  /** Attempt (or re-attempt) pairing for one device; returns its state. */
  commission(cfg) {
    if (!cfg) return null;
    this.ensureConnect(cfg); // triggers a scan → discover → connect (state machine)
    return this.pairing.get(cfg.id);
  }

  /** Tear down a device's connection + requeue it for re-pairing. */
  unpair(id) {
    const conn = this.conns.get(id);
    if (conn && conn.peripheral && typeof conn.peripheral.disconnect === 'function') {
      try { conn.peripheral.disconnect(() => {}); } catch { /* ignore */ }
    }
    this.conns.delete(id);
    if (this.pairing) this.pairing.requeue(id);
  }

  /** Write bytes to a device's write characteristic. Returns true on dispatch. */
  write(id, buffer) {
    const conn = this.conns.get(id);
    if (!conn || !conn.writeChar || typeof conn.writeChar.write !== 'function') return false;
    try { conn.writeChar.write(buffer, true, () => {}); return true; }
    catch { return false; }
  }

  stop() {
    try { if (typeof this.lib.stopScanning === 'function') this.lib.stopScanning(); } catch { /* ignore */ }
    for (const [, conn] of this.conns) {
      try { if (conn.peripheral && typeof conn.peripheral.disconnect === 'function') conn.peripheral.disconnect(() => {}); }
      catch { /* ignore */ }
    }
    this.conns.clear();
    this.wanted.clear();
    this.emit = null;
  }
}

/** Obtain (or lazily create) the process-wide BLE central. Null without a lib. */
function _ensureCentral() {
  const lib = loadBleLib();
  if (!lib) return null;
  if (!_central) _central = new BleCentral(lib);
  return _central;
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
 * otherwise writes to the connected BLE write characteristic. The PAL has
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

  // HIL simulation path — no real adapter touched.
  if (hil.isEnabled()) {
    const r = hil.perform(cfg, act, params);
    return { ...r, result: `ble:${cfg.id}:${act}`, envelope: built.envelope, simulated: true };
  }

  // Real path — write the DCP envelope to the connected write characteristic.
  const central = _ensureCentral();
  if (!central) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  const conn = central.connectionFor(cfg.id);
  if (!conn || !conn.writeChar) {
    central.ensureConnect(cfg); // kick a lazy connect so the next call can write
    return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  }
  const payload = Buffer.from(JSON.stringify(built.envelope));
  const dispatched = central.write(cfg.id, payload);
  if (!dispatched) return { ok: false, action: act, state: {}, reason: 'write-failed', envelope: built.envelope };
  return { ok: true, action: act, state: { lastCommand: act }, result: `ble:${cfg.id}:${act}`, envelope: built.envelope };
}

/**
 * Stream inbound notifications as readings. In HIL mode there is no real
 * subscription (readings are injected via PAL.ingestSensorReading). Otherwise
 * it connects declared peripherals and forwards NOTIFY value-changes to emit.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const central = _ensureCentral();
  if (!central) return () => {};
  central.startNotifications(emit, loadDeviceConfig());
  return () => { try { central.stop(); } catch { /* ignore */ } _central = null; };
}

/**
 * Consistent pairing surface (pair / unpair / pairingStatus) shared with the
 * other real drivers. HIL pairing is virtual + isolated.
 */
const _pairing = createDriverPairing({
  loadDeviceConfig,
  ensureManager: _ensureCentral,
  getManager: () => _central,
  commission: (mgr, cfg) => mgr.commission(cfg)
});
function pair(deviceId) { return _pairing.pair(deviceId); }
function unpair(deviceId) { return _pairing.unpair(deviceId); }
function pairingStatus() { return _pairing.pairingStatus(); }

module.exports = {
  DRIVER_ID, REMOTE, SUPPORTS_HIL,
  isAvailable, discover, perform, start, loadDeviceConfig,
  pair, unpair, pairingStatus,
  // test seam only
  _setBleLibForTest
};
