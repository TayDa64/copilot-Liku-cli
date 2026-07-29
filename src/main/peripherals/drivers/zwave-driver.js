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

// Phase 38 — Z-Wave Command Class mapping. Translate a semantic PAL action into the
// zwave-js ValueID + target value so `node.setValue(valueId, value)` speaks the
// right command class. Kept tiny + declarative (Binary Switch, Multilevel Switch,
// Door Lock); unknown actions fall back to a raw command call. Pure translation —
// the safety chain (DCP → class gate → confirm) has ALREADY run in the PAL.
const CC = Object.freeze({ BINARY_SWITCH: 37, MULTILEVEL_SWITCH: 38, DOOR_LOCK: 98 });
function zwaveValueId(act, params) {
  const a = String(act || '').toLowerCase();
  if (a === 'on' || a === 'off') return { valueId: { commandClass: CC.BINARY_SWITCH, property: 'targetValue' }, value: a === 'on' };
  if (a === 'brightness' || a === 'level' || a === 'dim') {
    const lvl = Number(params && params.level);
    return { valueId: { commandClass: CC.MULTILEVEL_SWITCH, property: 'targetValue' }, value: Number.isFinite(lvl) ? Math.max(0, Math.min(99, Math.round(lvl))) : 99 };
  }
  if (a === 'lock' || a === 'unlock') return { valueId: { commandClass: CC.DOOR_LOCK, property: 'targetMode' }, value: a === 'lock' ? 255 : 0 };
  return null;
}

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
    // Phase 38 — richer zwave-js onboarding: interview the node once so its command
    // classes + values are known before we address it. Idempotent per node.
    commission(controller, cfg) {
      try {
        const node = typeof controller.getNode === 'function' ? controller.getNode(cfg.nodeId) : null;
        if (!node) return true; // resolve() will report target-unresolved
        if (typeof node.interview === 'function') { const r = node.interview(); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); }
        else if (typeof node.refreshInfo === 'function') { const r = node.refreshInfo(); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); }
        return true;
      } catch { return false; }
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
      // Prefer the command-class ValueID path (real zwave-js semantics).
      const mapped = zwaveValueId(act, params);
      if (mapped && typeof target.setValue === 'function') {
        try { const r = target.setValue(mapped.valueId, mapped.value); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; } catch { return false; }
      }
      if (typeof target.command === 'function') { const r = target.command(act, params || {}); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; }
      if (typeof target.setValue === 'function') { const r = target.setValue(act, params || {}); if (r && typeof r.then === 'function') r.then(() => {}).catch(() => {}); return true; }
      return false;
    }
  }
});

module.exports = {
  ...driver,
  // exposed for unit tests / advanced callers
  _zwaveValueId: zwaveValueId,
  // test seam only
  _setZwaveLibForTest: driver._setLibForTest
};
