/**
 * Persistent .NET UIA host — spawns WindowsUIA.exe once, communicates
 * via newline-delimited JSON (JSONL) over stdin/stdout.
 *
 * Protocol:
 *   stdin  → {"cmd":"elementFromPoint","x":500,"y":300}
 *   stdout ← {"ok":true,"cmd":"elementFromPoint","element":{…}}
 *
 * Supported commands: getTree, elementFromPoint, exit.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const STARTUP_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;

class UIAHost extends EventEmitter {
  constructor() {
    super();
    const binDir = path.join(__dirname, '..', '..', '..', '..', 'bin');
    this._binaryPath = path.join(binDir, 'WindowsUIA.exe');
    this._proc = null;
    this._buffer = '';
    this._pending = null; // { resolve, reject, timer }
    this._alive = false;
  }

  /** Ensure the host process is running. Idempotent. */
  async start() {
    if (this._alive && this._proc && !this._proc.killed) return;

    if (!fs.existsSync(this._binaryPath)) {
      throw new Error(
        `UIA host binary not found at ${this._binaryPath}. ` +
        'Build with: powershell -ExecutionPolicy Bypass -File src/native/windows-uia-dotnet/build.ps1'
      );
    }

    this._proc = spawn(this._binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this._buffer = '';
    this._alive = true;

    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString());
    });
    this._proc.on('exit', (code) => {
      this._alive = false;
      this._rejectPending(new Error(`UIA host exited with code ${code}`));
      this.emit('exit', code);
    });
    this._proc.on('error', (err) => {
      this._alive = false;
      this._rejectPending(err);
      this.emit('error', err);
    });
  }

  /** Send a command and await the JSON response. */
  async send(cmd) {
    await this.start();

    if (this._pending) {
      throw new Error('UIAHost: concurrent request not supported (previous call still pending)');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`UIAHost: command "${cmd.cmd}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this._pending = { resolve, reject, timer };

      const line = JSON.stringify(cmd) + '\n';
      this._proc.stdin.write(line);
    });
  }

  /** Convenience: elementFromPoint(x, y) → rich element payload */
  async elementFromPoint(x, y) {
    const resp = await this.send({ cmd: 'elementFromPoint', x, y });
    if (!resp.ok) throw new Error(resp.error || 'elementFromPoint failed');
    return resp.element;
  }

  /** Convenience: getTree() → foreground window tree */
  async getTree() {
    const resp = await this.send({ cmd: 'getTree' });
    if (!resp.ok) throw new Error(resp.error || 'getTree failed');
    return resp.tree;
  }

  /** Gracefully shut down the host process. */
  async stop() {
    if (!this._alive || !this._proc) return;
    try {
      await this.send({ cmd: 'exit' });
    } catch { /* ignore */ }
    this._alive = false;
    if (this._proc && !this._proc.killed) {
      this._proc.kill();
    }
    this._proc = null;
  }

  get isAlive() {
    return this._alive;
  }

  // ── internal ─────────────────────────────────────────────────────────

  _onData(chunk) {
    this._buffer += chunk.toString();
    let nl;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const json = JSON.parse(line);
        this._resolvePending(json);
      } catch (e) {
        this.emit('parseError', line, e);
      }
    }
  }

  _resolvePending(json) {
    if (!this._pending) return;
    const { resolve, timer } = this._pending;
    clearTimeout(timer);
    this._pending = null;
    resolve(json);
  }

  _rejectPending(err) {
    if (!this._pending) return;
    const { reject, timer } = this._pending;
    clearTimeout(timer);
    this._pending = null;
    reject(err);
  }
}

// Singleton for shared use
let _shared = null;

/**
 * Get or create the shared UIAHost instance.
 * @returns {UIAHost}
 */
function getSharedUIAHost() {
  if (!_shared) {
    _shared = new UIAHost();
  }
  return _shared;
}

module.exports = { UIAHost, getSharedUIAHost };
