/**
 * QUIC worker lab prototype (Phase 50).
 *
 * Liku↔Liku loopback stand-in for a future QUIC/HTTP3 worker channel.
 * Length-prefixed JSON frames over 127.0.0.1 TCP. Not a vendor-API transport,
 * not a production switch, no new npm dependency, no UDP/msquic/quiche.
 *
 * Loaded only when TransportManager.select({ kind: 'quic' }) is taken under
 * LIKU_QUIC_WORKER_LAB=1. Flag off → this module is never required by
 * Supervisor / ai-service.
 *
 * Payload allowlist: control | cancel | telemetry | ping.
 * Inference-shaped payloads and vendor hosts are rejected.
 */

'use strict';

const net = require('net');

const LAB_KIND = 'quic';
const LOOPBACK_HOST = '127.0.0.1';
const ALLOWED_TYPES = Object.freeze(['control', 'cancel', 'telemetry', 'ping']);
const VENDOR_HOST_RE = /api\.x\.ai|api\.cerebras\.ai|api\.openai\.com|api\.anthropic\.com/i;
const MAX_FRAME = 64 * 1024;

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isQuicWorkerLabEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_QUIC_WORKER_LAB);
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function assertNoVendorTarget(value) {
  if (value == null) return;
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  if (VENDOR_HOST_RE.test(blob)) {
    const error = new Error('quic lab must not target vendor APIs');
    error.code = 'quic-vendor-forbidden';
    throw error;
  }
}

function isLabShapedPayload(payload) {
  return !!payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && ALLOWED_TYPES.includes(String(payload.type || '').trim().toLowerCase())
    && !Array.isArray(payload.messages);
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_FRAME) {
    const error = new Error('quic lab frame too large');
    error.code = 'quic-frame-too-large';
    throw error;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function attachFrameParser(socket, onFrame) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        socket.destroy();
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch {
        socket.destroy();
        return;
      }
      onFrame(parsed);
    }
  });
}

function defaultAck(payload) {
  return {
    ok: true,
    type: 'ack',
    echoType: payload && payload.type,
    taskId: payload && payload.taskId != null ? payload.taskId : null
  };
}

function startLabServer({ host = LOOPBACK_HOST, onFrame } = {}) {
  if (!isLoopbackHost(host)) {
    const error = new Error('quic lab must bind loopback only');
    error.code = 'quic-non-loopback';
    throw error;
  }
  const handler = typeof onFrame === 'function' ? onFrame : defaultAck;
  const server = net.createServer((socket) => {
    attachFrameParser(socket, (payload) => {
      let reply;
      try {
        reply = handler(payload) || defaultAck(payload);
      } catch (error) {
        reply = { ok: false, type: 'ack', error: error.code || error.message };
      }
      try { socket.end(encodeFrame(reply)); } catch { socket.destroy(); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      resolve({
        host: addr.address,
        port: addr.port,
        close() {
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

function invokeLabRoundTrip({ host = LOOPBACK_HOST, port, payload, timeoutMs = 2000 } = {}) {
  if (!isLoopbackHost(host)) {
    const error = new Error('quic lab must target loopback only');
    error.code = 'quic-non-loopback';
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error('quic lab round-trip timed out');
      error.code = 'quic-timeout';
      reject(error);
    }, timeoutMs);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('connect', () => {
      try { socket.write(encodeFrame(payload)); } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    attachFrameParser(socket, (frame) => {
      clearTimeout(timer);
      socket.end();
      resolve(frame);
    });
  });
}

function createQuicLabTransport(options = {}) {
  const invokeFrame = typeof options.invokeFrame === 'function' ? options.invokeFrame : defaultAck;
  let serverHandle = null;

  async function ensureServer() {
    if (serverHandle) return serverHandle;
    serverHandle = await startLabServer({ host: LOOPBACK_HOST, onFrame: invokeFrame });
    return serverHandle;
  }

  return {
    kind: LAB_KIND,
    lab: true,
    standIn: 'loopback-framed-tcp',
    async invoke(payload) {
      if (!isLabShapedPayload(payload)) {
        const error = new Error('quic lab requires a control-shaped payload');
        error.code = 'invalid-quic-payload';
        throw error;
      }
      assertNoVendorTarget(payload);
      const targetHost = payload.host || LOOPBACK_HOST;
      if (!isLoopbackHost(targetHost)) {
        const error = new Error('quic lab must target loopback only');
        error.code = 'quic-non-loopback';
        throw error;
      }
      const wire = {
        type: String(payload.type).trim().toLowerCase(),
        taskId: payload.taskId != null ? payload.taskId : null
      };
      if (payload.reason != null) wire.reason = String(payload.reason).slice(0, 200);
      const server = await ensureServer();
      return invokeLabRoundTrip({
        host: LOOPBACK_HOST,
        port: server.port,
        payload: wire
      });
    },
    async close() {
      if (!serverHandle) return;
      const handle = serverHandle;
      serverHandle = null;
      await handle.close();
    },
    _getBoundAddress() {
      return serverHandle ? { host: serverHandle.host, port: serverHandle.port } : null;
    }
  };
}

module.exports = {
  LAB_KIND,
  ALLOWED_TYPES,
  isQuicWorkerLabEnabled,
  isLoopbackHost,
  isLabShapedPayload,
  createQuicLabTransport,
  startLabServer,
  invokeLabRoundTrip,
  encodeFrame
};
