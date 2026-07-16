/**
 * ROS2 Bridge Driver — modern robotics protocol foundation + HIL support
 * (Pillar 3, Phase 14).
 *
 * Bridges the PAL to a ROS2 graph via rclnodejs (or equivalent): outbound
 * commands are published to a device's command topic; inbound sensor messages
 * on a state topic are forwarded to PAL.ingestSensorReading(), so ROS2 nodes
 * participate in the normal grounding + monitor + escalation pipeline.
 *
 * Interface (shared with mock/mqtt/serial/ble/zigbee):
 *   id, REMOTE, isAvailable(), discover(), perform(), start(emit)/stop().
 *
 * AVAILABILITY + SAFETY (same discipline as the other real drivers):
 *   - "available" only when a ROS2 domain is configured (LIKU_ROS2_DOMAIN) AND
 *     devices are declared (LIKU_ROS2_DEVICES) — OR when HIL simulation is on
 *     (LIKU_PERIPHERAL_HIL=1), in which case no real graph is required.
 *   - `rclnodejs` is required LAZILY, so discover() (and PAL/DCP safety gating)
 *     works without it installed. A test seam (`_setRos2LibForTest`) exercises
 *     the real path with a fake node.
 *   - ROS2 is a networked transport → REMOTE=true, so signed capability tokens
 *     are mandatory when a DCP secret is configured.
 *   - perform() PUBLISHES the signed DCP envelope to the command topic; the PAL
 *     has ALREADY enforced the class gate, so a Class A action still requires
 *     confirmation regardless of connectivity.
 *
 * Device config (JSON in env LIKU_ROS2_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, cmdTopic, stateTopic }
 */

'use strict';

const dcp = require('../dcp-protocol');
const hil = require('../hil-simulator');
const { createPairingState } = require('../pairing');
const { createDriverPairing } = require('../driver-pairing');

const DRIVER_ID = 'ros2';
// ROS2 is a networked transport — signed tokens required when a secret set.
const REMOTE = true;
const SUPPORTS_HIL = true;

const MSG_TYPE = 'std_msgs/msg/String';

// ── Optional-library loading + test seam ─────────────────────────────────────
let _injectedLib = null; // real path uses require(); tests inject a fake rclnodejs.
let _bridge = null;      // singleton bridge (per-process)

/** TEST-ONLY: inject a fake rclnodejs-like library and reset the bridge. */
function _setRos2LibForTest(lib) { _injectedLib = lib; _bridge = null; }

/** Lazily obtain the ROS2 library (injected fake in tests, real otherwise). */
function loadRos2Lib() {
  if (_injectedLib) return _injectedLib;
  try { return require('rclnodejs'); }
  catch { return null; }
}

function domainConfigured() {
  return !!String(process.env.LIKU_ROS2_DOMAIN || '').trim();
}

/** Parse declared device config from env (safe, never throws). */
function loadDeviceConfig() {
  try {
    const raw = process.env.LIKU_ROS2_DEVICES;
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
        cmdTopic: String(d.cmdTopic || `/liku/${d.id}/cmd`),
        stateTopic: String(d.stateTopic || `/liku/${d.id}/state`),
        powerW: Number.isFinite(Number(d.powerW)) ? Number(d.powerW) : undefined,
        driver: DRIVER_ID
      }));
  } catch {
    return [];
  }
}

// ── Real ROS2 bridge (Phase 14) ──────────────────────────────────────────────
/**
 * Wraps a rclnodejs Node. Every interaction with the (async) library is wrapped
 * so a failure degrades to "not connected" rather than throwing.
 */
class Ros2Bridge {
  constructor(lib) {
    this.lib = lib;
    this.node = null;
    this.ready = false;
    this.emit = null;             // reading sink (set by start())
    this.publishers = new Map();  // deviceId → publisher
    this.wanted = new Map();      // deviceId → cfg
    // Phase 17: pairing (node + publisher/subscription readiness) state machine.
    this.pairing = createPairingState({
      maxAttempts: Number(process.env.LIKU_ROS2_PAIR_MAX_ATTEMPTS),
      baseBackoffMs: Number(process.env.LIKU_ROS2_PAIR_BACKOFF_MS)
    });
    this._init();
  }

  _init() {
    try {
      const setup = () => {
        try {
          const name = String(process.env.LIKU_ROS2_NODE || 'liku_peripheral');
          if (typeof this.lib.Node === 'function') this.node = new this.lib.Node(name);
          else if (typeof this.lib.createNode === 'function') this.node = this.lib.createNode(name);
          this.ready = !!this.node;
        } catch { /* non-fatal */ }
      };
      const r = typeof this.lib.init === 'function' ? this.lib.init() : null;
      if (r && typeof r.then === 'function') r.then(setup).catch(() => {});
      else setup();
    } catch { /* non-fatal */ }
  }

  /** Begin streaming inbound state messages as readings. */
  startReports(emit, cfgs) {
    this.emit = emit;
    for (const c of cfgs || []) { this.wanted.set(c.id, c); this._subscribe(c); }
    try { if (this.node && typeof this.lib.spin === 'function') this.lib.spin(this.node); } catch { /* non-fatal */ }
  }

  _subscribe(cfg) {
    if (!this.node || typeof this.node.createSubscription !== 'function' || !cfg.stateTopic) return;
    try {
      this.node.createSubscription(MSG_TYPE, cfg.stateTopic, (msg) => {
        const data = msg && (msg.data != null ? msg.data : msg);
        let parsed = {};
        try { parsed = typeof data === 'string' ? JSON.parse(data) : (data && typeof data === 'object' ? data : {}); }
        catch { parsed = { raw: String(data).slice(0, 120) }; }
        const metrics = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') metrics[k] = v;
        }
        if (Object.keys(metrics).length && this.emit) {
          try { this.emit({ id: cfg.id, metrics, at: new Date().toISOString() }); } catch { /* non-fatal */ }
        }
      });
    } catch { /* non-fatal */ }
  }

  _publisher(cfg) {
    if (this.publishers.has(cfg.id)) return this.publishers.get(cfg.id);
    if (!this.node || typeof this.node.createPublisher !== 'function') return null;
    try {
      const p = this.node.createPublisher(MSG_TYPE, cfg.cmdTopic);
      if (p) this.publishers.set(cfg.id, p);
      return p || null;
    } catch { return null; }
  }

  /** Publish a DCP envelope to a device's command topic. Returns true on dispatch. */
  publish(cfg, envelope) {
    this.wanted.set(cfg.id, cfg);
    const p = this._publisher(cfg);
    if (!p || typeof p.publish !== 'function') return false;
    try { p.publish({ data: JSON.stringify(envelope) }); return true; }
    catch { return false; }
  }

  /**
   * Attempt (or re-attempt) "pairing": ensure the node exists and a
   * publisher/subscription can be created for the device. Returns its state.
   */
  commission(cfg) {
    if (!cfg) return null;
    this.wanted.set(cfg.id, cfg);
    if (this.pairing.isPaired(cfg.id)) return this.pairing.get(cfg.id);
    if (!this.pairing.canAttempt(cfg.id)) return this.pairing.get(cfg.id);
    this.pairing.begin(cfg.id);
    try {
      if (!this.node) { this.pairing.fail(cfg.id, 'no-node'); return this.pairing.get(cfg.id); }
      const p = this._publisher(cfg);
      if (!p) { this.pairing.fail(cfg.id, 'no-publisher'); return this.pairing.get(cfg.id); }
      this._subscribe(cfg);
      this.pairing.succeed(cfg.id);
    } catch (err) { this.pairing.fail(cfg.id, err.message); }
    return this.pairing.get(cfg.id);
  }

  /** Tear down a device's publisher + requeue it for re-pairing. */
  unpair(id) {
    this.publishers.delete(id);
    if (this.pairing) this.pairing.requeue(id);
  }

  stop() {
    try { if (this.node && typeof this.node.destroy === 'function') this.node.destroy(); } catch { /* ignore */ }
    this.publishers.clear();
    this.wanted.clear();
    this.emit = null;
  }
}

/** Obtain (or lazily create) the process-wide ROS2 bridge. */
function _ensureBridge() {
  const lib = loadRos2Lib();
  if (!lib) return null;
  if (!_bridge) _bridge = new Ros2Bridge(lib);
  return _bridge;
}

/**
 * Available when devices are declared AND (HIL is on OR a domain is configured).
 * HIL needs no real graph, enabling CI/testing.
 */
function isAvailable() {
  if (loadDeviceConfig().length === 0) return false;
  return hil.isEnabled() || domainConfigured();
}

/** Declared devices (no ROS2 connection required). @returns {object[]} */
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
 * Publish a command to the device via ROS2. Routes to the HIL simulator when HIL
 * is on; otherwise publishes to the command topic. The PAL has already enforced
 * the class gate before this is called.
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

  // HIL simulation path — no real graph touched.
  if (hil.isEnabled()) {
    const r = hil.perform(cfg, act, params);
    return { ...r, result: `ros2:${cfg.id}:${act}`, envelope: built.envelope, simulated: true };
  }

  // Real path — publish the DCP envelope to the command topic.
  const bridge = _ensureBridge();
  if (!bridge) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  const dispatched = bridge.publish(cfg, built.envelope);
  if (!dispatched) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
  return { ok: true, action: act, state: { lastCommand: act }, result: `ros2:${cfg.id}:${act}`, envelope: built.envelope };
}

/**
 * Stream inbound state messages as readings. In HIL mode there is no real
 * subscription (readings are injected via PAL.ingestSensorReading). Otherwise it
 * subscribes to declared state topics and forwards messages to emit.
 * @param {(reading:object)=>void} emit
 * @returns {() => void}
 */
function start(emit) {
  if (hil.isEnabled() || typeof emit !== 'function') return () => {};
  const bridge = _ensureBridge();
  if (!bridge) return () => {};
  bridge.startReports(emit, loadDeviceConfig());
  return () => { try { bridge.stop(); } catch { /* ignore */ } _bridge = null; };
}

/**
 * Consistent pairing surface (pair / unpair / pairingStatus) shared with the
 * other real drivers. HIL pairing is virtual + isolated.
 */
const _pairing = createDriverPairing({
  loadDeviceConfig,
  ensureManager: _ensureBridge,
  getManager: () => _bridge,
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
  _setRos2LibForTest
};
