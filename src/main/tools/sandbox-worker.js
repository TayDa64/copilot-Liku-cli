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

process.on('message', (msg) => {
  if (msg.type !== 'execute') return;

  const { code, args, timeout } = msg;

  const sandboxContext = {
    args: Object.freeze({ ...(args || {}) }),
    console: {
      log: (...a) => {}, // Silence console in worker
      warn: (...a) => {},
      error: (...a) => {}
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
    const context = vm.createContext(sandboxContext);
    const script = new vm.Script(code, { filename: 'dynamic-tool.js' });
    script.runInContext(context, { timeout: timeout || 5000 });
    process.send({ type: 'result', success: true, result: context.result });
  } catch (err) {
    process.send({ type: 'result', success: false, error: err.message });
  }
});

// If parent disconnects, exit cleanly
process.on('disconnect', () => process.exit(0));
