/**
 * Persistent .NET UIA host — spawns WindowsUIA.exe once, communicates
 * via newline-delimited JSON (JSONL) over stdin/stdout.
 *
 * Protocol:
 *   stdin  → {"cmd":"elementFromPoint","x":500,"y":300}
 *   stdout ← {"ok":true,"cmd":"elementFromPoint","element":{…}}
 *
 * Supported commands: getTree, findElementsByWindow, probeWindowAccessibility, getFocusedElementInWindow,
 * getForegroundWindowInfo, getWindowInfoByHandle, getRunningProcessesByNames, getClipboardText,
 * setClipboardText, saveClipboardState, restoreClipboardState,
 * elementFromPoint, elementFromPointInWindow, exit.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const STARTUP_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 1200;

class UIAHost extends EventEmitter {
  constructor() {
    super();
    const binDir = path.join(__dirname, '..', '..', '..', '..', 'bin');
    this._binaryPath = path.join(binDir, 'WindowsUIA.exe');
    this._proc = null;
    this._buffer = '';
    this._pending = null; // { requestId, command, resolve, reject, timer }
    this._queue = [];
    this._nextRequestId = 1;
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
      this._rejectAllPending(new Error(`UIA host exited with code ${code}`));
      this.emit('exit', code);
    });
    this._proc.on('error', (err) => {
      this._alive = false;
      this._rejectAllPending(err);
      this.emit('error', err);
    });
  }

  /** Send a command and await the JSON response. */
  async send(cmd) {
    await this.start();

    return new Promise((resolve, reject) => {
      const requestId = this._normalizeRequestId(cmd?.requestId) || this._createRequestId();
      this._queue.push({
        requestId,
        command: {
          ...(cmd || {}),
          requestId
        },
        resolve,
        reject,
        timer: null
      });
      this._dispatchNext();
    });
  }

  /** Convenience: elementFromPoint(x, y) → rich element payload */
  async elementFromPoint(x, y) {
    const resp = await this.send({ cmd: 'elementFromPoint', x, y });
    if (!resp.ok) throw new Error(resp.error || 'elementFromPoint failed');
    return resp.element;
  }

  /** Bounded hit-test scoped to a specific top-level window. */
  async elementFromPointInWindow(hwnd, x, y, options = {}) {
    const resp = await this.send({
      cmd: 'elementFromPointInWindow',
      hwnd,
      x,
      y,
      view: options.view || 'raw',
      maxDepth: Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 18,
      maxVisited: Number.isFinite(Number(options.maxVisited)) ? Number(options.maxVisited) : 1200,
      timeoutMs: Number.isFinite(Number(options.timeoutMs ?? options.timeout))
        ? Number(options.timeoutMs ?? options.timeout)
        : 300,
      includeOffscreen: options.includeOffscreen === true,
      includeDisabled: options.includeDisabled !== false
    });
    if (!resp.ok) throw new Error(resp.error || 'elementFromPointInWindow failed');
    return resp;
  }

  /** Convenience: getTree() → foreground window tree */
  async getTree() {
    const resp = await this.send({ cmd: 'getTree' });
    if (!resp.ok) throw new Error(resp.error || 'getTree failed');
    return resp.tree;
  }

  /** Bounded UIA element search scoped to a specific top-level window. */
  async findElementsByWindow(hwnd, options = {}) {
    const resp = await this.send({
      cmd: 'findElementsByWindow',
      hwnd,
      text: options.text || '',
      textMode: options.textMode || (options.exact ? 'exact' : 'contains'),
      controlType: options.controlType || '',
      view: options.view || 'control',
      bounds: options.bounds || null,
      skipRootMatch: options.skipRootMatch === true,
      maxResults: Number.isFinite(Number(options.maxResults)) ? Number(options.maxResults) : 50,
      maxDepth: Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 12,
      maxVisited: Number.isFinite(Number(options.maxVisited)) ? Number(options.maxVisited) : 750,
      timeoutMs: Number.isFinite(Number(options.timeoutMs ?? options.timeout))
        ? Number(options.timeoutMs ?? options.timeout)
        : 2500,
      includeOffscreen: options.includeOffscreen === true,
      includeDisabled: options.includeDisabled !== false
    });
    if (!resp.ok) throw new Error(resp.error || 'findElementsByWindow failed');
    return resp;
  }

  /** Bounded accessibility probe rooted under window-scoped document/content surfaces. */
  async probeWindowAccessibility(hwnd, options = {}) {
    const resp = await this.send({
      cmd: 'probeWindowAccessibility',
      hwnd,
      bounds: options.bounds || null,
      maxResults: Number.isFinite(Number(options.maxResults)) ? Number(options.maxResults) : 24,
      maxRoots: Number.isFinite(Number(options.maxRoots)) ? Number(options.maxRoots) : 4,
      maxDepth: Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 18,
      maxVisited: Number.isFinite(Number(options.maxVisited)) ? Number(options.maxVisited) : 1400,
      timeoutMs: Number.isFinite(Number(options.timeoutMs ?? options.timeout))
        ? Number(options.timeoutMs ?? options.timeout)
        : 900,
      includeOffscreen: options.includeOffscreen === true,
      includeDisabled: options.includeDisabled !== false,
      rootControlType: options.rootControlType || 'Document',
      rootClassName: options.rootClassName || 'Chrome_RenderWidgetHostHWND'
    });
    if (!resp.ok) throw new Error(resp.error || 'probeWindowAccessibility failed');
    return resp;
  }

  /** Return the currently focused UIA element if it belongs to the given window. */
  async getFocusedElementInWindow(hwnd) {
    const resp = await this.send({
      cmd: 'getFocusedElementInWindow',
      hwnd
    });
    if (!resp.ok) throw new Error(resp.error || 'getFocusedElementInWindow failed');
    return resp;
  }

  /** Invoke a semantic UIA element scoped to a specific top-level window. */
  async invokeElementByWindow(hwnd, options = {}) {
    const resp = await this.send({
      cmd: 'invokeElementByWindow',
      hwnd,
      text: options.text || '',
      textMode: options.textMode || (options.exact ? 'exact' : 'contains'),
      controlType: options.controlType || '',
      view: options.view || 'control',
      bounds: options.bounds || null,
      maxDepth: Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 16,
      maxVisited: Number.isFinite(Number(options.maxVisited)) ? Number(options.maxVisited) : 1000,
      timeoutMs: Number.isFinite(Number(options.timeoutMs ?? options.timeout))
        ? Number(options.timeoutMs ?? options.timeout)
        : 3000,
      includeOffscreen: options.includeOffscreen === true,
      includeDisabled: options.includeDisabled === true
    });
    if (!resp.ok) throw new Error(resp.error || 'invokeElementByWindow failed');
    return resp;
  }

  /** Convenience: getForegroundWindowInfo() → structured foreground window info. */
  async getForegroundWindowInfo() {
    const resp = await this.send({ cmd: 'getForegroundWindowInfo' });
    if (!resp.ok) throw new Error(resp.error || 'getForegroundWindowInfo failed');
    return resp.window;
  }

  /** Convenience: getWindowInfoByHandle(hwnd) → structured window info. */
  async getWindowInfoByHandle(hwnd) {
    const resp = await this.send({ cmd: 'getWindowInfoByHandle', hwnd });
    if (!resp.ok) throw new Error(resp.error || 'getWindowInfoByHandle failed');
    return resp.window;
  }

  /** Convenience: findWindow(criteria) → best matching top-level window or null. */
  async findWindow(criteria = {}) {
    const resp = await this.send({
      cmd: 'findWindow',
      title: criteria?.title || '',
      titleMode: criteria?.titleMode || 'contains',
      processName: criteria?.processName || '',
      className: criteria?.className || ''
    });
    if (!resp.ok) throw new Error(resp.error || 'findWindow failed');
    return resp.window || null;
  }

  /** Convenience: getRunningProcessesByNames(processNames) → lightweight process awareness data. */
  async getRunningProcessesByNames(processNames = []) {
    const normalized = Array.from(
      new Set(
        (Array.isArray(processNames) ? processNames : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    );

    if (!normalized.length) {
      return [];
    }

    const resp = await this.send({
      cmd: 'getRunningProcessesByNames',
      processNames: normalized
    });
    if (!resp.ok) throw new Error(resp.error || 'getRunningProcessesByNames failed');
    return Array.isArray(resp.processes) ? resp.processes : [];
  }

  /** Convenience: focusWindow(hwnd) → structured foreground verification result. */
  async focusWindow(hwnd) {
    const resp = await this.send({ cmd: 'focusWindow', hwnd });
    if (!resp.ok) throw new Error(resp.error || 'focusWindow failed');
    return resp;
  }

  /** Convenience: restoreWindow(hwnd) → structured restore result. */
  async restoreWindow(hwnd) {
    const resp = await this.send({ cmd: 'restoreWindow', hwnd });
    if (!resp.ok) throw new Error(resp.error || 'restoreWindow failed');
    return resp;
  }

  /** Set value on element at (x,y) using ValuePattern. */
  async setValue(x, y, value) {
    const resp = await this.send({ cmd: 'setValue', x, y, value });
    if (!resp.ok) throw new Error(resp.error || 'setValue failed');
    return resp;
  }

  /** Scroll element at (x,y) using ScrollPattern. direction: up|down|left|right. amount: percent (0-100) or -1 for small increment. */
  async scroll(x, y, direction = 'down', amount = -1) {
    const resp = await this.send({ cmd: 'scroll', x, y, direction, amount });
    if (!resp.ok) throw new Error(resp.error || 'scroll failed');
    return resp;
  }

  /** Expand/collapse element at (x,y). action: expand|collapse|toggle. */
  async expandCollapse(x, y, action = 'toggle') {
    const resp = await this.send({ cmd: 'expandCollapse', x, y, action });
    if (!resp.ok) throw new Error(resp.error || 'expandCollapse failed');
    return resp;
  }

  /** Get text from element at (x,y) using TextPattern → ValuePattern → Name fallback. */
  async getText(x, y) {
    const resp = await this.send({ cmd: 'getText', x, y });
    if (!resp.ok) throw new Error(resp.error || 'getText failed');
    return resp;
  }

  /** Convenience: getClipboardText() → current clipboard text payload. */
  async getClipboardText() {
    const resp = await this.send({ cmd: 'getClipboardText' });
    if (!resp.ok) throw new Error(resp.error || 'getClipboardText failed');
    return resp;
  }

  /** Convenience: setClipboardText(text) → set current clipboard text payload. */
  async setClipboardText(text = '') {
    const resp = await this.send({ cmd: 'setClipboardText', text });
    if (!resp.ok) throw new Error(resp.error || 'setClipboardText failed');
    return resp;
  }

  /** Save the current clipboard state in the host and return a restoration token. */
  async saveClipboardState() {
    const resp = await this.send({ cmd: 'saveClipboardState' });
    if (!resp.ok) throw new Error(resp.error || 'saveClipboardState failed');
    return resp;
  }

  /** Restore a previously saved clipboard state from a host-issued token. */
  async restoreClipboardState(token) {
    const resp = await this.send({ cmd: 'restoreClipboardState', token: String(token || '') });
    if (!resp.ok) throw new Error(resp.error || 'restoreClipboardState failed');
    return resp;
  }

  /** Subscribe to UIA events (focus, structure, property). Returns initial snapshot. */
  async subscribeEvents() {
    const resp = await this.send({ cmd: 'subscribeEvents' });
    if (!resp.ok) throw new Error(resp.error || 'subscribeEvents failed');
    return resp;
  }

  /** Unsubscribe from all UIA events. */
  async unsubscribeEvents() {
    const resp = await this.send({ cmd: 'unsubscribeEvents' });
    if (!resp.ok) throw new Error(resp.error || 'unsubscribeEvents failed');
    return resp;
  }

  /** Gracefully shut down the host process. */
  async stop() {
    if (!this._alive || !this._proc) return;
    const proc = this._proc;

    try {
      if (!this._pending && this._queue.length === 0) {
        await Promise.race([
          this.send({ cmd: 'exit' }),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
            if (typeof timer?.unref === 'function') {
              timer.unref();
            }
          })
        ]);
      }
    } catch { /* ignore */ }

    this._alive = false;
    this._rejectAllPending(new Error('UIA host shutdown'));

    try { proc.stdin?.end(); } catch {}
    try { proc.stdin?.destroy(); } catch {}
    try { proc.stdout?.destroy(); } catch {}
    try { proc.stderr?.destroy(); } catch {}

    if (proc && !proc.killed) {
      try { proc.kill(); } catch {}
    }
    try {
      if (typeof proc?.unref === 'function') {
        proc.unref();
      }
    } catch {}

    if (this._proc === proc) {
      this._proc = null;
    }
    this._buffer = '';
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
        // Phase 4: route unsolicited event messages before pending resolution
        if (json.type === 'event') {
          this.emit('uia-event', json);
          continue;
        }
        this._resolvePending(json);
      } catch (e) {
        this.emit('parseError', line, e);
      }
    }
  }

  _createRequestId() {
    const seq = this._nextRequestId++;
    return `uia-${process.pid}-${Date.now()}-${seq}`;
  }

  _normalizeRequestId(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
  }

  _dispatchNext() {
    if (this._pending || !this._alive || !this._proc?.stdin || this._proc.stdin.destroyed) {
      return;
    }

    const next = this._queue.shift();
    if (!next) {
      return;
    }

    const timer = setTimeout(() => {
      if (!this._pending || this._pending.requestId !== next.requestId) {
        return;
      }
      this._rejectActiveRequest(
        new Error(`UIAHost: command "${next.command.cmd}" timed out after ${REQUEST_TIMEOUT_MS}ms`)
      );
      this._dispatchNext();
    }, REQUEST_TIMEOUT_MS);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }

    next.timer = timer;
    this._pending = next;

    const line = JSON.stringify(next.command) + '\n';
    try {
      this._proc.stdin.write(line, (err) => {
        if (!err || !this._pending || this._pending.requestId !== next.requestId) {
          return;
        }
        this._rejectActiveRequest(err);
        this._dispatchNext();
      });
    } catch (error) {
      this._rejectActiveRequest(error);
      this._dispatchNext();
    }
  }

  _resolvePending(json) {
    if (!this._pending) {
      this.emit('orphanResponse', json);
      return;
    }

    const responseRequestId = this._normalizeRequestId(json?.requestId);
    if (responseRequestId && responseRequestId !== this._pending.requestId) {
      this.emit('orphanResponse', json);
      return;
    }

    const { resolve, timer } = this._pending;
    clearTimeout(timer);
    this._pending = null;
    resolve(json);
    this._dispatchNext();
  }

  _rejectActiveRequest(err) {
    if (!this._pending) return;
    const { reject, timer } = this._pending;
    clearTimeout(timer);
    this._pending = null;
    reject(err);
  }

  _rejectAllPending(err) {
    this._rejectActiveRequest(err);
    while (this._queue.length > 0) {
      const next = this._queue.shift();
      try {
        next?.reject?.(err);
      } catch {}
    }
  }
}

// Singleton for shared use
let _shared = null;
let _sharedCleanupRegistered = false;

/**
 * Get or create the shared UIAHost instance.
 * @returns {UIAHost}
 */
function getSharedUIAHost() {
  if (!_shared) {
    _shared = new UIAHost();
  }
  if (!_sharedCleanupRegistered) {
    _sharedCleanupRegistered = true;
    process.once('exit', () => {
      try {
        if (_shared?._proc && !_shared._proc.killed) {
          _shared._proc.kill();
        }
      } catch {}
    });
  }
  return _shared;
}

async function shutdownSharedUIAHost() {
  if (!_shared) return;
  try {
    await _shared.stop();
  } catch {}
  _shared = null;
  _sharedCleanupRegistered = false;
}

module.exports = { UIAHost, getSharedUIAHost, shutdownSharedUIAHost };
