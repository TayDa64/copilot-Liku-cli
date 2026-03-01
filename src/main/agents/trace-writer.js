/**
 * Agent Trace Writer — persistent JSONL flight recorder
 * 
 * Subscribes to orchestrator events and writes a structured trace log
 * to ~/.liku-cli/traces/<sessionId>.jsonl for post-hoc debugging.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TRACE_DIR = path.join(os.homedir(), '.liku-cli', 'traces');

class TraceWriter {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.stream = null;
    this.sessionId = null;

    this._bindEvents();
  }

  _ensureDir() {
    if (!fs.existsSync(TRACE_DIR)) {
      fs.mkdirSync(TRACE_DIR, { recursive: true, mode: 0o700 });
    }
  }

  _write(event, data) {
    if (!this.stream) return;
    const entry = {
      ts: new Date().toISOString(),
      session: this.sessionId,
      event,
      ...data
    };
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  _bindEvents() {
    const o = this.orchestrator;

    o.on('session:start', (session) => {
      this._ensureDir();
      this.sessionId = session.id;
      const filePath = path.join(TRACE_DIR, `${this.sessionId}.jsonl`);
      this.stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
      this._write('session:start', { metadata: session.metadata });
    });

    o.on('session:end', (session) => {
      this._write('session:end', { summary: session.summary });
      this._close();
    });

    o.on('task:start', (d) => this._write('task:start', { task: d.task, agent: d.agent }));
    o.on('task:complete', (d) => this._write('task:complete', { success: d.result?.success }));
    o.on('task:error', (d) => this._write('task:error', { error: d.error?.message || String(d.error) }));
    o.on('handoff:execute', (h) => this._write('handoff', { from: h.from, to: h.to, message: h.message }));
    o.on('checkpoint', (cp) => this._write('checkpoint', { label: cp.label }));

    // Agent-level events
    o.on('agent:log', (entry) => this._write('agent:log', entry));
    o.on('agent:proof', (proof) => this._write('agent:proof', proof));
    o.on('agent:handoff', (h) => this._write('agent:handoff', h));
  }

  _close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.sessionId = null;
  }

  /** Destroy and detach all listeners */
  destroy() {
    this._close();
    this.orchestrator.removeAllListeners();
  }
}

module.exports = { TraceWriter };
