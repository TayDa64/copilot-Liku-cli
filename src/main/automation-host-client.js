'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const REQUEST_TIMEOUT_MS = 10000;
const STARTUP_TIMEOUT_MS = 8000;

function toBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isNativeAutomationHostEnabled(options = {}) {
  if (typeof options.useNativeHost === 'boolean') {
    return options.useNativeHost;
  }

  if (typeof options.USE_NATIVE_HOST === 'boolean') {
    return options.USE_NATIVE_HOST;
  }

  return toBooleanFlag(process.env.USE_NATIVE_HOST) || toBooleanFlag(process.env.LIKU_USE_NATIVE_HOST);
}

function resolveHostLaunchSpec() {
  const repoRoot = path.join(__dirname, '..', '..');
  const binDir = path.join(repoRoot, 'bin');
  const explicitHostPath = process.env.LIKU_AUTOMATION_HOST_PATH || process.env.AUTOMATION_HOST_PATH;

  if (explicitHostPath && fs.existsSync(explicitHostPath)) {
    if (/\.dll$/i.test(explicitHostPath)) {
      return {
        command: 'dotnet',
        args: [explicitHostPath],
        description: `dotnet ${explicitHostPath}`
      };
    }

    return {
      command: explicitHostPath,
      args: [],
      description: explicitHostPath
    };
  }

  const executableCandidates = [
    path.join(binDir, 'AutomationHost.exe'),
    path.join(repoRoot, 'src', 'dotnet', 'AutomationHost', 'bin', 'Debug', 'net8.0', 'win-x64', 'publish', 'AutomationHost.exe'),
    path.join(repoRoot, 'src', 'dotnet', 'AutomationHost', 'bin', 'Release', 'net8.0', 'win-x64', 'publish', 'AutomationHost.exe')
  ];

  for (const filePath of executableCandidates) {
    if (fs.existsSync(filePath)) {
      return {
        command: filePath,
        args: [],
        description: filePath
      };
    }
  }

  const managedCandidates = [
    path.join(repoRoot, 'src', 'dotnet', 'AutomationHost', 'bin', 'Debug', 'net8.0', 'win-x64', 'AutomationHost.dll'),
    path.join(repoRoot, 'src', 'dotnet', 'AutomationHost', 'bin', 'Release', 'net8.0', 'win-x64', 'AutomationHost.dll'),
    path.join(repoRoot, 'src', 'dotnet', 'AutomationHost', 'bin', 'Release', 'net8.0', 'AutomationHost.dll'),
    path.join(repoRoot, 'src', 'dotnet', 'AutomationHost', 'bin', 'Debug', 'net8.0', 'AutomationHost.dll')
  ];

  for (const filePath of managedCandidates) {
    if (fs.existsSync(filePath)) {
      return {
        command: 'dotnet',
        args: [filePath],
        description: `dotnet ${filePath}`
      };
    }
  }

  throw new Error(
    'AutomationHost binary not found. Build it with: npm run build:automation-host or dotnet build src/dotnet/AutomationHost/AutomationHost.csproj'
  );
}

class AutomationHostClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs || REQUEST_TIMEOUT_MS,
      startupTimeoutMs: options.startupTimeoutMs || STARTUP_TIMEOUT_MS,
      windowsHide: options.windowsHide !== false,
      ...options
    };

    this._proc = null;
    this._startPromise = null;
    this._buffer = Buffer.alloc(0);
    this._contentLength = null;
    this._nextId = 1;
    this._pending = new Map();
    this._stopping = false;
  }

  async start() {
    if (this._proc && !this._proc.killed) {
      return;
    }

    if (this._startPromise) {
      return this._startPromise;
    }

    this._startPromise = this._spawnAndWaitForReady();
    try {
      await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async ping(params = {}) {
    return this.request('ping', params);
  }

  async invoke(method, params = null) {
    return this.request('invoke', { method, params });
  }

  async invokeBatch(invocations = []) {
    return this.request('invokeBatch', { invocations });
  }

  async notify(method, params = null) {
    await this.start();
    this._writeMessage({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  async request(method, params = null) {
    await this.start();

    return this._requestInternal(method, params);
  }

  _requestInternal(method, params = null) {
    if (!this._proc || this._proc.killed) {
      return Promise.reject(new Error('AutomationHost process is not running'));
    }

    const id = this._nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`AutomationHost request '${method}' timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);

      this._pending.set(id, { resolve, reject, timer, method });
      this._writeMessage(payload);
    });
  }

  async stop(reason = 'node-client-stop') {
    this._stopping = true;

    try {
      if (this._proc && !this._proc.killed) {
        await this.request('shutdown', { reason });
      }
    } catch {
      // Ignore shutdown request failures during teardown.
    }

    if (this._proc && !this._proc.killed) {
      this._proc.kill();
    }

    this._proc = null;
    this._buffer = Buffer.alloc(0);
    this._contentLength = null;
    this._rejectAllPending(new Error('AutomationHost stopped'));
    this._stopping = false;
  }

  onNotification(method, handler) {
    this.on(`notification:${method}`, handler);
    return () => this.off(`notification:${method}`, handler);
  }

  get isRunning() {
    return !!(this._proc && !this._proc.killed);
  }

  async _spawnAndWaitForReady() {
    const launchSpec = resolveHostLaunchSpec();
    this._buffer = Buffer.alloc(0);
    this._contentLength = null;
    this._stopping = false;

    this._proc = spawn(launchSpec.command, launchSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: this.options.windowsHide
    });

    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    this._proc.on('error', (error) => {
      this._rejectAllPending(error);
      this.emit('error', error);
    });
    this._proc.on('exit', (code, signal) => {
      const error = new Error(`AutomationHost exited with code ${code ?? 'unknown'}${signal ? ` signal ${signal}` : ''}`);
      this._rejectAllPending(error);
      this.emit('exit', { code, signal });
      this._proc = null;
    });

    const startupTimer = setTimeout(() => {
      if (this._proc && !this._proc.killed) {
        this._proc.kill();
      }
    }, this.options.startupTimeoutMs);

    try {
      await this._requestInternal('ping', { message: 'startup-probe' });
    } finally {
      clearTimeout(startupTimer);
    }
  }

  _writeMessage(message) {
    if (!this._proc || this._proc.killed) {
      throw new Error('AutomationHost process is not running');
    }

    const json = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    this._proc.stdin.write(payload, 'utf8');
  }

  _onStdout(chunk) {
    this._buffer = Buffer.concat([this._buffer, Buffer.from(chunk)]);

    while (true) {
      if (this._contentLength == null) {
        const headerEnd = this._buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headerText = this._buffer.slice(0, headerEnd).toString('utf8');
        this._buffer = this._buffer.slice(headerEnd + 4);

        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.emit('parseError', new Error(`Missing Content-Length header in message: ${headerText}`));
          continue;
        }

        this._contentLength = Number(match[1]);
      }

      if (this._buffer.length < this._contentLength) {
        return;
      }

      const body = this._buffer.slice(0, this._contentLength).toString('utf8');
      this._buffer = this._buffer.slice(this._contentLength);
      this._contentLength = null;

      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.emit('parseError', error);
        continue;
      }

      this._handleMessage(message);
    }
  }

  _handleMessage(message) {
    if (typeof message.id !== 'undefined') {
      const pending = this._pending.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this._pending.delete(message.id);

      if (message.error) {
        const error = new Error(message.error.message || pending.method || 'AutomationHost request failed');
        error.code = message.error.code;
        pending.reject(error);
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.emit(`notification:${message.method}`, message.params);
      this.emit('notification', message);
    }
  }

  _rejectAllPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }
}

let sharedClient = null;

function getAutomationHostClient(options = {}) {
  if (!sharedClient) {
    sharedClient = new AutomationHostClient(options);
  }
  return sharedClient;
}

module.exports = {
  AutomationHostClient,
  getAutomationHostClient,
  isNativeAutomationHostEnabled,
  resolveHostLaunchSpec,
};