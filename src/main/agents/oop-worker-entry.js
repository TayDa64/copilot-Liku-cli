'use strict';

/**
 * Out-of-process worker entry. Started only by oop-worker.js via fork.
 * Closed op set. No eval, no network, no vendor calls, no env echo.
 */

if (process.env.LIKU_OOP_WORKER_CHILD !== '1' || typeof process.send !== 'function') {
  process.exit(2);
}

const OPS = new Set(['identity', 'ping', 'sleep', 'fail']);

function finish(msg) {
  process.send(msg, () => {
    process.exit(msg && msg.ok === false ? 1 : 0);
  });
}

process.send({ type: 'ready', pid: process.pid, ppid: process.ppid });

let active = null;

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') {
    if (active && active.taskId === msg.taskId && typeof active.cancel === 'function') {
      active.cancel();
    }
    return;
  }
  if (msg.type !== 'run' || active) return;

  const op = String(msg.op || '').trim().toLowerCase();
  const taskId = String(msg.taskId || '').slice(0, 80);
  if (!OPS.has(op)) {
    finish({ type: 'result', ok: false, code: 'oop-op-forbidden', op, taskId, pid: process.pid, ppid: process.ppid });
    return;
  }

  if (op === 'fail') {
    active = { taskId, cancel: null };
    finish({ type: 'result', ok: false, code: 'oop-child-failed', op, taskId, pid: process.pid, ppid: process.ppid });
    return;
  }

  if (op === 'sleep') {
    const requested = Number(msg.payload && msg.payload.ms);
    const ms = Number.isFinite(requested) ? Math.min(3000, Math.max(50, requested)) : 1000;
    let timer = null;
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finish({
        type: 'result',
        ok: code == null,
        code: code || null,
        op,
        taskId,
        pid: process.pid,
        ppid: process.ppid
      });
    };
    active = { taskId, cancel: () => done('cancelled') };
    timer = setTimeout(() => done(null), ms);
    return;
  }

  active = { taskId, cancel: null };
  finish({
    type: 'result',
    ok: true,
    op,
    taskId,
    pid: process.pid,
    ppid: process.ppid
  });
});
