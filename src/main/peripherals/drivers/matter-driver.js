/**
 * Matter/Thread Peripheral Driver — modern smart-home protocol foundation + HIL
 * (Pillar 3, Phase 15).
 *
 * Bridges the PAL to a Matter fabric (over Thread or Wi-Fi) via matter.js (or
 * equivalent): outbound commands invoke a Matter cluster command on a node
 * endpoint; inbound attribute reports are forwarded to PAL.ingestSensorReading(),
 * so Matter nodes participate in the normal grounding + escalation pipeline.
 *
 * Interface (shared with mock/mqtt/serial/ble/zigbee/ros2):
 *   id, REMOTE, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * AVAILABILITY + SAFETY (same discipline as the other real drivers):
 *   - "available" only when a fabric is configured (LIKU_MATTER_FABRIC) AND
 *     devices are declared (LIKU_MATTER_DEVICES) — OR when HIL simulation is on
 *     (LIKU_PERIPHERAL_HIL=1), in which case no real fabric is required.
 *   - The optional matter.js package is required LAZILY, so discover() (and
 *     PAL/DCP safety gating) works without it installed. A test seam
 *     (`_setMatterLibForTest`) exercises the real path with a fake controller.
 *   - Matter is a NETWORKED transport → REMOTE=true, so signed capability tokens
 *     are mandatory when a DCP secret is configured.
 *   - perform() invokes a cluster command; if the node isn't resolved it returns
 *     { ok:false, reason:'not-connected' } — but the PAL has ALREADY enforced the
 *     class gate, so a Class A action still requires confirmation.
 *
 * Device config (JSON in env LIKU_MATTER_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, nodeId, endpoint }
 */

'use strict';

const dcp = require('../dcp-protocol');
const hil = require('../hil-simulator');
const { createPairingState } = require('../pairing');

const DRIVER_ID = 'matter';
// Matter is a networked transport — signed tokens required when a secret set.
const REMOTE = true;
const SUPPORTS_HIL = true;

// ── Optional-library loading + test seam ─────────────────────────────────────
let _injectedLib = null; // real path uses require(); tests inject a fake matter.js.
let _controller = null;  // singleton commissioning controller (per-process)

/** TEST-ONLY: inject a fake matter.js-like library and reset the controller. */
function _setMatterLibForTest(lib) { _injectedLib = lib; _controller = null; }

/** Lazily obtain the Matter library (injected fake in tests, real otherwise). */
function loadMatterLib() {
  if (_injectedLib) return _injectedLib;
  try { return require('@project-chip/matter.js'); }
  catch { try { return require('matter-node.js'); } catch { return null; } }
}

function fabricConfigured() {
  return !!String(process.env.LIKU_MATTER_FABRIC || '').trim();
}

// Map a normalized action to a Matter cluster + command. Unmapped actions cannot
// be dispatched (return not-connected), keeping the wire surface small + safe.
const CLUSTER_MAP = Object.freeze({
  on: { cluster: 'OnOff', command: 'on' },
  off: { cluster: 'OnOff', command: 'off' },
  toggle: { cluster: 'OnOff', command: 'toggle' },
  lock: { cluster: 'DoorLock', command: 'lockDoor' },
  unlock: { cluster: 'DoorLock', command: 'unlockDoor' },
  open: { cluster: 'WindowCovering', command: 'upOrOpen' },
  close: { cluster: 'WindowCovering', command: 'downOrClose' },
  brightness: { cluster: 'LevelControl', command: 'moveToLevel' }
});

/** Parse declared device config from env (safe, never throws). */
function loadDeviceConfig() {
  try {
    const raw = process.env.LIKU_MATTER_DEVICES;
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
        nodeId: d.nodeId != null ? String(d.nodeId) : undefined,
        endpoint: Number.isFinite(Number(d.endpoint)) ? Number(d.endpoint) : undefined,
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

// ── Real Matter commissioning controller (Phase 15) ──────────────────────────
/**
 * Wraps a matter.js CommissioningController. Every interaction with the (async)
 * library is wrapped so a failure degrades to "not connected" rather than throwing.
 */
class MatterController {
  constructor(lib) {
    this.lib = lib;
    this.controller = null;
    this.started = false;
    this.emit = null;         // reading sink (set by start())
    this.wanted = new Map();  // deviceId → cfg (for inbound report routing)
    this.endpoints = new Map(); // deviceId → resolved endpoint (cache)
    // Phase 16: fabric commissioning state machine (retry + backoff).
    this.pairing = createPairingState({
      maxAttempts: Number(process.env.LIKU_MATTER_PAIR_MAX_ATTEMPTS),
      baseBackoffMs: Number(process.env.LIKU_MATTER_PAIR_BACKOFF_MS)
    });
    this._init();
  }

  _init() {
    try {
      const opts = { fabric: String(process.env.LIKU_MATTER_FABRIC || '') };
      if (typeof this.lib.CommissioningController === 'function') this.controller = new this.lib.CommissioningController(opts);
      else if (typeof this.lib.createController === 'function') this.controller = this.lib.createController(opts);
      if (!this.controller) return;
      if (typeof this.controller.on === 'function') {
        this.controller.on('attributeReport', (msg) => this._onReport(msg));
      }
      const res = typeof this.controller.start === 'function' ? this.controller.start() : null;
      if (res && typeof res.then === 'function') res.then(() => { this.started = true; }).catch(() => {});
      else this.started = true;
    } catch { /* non-fatal */ }
  }

  ensureWanted(cfg) { if (cfg && cfg.id) this.wanted.set(cfg.id, cfg); }

  startReports(emit, cfgs) {
    this.emit = emit;
    for (const c of cfgs || []) this.ensureWanted(c);
  }

  _resolveEndpoint(cfg) {
    if (this.endpoints.has(cfg.id)) return this.endpoints.get(cfg.id);
    // Phase 16: drive the commissioning state machine. Only attempt when the
    // backoff window allows; a resolved endpoint marks the device PAIRED, a
    // failure schedules a backed-off retry (→ FAILED once attempts exhaust).
    if (!this.pairing.canAttempt(cfg.id)) return null;
    this.pairing.begin(cfg.id);
    try {
      if (!this.controller || typeof this.controller.getNode !== 'function') {
        this.pairing.fail(cfg.id, 'no-controller');
        return null;
      }
      const node = this.controller.getNode(cfg.nodeId);
      if (!node || typeof node.getEndpoint !== 'function') { this.pairing.fail(cfg.id, 'node-unresolved'); return null; }
      const ep = node.getEndpoint(cfg.endpoint || 1);
      if (!ep) { this.pairing.fail(cfg.id, 'endpoint-unresolved'); return null; }
      this.pairing.succeed(cfg.id);
      this.endpoints.set(cfg.id, ep);
      return ep;
    } catch (err) { this.pairing.fail(cfg.id, err.message); return null; }
  }

  /** Attempt (or re-attempt) commissioning for one device; returns its state. */
  commission(cfg) {
    if (!cfg) return null;
    this.ensureWanted(cfg);
    this._resolveEndpoint(cfg);
    return this.pairing.get(cfg.id);
  }

  /** Invoke a Matter cluster command on a node endpoint. Returns true on dispatch. */
  command(cfg, act, params = {}) {
    const map = CLUSTER_MAP[act];
    if (!map) return false;
    this.ensureWanted(cfg);
    const ep = this._resolveEndpoint(cfg);
    if (!ep || typeof ep.invoke !== 'function') return false;
    try {
      const payload = act === 'brightness'
        ? { level: Math.max(0, Math.min(254, Math.round((Number(params && params.level) || 0) / 100 * 254))), transitionTime: 0 }
        : {};
      const r = ep.invoke(map.cluster, map.command, payload);
      if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {});
      return true;
    } catch { return false; }
  }

  _onReport(msg) {
    try {
      const nodeId = msg && (msg.nodeId != null ? String(msg.nodeId) : undefined);
      let cfg = null;
      for (const c of this.wanted.values()) { if (c.nodeId != null && String(c.nodeId) === nodeId) { cfg = c; break; } }
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

/** Obtain (or lazily create) the process-wide Matter controller. */
function _ensureController() {
  const lib = loadMatterLib();
  if (!lib) return null;
  if (!_controller) _controller = new MatterController(lib);
  return _controller;
}

/**
 * Available when devices are declared AND (HIL is on OR a fabric is configured).
 * HIL needs no real fabric, enabling CI/testing.
 */
function isAvailable() {
  if (loadDeviceConfig().length === 0) return false;
  return hil.isEnabled() || fabricConfigured();
}

/** Declared devices (no fabric connection required). @returns {object[]} */
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
 * Invoke a command on the device via Matter. Routes to the HIL simulator when
 * HIL is on; otherwise invokes a real cluster command. The PAL has already
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

  // HIL simulation path — no real fabric touched.
  if (hil.isEnabled()) {
    const r = hil.perform(cfg, act, params);
    return { ...r, result: `matter:${cfg.id}:${act}`, envelope: built.envelope, simulated: true };
  }

  // Real path — invoke a Matter cluster command on the resolved endpoint.
  const ctrl = _ensureController();
  if (!ctrl) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  const dispatched = ctrl.command(cfg, act, params);
  if (!dispatched) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  return { ok: true, action: act, state: { lastCommand: act }, result: `matter:${cfg.id}:${act}`, envelope: built.envelope };
}

/**
 * Stream inbound attribute reports as readings. In HIL mode there is no real
 * subscription (readings are injected via PAL.ingestSensorReading). Otherwise it
 * starts the controller and forwards attribute reports to emit.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const ctrl = _ensureController();
  if (!ctrl) return () => {};
  ctrl.startReports(emit, loadDeviceConfig());
  return () => { try { ctrl.stop(); } catch { /* ignore */ } _controller = null; };
}

/**
 * Attempt (or re-attempt) commissioning for a device. In HIL the device is
 * virtually paired (no real fabric). Returns a pairing state record.
 * @param {string} deviceId
 */
function pair(deviceId) {
  if (hil.isEnabled()) return { id: deviceId, state: 'paired', simulated: true, hil: true };
  const cfg = loadDeviceConfig().find((d) => d.id === deviceId);
  if (!cfg) return { id: deviceId, state: 'unpaired', error: 'unknown-device' };
  const ctrl = _ensureController();
  if (!ctrl) return { id: deviceId, state: 'unpaired', error: 'no-controller' };
  const rec = ctrl.commission(cfg);
  return { id: deviceId, ...rec };
}

/** Per-device commissioning state for all declared devices. */
function pairingStatus() {
  const cfgs = loadDeviceConfig();
  if (hil.isEnabled()) {
    const out = {};
    for (const c of cfgs) out[c.id] = { state: 'paired', simulated: true, hil: true };
    return out;
  }
  return _controller ? _controller.pairing.all() : {};
}

module.exports = {
  DRIVER_ID, REMOTE, SUPPORTS_HIL,
  isAvailable, discover, perform, start, loadDeviceConfig,
  pair, pairingStatus,
  // test seam only
  _setMatterLibForTest
};
