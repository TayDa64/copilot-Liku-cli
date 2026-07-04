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
 *   liku system-context fragment [fmt]  Print injected fragment (structured|compact|flat-kv)
 *   liku system-context diff [key]      Show the most recent change(s) w/ provenance
 *   liku system-context pending         List sub-threshold updates awaiting confirmation
 *   liku system-context confirm <key>   Preview a pending update (add --apply or --reject)
 *   liku system-context refresh         Re-run grounded auto-detection + persist
 *   liku system-context json            Full serializable snapshot (metadata)
 *
 * Flags:
 *   --json    Machine-readable output for scripting
 *   --limit N Number of changes to show for `diff` (default 5)
 *   --apply   Apply a pending update (with `confirm`)
 *   --reject  Reject/discard a pending update (with `confirm`)
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
      const fmt = ['structured', 'compact', 'flat-kv'].includes(String(args[1] || '').toLowerCase())
        ? String(args[1]).toLowerCase() : 'structured';
      const fragment = mgr.toPromptFragment(fmt);
      const tokens = mgr.getFragmentTokenCount(fmt);
      if (flags.json) return { success: true, format: fmt, fragment, tokens, budget: mgr.tokenBudget };
      if (!fragment) {
        log('Fragment is empty. Run: liku system-context refresh');
        return { success: true, fragment: '', tokens: 0 };
      }
      log(fragment);
      log(dim(`\n(${fmt} — ${tokens} BPE tokens / budget ${mgr.tokenBudget})`));
      return { success: true, format: fmt, fragment, tokens };
    }

    case 'diff': {
      const key = args[1] || null;
      const limit = Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 5;
      const changes = mgr.getChanges(limit, key);
      if (flags.json) return { success: true, key: key || null, count: changes.length, changes };
      if (!changes.length) {
        log(key ? `No recorded changes for key: ${key}` : 'No recorded context changes yet.');
        return { success: true, count: 0 };
      }
      log(highlight(`System Context Changes${key ? ` for ${key}` : ''} (most recent first):`));
      for (const c of changes) {
        const oldV = c.oldValue === undefined ? '(none)' : c.oldValue;
        log(`  ${highlight(c.key)}: ${dim(String(oldV))} → ${c.newValue}`);
        log(dim(`    ${c.ts}  source=${c.source} confidence=${c.confidence}`));
      }
      return { success: true, count: changes.length };
    }

    case 'refresh': {
      const result = mgr.autoDetectEnvironment();
      if (flags.json) return { success: true, ...result, schemaVersion: mgr.schemaVersion };
      success(`Refreshed ${result.updated} grounded facts (${result.total} total).`);
      log(dim(`Persisted to: ${mgr.contextFile}`));
      return { success: true, ...result };
    }

    case 'record-regression': {
      // CI / test-runner evidence entry point (Phase 3). Example:
      //   liku system-context record-regression pass --lang js --quality 1
      const status = args[1];
      if (!status) { error('Usage: liku system-context record-regression <pass|fail> [--lang js] [--quality N]'); return { success: false }; }
      const store = getManager();
      const res = store.recordRegressionOutcome(status, {
        lang: flags.lang || 'js',
        quality: flags.quality !== undefined ? Number(flags.quality) : (status === 'pass' ? 1 : 0),
        detail: flags.detail
      });
      if (flags.json) return { success: !!res.accepted, ...res };
      if (res.accepted) success(`Recorded regression outcome: ${status} (lang=${flags.lang || 'js'}).`);
      else error(`Regression outcome not applied: ${res.reason || 'gated'}`);
      return { success: !!res.accepted, ...res };
    }

    case 'pending': {
      const items = mgr.getPendingUpdates();
      if (flags.json) return { success: true, count: items.length, pending: items };
      if (!items.length) {
        log('No pending updates awaiting confirmation.');
        return { success: true, count: 0 };
      }
      log(highlight(`Pending updates (${items.length}) — confirm with: liku system-context confirm <key> --apply|--reject`));
      for (const p of items) {
        log(`  ${highlight(p.key)} = ${p.value} ${dim(`[${p.source} conf=${p.confidence} < ${p.threshold}]`)}`);
        log(dim(`    id=${p.id} queuedAt=${p.queuedAt}${p.expiresAt ? ` expiresAt=${p.expiresAt}` : ''}`));
      }
      return { success: true, count: items.length };
    }

    case 'confirm': {
      const keyOrId = args[1];
      if (!keyOrId) { error('Usage: liku system-context confirm <key|id> [--apply|--reject]'); return { success: false }; }
      const matches = mgr.getPending(keyOrId);
      if (!matches.length) {
        if (flags.json) return { success: false, reason: 'not-found', key: keyOrId };
        error(`No pending update found for: ${keyOrId}`);
        return { success: false };
      }
      // Preview mode (no --apply/--reject): show the proposed change + provenance.
      if (!flags.apply && !flags.reject) {
        if (flags.json) return { success: true, preview: true, pending: matches };
        log(highlight(`Pending update for ${keyOrId} (${matches.length}):`));
        for (const p of matches) {
          const current = mgr.get(p.key);
          log(`  ${highlight(p.key)}: ${dim(current === undefined ? '(none)' : String(current))} → ${p.value}`);
          log(dim(`    source=${p.source} confidence=${p.confidence} threshold=${p.threshold} queuedAt=${p.queuedAt}`));
        }
        log(dim('\nRe-run with --apply to accept or --reject to discard.'));
        return { success: true, preview: true };
      }
      const action = flags.reject ? 'reject' : 'apply';
      const res = mgr.confirmPending(keyOrId, action);
      if (flags.json) return { success: !!res.ok, ...res };
      if (!res.ok) { error(`Confirm failed: ${res.reason}`); return { success: false, ...res }; }
      if (action === 'apply') {
        success(`Applied ${res.key} = ${res.applied ? res.applied.value : ''} (from pending).`);
      } else {
        success(`Rejected pending update for ${res.key}.`);
      }
      return { success: true, ...res };
    }

    case 'json': {
      const snapshot = mgr.toJSON();
      if (flags.json) return { success: true, ...snapshot };
      log(JSON.stringify(snapshot, null, 2));
      return { success: true, snapshot };
    }

    default:
      error(`Unknown subcommand: ${subcommand}`);
      log('Usage: liku system-context [show|get <path>|fragment [fmt]|diff [key]|pending|confirm <key> [--apply|--reject]|record-regression <status>|refresh|json]');
      return { success: false };
  }
}

module.exports = { run };
