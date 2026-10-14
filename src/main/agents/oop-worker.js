'use strict';

/**
 * Out-of-process execution lab.
 *
 * A real second Node process for a closed set of declared ops
 * (identity | ping | sleep | fail). Not QUIC, not HTTP/3, not a vendor
 * transport, and not the coding-model handoff. No new npm dependency.
 *
 * LIKU_OOP_WORKER defaults OFF. Flag off → this module is not required by
 * Supervisor, and runIsolated throws before fork.
 */

const { fork } = require('child_process');
const path = require('path');

const ENTRY = path.join(__dirname, 'oop-worker-entry.js');
const OPS = Object.freeze(['identity', 'ping', 'sleep', 'fail']);
const VENDOR_HOST_RE = /api\.x\.ai|api\.cerebras\.ai|api\.openai\.com|api\.anthropic\.com/i;
const SECRET_KEY_RE = /api[_-]?key|token|authorization|secret|password/i;

function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isOopWorkerEnabled(env = process.env) {
  return isEnabledFlag(env.LIKU_OOP_WORKER);
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertDispatchAllowed(request) {
  const op = String(request && request.op || '').trim().toLowerCase();
  if (!OPS.includes(op)) throw coded('oop-op-forbidden');
  let blob;
  try {
    blob = JSON.stringify({
      op,
      taskId: request && request.taskId,
      payload: request && request.payload
    });
  } catch {
    throw coded('oop-payload-forbidden');
  }
  if (blob.length > 4096) throw coded('oop-payload-too-large');
  if (VENDOR_HOST_RE.test(blob)) throw coded('oop-vendor-forbidden');
  if (SECRET_KEY_RE.test(blob)) throw coded('oop-secret-forbidden');
}

function safeChildEnv() {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    LIKU_OOP_WORKER_CHILD: '1'
  };
}

function createHandle(child) {
  let invokeSettled = false;
  const handle = {
    pid: child.pid,
    invoke(request) {
      assertDispatchAllowed(request);
      return new Promise((resolve, reject) => {
        const op = String(request.op).trim().toLowerCase();
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          reject(coded('oop-timeout'));
        }, op === 'sleep' ? 5000 : 2000);
        const onMsg = (msg) => {
          if (!msg || msg.type !== 'result') return;
          clearTimeout(timer);
          child.off('message', onMsg);
          invokeSettled = true;
          resolve({
            ok: msg.ok === true,
            op: msg.op || op,
            taskId: msg.taskId || null,
            pid: msg.pid || child.pid,
            ppid: msg.ppid || null,
            code: msg.code || null
          });
        };
        child.on('message', onMsg);
        child.once('exit', () => {
          if (invokeSettled) return;
          clearTimeout(timer);
          reject(coded('oop-child-exited'));
        });
        child.send({
          type: 'run',
          op,
          taskId: String(request.taskId || '').slice(0, 80),
          payload: request.payload && typeof request.payload === 'object' ? request.payload : null
        });
      });
    },
    cancel(taskId) {
      try { child.send({ type: 'cancel', taskId: String(taskId || '') }); } catch { /* exiting */ }
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 300);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try { child.kill('SIGTERM'); } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  };
  return handle;
}

function spawnWorker(env = process.env) {
  if (!isOopWorkerEnabled(env)) throw coded('oop-worker-disabled');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(ENTRY, [], {
        env: safeChildEnv(),
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json'
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(coded('oop-ready-timeout'));
    }, 2000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code) => {
      if (settled) return;
      const error = coded('oop-child-exited');
      error.exitCode = code;
      fail(error);
    });
    child.on('message', (msg) => {
      if (settled || !msg || msg.type !== 'ready') return;
      settled = true;
      clearTimeout(timer);
      resolve(createHandle(child));
    });
  });
}

async function runIsolated(request, env = process.env) {
  assertDispatchAllowed(request);
  if (!isOopWorkerEnabled(env)) throw coded('oop-worker-disabled');
  const handle = await spawnWorker(env);
  try {
    return await handle.invoke(request);
  } finally {
    await handle.close();
  }
}

module.exports = {
  OPS,
  isOopWorkerEnabled,
  assertDispatchAllowed,
  spawnWorker,
  runIsolated
};
