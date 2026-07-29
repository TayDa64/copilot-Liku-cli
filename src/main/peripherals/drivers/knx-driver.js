/**
 * KNX Peripheral Driver — building-automation foundation + HIL (Pillar 3, Phase 37).
 *
 * KNX is a bus standard for building automation (lighting, blinds, HVAC). This
 * driver bridges the PAL to a KNX/IP gateway: outbound commands write to a group
 * address; inbound group telegrams are forwarded to PAL.ingestSensorReading().
 * Built on the shared mesh-driver factory.
 *
 * AVAILABILITY: devices declared (LIKU_KNX_DEVICES) AND (HIL on OR a gateway
 * configured, LIKU_KNX_GATEWAY). REMOTE=true → signed capability tokens required
 * when a DCP secret is set. Flag-gated + HIL-isolated.
 *
 * Device config (JSON in env LIKU_KNX_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, groupAddress }
 */

'use strict';

const { createMeshDriver } = require('./mesh-driver-factory');

const driver = createMeshDriver({
  DRIVER_ID: 'knx',
  REMOTE: true,
  envDevices: 'LIKU_KNX_DEVICES',
  envTransport: 'LIKU_KNX_GATEWAY',
  pairEnvPrefix: 'LIKU_KNX_PAIR',
  resultPrefix: 'knx',
  loadLib() { try { return require('knx'); } catch { return null; } },
  extraFields: (d) => ({
    groupAddress: d.groupAddress ? String(d.groupAddress) : undefined
  }),
  transport: {
    createController(lib) {
      const opts = { ipAddr: String(process.env.LIKU_KNX_GATEWAY || '') };
      if (typeof lib.Connection === 'function') return lib.Connection(opts);
      if (typeof lib.IpTunnelingConnection === 'function') return new lib.IpTunnelingConnection(opts);
      if (typeof lib.createConnection === 'function') return lib.createConnection(opts);
      return null;
    },
    inboundEvent: 'event',
    extractInbound(msg, wanted) {
      const ga = msg && (msg.groupAddress || msg.dest || (Array.isArray(msg) ? msg[1] : undefined));
      let cfg = null;
      for (const c of wanted.values()) { if (c.groupAddress && c.groupAddress === ga) { cfg = c; break; } }
      if (!cfg) return null;
      const data = (msg && msg.data) || {};
      const metrics = {};
      for (const [k, v] of Object.entries(data)) { if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') metrics[k] = v; }
      if (!Object.keys(metrics).length && typeof (msg && msg.value) !== 'undefined' && ['number', 'string', 'boolean'].includes(typeof msg.value)) metrics.value = msg.value;
      return { id: cfg.id, metrics };
    },
    resolve(controller, cfg) {
      // A KNX "target" is a group-address write closure bound to the connection.
      if (!cfg.groupAddress) return null;
      return { ga: cfg.groupAddress, conn: controller };
    },
    send(target, act, params) {
      const conn = target && target.conn;
      const value = (params && typeof params.value !== 'undefined') ? params.value : (act === 'on' ? 1 : act === 'off' ? 0 : 1);
      if (conn && typeof conn.write === 'function') { try { conn.write(target.ga, value); return true; } catch { return false; } }
      if (conn && typeof conn.groupWrite === 'function') { try { conn.groupWrite(target.ga, value); return true; } catch { return false; } }
      return false;
    }
  }
});

module.exports = {
  ...driver,
  // test seam only
  _setKnxLibForTest: driver._setLibForTest
};
