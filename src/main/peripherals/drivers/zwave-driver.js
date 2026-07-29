/**
 * Z-Wave Peripheral Driver — foundation + HIL (Pillar 3, Phase 37).
 *
 * Z-Wave is a low-power sub-GHz mesh for home automation. This driver bridges the
 * PAL to a Z-Wave controller: outbound commands are dispatched to a node; inbound
 * value updates are forwarded to PAL.ingestSensorReading(). Built on the shared
 * mesh-driver factory, so it exposes the identical safe driver interface as
 * BLE / Zigbee / Matter.
 *
 * AVAILABILITY: devices declared (LIKU_ZWAVE_DEVICES) AND (HIL on OR a controller
 * configured, LIKU_ZWAVE_CONTROLLER, e.g. a serial port). REMOTE=true → signed
 * capability tokens required when a DCP secret is set. Flag-gated + HIL-isolated.
 *
 * Device config (JSON in env LIKU_ZWAVE_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, nodeId }
 */

'use strict';

const { createMeshDriver } = require('./mesh-driver-factory');

const driver = createMeshDriver({
  DRIVER_ID: 'zwave',
  REMOTE: true,
  envDevices: 'LIKU_ZWAVE_DEVICES',
  envTransport: 'LIKU_ZWAVE_CONTROLLER',
  pairEnvPrefix: 'LIKU_ZWAVE_PAIR',
  resultPrefix: 'zwave',
  loadLib() { try { return require('zwave-js'); } catch { return null; } },
  extraFields: (d) => ({
    nodeId: d.nodeId != null ? String(d.nodeId) : undefined
  }),
  transport: {
    createController(lib) {
      const port = String(process.env.LIKU_ZWAVE_CONTROLLER || '');
      if (typeof lib.Driver === 'function') return new lib.Driver(port);
      if (typeof lib.Controller === 'function') return new lib.Controller({ port });
      if (typeof lib.createController === 'function') return lib.createController({ port });
      return null;
    },
    inboundEvent: 'message',
    extractInbound(msg, wanted) {
      const nodeId = msg && (msg.nodeId != null ? String(msg.nodeId) : (msg.node && msg.node.id != null ? String(msg.node.id) : undefined));
      let cfg = null;
      for (const c of wanted.values()) { if (c.nodeId != null && String(c.nodeId) === nodeId) { cfg = c; break; } }
      if (!cfg) return null;
      const data = (msg && msg.data) || {};
      const metrics = {};
      for (const [k, v] of Object.entries(data)) { if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') metrics[k] = v; }
      return { id: cfg.id, metrics };
    },
    resolve(controller, cfg) {
      if (typeof controller.getNode === 'function') return controller.getNode(cfg.nodeId);
      if (controller.controller && typeof controller.controller.nodes === 'object' && controller.controller.nodes.get) return controller.controller.nodes.get(cfg.nodeId);
      return null;
    },
    send(target, act, params) {
      if (typeof target.command === 'function') { const r = target.command(act, params || {}); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; }
      if (typeof target.setValue === 'function') { const r = target.setValue(act, params || {}); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; }
      return false;
    }
  }
});

module.exports = {
  ...driver,
  // test seam only
  _setZwaveLibForTest: driver._setLibForTest
};
