/**
 * USB-HID Peripheral Driver — LOCAL foundation + HIL (Pillar 3, Phase 37).
 *
 * A foundation for local human-interface / simple-control USB devices (macropads,
 * relay boards, indicator panels). Outbound commands write a HID report; inbound
 * input reports are forwarded to PAL.ingestSensorReading(). Built on the shared
 * mesh-driver factory.
 *
 * LOCAL transport → REMOTE=false: signed capability tokens are NOT required (the
 * device is on the local USB bus, not a network). The full DCP → class gate →
 * pending/confirm chain still applies (Class A stays dual-validated + confirmed).
 *
 * AVAILABILITY: devices declared (LIKU_USBHID_DEVICES) AND (HIL on OR USB-HID
 * enabled, LIKU_USBHID_ENABLE=1). Flag-gated + HIL-isolated.
 *
 * Device config (JSON in env LIKU_USBHID_DEVICES) — array of:
 *   { id, name, class, kind, capabilities:[], powerW, path, vendorId, productId }
 */

'use strict';

const { createMeshDriver } = require('./mesh-driver-factory');

const driver = createMeshDriver({
  DRIVER_ID: 'usbhid',
  REMOTE: false, // LOCAL bus — no signed token required
  envDevices: 'LIKU_USBHID_DEVICES',
  envTransport: 'LIKU_USBHID_ENABLE',
  pairEnvPrefix: 'LIKU_USBHID_PAIR',
  resultPrefix: 'usbhid',
  loadLib() { try { return require('node-hid'); } catch { return null; } },
  extraFields: (d) => ({
    path: d.path ? String(d.path) : undefined,
    vendorId: Number.isFinite(Number(d.vendorId)) ? Number(d.vendorId) : undefined,
    productId: Number.isFinite(Number(d.productId)) ? Number(d.productId) : undefined,
    reportMap: (d.reportMap && typeof d.reportMap === 'object') ? d.reportMap : undefined
  }),
  transport: {
    createController(lib) {
      // node-hid is a module of functions, not a controller class; wrap it so the
      // generic controller can open device handles + subscribe to input reports.
      const openers = new Map();
      return {
        _lib: lib,
        on() { /* input reports are per-device (see open()) */ },
        start() { return null; },
        open(cfg) {
          if (openers.has(cfg.id)) return openers.get(cfg.id);
          let dev = null;
          try {
            if (typeof lib.HID === 'function') dev = cfg.path ? new lib.HID(cfg.path) : new lib.HID(cfg.vendorId, cfg.productId);
            else if (typeof lib.open === 'function') dev = lib.open(cfg);
          } catch { dev = null; }
          if (dev) openers.set(cfg.id, dev);
          return dev;
        },
        stop() { for (const d of openers.values()) { try { if (d && typeof d.close === 'function') d.close(); } catch { /* ignore */ } } openers.clear(); }
      };
    },
    // node-hid emits per-device 'data' events; the generic inbound path is not used
    // (readings are injected via PAL.ingestSensorReading in HIL / by device handlers).
    resolve(controller, cfg) { return controller && typeof controller.open === 'function' ? controller.open(cfg) : null; },
    // Phase 38 — real INPUT-REPORT subscription. node-hid devices emit 'data'
    // (a Buffer/byte array) per input report; parse it into metrics and forward
    // as a reading. Optional per-device `reportMap` (index → metric name) shapes
    // the bytes; default exposes byte0 as `value`. LOCAL bus, still read-only.
    subscribe(target, cfg, emit) {
      if (!target || typeof target.on !== 'function') return;
      const map = (cfg && cfg.reportMap && typeof cfg.reportMap === 'object') ? cfg.reportMap : null;
      target.on('data', (buf) => {
        try {
          const bytes = Array.isArray(buf) ? buf : (buf && typeof buf.length === 'number' ? Array.from(buf) : []);
          if (!bytes.length) return;
          const metrics = {};
          if (map) { for (const [idx, name] of Object.entries(map)) { const i = Number(idx); if (Number.isFinite(i) && i < bytes.length) metrics[String(name)] = bytes[i]; } }
          else metrics.value = bytes[0];
          if (Object.keys(metrics).length) emit({ id: cfg.id, metrics });
        } catch { /* non-fatal */ }
      });
      if (typeof target.on === 'function') { try { target.on('error', () => {}); } catch { /* ignore */ } }
    },
    send(target, act, params) {
      // Write a small HID report. `params.report` (array of bytes) or a mapped action.
      const report = Array.isArray(params && params.report) ? params.report : [0x00, act === 'on' ? 0x01 : act === 'off' ? 0x00 : 0x02];
      if (typeof target.write === 'function') { try { target.write(report); return true; } catch { return false; } }
      if (typeof target.sendFeatureReport === 'function') { try { target.sendFeatureReport(report); return true; } catch { return false; } }
      return false;
    }
  }
});

module.exports = {
  ...driver,
  // test seam only
  _setUsbHidLibForTest: driver._setLibForTest
};
