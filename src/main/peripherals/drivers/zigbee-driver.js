/**
 * Zigbee Peripheral Driver — REAL bidirectional transport + HIL support
 * (Pillar 3, Phase 11 discovery/HIL → Phase 13 real connect/notify/write).
 *
 * Interface (shared with mock/mqtt/serial/ble):
 *   id, REMOTE, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * REAL TRANSPORT (Phase 13):
 *   - A ZigbeeCoordinator wraps a zigbee-herdsman Controller: it starts the
 *     coordinator, listens for inbound `message` events (attribute reports) and
 *     forwards their numeric attributes to emit({ id, metrics }) — i.e. into
 *     PAL.ingestSensorReading(), so mesh sensor updates participate in the normal
 *     grounding + monitor + escalation pipeline.
 *   - perform() resolves the device endpoint (getDeviceByIeeeAddr → getEndpoint)
 *     and issues a ZCL command (genOnOff / closuresDoorLock / genLevelCtrl …).
 *     Until the endpoint resolves it returns { ok:false, reason:'not-connected' }
 *     — but the PAL has ALREADY enforced the class gate, so a Class A action
 *     still requires confirmation regardless of connectivity.
 *
 * SAFETY + ISOLATION:
 *   - Zigbee is a networked/mesh transport → REMOTE=true, so signed capability
 *     tokens are mandatory when a DCP secret (LIKU_DCP_SECRET) is configured.
 *   - The optional `zigbee-herdsman` package is required LAZILY, so discover()
 *     (and PAL/DCP safety gating) works without it installed. A test seam
 *     (`_setZigbeeLibForTest`) exercises the real path with a fake controller.
 *   - HIL simulation (LIKU_PERIPHERAL_HIL=1) is fully isolated: when HIL is on
 *     the real transport is NEVER used; when off, HIL is never consulted.
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

// ── Optional-library loading + test seam ─────────────────────────────────────
let _injectedLib = null; // real path uses require(); tests inject a fake herdsman.
let _coordinator = null; // singleton coordinator (per-process)

/** TEST-ONLY: inject a fake zigbee-herdsman-like library and reset coordinator. */
function _setZigbeeLibForTest(lib) { _injectedLib = lib; _coordinator = null; }

/** Lazily obtain the Zigbee library (injected fake in tests, real otherwise). */
function loadZigbeeLib() {
  if (_injectedLib) return _injectedLib;
  try { return require('zigbee-herdsman'); }
  catch { return null; }
}

function coordinatorConfigured() {
  return !!String(process.env.LIKU_ZIGBEE_COORDINATOR || '').trim();
}

// Map a normalized action to a ZCL cluster + command. Unmapped actions cannot be
// dispatched (return not-connected), which keeps the wire surface small + safe.
const ZCL_MAP = Object.freeze({
  on: { cluster: 'genOnOff', command: 'on' },
  off: { cluster: 'genOnOff', command: 'off' },
  toggle: { cluster: 'genOnOff', command: 'toggle' },
  lock: { cluster: 'closuresDoorLock', command: 'lockDoor' },
  unlock: { cluster: 'closuresDoorLock', command: 'unlockDoor' },
  open: { cluster: 'closuresWindowCovering', command: 'upOpen' },
  close: { cluster: 'closuresWindowCovering', command: 'downClose' },
  brightness: { cluster: 'genLevelCtrl', command: 'moveToLevel' }
});

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

// ── Real Zigbee coordinator (Phase 13) ───────────────────────────────────────
/**
 * Wraps a zigbee-herdsman Controller. Every interaction with the (async,
 * event-driven) library is wrapped so a failure degrades to "not connected"
 * rather than throwing.
 */
class ZigbeeCoordinator {
  constructor(lib) {
    this.lib = lib;
    this.controller = null;
    this.started = false;
    this.emit = null;          // reading sink (set by start())
    this.wanted = new Map();   // deviceId → cfg (for inbound report routing)
    this.endpoints = new Map(); // deviceId → resolved endpoint (cache)
    this._init();
  }

  _init() {
    try {
      const opts = { serialPort: { path: String(process.env.LIKU_ZIGBEE_COORDINATOR || '') } };
      if (typeof this.lib.Controller === 'function') this.controller = new this.lib.Controller(opts);
      else if (typeof this.lib.createController === 'function') this.controller = this.lib.createController(opts);
      if (!this.controller) return;
      if (typeof this.controller.on === 'function') {
        this.controller.on('message', (msg) => this._onMessage(msg));
      }
      const res = typeof this.controller.start === 'function' ? this.controller.start() : null;
      if (res && typeof res.then === 'function') res.then(() => { this.started = true; }).catch(() => {});
      else this.started = true;
    } catch { /* non-fatal */ }
  }

  /** Register a device we care about for inbound report routing. */
  ensureWanted(cfg) { if (cfg && cfg.id) this.wanted.set(cfg.id, cfg); }

  /** Begin streaming inbound attribute reports as readings. */
  startReports(emit, cfgs) {
    this.emit = emit;
    for (const c of cfgs || []) this.ensureWanted(c);
  }

  _resolveEndpoint(cfg) {
    if (this.endpoints.has(cfg.id)) return this.endpoints.get(cfg.id);
    try {
      if (!this.controller || typeof this.controller.getDeviceByIeeeAddr !== 'function') return null;
      const dev = this.controller.getDeviceByIeeeAddr(cfg.ieeeAddr);
      if (!dev || typeof dev.getEndpoint !== 'function') return null;
      const ep = dev.getEndpoint(cfg.endpoint || 1);
      if (ep) this.endpoints.set(cfg.id, ep);
      return ep || null;
    } catch { return null; }
  }

  /** Issue a ZCL command to a device endpoint. Returns true on dispatch. */
  command(cfg, act, params = {}) {
    const map = ZCL_MAP[act];
    if (!map) return false;
    this.ensureWanted(cfg);
    const ep = this._resolveEndpoint(cfg);
    if (!ep || typeof ep.command !== 'function') return false;
    try {
      const payload = act === 'brightness'
        ? { level: Math.max(0, Math.min(255, Math.round((Number(params && params.level) || 0) / 100 * 255))), transtime: 0 }
        : {};
      const r = ep.command(map.cluster, map.command, payload);
      if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {});
      return true;
    } catch { return false; }
  }

  _onMessage(msg) {
    try {
      const addr = msg && msg.device && msg.device.ieeeAddr;
      let cfg = null;
      for (const c of this.wanted.values()) { if (c.ieeeAddr && c.ieeeAddr === addr) { cfg = c; break; } }
      if (!cfg) return;
      const data = (msg && msg.data) || {};
      const metrics = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') metrics[k] = v;
      }
      if (Object.keys(metrics).length && this.emit) {
        try { this.emit({ id: cfg.id, metrics, at: new Date().toISOString() }); } catch { /* non-fatal */ }
      }
    } catch { /* non-fatal */ }
  }

  stop() {
    try { if (this.controller && typeof this.controller.stop === 'function') this.controller.stop(); } catch { /* ignore */ }
    this.endpoints.clear();
    this.wanted.clear();
    this.emit = null;
  }
}

/** Obtain (or lazily create) the process-wide Zigbee coordinator. */
function _ensureCoordinator() {
  const lib = loadZigbeeLib();
  if (!lib) return null;
  if (!_coordinator) _coordinator = new ZigbeeCoordinator(lib);
  return _coordinator;
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
 * when HIL is on; otherwise issues a real ZCL command. The PAL has already
 * enforced the class gate before this is called.
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

  // Real path — issue a ZCL command to the resolved endpoint.
  const coord = _ensureCoordinator();
  if (!coord) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  const dispatched = coord.command(cfg, act, params);
  if (!dispatched) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  return { ok: true, action: act, state: { lastCommand: act }, result: `zigbee:${cfg.id}:${act}`, envelope: built.envelope };
}

/**
 * Stream inbound attribute reports as readings. In HIL mode there is no real
 * subscription (readings are injected via PAL.ingestSensorReading). Otherwise it
 * starts the coordinator and forwards mesh reports to emit.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const coord = _ensureCoordinator();
  if (!coord) return () => {};
  coord.startReports(emit, loadDeviceConfig());
  return () => { try { coord.stop(); } catch { /* ignore */ } _coordinator = null; };
}

module.exports = {
  DRIVER_ID, REMOTE, SUPPORTS_HIL,
  isAvailable, discover, perform, start, loadDeviceConfig,
  // test seam only
  _setZigbeeLibForTest
};
