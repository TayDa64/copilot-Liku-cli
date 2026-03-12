/**
 * liku tools — Manage the dynamic tool registry
 *
 * Usage:
 *   liku tools list              List all registered dynamic tools
 *   liku tools proposals         List pending tool proposals
 *   liku tools show <name>       Show tool details
 *   liku tools approve <name>    Approve/promote a tool for execution
 *   liku tools reject <name>     Reject a proposed tool
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
        const status = entry.status === 'proposed' ? '? proposed' : (entry.approved ? '✓ approved' : '✗ revoked');
        log(`  ${highlight(name)} — ${entry.description || 'no description'} ${dim(`[${status}]`)}`);
        if (entry.invocations) log(`    ${dim(`Invoked ${entry.invocations} time(s)`)}`);
      }
      return { success: true, count: entries.length };
    }

    case 'proposals': {
      const proposals = registry.listProposals();
      const entries = Object.entries(proposals);
      if (entries.length === 0) {
        log('No pending tool proposals.');
        return { success: true, count: 0 };
      }
      if (flags.json) return { success: true, count: entries.length, proposals };
      log(highlight(`Pending Proposals (${entries.length}):`));
      for (const [name, entry] of entries) {
        log(`  ${highlight(name)} — ${entry.description || 'no description'} ${dim(`[proposed ${entry.createdAt || ''}]`)}`);
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
      log(`  Status: ${lookup.entry.status || 'active'}`);
      log(`  Approved: ${lookup.entry.approved ? 'yes' : 'no'}`);
      log(`  Parameters: ${JSON.stringify(lookup.entry.parameters || {})}`);
      log(`  Invocations: ${lookup.entry.invocations || 0}`);
      log(`  Path: ${lookup.absolutePath}`);
      return { success: true, name, entry: lookup.entry };
    }

    case 'approve': {
      const name = args[1];
      if (!name) { error('Usage: liku tools approve <name>'); return { success: false }; }
      const result = registry.approveTool(name);
      if (result.success) {
        success(`Tool '${name}' approved and promoted.`);
      } else {
        error(result.error || `Tool not found: ${name}`);
      }
      return { success: result.success };
    }

    case 'reject': {
      const name = args[1];
      if (!name) { error('Usage: liku tools reject <name>'); return { success: false }; }
      const result = registry.rejectTool(name);
      if (result.success) {
        success(`Tool '${name}' rejected and removed.`);
      } else {
        error(result.error || `Tool not found: ${name}`);
      }
      return { success: result.success };
    }

    case 'revoke': {
      const name = args[1];
      if (!name) { error('Usage: liku tools revoke <name>'); return { success: false }; }
      const result = registry.revokeTool(name);
      if (result.success) {
        success(`Tool '${name}' approval revoked.`);
      } else {
        error(result.error || `Tool not found: ${name}`);
      }
      return { success: result.success };
    }

    default:
      error(`Unknown subcommand: ${subcommand}`);
      log('Usage: liku tools [list|proposals|show|approve|reject|revoke]');
      return { success: false };
  }
}

module.exports = { run };
