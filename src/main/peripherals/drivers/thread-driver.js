/**
 * Thread Peripheral Driver — foundation + HIL (Pillar 3, Phase 37).
 *
 * Thread is a low-power IPv6 mesh (the network layer beneath much of Matter). This
 * driver bridges the PAL to a Thread border router: outbound commands are sent to a
 * mesh endpoint; inbound telemetry is forwarded to PAL.ingestSensorReading().
 * Built on the shared mesh-driver factory, so it exposes the identical safe driver
 * interface (discover / perform / start / pair) as BLE / Zigbee / Matter.
 *
 * AVAILABILITY: devices declared (LIKU_THREAD_DEVICES) AND (HIL on OR a border
 * router configured, LIKU_THREAD_BORDER_ROUTER). REMOTE=true → signed capability
 * tokens required when a DCP secret is set. Flag-gated + HIL-isolated.
 *
 * Device config (JSON in env LIKU_THREAD_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, address, endpoint }
 */

'use strict';

const { createMeshDriver } = require('./mesh-driver-factory');

const driver = createMeshDriver({
  DRIVER_ID: 'thread',
  REMOTE: true,
  envDevices: 'LIKU_THREAD_DEVICES',
  envTransport: 'LIKU_THREAD_BORDER_ROUTER',
  pairEnvPrefix: 'LIKU_THREAD_PAIR',
  resultPrefix: 'thread',
  loadLib() { try { return require('openthread'); } catch { return null; } },
  extraFields: (d) => ({
    address: d.address ? String(d.address) : undefined,
    endpoint: Number.isFinite(Number(d.endpoint)) ? Number(d.endpoint) : undefined
  }),
  transport: {
    createController(lib) {
      const opts = { borderRouter: String(process.env.LIKU_THREAD_BORDER_ROUTER || '') };
      if (typeof lib.BorderRouter === 'function') return new lib.BorderRouter(opts);
      if (typeof lib.Controller === 'function') return new lib.Controller(opts);
      if (typeof lib.createController === 'function') return lib.createController(opts);
      return null;
    },
    inboundEvent: 'message',
    extractInbound(msg, wanted) {
      const addr = msg && (msg.address || (msg.device && msg.device.address));
      let cfg = null;
      for (const c of wanted.values()) { if (c.address && c.address === addr) { cfg = c; break; } }
      if (!cfg) return null;
      const data = (msg && msg.data) || {};
      const metrics = {};
      for (const [k, v] of Object.entries(data)) { if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') metrics[k] = v; }
      return { id: cfg.id, metrics };
    },
    resolve(controller, cfg) {
      if (typeof controller.getDeviceByAddr === 'function') {
        const dev = controller.getDeviceByAddr(cfg.address);
        if (dev && typeof dev.getEndpoint === 'function') return dev.getEndpoint(cfg.endpoint || 1);
        return dev || null;
      }
      if (typeof controller.getNode === 'function') return controller.getNode(cfg.address);
      return null;
    },
    send(target, act, params) {
      if (typeof target.send === 'function') { const r = target.send(act, params || {}); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; }
      if (typeof target.command === 'function') { const r = target.command(act, params || {}); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; }
      return false;
    }
  }
});

module.exports = {
  ...driver,
  // test seam only
  _setThreadLibForTest: driver._setLibForTest
};
