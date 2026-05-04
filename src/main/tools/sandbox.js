/**
 * Sandbox — secure execution of AI-generated tool scripts
 *
 * Uses child_process.fork() to run dynamic tools in a separate Node.js process.
 * This provides true process-level isolation:
 *   - No shared memory with the main process
 *   - Worker has no access to parent's require cache, fs handles, or sockets
 *   - Worker is killed on timeout (prevents infinite loops / resource exhaustion)
 *   - Even a VM escape only compromises the short-lived worker process
 *
 * Execution flow:
 *   1. Static validation (tool-validator.js — banned patterns)
 *   2. Fork sandbox-worker.js as a child process
 *   3. Send code + args via IPC
 *   4. Receive result via IPC or kill on timeout
 *   5. Return result to caller
 *
 * SECURITY: NEVER use require() to load AI-generated code. This sandbox
 * is the only sanctioned execution path for dynamic tools.
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const { validateToolSource } = require('./tool-validator');

const EXECUTION_TIMEOUT = 5000; // 5 seconds
const WORKER_PATH = path.join(__dirname, 'sandbox-worker.js');

function truncateTail(text = '', maxLen = 4000) {
  const raw = String(text || '');
  if (!raw || raw.length <= maxLen) return raw;
  return `... [${raw.length - maxLen} chars truncated]\n${raw.slice(-maxLen)}`;
}

function normalizeSandboxDiagnostics(diagnostics = {}, overrides = {}) {
  const merged = {
    ...(diagnostics && typeof diagnostics === 'object' ? diagnostics : {}),
    ...overrides
  };
  return {
    phase: String(merged.phase || '').trim() || null,
    logs: Array.isArray(merged.logs) ? merged.logs.slice(-40) : [],
    stdout: truncateTail(merged.stdout || '', 2000) || null,
    stderr: truncateTail(merged.stderr || '', 2000) || null,
    error: merged.error && typeof merged.error === 'object'
      ? {
        name: String(merged.error.name || 'Error'),
        message: String(merged.error.message || ''),
        stack: truncateTail(merged.error.stack || '', 4000) || null
      }
      : (merged.error ? { name: 'Error', message: String(merged.error), stack: null } : null)
  };
}

/**
 * Execute a dynamic tool script in an isolated child process.
 *
 * @param {string} toolPath - Absolute path to the tool script
 * @param {object} [args={}] - Arguments to pass to the tool
 * @returns {{ success: boolean, result: any, error?: string }}
 */
function executeDynamicTool(toolPath, args) {
  let code;
  try {
    code = fs.readFileSync(toolPath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      result: null,
      error: `Cannot read tool: ${err.message}`,
      diagnostics: normalizeSandboxDiagnostics({ phase: 'read-tool', error: err })
    };
  }

  // Static validation first
  const validation = validateToolSource(code);
  if (!validation.valid) {
    return {
      success: false,
      result: null,
      error: `Tool failed validation: ${validation.violations.join(', ')}`,
      diagnostics: normalizeSandboxDiagnostics({
        phase: 'validation',
        error: { name: 'ValidationError', message: validation.violations.join(', ') },
        violations: validation.violations
      })
    };
  }

  // Fork a worker process for isolation
  return new Promise((resolve) => {
    const worker = fork(WORKER_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // Drop env vars that could leak secrets into the sandbox
      env: { NODE_ENV: 'sandbox', PATH: process.env.PATH }
    });

    let settled = false;
    let workerStdout = '';
    let workerStderr = '';

    worker.stdout?.on('data', (chunk) => {
      workerStdout += chunk.toString();
      workerStdout = truncateTail(workerStdout, 4000);
    });

    worker.stderr?.on('data', (chunk) => {
      workerStderr += chunk.toString();
      workerStderr = truncateTail(workerStderr, 4000);
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { worker.kill('SIGKILL'); } catch {}
        resolve({
          success: false,
          result: null,
          error: `Tool execution timed out after ${EXECUTION_TIMEOUT}ms`,
          diagnostics: normalizeSandboxDiagnostics({
            phase: 'timeout',
            stdout: workerStdout,
            stderr: workerStderr,
            error: { name: 'TimeoutError', message: `Tool execution timed out after ${EXECUTION_TIMEOUT}ms` }
          })
        });
      }
    }, EXECUTION_TIMEOUT + 500); // +500ms grace for IPC overhead

    worker.on('message', (msg) => {
      if (msg.type === 'result' && !settled) {
        settled = true;
        clearTimeout(timer);
        try { worker.kill(); } catch {}
        resolve({
          success: msg.success,
          result: msg.result || null,
          error: msg.error || undefined,
          diagnostics: normalizeSandboxDiagnostics(msg.diagnostics, {
            stdout: workerStdout,
            stderr: workerStderr
          })
        });
      }
    });

    worker.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          result: null,
          error: `Worker error: ${err.message}`,
          diagnostics: normalizeSandboxDiagnostics({
            phase: 'worker-error',
            stdout: workerStdout,
            stderr: workerStderr,
            error: err
          })
        });
      }
    });

    worker.on('exit', (exitCode) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          result: null,
          error: exitCode ? `Worker exited with code ${exitCode}` : 'Worker exited unexpectedly',
          diagnostics: normalizeSandboxDiagnostics({
            phase: 'worker-exit',
            stdout: workerStdout,
            stderr: workerStderr,
            error: {
              name: 'WorkerExitError',
              message: exitCode ? `Worker exited with code ${exitCode}` : 'Worker exited unexpectedly'
            }
          })
        });
      }
    });

    // Send the code to the worker
    worker.send({ type: 'execute', code, args: args || {}, timeout: EXECUTION_TIMEOUT });
  });
}

module.exports = { executeDynamicTool, EXECUTION_TIMEOUT };
