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
  let _controller = null;

  function _setLibForTest(lib) { _injectedLib = lib; _controller = null; }
  function _loadLib() { if (_injectedLib) return _injectedLib; try { return loadLib ? loadLib() : null; } catch { return null; } }
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
    startReports(emit, cfgs) { this.emit = emit; for (const c of cfgs || []) this.ensureWanted(c); }

    _resolve(cfg) {
      if (this.targets.has(cfg.id)) return this.targets.get(cfg.id);
      if (!this.pairing.canAttempt(cfg.id)) return null;
      this.pairing.begin(cfg.id);
      try {
        if (!this.controller) { this.pairing.fail(cfg.id, 'no-controller'); return null; }
        const target = transport.resolve(this.controller, cfg);
        if (!target) { this.pairing.fail(cfg.id, 'target-unresolved'); return null; }
        this.pairing.succeed(cfg.id);
        this.targets.set(cfg.id, target);
        return target;
      } catch (err) { this.pairing.fail(cfg.id, err.message); return null; }
    }

    commission(cfg) { if (!cfg) return null; this.ensureWanted(cfg); this._resolve(cfg); return this.pairing.get(cfg.id); }
    unpair(id) { this.targets.delete(id); if (this.pairing) this.pairing.requeue(id); }

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
    _setLibForTest
  };
}

module.exports = { createMeshDriver };
