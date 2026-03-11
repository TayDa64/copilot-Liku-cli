/**
 * Tool Registry — CRUD for dynamic tool registration
 *
 * Manages ~/.liku/tools/registry.json and provides lookup for dynamic
 * tools that can be appended to LIKU_TOOLS at runtime.
 *
 * Rollout phases:
 *   3a: Sandbox execution + static validation (current)
 *   3b: AI proposes tools, requires user approval before registration
 *   3c: Auto-registration for validated + hook-approved tools (future)
 */

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { validateToolSource } = require('./tool-validator');

const TOOLS_DIR = path.join(LIKU_HOME, 'tools');
const DYNAMIC_DIR = path.join(TOOLS_DIR, 'dynamic');
const REGISTRY_FILE = path.join(TOOLS_DIR, 'registry.json');

// ─── Registry I/O ───────────────────────────────────────────

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.warn('[ToolRegistry] Failed to read registry:', err.message);
  }
  return { tools: {} };
}

function saveRegistry(registry) {
  if (!fs.existsSync(TOOLS_DIR)) {
    fs.mkdirSync(TOOLS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Register a new dynamic tool.
 *
 * @param {string} name - Tool name (alphanumeric + hyphens only)
 * @param {object} opts
 * @param {string} opts.code - Tool source code
 * @param {string} opts.description - What the tool does
 * @param {object} opts.parameters - Parameter definitions { name: type }
 * @returns {{ success: boolean, error?: string }}
 */
function registerTool(name, { code, description, parameters }) {
  // Validate name
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { success: false, error: 'Tool name must be lowercase alphanumeric with hyphens' };
  }

  // Validate source
  const validation = validateToolSource(code);
  if (!validation.valid) {
    return { success: false, error: `Validation failed: ${validation.violations.join(', ')}` };
  }

  // Write tool file
  if (!fs.existsSync(DYNAMIC_DIR)) {
    fs.mkdirSync(DYNAMIC_DIR, { recursive: true, mode: 0o700 });
  }
  const toolFile = `${name}.js`;
  const toolPath = path.join(DYNAMIC_DIR, toolFile);
  fs.writeFileSync(toolPath, code, 'utf-8');

  // Update registry
  const registry = loadRegistry();
  registry.tools[name] = {
    file: `dynamic/${toolFile}`,
    description: description || '',
    parameters: parameters || {},
    createdBy: 'ai',
    createdAt: new Date().toISOString(),
    invocations: 0,
    lastInvokedAt: null
  };
  saveRegistry(registry);

  return { success: true };
}

/**
 * Remove a dynamic tool from the registry and optionally delete the file.
 */
function unregisterTool(name, deleteFile) {
  const registry = loadRegistry();
  if (!registry.tools[name]) {
    return { success: false, error: 'Tool not found' };
  }

  if (deleteFile) {
    const toolPath = path.join(TOOLS_DIR, registry.tools[name].file);
    try {
      if (fs.existsSync(toolPath)) fs.unlinkSync(toolPath);
    } catch (err) {
      console.warn(`[ToolRegistry] Failed to delete tool file: ${err.message}`);
    }
  }

  delete registry.tools[name];
  saveRegistry(registry);
  return { success: true };
}

/**
 * Look up a tool by name.
 * @returns {{ entry: object, absolutePath: string } | null}
 */
function lookupTool(name) {
  const registry = loadRegistry();
  const entry = registry.tools[name];
  if (!entry) return null;

  return {
    entry,
    absolutePath: path.join(TOOLS_DIR, entry.file)
  };
}

/**
 * Record a tool invocation (updates stats).
 */
function recordInvocation(name) {
  const registry = loadRegistry();
  if (registry.tools[name]) {
    registry.tools[name].invocations = (registry.tools[name].invocations || 0) + 1;
    registry.tools[name].lastInvokedAt = new Date().toISOString();
    saveRegistry(registry);
  }
}

/**
 * List all registered dynamic tools.
 */
function listTools() {
  return loadRegistry().tools;
}

/**
 * Get tool definitions in the format expected by LIKU_TOOLS for API calls.
 * These get appended to the static tool set at runtime.
 *
 * @returns {object[]} Array of tool function definitions
 */
function getDynamicToolDefinitions() {
  const registry = loadRegistry();
  return Object.entries(registry.tools).map(([name, entry]) => ({
    type: 'function',
    function: {
      name: `dynamic_${name}`,
      description: entry.description || `Dynamic tool: ${name}`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(entry.parameters || {}).map(([pName, pType]) => [
            pName,
            { type: pType, description: pName }
          ])
        ),
        required: Object.keys(entry.parameters || {})
      }
    }
  }));
}

module.exports = {
  registerTool,
  unregisterTool,
  lookupTool,
  recordInvocation,
  listTools,
  getDynamicToolDefinitions,
  TOOLS_DIR,
  DYNAMIC_DIR,
  REGISTRY_FILE
};
