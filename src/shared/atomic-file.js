/**
 * Atomic file writes with best-effort advisory locking (Phase 10).
 *
 * Dependency-free, synchronous helpers used by every ~/.liku/*.json store so
 * that concurrent processes (CLI + Electron, or multiple CLIs) can safely share
 * the same home directory.
 *
 * LOCKING MODEL — advisory, best-effort, NON-FATAL:
 *   - A lock is a directory `<target>.lock` created with fs.mkdirSync, which is
 *     atomic on POSIX and Windows (EEXIST when already held).
 *   - Acquisition retries for a bounded time with a real synchronous sleep
 *     (Atomics.wait) so we never busy-spin the CPU.
 *   - Stale locks (older than staleMs, e.g. from a crashed process) are stolen.
 *   - If the lock still can't be acquired, we WARN ONCE and proceed anyway
 *     (last-writer-wins). Locking must never block normal operation.
 *
 * WRITE MODEL — tmp file + rename (atomic replace), performed while holding the
 * lock so a reader never observes a torn file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let _warnedOnce = false;

/** True synchronous sleep (no busy-wait) via Atomics.wait. @private */
function _sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback busy-wait */ }
  }
}

/**
 * Acquire an advisory lock for a target path. Best-effort: returns
 * { locked:false } (never throws) if the lock cannot be taken.
 * @param {string} targetPath
 * @param {{ retries?:number, retryDelayMs?:number, staleMs?:number }} [opts]
 * @returns {{ locked:boolean, release:()=>void }}
 */
function acquireLockSync(targetPath, opts = {}) {
  const lockPath = `${targetPath}.lock`;
  const retries = Number.isFinite(opts.retries) ? opts.retries : 50;
  const retryDelayMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 20;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 10000;

  for (let i = 0; i <= retries; i++) {
    try {
      fs.mkdirSync(lockPath);
      try { fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}:${Date.now()}`); } catch { /* diagnostic only */ }
      return { locked: true, release: () => releaseLockSync(lockPath) };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // Cannot create the lock at all (e.g. permissions) → proceed unlocked.
        return { locked: false, release: () => {} };
      }
      // Steal a stale lock (crashed holder).
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
          continue;
        }
      } catch {
        // Lock vanished between mkdir and stat → retry immediately.
        continue;
      }
      if (i < retries) _sleepSync(retryDelayMs);
    }
  }
  return { locked: false, release: () => {} };
}

/** Release a previously acquired lock. Never throws. */
function releaseLockSync(lockPath) {
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run fn while holding an advisory lock on targetPath. Best-effort: fn still
 * runs (with a one-time warning) if the lock can't be acquired.
 * @param {string} targetPath
 * @param {(locked:boolean)=>any} fn
 * @param {object} [opts]
 * @returns {any}
 */
function withFileLockSync(targetPath, fn, opts = {}) {
  const lock = acquireLockSync(targetPath, opts);
  if (!lock.locked && !_warnedOnce) {
    _warnedOnce = true;
    console.warn(`[liku] advisory lock unavailable for ${path.basename(targetPath)}; using last-writer-wins`);
  }
  try { return fn(lock.locked); }
  finally { lock.release(); }
}

/**
 * Atomically write data to targetPath (tmp + rename) while holding an advisory
 * lock. Creates the parent directory if needed. Returns true on success.
 * @param {string} targetPath
 * @param {string|Buffer} data
 * @param {{ mode?:number, retries?:number, retryDelayMs?:number, staleMs?:number }} [opts]
 * @returns {boolean}
 */
function atomicWriteFileSync(targetPath, data, opts = {}) {
  return withFileLockSync(targetPath, () => {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: opts.mode || 0o600 });
    fs.renameSync(tmp, targetPath);
    return true;
  }, opts);
}

module.exports = { acquireLockSync, releaseLockSync, withFileLockSync, atomicWriteFileSync };
