/**
 * Tool Registry — CRUD for dynamic tool registration
 *
 * Manages ~/.liku/tools/registry.json and provides lookup for dynamic
 * tools that can be appended to LIKU_TOOLS at runtime.
 *
 * Rollout phases:
 *   3a: Sandbox execution + static validation
 *   3b: AI proposes tools → quarantine in proposed/ → user approval → promote to dynamic/
 *   3c: Auto-registration for validated + hook-approved tools (future)
 */

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { validateToolSource } = require('./tool-validator');
const { writeTelemetry } = require('../telemetry/telemetry-writer');

const TOOLS_DIR = path.join(LIKU_HOME, 'tools');
const DYNAMIC_DIR = path.join(TOOLS_DIR, 'dynamic');
const PROPOSED_DIR = path.join(TOOLS_DIR, 'proposed');
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
 * Propose a new dynamic tool (Phase 3b — quarantine stage).
 * Tool code is written to ~/.liku/tools/proposed/ and indexed as status:'proposed'.
 * The tool CANNOT be executed until approved via approveTool().
 *
 * @param {string} name - Tool name (alphanumeric + hyphens only)
 * @param {object} opts
 * @param {string} opts.code - Tool source code
 * @param {string} opts.description - What the tool does
 * @param {object} opts.parameters - Parameter definitions { name: type }
 * @returns {{ success: boolean, error?: string, proposalPath?: string }}
 */
function proposeTool(name, { code, description, parameters }) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { success: false, error: 'Tool name must be lowercase alphanumeric with hyphens' };
  }

  const validation = validateToolSource(code);
  if (!validation.valid) {
    return { success: false, error: `Validation failed: ${validation.violations.join(', ')}` };
  }

  // Write to quarantine (proposed/) — NOT dynamic/
  if (!fs.existsSync(PROPOSED_DIR)) {
    fs.mkdirSync(PROPOSED_DIR, { recursive: true, mode: 0o700 });
  }
  const toolFile = `${name}.js`;
  const proposalPath = path.join(PROPOSED_DIR, toolFile);
  fs.writeFileSync(proposalPath, code, 'utf-8');

  // Index with status:'proposed' — tool is NOT executable
  const registry = loadRegistry();
  registry.tools[name] = {
    file: `proposed/${toolFile}`,
    description: description || '',
    parameters: parameters || {},
    createdBy: 'ai',
    createdAt: new Date().toISOString(),
    approved: false,
    status: 'proposed',
    invocations: 0,
    lastInvokedAt: null
  };
  saveRegistry(registry);

  writeTelemetry({
    task: `tool_proposal:${name}`,
    phase: 'execution',
    outcome: 'success',
    context: { event: 'tool_proposed', name, description }
  });

  return { success: true, proposalPath };
}

/**
 * Promote a proposed tool from quarantine to the active registry.
 * Moves the file from proposed/ to dynamic/ and marks the tool as approved.
 *
 * @param {string} name - Tool name to promote
 * @returns {{ success: boolean, error?: string }}
 */
function promoteTool(name) {
  const registry = loadRegistry();
  const entry = registry.tools[name];
  if (!entry) return { success: false, error: 'Tool not found' };
  if (entry.status !== 'proposed') return { success: false, error: `Tool status is '${entry.status}', not 'proposed'` };

  const sourceFile = `${name}.js`;
  const sourcePath = path.join(PROPOSED_DIR, sourceFile);
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Proposed file not found: ${sourcePath}` };
  }

  // Move from proposed/ to dynamic/
  if (!fs.existsSync(DYNAMIC_DIR)) {
    fs.mkdirSync(DYNAMIC_DIR, { recursive: true, mode: 0o700 });
  }
  const destPath = path.join(DYNAMIC_DIR, sourceFile);
  fs.copyFileSync(sourcePath, destPath);
  fs.unlinkSync(sourcePath);

  // Update registry
  entry.file = `dynamic/${sourceFile}`;
  entry.status = 'active';
  entry.approved = true;
  entry.approvedAt = new Date().toISOString();
  saveRegistry(registry);

  writeTelemetry({
    task: `tool_promotion:${name}`,
    phase: 'execution',
    outcome: 'success',
    context: { event: 'tool_promoted', name }
  });

  return { success: true };
}

/**
 * Reject a proposed tool — deletes the quarantined file and logs a negative reward.
 *
 * @param {string} name - Tool name to reject
 * @returns {{ success: boolean, error?: string }}
 */
function rejectTool(name) {
  const registry = loadRegistry();
  const entry = registry.tools[name];
  if (!entry) return { success: false, error: 'Tool not found' };
  if (entry.status !== 'proposed') return { success: false, error: `Tool status is '${entry.status}', not 'proposed'` };

  const sourcePath = path.join(PROPOSED_DIR, `${name}.js`);
  try {
    if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
  } catch (err) {
    console.warn(`[ToolRegistry] Failed to delete proposed file: ${err.message}`);
  }

  delete registry.tools[name];
  saveRegistry(registry);

  writeTelemetry({
    task: `tool_rejection:${name}`,
    phase: 'execution',
    outcome: 'failure',
    context: { event: 'tool_rejected', name, reason: 'user_rejected' }
  });

  return { success: true };
}

/**
 * List pending tool proposals (status:'proposed').
 * @returns {object} Map of name → entry for proposed tools
 */
function listProposals() {
  const registry = loadRegistry();
  const proposals = {};
  for (const [name, entry] of Object.entries(registry.tools)) {
    if (entry.status === 'proposed') proposals[name] = entry;
  }
  return proposals;
}

/**
 * Register a new dynamic tool (legacy convenience — calls proposeTool internally).
 * Tool starts in 'proposed' status. Use promoteTool() or approveTool() to activate.
 */
function registerTool(name, { code, description, parameters }) {
  return proposeTool(name, { code, description, parameters });
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
 * Approve a dynamic tool for execution (Phase 3b gate).
 * If the tool is in 'proposed' status, promotes it first (moves to dynamic/).
 */
function approveTool(name) {
  const registry = loadRegistry();
  if (!registry.tools[name]) {
    return { success: false, error: 'Tool not found' };
  }
  // If proposed, promote first
  if (registry.tools[name].status === 'proposed') {
    const promoteResult = promoteTool(name);
    if (!promoteResult.success) return promoteResult;
    return { success: true };
  }
  registry.tools[name].approved = true;
  registry.tools[name].approvedAt = new Date().toISOString();
  saveRegistry(registry);
  return { success: true };
}

/**
 * Revoke approval for a dynamic tool.
 */
function revokeTool(name) {
  const registry = loadRegistry();
  if (!registry.tools[name]) {
    return { success: false, error: 'Tool not found' };
  }
  registry.tools[name].approved = false;
  saveRegistry(registry);
  return { success: true };
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
  return Object.entries(registry.tools)
    .filter(([, entry]) => entry.approved)
    .map(([name, entry]) => ({
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
  proposeTool,
  promoteTool,
  rejectTool,
  listProposals,
  registerTool,
  unregisterTool,
  lookupTool,
  approveTool,
  revokeTool,
  recordInvocation,
  listTools,
  getDynamicToolDefinitions,
  TOOLS_DIR,
  DYNAMIC_DIR,
  PROPOSED_DIR,
  REGISTRY_FILE
};
