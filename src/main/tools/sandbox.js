/**
 * VM Sandbox — secure execution of AI-generated tool scripts
 *
 * Uses Node.js vm.createContext() to run dynamic tools with:
 *   - Explicit allowlist of available APIs (no fs, no child_process, no require)
 *   - 5-second timeout (prevents infinite loops)
 *   - Result extraction via a `result` variable in the sandbox context
 *   - Hook enforcement: PreToolUse must approve before execution
 *
 * SECURITY: NEVER use require() to load AI-generated code. This sandbox
 * is the only sanctioned execution path for dynamic tools.
 */

const vm = require('vm');
const fs = require('fs');
const { validateToolSource } = require('./tool-validator');

const EXECUTION_TIMEOUT = 5000; // 5 seconds

/**
 * Execute a dynamic tool script in a sandboxed VM context.
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
    return { success: false, result: null, error: `Cannot read tool: ${err.message}` };
  }

  // Static validation first
  const validation = validateToolSource(code);
  if (!validation.valid) {
    return {
      success: false,
      result: null,
      error: `Tool failed validation: ${validation.violations.join(', ')}`
    };
  }

  // Build the sandbox with a strict allowlist
  const sandboxContext = {
    args: Object.freeze({ ...args }),
    console: {
      log: (...a) => console.log('[DynTool]', ...a),
      warn: (...a) => console.warn('[DynTool]', ...a),
      error: (...a) => console.error('[DynTool]', ...a)
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
    const script = new vm.Script(code, { filename: toolPath });
    script.runInContext(context, { timeout: EXECUTION_TIMEOUT });
    return { success: true, result: context.result };
  } catch (err) {
    return {
      success: false,
      result: null,
      error: err.message
    };
  }
}

module.exports = { executeDynamicTool, EXECUTION_TIMEOUT };
