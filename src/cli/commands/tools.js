/**
 * liku tools — Manage the dynamic tool registry
 *
 * Usage:
 *   liku tools list              List all registered dynamic tools
 *   liku tools show <name>       Show tool details
 *   liku tools approve <name>    Approve a tool for execution
 *   liku tools revoke <name>     Revoke tool approval
 */

const { log, success, error, dim, highlight } = require('../util/output');

function getToolRegistry() {
  return require('../../main/tools/tool-registry');
}

async function run(args, flags) {
  const subcommand = args[0] || 'list';
  const registry = getToolRegistry();

  switch (subcommand) {
    case 'list': {
      const tools = registry.listTools();
      const entries = Object.entries(tools);
      if (entries.length === 0) {
        log('No dynamic tools registered.');
        return { success: true, count: 0 };
      }
      if (flags.json) return { success: true, count: entries.length, tools };
      log(highlight(`Dynamic Tools (${entries.length}):`));
      for (const [name, entry] of entries) {
        const status = entry.approved ? '✓ approved' : '✗ pending';
        log(`  ${highlight(name)} — ${entry.description || 'no description'} ${dim(`[${status}]`)}`);
        if (entry.invocationCount) log(`    ${dim(`Invoked ${entry.invocationCount} time(s)`)}`);
      }
      return { success: true, count: entries.length };
    }

    case 'show': {
      const name = args[1];
      if (!name) { error('Usage: liku tools show <name>'); return { success: false }; }
      const lookup = registry.lookupTool(name);
      if (!lookup) { error(`Tool not found: ${name}`); return { success: false }; }
      if (flags.json) return { success: true, name, entry: lookup.entry };
      log(highlight(`Tool: ${name}`));
      log(`  Description: ${lookup.entry.description || 'none'}`);
      log(`  Approved: ${lookup.entry.approved ? 'yes' : 'no'}`);
      log(`  Parameters: ${JSON.stringify(lookup.entry.parameters || {})}`);
      log(`  Invocations: ${lookup.entry.invocationCount || 0}`);
      log(`  Path: ${lookup.absolutePath}`);
      return { success: true, name, entry: lookup.entry };
    }

    case 'approve': {
      const name = args[1];
      if (!name) { error('Usage: liku tools approve <name>'); return { success: false }; }
      const result = registry.approveTool(name);
      if (result) {
        success(`Tool '${name}' approved.`);
      } else {
        error(`Tool not found: ${name}`);
      }
      return { success: !!result };
    }

    case 'revoke': {
      const name = args[1];
      if (!name) { error('Usage: liku tools revoke <name>'); return { success: false }; }
      const result = registry.revokeTool(name);
      if (result) {
        success(`Tool '${name}' approval revoked.`);
      } else {
        error(`Tool not found: ${name}`);
      }
      return { success: !!result };
    }

    default:
      error(`Unknown subcommand: ${subcommand}`);
      log('Usage: liku tools [list|show|approve|revoke]');
      return { success: false };
  }
}

module.exports = { run };
