/**
 * liku system-context — Inspect the Cognitive Substrate self-awareness store
 *
 * Phase 0 is read-only. This command surfaces the grounded environment context
 * that is injected into every LLM call, so it can be validated without touching
 * the model.
 *
 * Usage:
 *   liku system-context                 Show grounded facts (structured view)
 *   liku system-context show            Same as above
 *   liku system-context get <dot.path>  Print one fact value
 *   liku system-context fragment        Print the exact injected prompt fragment
 *   liku system-context refresh         Re-run grounded auto-detection + persist
 *   liku system-context json            Full serializable snapshot (metadata)
 *
 * Flags:
 *   --json    Machine-readable output for scripting
 */

const { log, success, error, dim, highlight } = require('../util/output');

function getManager() {
  return require('../../main/system-context-manager');
}

async function run(args, flags) {
  const subcommand = (args[0] || 'show').toLowerCase();
  const mgr = getManager().getInstance();

  switch (subcommand) {
    case 'show': {
      const all = mgr.getAll();
      const keys = Object.keys(all);
      if (flags.json) {
        return { success: true, schemaVersion: mgr.schemaVersion, count: keys.length, context: all };
      }
      if (!keys.length) {
        log('No system context populated yet. Run: liku system-context refresh');
        return { success: true, count: 0 };
      }
      log(highlight(`System Self-Awareness (schema ${mgr.schemaVersion}, ${keys.length} facts):`));
      for (const key of keys.sort()) {
        const entry = mgr.getEntry(key);
        log(`  ${highlight(key)} = ${all[key]} ${dim(`[${entry ? entry.source : 'unknown'}]`)}`);
      }
      log(dim(`\nInjected fragment: ~${mgr.getFragmentTokenCount()} BPE tokens (budget ${mgr.tokenBudget}).`));
      return { success: true, count: keys.length };
    }

    case 'get': {
      const key = args[1];
      if (!key) { error('Usage: liku system-context get <dot.path>'); return { success: false }; }
      const value = mgr.get(key);
      if (value === undefined) {
        if (flags.json) return { success: false, key, value: null };
        error(`No fact for key: ${key}`);
        return { success: false };
      }
      if (flags.json) return { success: true, key, value };
      log(String(value));
      return { success: true, key, value };
    }

    case 'fragment': {
      const fragment = mgr.toPromptFragment('structured');
      const tokens = mgr.getFragmentTokenCount('structured');
      if (flags.json) return { success: true, fragment, tokens, budget: mgr.tokenBudget };
      if (!fragment) {
        log('Fragment is empty. Run: liku system-context refresh');
        return { success: true, fragment: '', tokens: 0 };
      }
      log(fragment);
      log(dim(`\n(${tokens} BPE tokens / budget ${mgr.tokenBudget})`));
      return { success: true, fragment, tokens };
    }

    case 'refresh': {
      const result = mgr.autoDetectEnvironment();
      if (flags.json) return { success: true, ...result, schemaVersion: mgr.schemaVersion };
      success(`Refreshed ${result.updated} grounded facts (${result.total} total).`);
      log(dim(`Persisted to: ${mgr.contextFile}`));
      return { success: true, ...result };
    }

    case 'json': {
      const snapshot = mgr.toJSON();
      if (flags.json) return { success: true, ...snapshot };
      log(JSON.stringify(snapshot, null, 2));
      return { success: true, snapshot };
    }

    default:
      error(`Unknown subcommand: ${subcommand}`);
      log('Usage: liku system-context [show|get <path>|fragment|refresh|json]');
      return { success: false };
  }
}

module.exports = { run };
