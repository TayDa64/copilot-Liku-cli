/**
 * Driver Pairing Surface — consistent pair / unpair / pairingStatus for every
 * connection-oriented real driver (Pillar 3, Phase 17).
 *
 * Wraps a driver's connection manager (which owns a `pairing` state machine from
 * pairing.js) with a uniform surface so BLE, Zigbee, ROS2 and Matter all expose
 * IDENTICAL pairing semantics:
 *
 *   pair(id)          → attempt/commission (retry+backoff via the state machine)
 *   unpair(id)        → tear down the connection + requeue for re-pair
 *   pairingStatus()   → per-device state map
 *
 * SAFETY / ISOLATION:
 *   - Pairing is TRANSPORT bookkeeping only — it never actuates a device and
 *     never bypasses the PAL safety chain (DCP → class gate → pending/confirm).
 *   - HIL mode is fully isolated: pairing is VIRTUAL (`simulated:true`), and no
 *     real adapter / coordinator / fabric / graph is ever touched.
 */

'use strict';

const hil = require('./hil-simulator');

/**
 * @param {object} deps
 * @param {() => object[]} deps.loadDeviceConfig  declared device config
 * @param {() => (object|null)} deps.ensureManager  create-or-get the connection manager
 * @param {() => (object|null)} deps.getManager     get the current manager (no create)
 * @param {(mgr:object, cfg:object) => any} deps.commission  drive one pairing attempt
 */
function createDriverPairing({ loadDeviceConfig, ensureManager, getManager, commission }) {
  function pair(deviceId) {
    if (hil.isEnabled()) return { id: deviceId, state: 'paired', simulated: true, hil: true };
    const cfg = (loadDeviceConfig() || []).find((d) => d.id === deviceId);
    if (!cfg) return { id: deviceId, state: 'unpaired', error: 'unknown-device' };
    const mgr = ensureManager();
    if (!mgr) return { id: deviceId, state: 'unpaired', error: 'no-transport' };
    try { commission(mgr, cfg); } catch { /* the state machine records the failure */ }
    return { id: deviceId, ...(mgr.pairing ? mgr.pairing.get(deviceId) : { state: 'unpaired' }) };
  }

  function unpair(deviceId) {
    if (hil.isEnabled()) return { id: deviceId, state: 'unpaired', simulated: true, hil: true };
    const mgr = getManager();
    if (mgr && typeof mgr.unpair === 'function') { try { mgr.unpair(deviceId); } catch { /* non-fatal */ } }
    else if (mgr && mgr.pairing) mgr.pairing.requeue(deviceId);
    return { id: deviceId, ...((mgr && mgr.pairing) ? mgr.pairing.get(deviceId) : { state: 'unpaired' }) };
  }

  function pairingStatus() {
    const cfgs = loadDeviceConfig() || [];
    if (hil.isEnabled()) {
      const out = {};
      for (const c of cfgs) out[c.id] = { state: 'paired', simulated: true, hil: true };
      return out;
    }
    const mgr = getManager();
    return mgr && mgr.pairing ? mgr.pairing.all() : {};
  }

  return { pair, unpair, pairingStatus };
}

module.exports = { createDriverPairing };
