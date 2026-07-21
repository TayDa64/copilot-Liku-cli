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
const tokenStore = require('./token-store');
const coordination = require('./coordination');

/** Cross-host device lease key (shared with the PAL execute gate). @private */
function _leaseKey(id) { return `device:${id}`; }
function _pairLeaseTtlMs() {
  const v = Number(process.env.LIKU_PERIPHERAL_PAIR_LEASE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 300000; // 5 min; auto-expires so a crashed node can't block forever
}

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
    // Phase 25: LEASE-AWARE pairing. In cluster mode only the node that holds the
    // device lease may complete pairing (and bind its token). Single-machine
    // (cluster off) → always granted → behaviour unchanged.
    if (coordination.clusterEnabled()) {
      const lease = coordination.acquireLease(_leaseKey(deviceId), { ttlMs: _pairLeaseTtlMs() });
      if (!lease.granted) {
        return { id: deviceId, state: 'unpaired', error: 'leased-elsewhere', holder: lease.holder ? lease.holder.nodeId : null };
      }
    }
    const mgr = ensureManager();
    if (!mgr) return { id: deviceId, state: 'unpaired', error: 'no-transport' };
    try { commission(mgr, cfg); } catch { /* the state machine records the failure */ }
    const rec = mgr.pairing ? mgr.pairing.get(deviceId) : { state: 'unpaired' };
    // Phase 18: issue a capability token on successful pairing (revoked→re-issue,
    // i.e. token rotation on re-pair). Best-effort + flag-gated.
    if (rec && rec.state === 'paired') {
      try { tokenStore.onPair(deviceId, { actions: cfg.capabilities }); } catch { /* non-fatal */ }
    }
    return { id: deviceId, ...rec, token: _tokenSummary(deviceId) };
  }

  function unpair(deviceId) {
    if (hil.isEnabled()) return { id: deviceId, state: 'unpaired', simulated: true, hil: true };
    const mgr = getManager();
    if (mgr && typeof mgr.unpair === 'function') { try { mgr.unpair(deviceId); } catch { /* non-fatal */ } }
    else if (mgr && mgr.pairing) mgr.pairing.requeue(deviceId);
    // Phase 18: revoke the device's capability token on unpair.
    try { tokenStore.revoke(deviceId); } catch { /* non-fatal */ }
    // Phase 25: release the device lease so another node may take over pairing.
    if (coordination.clusterEnabled()) { try { coordination.releaseLease(_leaseKey(deviceId)); } catch { /* non-fatal */ } }
    return { id: deviceId, ...((mgr && mgr.pairing) ? mgr.pairing.get(deviceId) : { state: 'unpaired' }), token: _tokenSummary(deviceId) };
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

/** Compact token lifecycle summary for a device (safe when flag off). @private */
function _tokenSummary(deviceId) {
  try {
    const s = tokenStore.status(deviceId);
    if (!s) return null;
    return { gen: s.gen, revoked: !!s.revoked, identityFp: s.identityFp };
  } catch { return null; }
}

module.exports = { createDriverPairing };
