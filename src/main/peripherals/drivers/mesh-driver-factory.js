/**
 * Mesh Driver Factory — a shared foundation for new networked/local transport
 * drivers (Pillar 3, Phase 37). Produces a driver that exposes the SAME interface
 * as the BLE / Zigbee / Matter drivers (id, REMOTE, isAvailable, discover, perform,
 * start, pair/unpair/pairingStatus, loadDeviceConfig, _setLibForTest) so a new
 * transport only has to describe its small transport-specific bits.
 *
 * SAFETY (identical discipline to the existing real drivers):
 *   - The optional transport library is required LAZILY, so discover() + PAL/DCP
 *     safety gating work without it installed. A test seam (`_setLibForTest`)
 *     exercises the real path with a fake controller.
 *   - perform() builds a signed DCP envelope (REMOTE transports refuse unsigned
 *     when a secret is set) and dispatches a command; if the target isn't resolved
 *     it returns { ok:false, reason:'not-connected' }. The PAL has ALREADY enforced
 *     DCP evaluation → class gate → pending/confirm BEFORE perform is called, so a
 *     Class A action still requires confirmation regardless of connectivity.
 *   - HIL simulation (LIKU_PERIPHERAL_HIL=1) is fully isolated: when HIL is on the
 *     real transport is NEVER touched; when off, HIL is never consulted.
 *   - Pairing participates in the shared lease-aware pairing surface (driver-pairing),
 *     so cluster pairing coordination + capability-token binding are inherited.
 */

'use strict';

const dcp = require('../dcp-protocol');
const hil = require('../hil-simulator');
const { createPairingState } = require('../pairing');
const { createDriverPairing } = require('../driver-pairing');

/**
 * @param {object} spec
 * @param {string} spec.DRIVER_ID
 * @param {boolean} [spec.REMOTE=true]        networked transport → signed tokens required
 * @param {boolean} [spec.SUPPORTS_HIL=true]
 * @param {string}  spec.envDevices           env var holding the JSON device config
 * @param {string}  spec.envTransport         env var whose presence means "transport configured"
 * @param {string}  spec.pairEnvPrefix        env prefix for pairing tuning (_MAX_ATTEMPTS/_BACKOFF_MS)
 * @param {string}  spec.resultPrefix         result label prefix (e.g. 'thread')
 * @param {() => any} spec.loadLib            lazily require the real transport library (or null)
 * @param {(d:object)=>object} [spec.extraFields]  extra normalized config fields per device
 * @param {object}  spec.transport            transport-specific hooks (createController/inboundEvent/extractInbound/resolve/send)
 */
function createMeshDriver(spec) {
  const {
    DRIVER_ID,
    REMOTE = true,
    SUPPORTS_HIL = true,
    envDevices,
    envTransport,
    pairEnvPrefix,
    resultPrefix,
    loadLib,
    extraFields,
    transport
  } = spec;

  let _injectedLib = null;
  let _liveLib = null;
  let _controller = null;

  function _setLibForTest(lib) { _injectedLib = lib; _controller = null; }
  // Phase 39 — simulate a REAL installed transport library for tests of the live
  // gate: it is used ONLY when the live flag is enabled (unlike _injectedLib which
  // always bypasses the gate, standing in for a mocked transport).
  function _setLiveLibForTest(lib) { _liveLib = lib; _controller = null; }
  /**
   * Phase 39 — LIVE-HARDWARE opt-in gate. Touching a real transport library
   * (openthread / zwave-js / knx / node-hid) requires an EXPLICIT opt-in so that a
   * library merely being installed never causes live I/O. Default OFF. Enabled via
   * the global `LIKU_PERIPHERAL_LIVE=1` or a per-driver `spec.liveEnv` flag.
   */
  function _liveEnabled() {
    if (String(process.env.LIKU_PERIPHERAL_LIVE || '').trim() === '1') return true;
    return !!(spec.liveEnv && String(process.env[spec.liveEnv] || '').trim() === '1');
  }
  function _loadLib() {
    if (_injectedLib) return _injectedLib;   // explicit test double — always allowed
    if (!_liveEnabled()) return null;        // real hardware libs require opt-in
    if (_liveLib) return _liveLib;           // simulated real lib (live-gate tests)
    try { return loadLib ? loadLib() : null; } catch { return null; }
  }
  function transportConfigured() { return !!String(process.env[envTransport] || '').trim(); }

  /** Parse declared device config from env (safe, never throws). */
  function loadDeviceConfig() {
    try {
      const raw = process.env[envDevices];
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
          driver: DRIVER_ID,
          ...(extraFields ? extraFields(d) : {})
        }));
    } catch { return []; }
  }

  /** Generic controller: drives the pairing state machine + delegates transport specifics. */
  class MeshController {
    constructor(lib) {
      this.lib = lib;
      this.controller = null;
      this.started = false;
      this.emit = null;
      this.wanted = new Map();   // deviceId → cfg
      this.targets = new Map();  // deviceId → resolved endpoint/node (cache)
      this.commissioned = new Set();  // deviceId → richer onboarding already done (idempotent)
      this.subscribed = new Set();    // deviceId → per-device inbound subscription wired
      this.pairing = createPairingState({
        maxAttempts: Number(process.env[`${pairEnvPrefix}_MAX_ATTEMPTS`]),
        baseBackoffMs: Number(process.env[`${pairEnvPrefix}_BACKOFF_MS`])
      });
      this._init();
    }

    _init() {
      try {
        this.controller = transport.createController(this.lib);
        if (!this.controller) return;
        if (transport.inboundEvent && typeof this.controller.on === 'function') {
          this.controller.on(transport.inboundEvent, (msg) => this._onInbound(msg));
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
      // For transports with per-device inbound (subscribe), eagerly resolve +
      // subscribe each declared device so input reports flow without a prior
      // command. Controller-level inbound transports are unaffected (no-op).
      if (typeof transport.subscribe === 'function') { for (const c of cfgs || []) { try { this._resolve(c); } catch { /* non-fatal */ } } }
    }

    _resolve(cfg) {
      if (this.targets.has(cfg.id)) return this.targets.get(cfg.id);
      if (!this.pairing.canAttempt(cfg.id)) return null;
      this.pairing.begin(cfg.id);
      try {
        if (!this.controller) { this.pairing.fail(cfg.id, 'no-controller'); return null; }
        // Optional richer onboarding (Thread network/dataset join, Z-Wave node
        // interview). Idempotent — runs at most once per device. A commission
        // step that reports failure fails the pairing attempt (bounded retry).
        if (typeof transport.commission === 'function' && !this.commissioned.has(cfg.id)) {
          const ok = transport.commission(this.controller, cfg);
          if (ok === false) { this.pairing.fail(cfg.id, 'commission-failed'); return null; }
          this.commissioned.add(cfg.id);
        }
        const target = transport.resolve(this.controller, cfg);
        if (!target) { this.pairing.fail(cfg.id, 'target-unresolved'); return null; }
        this.pairing.succeed(cfg.id);
        this.targets.set(cfg.id, target);
        this._subscribe(cfg, target);
        return target;
      } catch (err) { this.pairing.fail(cfg.id, err.message); return null; }
    }

    /** Optional per-device inbound subscription (e.g. USB-HID input reports). */
    _subscribe(cfg, target) {
      if (typeof transport.subscribe !== 'function' || this.subscribed.has(cfg.id) || !this.emit) return;
      try {
        transport.subscribe(target, cfg, (reading) => {
          try {
            if (reading && reading.id && reading.metrics && Object.keys(reading.metrics).length && this.emit) {
              this.emit({ id: reading.id, metrics: reading.metrics, at: reading.at || new Date().toISOString() });
            }
          } catch { /* non-fatal */ }
        });
        this.subscribed.add(cfg.id);
      } catch { /* non-fatal */ }
    }

    commission(cfg) { if (!cfg) return null; this.ensureWanted(cfg); this._resolve(cfg); return this.pairing.get(cfg.id); }
    unpair(id) { this.targets.delete(id); this.commissioned.delete(id); this.subscribed.delete(id); if (this.pairing) this.pairing.requeue(id); }

    command(cfg, act, params = {}) {
      this.ensureWanted(cfg);
      const target = this._resolve(cfg);
      if (!target) return false;
      try { return !!transport.send(target, act, params); } catch { return false; }
    }

    _onInbound(msg) {
      try {
        const res = transport.extractInbound ? transport.extractInbound(msg, this.wanted) : null;
        if (res && res.id && res.metrics && Object.keys(res.metrics).length && this.emit) {
          this.emit({ id: res.id, metrics: res.metrics, at: new Date().toISOString() });
        }
      } catch { /* non-fatal */ }
    }

    stop() {
      try { if (this.controller && typeof this.controller.stop === 'function') this.controller.stop(); } catch { /* ignore */ }
      this.targets.clear();
      this.wanted.clear();
      this.commissioned.clear();
      this.subscribed.clear();
      this.emit = null;
    }
  }

  function _ensureController() {
    const lib = _loadLib();
    if (!lib) return null;
    if (!_controller) _controller = new MeshController(lib);
    return _controller;
  }

  function isAvailable() {
    if (loadDeviceConfig().length === 0) return false;
    return hil.isEnabled() || transportConfigured();
  }

  function discover() {
    return loadDeviceConfig().map((d) => ({
      id: d.id, name: d.name, class: d.class, kind: d.kind,
      capabilities: d.capabilities, state: {}, powerW: d.powerW, driver: DRIVER_ID
    }));
  }

  function _buildEnvelope(cfg, act, params) {
    const token = dcp.issueCapabilityToken({ deviceId: cfg.id, actions: [act], ttlSec: 60 });
    if (REMOTE && dcp.isSigningConfigured() && String(token).endsWith(`.${dcp.UNSIGNED_MARKER}`)) {
      return { error: 'signed-token-required' };
    }
    return { envelope: dcp.buildCommandEnvelope({ device: cfg, action: act, params, token }) };
  }

  function perform(device, action, params = {}) {
    const cfg = loadDeviceConfig().find((d) => d.id === (device && device.id));
    const act = String(action || '').trim().toLowerCase();
    if (!cfg) return { ok: false, action: act, state: {}, reason: 'unknown-device' };
    if (!cfg.capabilities.map((c) => c.toLowerCase()).includes(act)) {
      return { ok: false, action: act, state: {}, reason: 'unsupported-action' };
    }
    const built = _buildEnvelope(cfg, act, params);
    if (built.error) return { ok: false, action: act, state: {}, reason: built.error };
    // HIL simulation path — no real transport touched.
    if (hil.isEnabled()) {
      const r = hil.perform(cfg, act, params);
      return { ...r, result: `${resultPrefix}:${cfg.id}:${act}`, envelope: built.envelope, simulated: true };
    }
    // Real path — dispatch a command to the resolved target.
    const ctrl = _ensureController();
    if (!ctrl) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
    const dispatched = ctrl.command(cfg, act, params);
    if (!dispatched) return { ok: false, action: act, state: {}, reason: 'not-connected', envelope: built.envelope };
    return { ok: true, action: act, state: { lastCommand: act }, result: `${resultPrefix}:${cfg.id}:${act}`, envelope: built.envelope };
  }

  function start(emit) {
    if (hil.isEnabled() || typeof emit !== 'function') return () => {};
    const ctrl = _ensureController();
    if (!ctrl) return () => {};
    ctrl.startReports(emit, loadDeviceConfig());
    return () => { try { ctrl.stop(); } catch { /* ignore */ } _controller = null; };
  }

  const _pairing = createDriverPairing({
    loadDeviceConfig,
    ensureManager: _ensureController,
    getManager: () => _controller,
    commission: (mgr, cfg) => mgr.commission(cfg)
  });

  return {
    DRIVER_ID, REMOTE, SUPPORTS_HIL,
    isAvailable, discover, perform, start, loadDeviceConfig,
    pair: (id) => _pairing.pair(id),
    unpair: (id) => _pairing.unpair(id),
    pairingStatus: () => _pairing.pairingStatus(),
    isLiveEnabled: _liveEnabled,
    _setLibForTest,
    _setLiveLibForTest
  };
}

module.exports = { createMeshDriver };
