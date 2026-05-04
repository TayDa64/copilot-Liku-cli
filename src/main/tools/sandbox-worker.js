/**
 * Sandbox Worker — runs untrusted tool code in an isolated child process.
 *
 * Receives tool script + args via IPC, executes in a restricted VM,
 * and returns the result. The parent process can kill this worker
 * if it hangs or exceeds the timeout.
 *
 * SECURITY: This file runs as a separate Node.js process with no shared memory.
 * Even if a malicious script breaks out of the VM, it only compromises this
 * short-lived worker process (which the parent kills immediately).
 */

'use strict';

const vm = require('vm');

const MAX_LOG_ENTRIES = 40;
const MAX_LOG_TEXT = 4000;

function createBoundedLogCollector() {
  const entries = [];
  let totalLength = 0;

  function trimToBudget() {
    while (entries.length > MAX_LOG_ENTRIES || totalLength > MAX_LOG_TEXT) {
      const removed = entries.shift();
      totalLength -= String(removed?.message || '').length;
    }
  }

  return {
    push(level, values) {
      const message = values.map((value) => {
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }).join(' ');
      entries.push({ level, message, ts: new Date().toISOString() });
      totalLength += message.length;
      trimToBudget();
    },
    snapshot() {
      return entries.slice();
    }
  };
}

function serializeWorkerError(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
    stack: String(error.stack || '').slice(0, 4000) || null
  };
}

process.on('message', (msg) => {
  if (msg.type !== 'execute') return;

  const { code, args, timeout } = msg;
  const logs = createBoundedLogCollector();
  let phase = 'initialize';

  const sandboxContext = {
    args: Object.freeze({ ...(args || {}) }),
    console: {
      log: (...a) => { logs.push('log', a); },
      warn: (...a) => { logs.push('warn', a); },
      error: (...a) => { logs.push('error', a); }
    },
    JSON: JSON,
    Math: Math,
    Date: Date,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Boolean: Boolean,
    RegExp: RegExp,
    Map: Map,
    Set: Set,
    Promise: Promise,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    isFinite: isFinite,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
    result: null
  };

  try {
    phase = 'context';
    const context = vm.createContext(sandboxContext);
    phase = 'compile';
    const script = new vm.Script(code, { filename: 'dynamic-tool.js' });
    phase = 'execute';
    script.runInContext(context, { timeout: timeout || 5000 });
    phase = 'serialize';
    process.send({
      type: 'result',
      success: true,
      result: context.result,
      diagnostics: {
        phase,
        logs: logs.snapshot()
      }
    });
  } catch (err) {
    process.send({
      type: 'result',
      success: false,
      error: String(err.message || err),
      diagnostics: {
        phase,
        logs: logs.snapshot(),
        error: serializeWorkerError(err)
      }
    });
  }
});

// If parent disconnects, exit cleanly
process.on('disconnect', () => process.exit(0));
