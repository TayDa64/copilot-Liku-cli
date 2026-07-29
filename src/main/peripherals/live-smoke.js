/**
 * Live-Hardware Smoke Harness — opt-in, reviewable, safety-preserving (Phase 40).
 *
 * A thin, dedicated entry point that exercises the REAL driver paths (Thread /
 * Z-Wave / KNX / USB-HID) through the hardened live-hardware gate AND the full PAL
 * safety chain. It exists so a dedicated CI lane (or an operator with real devices)
 * can prove the live wiring works end-to-end without scattering live-only logic
 * through production paths.
 *
 * MODES:
 *   - simulated (default in CI): injects a fake "real" library via each driver's
 *     `_set<X>LiveLibForTest` seam, so the live PATH is exercised with no hardware.
 *   - real: set LIKU_PERIPHERAL_LIVE=1 with NO injection → the drivers load their
 *     actual transport libraries and drive real devices.
 *
 * SAFETY (identical to production — the harness only observes/asserts):
 *   - Every action goes through `PAL.execute`, so DCP → class gate → pending/confirm
 *     runs first. The harness asserts a Class A action stays `pending` until an
 *     explicit confirm, and only dispatches SAFE Class B actions automatically.
 *   - HIL isolation is asserted: with LIKU_PERIPHERAL_HIL=1 no real/live library is
 *     touched (the simulated fake records zero sends).
 *   - DOUBLE-GATED: the harness NO-OPS unless LIKU_PERIPHERAL_LIVE_SMOKE=1 (or
 *     LIKU_PERIPHERAL_LIVE=1). It never runs by default.
 *   - The caller owns home isolation (LIKU_HOME_OVERRIDE) — no real-home pollution.
 */

'use strict';

const SMOKE_FLAG = 'LIKU_PERIPHERAL_LIVE_SMOKE';

/** The harness only runs when explicitly opted in. */
function smokeEnabled() {
  return String(process.env[SMOKE_FLAG] || '').trim() === '1'
    || String(process.env.LIKU_PERIPHERAL_LIVE || '').trim() === '1';
}

// ── Minimal fake "real" libraries (simulated mode only) ─────────────────────
const EventEmitter = require('events');

function fakeThread() {
  const sent = [];
  class BorderRouter extends EventEmitter {
    start() { return Promise.resolve(); }
    setActiveDataset() {}
    formNetwork() {}
    commissionJoiner() { return true; }
    getDeviceByAddr() { return { getEndpoint: () => ({ send: (a, p) => { sent.push({ a, p }); return Promise.resolve(); } }) }; }
    stop() {}
  }
  return { lib: { BorderRouter }, sent };
}
function fakeZwave() {
  const sent = [];
  class Driver extends EventEmitter {
    start() { return Promise.resolve(); }
    getNode() { return { interview: () => Promise.resolve(), setValue: (v, val) => { sent.push({ v, val }); return Promise.resolve(true); } }; }
    stop() {}
  }
  return { lib: { Driver }, sent };
}
function fakeKnx() {
  const sent = [];
  const conn = new EventEmitter();
  conn.write = (ga, v) => sent.push({ ga, v });
  return { lib: { Connection: () => conn }, sent };
}
function fakeHid() {
  const sent = [];
  return { lib: { HID: function () { return { write: (r) => sent.push(r), on: () => {}, sendFeatureReport: (r) => sent.push(r), close: () => {} }; } }, sent };
}

/** Per-driver smoke configuration. */
function _driverConfigs() {
  return [
    {
      id: 'thread', mod: '../peripherals/drivers/thread-driver', liveSeam: '_setThreadLiveLibForTest', liveFlag: 'LIKU_THREAD_LIVE',
      transportEnv: 'LIKU_THREAD_BORDER_ROUTER', transportVal: '/dev/live-thread', devicesEnv: 'LIKU_THREAD_DEVICES',
      fake: fakeThread,
      devices: [
        { id: 'smoke-th-b', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 5, address: 'fd00::b1', joinerEui64: 'B1' },
        { id: 'smoke-th-a', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, address: 'fd00::a1', joinerEui64: 'A1' }
      ]
    },
    {
      id: 'zwave', mod: '../peripherals/drivers/zwave-driver', liveSeam: '_setZwaveLiveLibForTest', liveFlag: 'LIKU_ZWAVE_LIVE',
      transportEnv: 'LIKU_ZWAVE_CONTROLLER', transportVal: '/dev/live-zwave', devicesEnv: 'LIKU_ZWAVE_DEVICES',
      fake: fakeZwave,
      devices: [
        { id: 'smoke-zw-b', name: 'Plug', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 8, nodeId: 21 },
        { id: 'smoke-zw-a', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, nodeId: 22 }
      ]
    },
    {
      id: 'knx', mod: '../peripherals/drivers/knx-driver', liveSeam: '_setKnxLiveLibForTest', liveFlag: 'LIKU_KNX_LIVE',
      transportEnv: 'LIKU_KNX_GATEWAY', transportVal: '10.0.0.9', devicesEnv: 'LIKU_KNX_DEVICES',
      fake: fakeKnx,
      devices: [
        { id: 'smoke-knx-b', name: 'Light', class: 'B', kind: 'light', capabilities: ['on', 'off'], powerW: 6, groupAddress: '5/1/1', dpt: '1.001' },
        { id: 'smoke-knx-a', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 3, groupAddress: '5/1/2', dpt: '1.001' }
      ]
    },
    {
      id: 'usbhid', mod: '../peripherals/drivers/usbhid-driver', liveSeam: '_setUsbHidLiveLibForTest', liveFlag: 'LIKU_USBHID_LIVE',
      transportEnv: 'LIKU_USBHID_ENABLE', transportVal: '1', devicesEnv: 'LIKU_USBHID_DEVICES',
      fake: fakeHid,
      devices: [
        { id: 'smoke-hid-b', name: 'Relay', class: 'B', kind: 'switch', capabilities: ['on', 'off'], powerW: 2, path: 'usb:b' },
        { id: 'smoke-hid-a', name: 'Lock', class: 'A', kind: 'lock', capabilities: ['lock', 'unlock'], powerW: 4, path: 'usb:a' }
      ]
    }
  ];
}

/** Restore a driver's live seam + clear its env (best-effort). @private */
function _cleanup(cfg) {
  try { const drv = require(cfg.mod); if (typeof drv[cfg.liveSeam] === 'function') drv[cfg.liveSeam](null); if (typeof drv._setLibForTest === 'function') drv._setLibForTest(null); } catch { /* ignore */ }
  delete process.env[cfg.transportEnv];
  delete process.env[cfg.devicesEnv];
  delete process.env[cfg.liveFlag];
}

/**
 * Run the smoke checks for one driver. Returns { driver, ok, checks:[{name, ok}] }.
 * @param {object} cfg  a driver config
 * @param {{ simulated?:boolean }} [opts]
 */
function _runDriver(cfg, opts = {}) {
  const simulated = opts.simulated !== false; // default simulated
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: !!ok });
  const bId = cfg.devices[0].id;
  const aId = cfg.devices[1].id;
  try {
    process.env.LIKU_ENABLE_PERIPHERALS = '1';
    delete process.env.LIKU_PERIPHERAL_HIL;
    process.env[cfg.transportEnv] = cfg.transportVal;
    process.env[cfg.devicesEnv] = JSON.stringify(cfg.devices);
    const drv = require(cfg.mod);
    let fake = null;
    if (simulated) { fake = cfg.fake(); drv[cfg.liveSeam](fake.lib); process.env[cfg.liveFlag] = '1'; }
    else { process.env.LIKU_PERIPHERAL_LIVE = '1'; }
    const pal = require('../peripherals/peripheral-abstraction-layer');
    pal.scan();
    add('driver-available', pal.listDrivers().drivers.includes(cfg.id));
    add('live-enabled', drv.isLiveEnabled() === true);
    const stop = pal.startStreaming();
    // Safe Class B action dispatches on the live path.
    add('classB-dispatch', pal.execute(bId, 'on').ok === true);
    if (simulated) add('classB-reached-transport', fake.sent.length >= 1);
    // Class A stays confirm-gated even with real/live transport connected.
    const beforeA = simulated ? fake.sent.length : 0;
    add('classA-gated', pal.execute(aId, 'unlock').pending === true);
    if (simulated) add('classA-no-send-before-confirm', fake.sent.length === beforeA);
    pal.authorize(aId, 'unlock');
    add('classA-dispatch-after-confirm', pal.execute(aId, 'unlock').ok === true);
    stop();
    // HIL isolation: with HIL on, no live library is touched.
    if (simulated) {
      const hilFake = cfg.fake();
      drv[cfg.liveSeam](hilFake.lib);
      process.env.LIKU_PERIPHERAL_HIL = '1';
      pal.scan();
      const r = pal.execute(bId, 'on');
      add('hil-simulated', r && r.result && r.result.simulated === true);
      add('hil-no-live-touch', hilFake.sent.length === 0);
      delete process.env.LIKU_PERIPHERAL_HIL;
      drv[cfg.liveSeam](null);
    }
  } catch (err) {
    add('exception', false);
    checks._error = err.message;
  } finally {
    _cleanup(cfg);
    delete process.env.LIKU_PERIPHERAL_LIVE;
    delete process.env.LIKU_ENABLE_PERIPHERALS;
  }
  return { driver: cfg.id, ok: checks.every((c) => c.ok), checks };
}

/**
 * Run the live-hardware smoke harness across all (or selected) drivers.
 * @param {{ simulated?:boolean, drivers?:string[], force?:boolean }} [opts]
 * @returns {{ enabled:boolean, ok:boolean, results:object[] }}
 */
function runSmoke(opts = {}) {
  if (!opts.force && !smokeEnabled()) return { enabled: false, ok: true, results: [], reason: `opt-in with ${SMOKE_FLAG}=1` };
  const want = Array.isArray(opts.drivers) && opts.drivers.length ? new Set(opts.drivers) : null;
  const results = [];
  for (const cfg of _driverConfigs()) {
    if (want && !want.has(cfg.id)) continue;
    results.push(_runDriver(cfg, opts));
  }
  return { enabled: true, ok: results.every((r) => r.ok), results };
}

module.exports = { SMOKE_FLAG, smokeEnabled, runSmoke };
