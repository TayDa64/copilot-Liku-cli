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

// Phase 38 — KNX Datapoint Type (DPT) encode/decode. KNX group values are typed:
// DPT 1.001 = 1-bit boolean (switch), DPT 5.001 = 8-bit scaling 0..100% → 0..255,
// DPT 9.x = 2-byte float (temperature/humidity telemetry). We keep a tiny, pure,
// dependency-free codec so a real gateway receives correctly-typed values and
// inbound telegrams decode to numbers. Unknown DPT → passthrough.
function encodeDpt(dpt, value) {
  const t = String(dpt || '1.001');
  if (t.startsWith('1.')) return value ? 1 : 0;                       // boolean
  if (t.startsWith('5.')) {                                            // 8-bit scaling / unsigned
    const pct = Number(value);
    if (!Number.isFinite(pct)) return 0;
    return t === '5.001' ? Math.max(0, Math.min(255, Math.round((pct / 100) * 255)))
                         : Math.max(0, Math.min(255, Math.round(pct)));
  }
  if (t.startsWith('9.')) {                                            // 2-byte float (KNX half-precision)
    return knxFloat16(Number(value) || 0);
  }
  return value;
}
function decodeDpt(dpt, raw) {
  const t = String(dpt || '1.001');
  if (t.startsWith('1.')) return raw ? 1 : 0;
  if (t.startsWith('5.')) { const n = Number(raw) || 0; return t === '5.001' ? Math.round((n / 255) * 100) : n; }
  return Number(raw);
}
/** Encode a KNX 2-byte float (DPT 9.x): [0.01 resolution, 4-bit exponent]. */
function knxFloat16(v) {
  let mantissa = Math.round(v * 100);
  let exp = 0;
  while (mantissa < -2048 || mantissa > 2047) { mantissa = Math.round(mantissa / 2); exp++; }
  const sign = mantissa < 0 ? 0x8000 : 0;
  return sign | (exp << 11) | (mantissa & 0x07ff);
}
/** Map a semantic action → a typed KNX value using the device's DPT. */
function knxValue(cfg, act, params) {
  const dpt = cfg && cfg.dpt;
  let logical;
  if (params && typeof params.value !== 'undefined') logical = params.value;
  else if (act === 'on') logical = true;
  else if (act === 'off') logical = false;
  else if (act === 'brightness' || act === 'level' || act === 'dim') logical = Number(params && params.level);
  else logical = true;
  return encodeDpt(dpt, logical);
}

const driver = createMeshDriver({
  DRIVER_ID: 'knx',
  REMOTE: true,
  envDevices: 'LIKU_KNX_DEVICES',
  envTransport: 'LIKU_KNX_GATEWAY',
  pairEnvPrefix: 'LIKU_KNX_PAIR',
  liveEnv: 'LIKU_KNX_LIVE',
  resultPrefix: 'knx',
  loadLib() { try { return require('knx'); } catch { return null; } },
  extraFields: (d) => ({
    groupAddress: d.groupAddress ? String(d.groupAddress) : undefined,
    dpt: d.dpt ? String(d.dpt) : undefined
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
      // Decode a raw group value using the device's DPT (Phase 38).
      if (!Object.keys(metrics).length && typeof (msg && msg.value) !== 'undefined' && ['number', 'string', 'boolean'].includes(typeof msg.value)) {
        metrics.value = cfg.dpt ? decodeDpt(cfg.dpt, msg.value) : msg.value;
      }
      return { id: cfg.id, metrics };
    },
    resolve(controller, cfg) {
      // A KNX "target" is a group-address write closure bound to the connection.
      if (!cfg.groupAddress) return null;
      return { ga: cfg.groupAddress, conn: controller, dpt: cfg.dpt };
    },
    send(target, act, params) {
      const conn = target && target.conn;
      // Encode the outbound value with the device's DPT (Phase 38).
      const value = knxValue({ dpt: target && target.dpt }, act, params);
      if (conn && typeof conn.write === 'function') { try { conn.write(target.ga, value); return true; } catch { return false; } }
      if (conn && typeof conn.groupWrite === 'function') { try { conn.groupWrite(target.ga, value); return true; } catch { return false; } }
      return false;
    }
  }
});

module.exports = {
  ...driver,
  // exposed for unit tests / advanced callers
  _encodeDpt: encodeDpt,
  _decodeDpt: decodeDpt,
  _knxValue: knxValue,
  // test seams only
  _setKnxLibForTest: driver._setLibForTest,
  _setKnxLiveLibForTest: driver._setLiveLibForTest
};
