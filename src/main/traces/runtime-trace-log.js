const fs = require('fs');
const path = require('path');

const { LIKU_HOME } = require('../../shared/liku-home');

const TRACE_DIR = path.join(LIKU_HOME, 'traces');

function ensureTraceDir() {
  if (!fs.existsSync(TRACE_DIR)) {
    fs.mkdirSync(TRACE_DIR, { recursive: true, mode: 0o700 });
  }
}

function buildRuntimeTraceSessionId() {
  return `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createRuntimeTraceLog(options = {}) {
  ensureTraceDir();

  const sessionId = String(options.sessionId || buildRuntimeTraceSessionId()).trim() || buildRuntimeTraceSessionId();
  const filePath = path.join(TRACE_DIR, `${sessionId}.jsonl`);
  let closed = false;

  const append = (event, data = {}) => {
    if (closed) return null;
    const entry = {
      ts: new Date().toISOString(),
      session: sessionId,
      event,
      ...data
    };
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  };

  append('runtime:session:start', {
    metadata: options.metadata && typeof options.metadata === 'object'
      ? options.metadata
      : {}
  });

  return {
    sessionId,
    filePath,
    append,
    close(summary = {}) {
      if (closed) return;
      append('runtime:session:end', {
        summary: summary && typeof summary === 'object' ? summary : {}
      });
      closed = true;
    }
  };
}

module.exports = {
  createRuntimeTraceLog
};