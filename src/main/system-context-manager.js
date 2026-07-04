/**
 * System Context Manager — Cognitive Substrate (Pillar 1, Phase 0)
 *
 * Provides structured, machine-readable self-awareness that is injected into
 * every LLM call as a compact system message. Phase 0 is intentionally
 * **read-only** and **non-breaking**:
 *
 *   - Grounded facts only. autoDetectEnvironment() derives values from the Node
 *     `os` module, `process`, package.json, and documented safety constants.
 *     It NEVER accepts raw LLM inference.
 *   - proposeUpdate() is a deliberate no-op in Phase 0 (logs a warning and
 *     returns a structured rejection). Full provenance + confidence gating
 *     arrives in Phase 1.
 *   - Persistence uses ATOMIC writes (tmp + rename) — an improvement over the
 *     direct writeFileSync used by memory-store.js, chosen to avoid partial /
 *     torn writes to ~/.liku/system-context.json.
 *
 * Schema: v1.1.2 core (flat dot-path). Phase 0 prefix groups:
 *   meta.*   env.*   hardware.*
 *   guard.tradingview.*  guard.fs.*  guard.net.*  guard.agents.*
 *   flags.*  reg.*
 *
 * Integration surface:
 *   - getInstance()               → shared singleton (one in-memory cache)
 *   - autoDetectEnvironment()     → grounded population at startup
 *   - toPromptFragment('structured') → system-prompt–injectable string
 *   - get(dotPath) / getAll()     → programmatic + CLI queries
 *   - proposeUpdate(...)          → read-only no-op in Phase 0
 *
 * Safety invariants (enforced here, verified by regression tests):
 *   1. Only grounded, deterministic sources may mutate state (Phase 0).
 *   2. Injected fragment stays comfortably under the 1,200 BPE hard cap.
 *   3. All persisted keys/values are sanitized (bounded, no functions/PII drift).
 *   4. Failure to read/write context is non-fatal — the caller degrades to the
 *      prior behavior (empty fragment), never throwing into the hot path.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { LIKU_HOME } = require('../shared/liku-home');

let countTokens;
try {
  // Reuse the same BPE tokenizer that governs the memory/skills budgets.
  ({ countTokens } = require('../shared/token-counter'));
} catch {
  // Extremely defensive: if the tokenizer is unavailable, fall back to a
  // conservative char/4 heuristic so token gating never throws in the hot path.
  countTokens = (text) => Math.ceil(String(text || '').length / 4);
}

// ─── Constants ──────────────────────────────────────────────

const SCHEMA_VERSION = '1.1.2';
const CONTEXT_FILE = path.join(LIKU_HOME, 'system-context.json');

/**
 * Hard budget for the injected fragment. The global system-message hard cap is
 * 1,200 BPE tokens; we stay comfortably below it so this context can never
 * crowd out memory, skills, or capability policy blocks.
 */
const SYSTEM_CONTEXT_TOKEN_BUDGET = 400;

/** Maximum characters retained for any single sanitized string value. */
const MAX_VALUE_LENGTH = 512;

/** Allowed dot-path key shape: prefix groups + alnum/underscore/dash segments. */
const KEY_PATTERN = /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9_-]+)+$/;

/**
 * Privacy: keys that are DETECTED and stored (useful for local CLI diagnostics)
 * but are NOT injected into the prompt fragment by default. Each entry maps to a
 * boolean flag key that, when true, opts the value back into the fragment.
 * Rationale: hostname can be sensitive on shared/enterprise machines and adds
 * little value to the cognitive substrate, so it is excluded from LLM context
 * unless explicitly enabled.
 */
const PROMPT_PRIVACY_GATES = Object.freeze({
  'env.hostname': 'flags.includeHostname'
});

/**
 * Phase 0 sources that are considered "grounded". proposeUpdate() (the public
 * mutation API) is NOT in this list — it is a read-only no-op until Phase 1.
 */
const GROUNDED_SOURCES = Object.freeze(['os', 'process', 'package', 'env', 'constant', 'system']);

const CONTEXT_VERBOSE = /^(1|true|yes)$/i.test(String(process.env.LIKU_SYSTEM_CONTEXT_VERBOSE || '').trim());

// ─── Sanitization (mirrors memory-store.js discipline) ──────

/**
 * Validate a dot-path key. Returns the trimmed key or null when invalid.
 * @param {string} key
 * @returns {string|null}
 */
function sanitizeKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed || trimmed.length > 128) return null;
  return KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Coerce an arbitrary value into a safe, bounded, JSON-serializable primitive.
 * Objects/functions are rejected (returns undefined) so only flat scalar facts
 * enter the store — matching the flat dot-path schema contract.
 * @param {*} value
 * @returns {string|number|boolean|undefined}
 */
function sanitizeValue(value) {
  if (value === null || value === undefined) return undefined;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : undefined;
  if (t === 'boolean') return value;
  if (t === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_VALUE_LENGTH ? trimmed.slice(0, MAX_VALUE_LENGTH) : trimmed;
  }
  // Reject objects, arrays, functions, symbols — flat scalars only in Phase 0.
  return undefined;
}

function nowIso() {
  return new Date().toISOString();
}

function verboseLog(...args) {
  if (CONTEXT_VERBOSE) console.log('[SystemContext]', ...args);
}

// ─── Grounded environment detection ─────────────────────────

/**
 * Read the app version from package.json without throwing.
 * @returns {string}
 */
function readAppVersion() {
  try {
    // src/main/system-context-manager.js → repo root is two levels up.
    const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));
    return sanitizeValue(pkg && pkg.version) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Build the flat map of grounded facts. Every value here is derived from a
 * deterministic, non-LLM source (os / process / package.json / env / documented
 * constant). This function does NOT touch disk.
 * @returns {Record<string, {value: (string|number|boolean), source: string}>}
 */
function detectGroundedFacts() {
  const facts = {};
  const put = (key, value, source) => {
    const safeKey = sanitizeKey(key);
    const safeValue = sanitizeValue(value);
    if (safeKey && safeValue !== undefined && GROUNDED_SOURCES.includes(source)) {
      facts[safeKey] = { value: safeValue, source };
    }
  };

  // meta.* — identity of the running agent build.
  put('meta.schemaVersion', SCHEMA_VERSION, 'constant');
  put('meta.appVersion', readAppVersion(), 'package');
  put('meta.detectedAt', nowIso(), 'system');

  // env.* — runtime/OS environment (grounded in os + process).
  put('env.platform', os.platform(), 'os');
  put('env.osType', os.type(), 'os');
  put('env.osRelease', os.release(), 'os');
  put('env.arch', os.arch(), 'os');
  put('env.nodeVersion', process.version, 'process');
  put('env.hostname', os.hostname(), 'os');
  put('env.electron', process.versions && process.versions.electron ? 'available' : 'headless', 'process');

  // hardware.* — coarse capability signal (grounded in os).
  try {
    const cpus = os.cpus() || [];
    put('hardware.cpuModel', cpus[0] && cpus[0].model, 'os');
    put('hardware.cpuCount', cpus.length, 'os');
  } catch { /* os.cpus can throw in constrained sandboxes; degrade silently */ }
  try {
    put('hardware.totalMemGB', Math.round((os.totalmem() / 1e9) * 10) / 10, 'os');
  } catch { /* non-fatal */ }

  // guard.* — documented safety posture (constants, NOT LLM inference).
  // These reflect invariants already enforced elsewhere in the codebase and are
  // surfaced read-only so the model is aware of its own rails.
  put('guard.tradingview.mode', 'advisory-observational', 'constant');
  put('guard.tradingview.orderEntry', 'disabled', 'constant');
  put('guard.fs.writeScope', 'liku-home-only', 'constant');
  put('guard.net.mode', 'read-only', 'constant');
  put('guard.agents.orchestration', 'handoff-driven', 'constant');

  // flags.* — deployment/runtime flags (grounded in env + constants).
  const traceDisabled = /^(1|true|yes)$/i.test(String(process.env.LIKU_DISABLE_RUNTIME_TRACE || '').trim());
  put('flags.runtimeTrace', traceDisabled ? 'disabled' : 'enabled', 'env');
  put('flags.phase', 'phase-0', 'constant');
  put('flags.readOnlyContext', true, 'constant');
  // Privacy opt-in: hostname is stored but excluded from the injected fragment
  // unless this flag is explicitly enabled (defaults to false).
  const includeHostname = /^(1|true|yes)$/i.test(String(process.env.LIKU_CONTEXT_INCLUDE_HOSTNAME || '').trim());
  put('flags.includeHostname', includeHostname, 'env');

  // reg.* — registry/location metadata for diagnostics.
  put('reg.homeDir', LIKU_HOME, 'system');
  put('reg.schema', SCHEMA_VERSION, 'constant');

  return facts;
}

// ─── Manager singleton ──────────────────────────────────────

class SystemContextManager {
  constructor() {
    /**
     * In-memory cache: flat dot-path → entry.
     * entry = { value, source, updatedAt }
     * (Phase 1 will extend entry with confidence + full provenance.)
     * @type {Record<string, {value: (string|number|boolean), source: string, updatedAt: string}>}
     */
    this._entries = {};
    this._schemaVersion = SCHEMA_VERSION;
    this._loaded = false;
    this._loadFromDisk();
  }

  // ── Persistence ──────────────────────────────────────────

  /**
   * Load context from ~/.liku/system-context.json. Corruption/absence is
   * non-fatal: we start from an empty (but valid) cache.
   * @private
   */
  _loadFromDisk() {
    try {
      if (fs.existsSync(CONTEXT_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
        if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
          for (const [key, entry] of Object.entries(raw.entries)) {
            const safeKey = sanitizeKey(key);
            const safeValue = entry && sanitizeValue(entry.value);
            if (safeKey && safeValue !== undefined) {
              this._entries[safeKey] = {
                value: safeValue,
                source: sanitizeValue(entry.source) || 'unknown',
                updatedAt: sanitizeValue(entry.updatedAt) || nowIso()
              };
            }
          }
          if (typeof raw.schemaVersion === 'string') {
            this._schemaVersion = sanitizeValue(raw.schemaVersion) || SCHEMA_VERSION;
          }
        }
      }
    } catch (err) {
      console.warn('[SystemContext] Failed to read context file:', err.message);
    }
    this._loaded = true;
  }

  /**
   * Persist the current cache atomically (tmp + rename). Never throws into the
   * caller — persistence failures degrade to an in-memory-only cache.
   * @private
   */
  _persist() {
    const payload = {
      schemaVersion: this._schemaVersion,
      updatedAt: nowIso(),
      entries: this._entries
    };
    try {
      if (!fs.existsSync(LIKU_HOME)) {
        fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
      }
      // Atomic write: write to a unique tmp file in the SAME directory (so
      // rename is atomic on the same filesystem), then rename over the target.
      const tmpFile = `${CONTEXT_FILE}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpFile, CONTEXT_FILE);
      verboseLog('persisted', Object.keys(this._entries).length, 'entries');
      return true;
    } catch (err) {
      console.warn('[SystemContext] Failed to persist context file:', err.message);
      return false;
    }
  }

  // ── Grounded mutation (internal only) ────────────────────

  /**
   * Grounded setter — the ONLY write path allowed in Phase 0. Values must come
   * from a whitelisted deterministic source (never LLM inference). Used by
   * autoDetectEnvironment(). Not exported directly.
   * @private
   * @param {string} key dot-path
   * @param {*} value scalar
   * @param {string} source one of GROUNDED_SOURCES
   * @returns {boolean} whether the write was applied
   */
  _setGrounded(key, value, source) {
    const safeKey = sanitizeKey(key);
    const safeValue = sanitizeValue(value);
    if (!safeKey || safeValue === undefined) return false;
    if (!GROUNDED_SOURCES.includes(source)) {
      console.warn(`[SystemContext] Rejected non-grounded source "${source}" for ${safeKey}`);
      return false;
    }
    this._entries[safeKey] = { value: safeValue, source, updatedAt: nowIso() };
    return true;
  }

  /**
   * Re-detect the environment from grounded sources and persist. Idempotent:
   * re-running simply refreshes deterministic facts. Safe to call at startup.
   * @returns {{updated: number, total: number}}
   */
  autoDetectEnvironment() {
    const facts = detectGroundedFacts();
    let updated = 0;
    for (const [key, { value, source }] of Object.entries(facts)) {
      if (this._setGrounded(key, value, source)) updated++;
    }
    this._persist();
    verboseLog('autoDetectEnvironment applied', updated, 'grounded facts');
    return { updated, total: Object.keys(this._entries).length };
  }

  // ── Read-only public mutation stub ───────────────────────

  /**
   * Phase 0 read-only no-op. In Phase 1 this becomes the provenance- and
   * confidence-gated update path for observed (non-deterministic) signals.
   * Today it intentionally does nothing except warn — so callers can be wired
   * now without ever mutating grounded state from unverified inputs.
   * @param {string} key dot-path
   * @param {*} value proposed value
   * @param {object} [opts]
   * @returns {{accepted: false, reason: string, phase: string}}
   */
  proposeUpdate(key, value, opts = {}) {
    const safeKey = sanitizeKey(key) || String(key || '').slice(0, 128);
    console.warn(`[SystemContext] proposeUpdate("${safeKey}") ignored — read-only in Phase 0 (provenance/confidence gating lands in Phase 1).`);
    return { accepted: false, reason: 'read-only-phase-0', phase: 'phase-0' };
  }

  // ── Queries ──────────────────────────────────────────────

  /**
   * Get a single fact value by dot-path.
   * @param {string} key
   * @returns {(string|number|boolean|undefined)}
   */
  get(key) {
    const safeKey = sanitizeKey(key);
    const entry = safeKey ? this._entries[safeKey] : null;
    return entry ? entry.value : undefined;
  }

  /**
   * Get the full entry (value + source + updatedAt) for a dot-path.
   * @param {string} key
   * @returns {object|null}
   */
  getEntry(key) {
    const safeKey = sanitizeKey(key);
    return safeKey && this._entries[safeKey] ? { ...this._entries[safeKey] } : null;
  }

  /**
   * Get a flat snapshot of all fact values (key → value).
   * @returns {Record<string, (string|number|boolean)>}
   */
  getAll() {
    const out = {};
    for (const [key, entry] of Object.entries(this._entries)) {
      out[key] = entry.value;
    }
    return out;
  }

  /**
   * Full serializable snapshot including metadata — used by CLI --json.
   * @returns {object}
   */
  toJSON() {
    return {
      schemaVersion: this._schemaVersion,
      contextFile: CONTEXT_FILE,
      tokenBudget: SYSTEM_CONTEXT_TOKEN_BUDGET,
      entries: JSON.parse(JSON.stringify(this._entries))
    };
  }

  // ── Prompt fragment ──────────────────────────────────────

  /**
   * Render the context as a system-prompt–injectable string, grouped by prefix.
   * Guaranteed to stay within SYSTEM_CONTEXT_TOKEN_BUDGET (well under the global
   * 1,200 BPE cap): if the rendered fragment exceeds the budget, lower-priority
   * groups are dropped rather than mid-line truncation.
   *
   * Privacy: keys in PROMPT_PRIVACY_GATES (e.g. env.hostname) are omitted unless
   * their opt-in flag is explicitly enabled (defaults off).
   *
   * @param {'structured'} [format] Phase 0 supports 'structured' only.
   *   (Phase 1 will add 'compact' / 'flat-kv' + selective injection.)
   * @returns {string}
   */
  toPromptFragment(format = 'structured') {
    const keys = Object.keys(this._entries);
    if (!keys.length) return '';

    // Priority order controls which groups survive if the budget is tight.
    const groupOrder = ['meta', 'env', 'hardware', 'guard', 'flags', 'reg'];
    const grouped = {};
    for (const key of keys.sort()) {
      // Privacy gate: skip keys that are stored-but-not-injected unless their
      // opt-in flag is explicitly true (e.g. env.hostname → flags.includeHostname).
      const gateFlag = PROMPT_PRIVACY_GATES[key];
      if (gateFlag) {
        const gateEntry = this._entries[gateFlag];
        const enabled = gateEntry && (gateEntry.value === true || gateEntry.value === 'true');
        if (!enabled) continue;
      }
      const group = key.split('.')[0];
      (grouped[group] = grouped[group] || []).push(`${key}=${this._entries[key].value}`);
    }

    const header = '## System Self-Awareness (read-only, grounded)';
    const orderedGroups = [
      ...groupOrder.filter((g) => grouped[g]),
      ...Object.keys(grouped).filter((g) => !groupOrder.includes(g))
    ];

    // Build incrementally, dropping trailing groups that would exceed budget.
    const lines = [header];
    for (const group of orderedGroups) {
      const candidate = [...lines, `- ${group}: ${grouped[group].join('; ')}`].join('\n');
      if (countTokens(candidate) > SYSTEM_CONTEXT_TOKEN_BUDGET) {
        verboseLog(`token budget reached; dropping group "${group}" and beyond`);
        break;
      }
      lines.push(`- ${group}: ${grouped[group].join('; ')}`);
    }

    // Only the header survived → nothing useful to inject.
    if (lines.length <= 1) return '';
    return lines.join('\n');
  }

  /**
   * Number of BPE tokens the current fragment would consume — for validation.
   * @param {string} [format]
   * @returns {number}
   */
  getFragmentTokenCount(format = 'structured') {
    return countTokens(this.toPromptFragment(format));
  }

  /** Introspection helpers. */
  get schemaVersion() { return this._schemaVersion; }
  get contextFile() { return CONTEXT_FILE; }
  get tokenBudget() { return SYSTEM_CONTEXT_TOKEN_BUDGET; }
}

// ─── Singleton wiring ───────────────────────────────────────

let _instance = null;

/**
 * Return the shared SystemContextManager. All code paths (CLI, Electron, tests)
 * share one in-memory cache so reads/writes are consistent within a process.
 * @returns {SystemContextManager}
 */
function getInstance() {
  if (!_instance) {
    _instance = new SystemContextManager();
  }
  return _instance;
}

/**
 * Convenience: run grounded auto-detection on the shared instance. Safe to call
 * at startup; non-fatal on failure.
 * @returns {{updated: number, total: number}|null}
 */
function autoDetectEnvironment() {
  try {
    return getInstance().autoDetectEnvironment();
  } catch (err) {
    console.warn('[SystemContext] autoDetectEnvironment failed:', err.message);
    return null;
  }
}

/**
 * Convenience: the prompt fragment for the shared instance. Never throws.
 * @param {string} [format]
 * @returns {string}
 */
function toPromptFragment(format = 'structured') {
  try {
    return getInstance().toPromptFragment(format);
  } catch (err) {
    console.warn('[SystemContext] toPromptFragment failed:', err.message);
    return '';
  }
}

module.exports = {
  SystemContextManager,
  getInstance,
  autoDetectEnvironment,
  toPromptFragment,
  SCHEMA_VERSION,
  SYSTEM_CONTEXT_TOKEN_BUDGET,
  CONTEXT_FILE
};
