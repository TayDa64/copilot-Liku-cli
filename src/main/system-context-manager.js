/**
 * System Context Manager — Cognitive Substrate (Pillar 1, Phase 1)
 *
 * Provides structured, machine-readable self-awareness that is injected into
 * every LLM call as a compact system message. Phase 1 makes the substrate
 * **self-updating on evidence** (never on raw LLM inference) while keeping the
 * Phase 0 safety posture intact:
 *
 *   - Grounded facts only. autoDetectEnvironment() derives values from the Node
 *     `os` module, `process`, package.json, and documented safety constants.
 *   - proposeUpdate(delta, options) is now ACTIVE but strictly gated: updates
 *     must carry a TRUSTED source + confidence. High-risk keys (guard.*) require
 *     a higher confidence bar. Low-confidence updates are queued (or rejected in
 *     strict mode); untrusted/LLM-inference sources are always rejected.
 *   - Every applied update records provenance (source, confidence, observedAt,
 *     optional ttl/expiry) and appends an auditable change to a rolling history
 *     under ~/.liku/system-context.history/.
 *   - Persistence uses ATOMIC writes (tmp + rename) to avoid torn files.
 *
 * Rendering (Phase 1):
 *   - toPromptFragment(format, options) supports 'structured' | 'compact' |
 *     'flat-kv'. Default (no options) is byte-identical to Phase 0 'structured'.
 *   - Selective injection: expensive contextual sections (e.g. guard.tradingview.*)
 *     are only injected when the current query/foreground indicates relevance.
 *
 * Schema: v1.2.0 core (flat dot-path). Prefix groups:
 *   meta.*   env.*   hardware.*
 *   guard.tradingview.*  guard.fs.*  guard.net.*  guard.agents.*
 *   flags.*  reg.*  cap.*
 *
 * Integration surface:
 *   - getInstance()                       → shared singleton (one in-memory cache)
 *   - autoDetectEnvironment()             → grounded population at startup
 *   - toPromptFragment(format, options)   → system-prompt–injectable string
 *   - get(dotPath) / getAll() / getSection(prefix) → queries
 *   - proposeUpdate(delta, options)       → evidence-gated, provenance-tracked
 *   - recordReflectionQuality(q, opts)    → example self-update extension point
 *   - getChanges(limit) / getLastChange(key) → auditability
 *
 * Safety invariants (enforced here, verified by regression tests):
 *   1. Only trusted, grounded/evidence sources may mutate state. Raw LLM
 *      inference can NEVER mutate the substrate.
 *   2. High-risk (guard.*) keys require elevated confidence to change.
 *   3. Injected fragment stays comfortably under the 1,200 BPE hard cap.
 *   4. All persisted keys/values are sanitized (bounded, no functions/PII drift).
 *   5. Failure to read/write context is non-fatal — the caller degrades to the
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

/**
 * Reuse the PROVEN TF-IDF / cosine-similarity primitives from the skill router
 * (Phase 3) for smarter selective injection. Loaded lazily + defensively — if
 * unavailable, relevance scoring falls back to a whole-word keyword heuristic.
 */
let skillRouterTfidf = null;
try {
  const sr = require('./memory/skill-router');
  if (sr && typeof sr.tfidfScores === 'function') skillRouterTfidf = sr;
} catch { /* non-fatal: relevance falls back to keyword scoring */ }

// ─── Constants ──────────────────────────────────────────────

const SCHEMA_VERSION = '1.2.0';
const CONTEXT_FILE = path.join(LIKU_HOME, 'system-context.json');

/** Rolling audit history (Phase 1). */
const HISTORY_DIR = path.join(LIKU_HOME, 'system-context.history');
const CHANGES_LOG = path.join(HISTORY_DIR, 'changes.jsonl');
const HISTORY_MAX_SNAPSHOTS = 10;   // full-context snapshots retained
const CHANGES_LOG_MAX = 200;        // change-log lines retained (rolling)

/** Durable pending (sub-threshold) update queue (Phase 2). */
const PENDING_FILE = path.join(LIKU_HOME, 'system-context.pending.json');
const PENDING_MAX = 100;            // queued items retained (drop oldest)

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
 * Phase 0/1 grounded sources — deterministic, non-LLM. autoDetectEnvironment()
 * writes exclusively through these via _setGrounded().
 */
const GROUNDED_SOURCES = Object.freeze(['os', 'process', 'package', 'env', 'constant', 'system']);

/**
 * Phase 1 TRUSTED evidence sources accepted by proposeUpdate(). These are
 * deterministic runtime signals (tool results, telemetry, reflection outcomes,
 * regression/verifier results) — NOT free-form model text. Grounded sources are
 * also trusted so internal callers can reuse either vocabulary.
 */
const TRUSTED_UPDATE_SOURCES = Object.freeze([
  ...GROUNDED_SOURCES,
  'reflection', 'post-tool-use', 'telemetry', 'regression', 'verifier', 'hook', 'ci', 'test-runner'
]);

/**
 * Explicit deny-list. Even if some caller mislabels these, they can never
 * mutate the substrate — belt-and-suspenders against LLM-inference writes.
 */
const UNTRUSTED_SOURCES = Object.freeze(['llm', 'model', 'inference', 'assistant', 'completion', 'chat', 'unknown']);

/** Keys under these prefixes are HIGH-RISK and require elevated confidence. */
const HIGH_RISK_PREFIXES = Object.freeze(['guard.']);

/** Confidence gates (0..1). */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const HIGH_RISK_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Contextual (expensive) sections: only injected into the prompt fragment when
 * the current query/foreground indicates relevance. Each prefix maps to the
 * keyword set that makes it relevant. When NO relevance signal is supplied,
 * these are included (preserving Phase 0 default output exactly).
 */
const CONTEXTUAL_SECTIONS = Object.freeze({
  'guard.tradingview': ['tradingview', 'trading', 'chart', 'pine', 'ticker', 'candlestick', 'symbol', 'watchlist', 'alert', 'indicator', 'drawing', 'fib', 'order']
});

/** Per-section hard cap for injected fragments (defense-in-depth). */
const DEFAULT_MAX_SECTION_TOKENS = 160;

/**
 * TF-IDF relevance threshold (Phase 3): a contextual section is injected when
 * its cosine similarity to the current query/foreground meets this bar. Tunable
 * via env for future calibration; safe default keeps prior behavior on strong
 * keyword overlap while suppressing unrelated queries.
 */
const RELEVANCE_THRESHOLD = (() => {
  const n = Number(process.env.LIKU_CONTEXT_RELEVANCE_THRESHOLD);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;
})();

/**
 * Background "document" of generic terms. Including it in the tiny TF-IDF corpus
 * keeps IDF > 0 for section-specific terms (single-doc corpora otherwise
 * collapse to zero similarity). These are common, non-distinctive words.
 */
const RELEVANCE_BACKGROUND_TERMS = Object.freeze([
  'the', 'open', 'show', 'me', 'please', 'help', 'what', 'how', 'is', 'do',
  'file', 'window', 'app', 'run', 'check', 'status', 'today', 'weather', 'code', 'text'
]);

/**
 * Live guard grounding (Phase 3): safety ranking per guard key. Higher rank =
 * SAFER. A live value that is safer-or-equal to the current rail is applied at
 * high confidence; a value that would RELAX (lower) a rail is proposed at low
 * confidence so it must pass the pending/confirm flow. Unknown values rank -1
 * (treated as least-safe → queued).
 */
const GUARD_SAFETY_RANK = Object.freeze({
  'guard.tradingview.mode': { 'advisory-observational': 3, observational: 3, advisory: 2, active: 0 },
  'guard.tradingview.orderEntry': { disabled: 3, 'confirm-required': 1, enabled: 0 },
  'guard.net.mode': { 'read-only': 3, restricted: 2, 'read-write': 0 },
  'guard.fs.writeScope': { 'liku-home-only': 3, workspace: 1, unrestricted: 0 }
});

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

/**
 * Clamp a confidence value into [0,1]. Non-numeric → null (treated as missing).
 * @param {*} value
 * @returns {number|null}
 */
function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** True when a key falls under any of the given dot-prefixes. */
function matchesAnyPrefix(key, prefixes) {
  const k = String(key || '');
  return prefixes.some((p) => k === p.replace(/\.$/, '') || k.startsWith(p));
}

/**
 * True when an entry carries an expiry that has passed. Grounded facts (no
 * expiresAt) never expire — this keeps Phase 0 facts stable.
 * @param {object} entry
 * @returns {boolean}
 */
function isExpired(entry) {
  if (!entry || !entry.expiresAt) return false;
  const t = Date.parse(entry.expiresAt);
  return Number.isFinite(t) && t <= Date.now();
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
  put('flags.phase', 'phase-1', 'constant');
  // Context is no longer strictly read-only: trusted, confidence-gated evidence
  // updates are allowed via proposeUpdate(). Raw LLM inference still cannot write.
  put('flags.readOnlyContext', false, 'constant');
  put('flags.evidenceGating', 'confidence-threshold', 'constant');
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
     * Phase 0 entry: { value, source, updatedAt }
     * Phase 1 adds optional provenance: { confidence, observedAt, ttl, expiresAt }
     * @type {Record<string, object>}
     */
    this._entries = {};
    /**
     * Pending (sub-threshold) updates awaiting confirmation. Durable in Phase 2:
     * mirrored to ~/.liku/system-context.pending.json via atomic writes. The
     * queue is RESTORED on startup but never auto-applied — sub-threshold
     * evidence still requires explicit confirmation.
     * @type {Array<object>}
     */
    this._pending = [];
    this._schemaVersion = SCHEMA_VERSION;
    this._loaded = false;
    this._loadFromDisk();
    this._loadPending();
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
              const rebuilt = {
                value: safeValue,
                source: sanitizeValue(entry.source) || 'unknown',
                updatedAt: sanitizeValue(entry.updatedAt) || nowIso()
              };
              // Preserve Phase 1 provenance metadata when present.
              const conf = clampConfidence(entry.confidence);
              if (conf !== null) rebuilt.confidence = conf;
              if (entry.observedAt) rebuilt.observedAt = sanitizeValue(entry.observedAt);
              if (Number.isFinite(Number(entry.ttl))) rebuilt.ttl = Number(entry.ttl);
              if (entry.expiresAt) rebuilt.expiresAt = sanitizeValue(entry.expiresAt);
              if (entry.provenance) rebuilt.provenance = sanitizeValue(entry.provenance);
              this._entries[safeKey] = rebuilt;
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

  // ── Durable pending queue (Phase 2) ──────────────────────

  /** Generate a stable pending-item id. @private */
  _makePendingId() {
    return `pend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Load the durable pending queue from disk, dropping malformed or already
   * expired items. Corruption/absence is non-fatal (empty queue). @private
   */
  _loadPending() {
    try {
      if (!fs.existsSync(PENDING_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
      const items = raw && Array.isArray(raw.pending) ? raw.pending : [];
      const restored = [];
      for (const item of items) {
        const key = item && sanitizeKey(item.key);
        const value = item && sanitizeValue(item.value);
        const source = item && sanitizeValue(item.source);
        const confidence = item && clampConfidence(item.confidence);
        if (!key || value === undefined || !source || confidence === null) continue;
        // Respect TTL/expiry — never restore stale evidence.
        if (item.expiresAt && isExpired(item)) continue;
        restored.push({
          id: sanitizeValue(item.id) || this._makePendingId(),
          key,
          value,
          source,
          confidence,
          threshold: clampConfidence(item.threshold) ?? this._thresholdFor(key),
          observedAt: sanitizeValue(item.observedAt) || undefined,
          ttl: Number.isFinite(Number(item.ttl)) ? Number(item.ttl) : undefined,
          expiresAt: sanitizeValue(item.expiresAt) || undefined,
          provenance: sanitizeValue(item.provenance) || undefined,
          queuedAt: sanitizeValue(item.queuedAt) || nowIso()
        });
      }
      this._pending = restored;
      verboseLog('restored', restored.length, 'pending items');
    } catch (err) {
      console.warn('[SystemContext] Failed to load pending queue:', err.message);
    }
  }

  /**
   * Persist the pending queue atomically (tmp + rename), capped to PENDING_MAX
   * (dropping oldest). Never throws into the caller. @private
   */
  _persistPending() {
    try {
      if (this._pending.length > PENDING_MAX) {
        this._pending = this._pending.slice(-PENDING_MAX);
      }
      if (!fs.existsSync(LIKU_HOME)) {
        fs.mkdirSync(LIKU_HOME, { recursive: true, mode: 0o700 });
      }
      const payload = { schemaVersion: this._schemaVersion, updatedAt: nowIso(), pending: this._pending };
      const tmpFile = `${PENDING_FILE}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpFile, PENDING_FILE);
      return true;
    } catch (err) {
      console.warn('[SystemContext] Failed to persist pending queue:', err.message);
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
    // Migrate the persisted schema version forward on refresh.
    this._schemaVersion = SCHEMA_VERSION;
    this._persist();
    // Phase 3: overlay live guardrail values (best-effort). Safer-or-equal values
    // apply; any relaxation queues for confirmation. Never fatal.
    try { this.refreshGuardRails(); } catch { /* non-fatal */ }
    verboseLog('autoDetectEnvironment applied', updated, 'grounded facts');
    return { updated, total: Object.keys(this._entries).length };
  }

  // ── Evidence-gated mutation (Phase 1) ────────────────────

  /**
   * Determine the confidence threshold that applies to a key.
   * @private
   */
  _thresholdFor(key) {
    return matchesAnyPrefix(key, HIGH_RISK_PREFIXES)
      ? HIGH_RISK_CONFIDENCE_THRESHOLD
      : DEFAULT_CONFIDENCE_THRESHOLD;
  }

  /**
   * Apply a single vetted evidence update: record provenance, snapshot the
   * change to the rolling history, and mutate the cache. Does NOT re-check
   * gating (the caller must have already gated). Internal.
   * @private
   * @returns {object} the applied entry
   */
  _applyEvidence(key, value, meta) {
    const prev = this._entries[key];
    const observedAt = meta.observedAt || nowIso();
    const entry = {
      value,
      source: meta.source,
      updatedAt: nowIso(),
      confidence: meta.confidence,
      observedAt
    };
    if (Number.isFinite(Number(meta.ttl)) && Number(meta.ttl) > 0) {
      entry.ttl = Number(meta.ttl);
      entry.expiresAt = new Date(Date.now() + Number(meta.ttl) * 1000).toISOString();
    }
    if (meta.provenance) entry.provenance = sanitizeValue(meta.provenance);

    this._entries[key] = entry;
    this._recordChange({
      key,
      oldValue: prev ? prev.value : undefined,
      newValue: value,
      source: meta.source,
      confidence: meta.confidence,
      observedAt
    });
    return entry;
  }

  /**
   * Evidence-gated update API. Accepts EITHER:
   *   proposeUpdate('dot.path', value, options)
   *   proposeUpdate({ 'dot.path': value, ... }, options)
   *   proposeUpdate({ key: 'dot.path', value }, options)
   *
   * options = { source, confidence, observedAt, ttl, provenance, strict }
   *
   * Gating rules (safety invariants):
   *   - source is REQUIRED and must be in TRUSTED_UPDATE_SOURCES.
   *   - UNTRUSTED_SOURCES (llm/model/inference/...) are always rejected.
   *   - high-risk keys (guard.*) require confidence >= 0.9; others >= 0.6.
   *   - below-threshold trusted updates are QUEUED (strict mode → rejected).
   *   - raw LLM inference can NEVER mutate the substrate.
   *
   * @param {string|object} delta
   * @param {*} [valueOrOptions] value (string form) or options (object form)
   * @param {object} [maybeOptions]
   * @returns {{accepted: boolean, applied: string[], queued: string[], rejected: object[], reason?: string}}
   */
  proposeUpdate(delta, valueOrOptions, maybeOptions) {
    // ── Normalize the (key,value) pairs + options across call styles ──
    let pairs = [];
    let options = {};
    if (typeof delta === 'string') {
      pairs = [[delta, valueOrOptions]];
      options = maybeOptions || {};
    } else if (delta && typeof delta === 'object') {
      options = valueOrOptions || {};
      if (typeof delta.key === 'string' && 'value' in delta) {
        pairs = [[delta.key, delta.value]];
      } else {
        pairs = Object.entries(delta);
      }
    }

    const source = String(options.source || '').trim().toLowerCase();
    const confidence = clampConfidence(options.confidence);
    const strict = options.strict === true;
    const result = { accepted: false, applied: [], queued: [], rejected: [] };

    // ── Global source gate (applies to the whole batch) ──
    if (!source) {
      result.reason = 'missing-source';
      console.warn('[SystemContext] proposeUpdate rejected: missing trusted source.');
      return result;
    }
    if (UNTRUSTED_SOURCES.includes(source) || !TRUSTED_UPDATE_SOURCES.includes(source)) {
      result.reason = 'untrusted-source';
      console.warn(`[SystemContext] proposeUpdate rejected: source "${source}" is not trusted (LLM inference can never write).`);
      return result;
    }
    if (confidence === null) {
      result.reason = 'missing-confidence';
      console.warn('[SystemContext] proposeUpdate rejected: confidence is required in Phase 1.');
      return result;
    }

    let mutated = false;
    let queuedPending = false;
    for (const [rawKey, rawValue] of pairs) {
      const key = sanitizeKey(rawKey);
      const value = sanitizeValue(rawValue);
      if (!key || value === undefined) {
        result.rejected.push({ key: String(rawKey), reason: 'invalid-key-or-value' });
        continue;
      }
      const threshold = this._thresholdFor(key);
      const meta = { source, confidence, observedAt: options.observedAt, ttl: options.ttl, provenance: options.provenance };

      if (confidence >= threshold) {
        this._applyEvidence(key, value, meta);
        result.applied.push(key);
        mutated = true;
      } else if (strict) {
        result.rejected.push({ key, reason: 'below-threshold', threshold, confidence });
      } else {
        // Queue for confirmation rather than silently applying weak evidence.
        // Durable in Phase 2: mirrored to disk so it survives restarts.
        const observedAt = meta.observedAt || nowIso();
        const pendingItem = {
          id: this._makePendingId(),
          key,
          value,
          source,
          confidence,
          threshold,
          observedAt,
          queuedAt: nowIso()
        };
        if (Number.isFinite(Number(meta.ttl)) && Number(meta.ttl) > 0) {
          pendingItem.ttl = Number(meta.ttl);
          pendingItem.expiresAt = new Date(Date.now() + Number(meta.ttl) * 1000).toISOString();
        }
        if (meta.provenance) pendingItem.provenance = sanitizeValue(meta.provenance);
        this._pending.push(pendingItem);
        queuedPending = true;
        result.queued.push(key);
      }
    }

    if (mutated) this._persist();
    if (queuedPending) this._persistPending();
    result.accepted = result.applied.length > 0;
    verboseLog('proposeUpdate', JSON.stringify({ source, applied: result.applied, queued: result.queued, rejected: result.rejected.length }));
    return result;
  }

  /**
   * Example self-update extension point (Phase 1): record the quality of the
   * most recent reflection pass as grounded evidence. This is intentionally a
   * reg.* (non-high-risk) key so a normal confidence gate applies.
   *
   * Callers (e.g. the reflection loop in ai-service.js) invoke this with a
   * deterministic quality signal — NOT model free-text.
   *
   * @param {number} quality 0..1 reflection quality/confidence signal
   * @param {object} [opts] { source, detail, ttl }
   * @returns {object} proposeUpdate result
   */
  recordReflectionQuality(quality, opts = {}) {
    const q = clampConfidence(quality);
    if (q === null) return { accepted: false, applied: [], queued: [], rejected: [], reason: 'invalid-quality' };
    const delta = {
      'reg.lastReflectionQuality': q,
      'reg.lastReflectionAt': nowIso()
    };
    if (opts.detail) delta['reg.lastReflectionDetail'] = String(opts.detail).slice(0, 120);
    return this.proposeUpdate(delta, {
      source: opts.source || 'reflection',
      confidence: Number.isFinite(Number(opts.confidence)) ? Number(opts.confidence) : 0.95,
      ttl: opts.ttl
    });
  }

  /**
   * Evidence extension point (Phase 2): record post-execution verification /
   * regression quality as grounded evidence. Deterministic signal (verified?,
   * healed?, attempts) — NOT model free-text. reg.* keys use the normal gate.
   *
   * @param {number} quality 0..1 verification quality/confidence signal
   * @param {object} [opts] { source, detail, status, ttl, confidence }
   * @returns {object} proposeUpdate result
   */
  recordVerificationQuality(quality, opts = {}) {
    const q = clampConfidence(quality);
    if (q === null) return { accepted: false, applied: [], queued: [], rejected: [], reason: 'invalid-quality' };
    const delta = {
      'reg.lastVerificationQuality': q,
      'reg.lastVerificationAt': nowIso()
    };
    if (opts.status) delta['reg.lastVerificationStatus'] = String(opts.status).slice(0, 40);
    if (opts.detail) delta['reg.lastVerificationDetail'] = String(opts.detail).slice(0, 120);
    return this.proposeUpdate(delta, {
      source: opts.source || 'verifier',
      confidence: Number.isFinite(Number(opts.confidence)) ? Number(opts.confidence) : 0.95,
      ttl: opts.ttl
    });
  }

  /**
   * Evidence extension point (Phase 3): record a regression / CI test-run
   * outcome. Deterministic signal (pass/fail counts) — NOT model text. Targets
   * cap.lang.*.regression.status + reg.lastRegression* (normal, non-guard gate).
   *
   * @param {string} status e.g. 'pass' | 'fail'
   * @param {object} [opts] { lang, quality, source, detail, ttl, confidence }
   * @returns {object} proposeUpdate result
   */
  recordRegressionOutcome(status, opts = {}) {
    const safeStatus = sanitizeValue(status);
    if (safeStatus === undefined) return { accepted: false, applied: [], queued: [], rejected: [], reason: 'invalid-status' };
    const lang = String(opts.lang || 'js').trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'js';
    const q = clampConfidence(opts.quality);
    const delta = {
      [`cap.lang.${lang}.regression.status`]: String(safeStatus).slice(0, 40),
      'reg.lastRegressionAt': nowIso()
    };
    if (q !== null) delta['reg.lastRegressionQuality'] = q;
    if (opts.detail) delta['reg.lastRegressionDetail'] = String(opts.detail).slice(0, 120);
    return this.proposeUpdate(delta, {
      source: opts.source || 'regression',
      confidence: Number.isFinite(Number(opts.confidence)) ? Number(opts.confidence) : 0.95,
      ttl: opts.ttl
    });
  }

  // ── Live guard.* grounding (Phase 3) ─────────────────────

  /**
   * Safety rank for a guard value (higher = safer). Unknown value → -1.
   * @private
   */
  _guardRank(key, value) {
    const table = GUARD_SAFETY_RANK[key];
    if (!table) return 0; // no ranking table → treat all as neutral/equal
    const v = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(table, v) ? table[v] : -1;
  }

  /**
   * Confidence to use when grounding a live guard value:
   *   - safer-or-equal than current (or no current) → 0.95 (applies, ≥0.9)
   *   - would RELAX (lower) the rail                 → 0.5  (queues for confirm)
   * This guarantees a human confirms any rail relaxation.
   * @private
   */
  _guardUpdateConfidence(key, newValue) {
    if (!GUARD_SAFETY_RANK[key]) return 0.95; // informational guard key
    const current = this.get(key);
    const currentRank = current === undefined ? -Infinity : this._guardRank(key, current);
    const newRank = this._guardRank(key, newValue);
    return newRank >= currentRank ? 0.95 : 0.5;
  }

  /**
   * Source live guardrail values from authoritative runtime modules
   * (capability-policy / TradingView verification) instead of static constants.
   * Best-effort: each source is guarded; unknown → safe documented default.
   *
   * @param {object} [context] { foreground, userMessage, guardOverrides }
   * @returns {Record<string, string>} guard.key → live value
   */
  getLiveGuardValues(context = {}) {
    const live = {};
    try {
      const fg = context.foreground || {};
      const haystack = [fg.processName, fg.title, context.userMessage]
        .map((v) => String(v || '').trim().toLowerCase()).filter(Boolean).join(' ');
      const isTradingView = /tradingview|trading\s*view/.test(haystack);
      if (isTradingView) {
        // Authoritative: infer the live TradingView trading mode.
        let mode = { mode: 'unknown' };
        try {
          const { inferTradingViewTradingMode } = require('./tradingview/verification');
          mode = inferTradingViewTradingMode({ textSignals: haystack }) || mode;
        } catch { /* fall back to safe default */ }
        // We remain observational regardless of paper/live; order entry stays disabled.
        live['guard.tradingview.mode'] = 'advisory-observational';
        live['guard.tradingview.orderEntry'] = 'disabled';
        live['reg.tradingViewLiveMode'] = String(mode.mode || 'unknown').slice(0, 20);
      }
    } catch { /* non-fatal */ }

    // Extension/test hook: explicit candidate overrides (still safety-gated below).
    if (context.guardOverrides && typeof context.guardOverrides === 'object') {
      for (const [k, v] of Object.entries(context.guardOverrides)) {
        const key = sanitizeKey(k);
        const val = sanitizeValue(v);
        if (key && key.startsWith('guard.') && val !== undefined) live[key] = val;
      }
    }
    return live;
  }

  /**
   * Merge live guard values into the substrate via the gated proposeUpdate path.
   * Safer-or-equal values apply immediately; relaxations queue for confirmation.
   * @param {object} [context]
   * @returns {{applied: string[], queued: string[]}}
   */
  refreshGuardRails(context = {}) {
    const live = this.getLiveGuardValues(context);
    const applied = [];
    const queued = [];
    for (const [key, value] of Object.entries(live)) {
      const isGuard = key.startsWith('guard.');
      const confidence = isGuard ? this._guardUpdateConfidence(key, value) : 0.95;
      const res = this.proposeUpdate(key, value, { source: 'system', confidence });
      if (res.applied.includes(key)) applied.push(key);
      if (res.queued.includes(key)) queued.push(key);
    }
    verboseLog('refreshGuardRails', JSON.stringify({ applied, queued }));
    return { applied, queued };
  }

  /**
   * Return pending (sub-threshold) updates awaiting confirmation. Expired items
   * are dropped lazily (and pruned from disk). Durable across restarts (Phase 2).
   * @returns {object[]} copies of pending items
   */
  getPendingUpdates() {
    const live = this._pending.filter((p) => !isExpired(p));
    if (live.length !== this._pending.length) {
      this._pending = live;
      this._persistPending();
    }
    return this._pending.map((p) => ({ ...p }));
  }

  /**
   * Find pending items for a key (or a specific pending id).
   * @param {string} keyOrId
   * @returns {object[]}
   */
  getPending(keyOrId) {
    const needle = String(keyOrId || '').trim();
    const safeKey = sanitizeKey(needle);
    return this._pending
      .filter((p) => !isExpired(p))
      .filter((p) => p.id === needle || (safeKey && p.key === safeKey))
      .map((p) => ({ ...p }));
  }

  /**
   * Confirm a pending update by key or id: either apply it (promote to a normal
   * grounded entry via _applyEvidence) or reject it. Both outcomes remove the
   * item from the queue and are recorded in the change history for audit.
   *
   * @param {string} keyOrId
   * @param {'apply'|'reject'} action
   * @returns {{ok: boolean, action?: string, key?: string, applied?: object, reason?: string, count?: number}}
   */
  confirmPending(keyOrId, action = 'apply') {
    const matches = this._pending.filter((p) => !isExpired(p))
      .filter((p) => p.id === String(keyOrId).trim() || p.key === sanitizeKey(keyOrId));
    if (!matches.length) {
      return { ok: false, reason: 'not-found', key: String(keyOrId) };
    }
    // Operate on the MOST RECENT matching item (newest queuedAt).
    const item = matches.reduce((a, b) => (a.queuedAt >= b.queuedAt ? a : b));
    // Remove ALL matching items for this key/id from the queue.
    const removedKeys = new Set(matches.map((m) => m.id));
    this._pending = this._pending.filter((p) => !removedKeys.has(p.id));

    if (action === 'reject') {
      this._recordChange({
        key: item.key,
        oldValue: this.get(item.key),
        newValue: item.value,
        source: item.source,
        confidence: item.confidence,
        observedAt: item.observedAt,
        decision: 'rejected'
      });
      this._persistPending();
      verboseLog('confirmPending rejected', item.key);
      return { ok: true, action: 'reject', key: item.key, count: matches.length };
    }

    // action === 'apply' → promote to a grounded entry with provenance.
    const applied = this._applyEvidence(item.key, item.value, {
      source: item.source,
      confidence: item.confidence,
      observedAt: item.observedAt,
      ttl: item.ttl,
      provenance: item.provenance || 'confirmed'
    });
    this._persist();
    this._persistPending();
    verboseLog('confirmPending applied', item.key);
    return { ok: true, action: 'apply', key: item.key, applied: { ...applied }, count: matches.length };
  }

  // ── History / auditability ───────────────────────────────

  /**
   * Append a change record to the rolling change log and write a full snapshot,
   * pruning both to their caps. Never throws into the caller.
   * @private
   */
  _recordChange(change) {
    try {
      if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
      }
      const line = JSON.stringify({ ts: nowIso(), ...change });

      // Append then cap the change log (read-tail-rewrite; the log is small).
      let lines = [];
      if (fs.existsSync(CHANGES_LOG)) {
        lines = fs.readFileSync(CHANGES_LOG, 'utf-8').split('\n').filter(Boolean);
      }
      lines.push(line);
      if (lines.length > CHANGES_LOG_MAX) lines = lines.slice(-CHANGES_LOG_MAX);
      const tmp = `${CHANGES_LOG}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, CHANGES_LOG);

      this._writeSnapshot();
    } catch (err) {
      console.warn('[SystemContext] Failed to record change history:', err.message);
    }
  }

  /**
   * Persist a timestamped full snapshot, pruning to HISTORY_MAX_SNAPSHOTS.
   * @private
   */
  _writeSnapshot() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(HISTORY_DIR, `snapshot-${stamp}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: this._schemaVersion, savedAt: nowIso(), entries: this._entries }, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, file);

      const snapshots = fs.readdirSync(HISTORY_DIR)
        .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort();
      while (snapshots.length > HISTORY_MAX_SNAPSHOTS) {
        const oldest = snapshots.shift();
        try { fs.unlinkSync(path.join(HISTORY_DIR, oldest)); } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.warn('[SystemContext] Failed to write snapshot:', err.message);
    }
  }

  /**
   * Return the most recent change records (optionally filtered by key).
   * @param {number} [limit]
   * @param {string} [key]
   * @returns {object[]}
   */
  getChanges(limit = 10, key = null) {
    try {
      if (!fs.existsSync(CHANGES_LOG)) return [];
      const safeKey = key ? sanitizeKey(key) : null;
      const rows = fs.readFileSync(CHANGES_LOG, 'utf-8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .filter((r) => !safeKey || r.key === safeKey);
      return rows.slice(-Math.max(1, limit)).reverse();
    } catch (err) {
      console.warn('[SystemContext] Failed to read change log:', err.message);
      return [];
    }
  }

  /**
   * The single most recent change (optionally for a specific key), or null.
   * @param {string} [key]
   * @returns {object|null}
   */
  getLastChange(key = null) {
    const changes = this.getChanges(1, key);
    return changes.length ? changes[0] : null;
  }


  // ── Queries ──────────────────────────────────────────────

  /**
   * Live (non-expired) key → entry map. TTL'd entries past expiry are hidden
   * from all reads (lazy expiry); grounded facts without expiry are unaffected.
   * @private
   */
  _liveEntries() {
    const out = {};
    for (const [key, entry] of Object.entries(this._entries)) {
      if (!isExpired(entry)) out[key] = entry;
    }
    return out;
  }

  /**
   * Get a single fact value by dot-path (undefined if absent or expired).
   * @param {string} key
   * @returns {(string|number|boolean|undefined)}
   */
  get(key) {
    const safeKey = sanitizeKey(key);
    const entry = safeKey ? this._entries[safeKey] : null;
    return entry && !isExpired(entry) ? entry.value : undefined;
  }

  /**
   * Get the full entry (value + provenance metadata) for a dot-path.
   * @param {string} key
   * @returns {object|null}
   */
  getEntry(key) {
    const safeKey = sanitizeKey(key);
    const entry = safeKey ? this._entries[safeKey] : null;
    return entry && !isExpired(entry) ? { ...entry } : null;
  }

  /**
   * Get a flat snapshot of all live fact values (key → value).
   * @returns {Record<string, (string|number|boolean)>}
   */
  getAll() {
    const out = {};
    for (const [key, entry] of Object.entries(this._liveEntries())) {
      out[key] = entry.value;
    }
    return out;
  }

  /**
   * Get all live entries under a dot-prefix (e.g. 'guard.tradingview').
   * @param {string} prefix
   * @returns {Record<string, object>} key → entry (copies)
   */
  getSection(prefix) {
    const p = String(prefix || '').trim();
    if (!p) return {};
    const norm = p.endsWith('.') ? p : `${p}.`;
    const out = {};
    for (const [key, entry] of Object.entries(this._liveEntries())) {
      if (key === p || key.startsWith(norm)) out[key] = { ...entry };
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

  // ── Relevance / selective injection ──────────────────────

  /**
   * Score the relevance of a contextual section to a haystack (query +
   * foreground text) using the skill-router's proven TF-IDF cosine similarity.
   * Falls back to a whole-word keyword-overlap ratio when the TF-IDF module is
   * unavailable. Returns a number in [0,1].
   * @private
   * @param {string} prefix contextual section prefix (e.g. 'guard.tradingview')
   * @param {string[]} keywords the section's relevance keywords
   * @param {string} haystack lowercased query + foreground text
   * @returns {number}
   */
  _scoreRelevance(prefix, keywords, haystack) {
    if (!haystack) return 0;
    // Primary path: reuse skill-router TF-IDF (whole-word tokenization avoids the
    // substring false-positives of a naive includes() check).
    if (skillRouterTfidf) {
      try {
        const index = {
          [prefix]: { keywords, tags: [] },
          __background__: { keywords: RELEVANCE_BACKGROUND_TERMS, tags: [] }
        };
        const scores = skillRouterTfidf.tfidfScores(index, haystack);
        return Number(scores.get(prefix)) || 0;
      } catch { /* fall through to keyword heuristic */ }
    }
    // Fallback: fraction of section keywords present as whole words.
    const tokens = new Set(haystack.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
    const hits = keywords.filter((kw) => tokens.has(String(kw).toLowerCase())).length;
    return keywords.length ? hits / keywords.length : 0;
  }

  /**
   * Decide whether a contextual (expensive) key should be injected given the
   * current relevance signal. Returns true when:
   *   - the key is not contextual (always relevant), OR
   *   - no relevance signal was supplied (preserve Phase 0/1/2 default output), OR
   *   - the TF-IDF relevance score meets the (tunable) threshold.
   * Fails OPEN: any scoring error → include the section.
   * @private
   */
  _isKeyRelevant(key, options = {}) {
    let matchedSectionKeywords = null;
    let matchedPrefix = null;
    for (const [prefix, keywords] of Object.entries(CONTEXTUAL_SECTIONS)) {
      if (key === prefix || key.startsWith(`${prefix}.`)) { matchedSectionKeywords = keywords; matchedPrefix = prefix; break; }
    }
    if (!matchedSectionKeywords) return true; // not a contextual key

    const hasSignal = (typeof options.query === 'string' && options.query.trim())
      || (options.foreground && typeof options.foreground === 'object')
      || options.selective === true;
    if (!hasSignal) return true; // compatibility: include when no relevance signal

    try {
      const haystack = [
        String(options.query || ''),
        String(options.foreground?.processName || ''),
        String(options.foreground?.title || ''),
        String(options.foreground?.appId || '')
      ].join(' ').toLowerCase().trim();
      if (!haystack) return true; // fail open

      const threshold = Number.isFinite(Number(options.relevanceThreshold))
        ? Number(options.relevanceThreshold) : RELEVANCE_THRESHOLD;
      return this._scoreRelevance(matchedPrefix, matchedSectionKeywords, haystack) >= threshold;
    } catch {
      return true; // fail open on any scoring error
    }
  }

  // ── Prompt fragment ──────────────────────────────────────

  /**
   * Render the context as a system-prompt–injectable string.
   * Guaranteed to stay within SYSTEM_CONTEXT_TOKEN_BUDGET (well under the global
   * 1,200 BPE cap): trailing groups are dropped rather than mid-line truncation,
   * and each section is capped to maxSectionTokens.
   *
   * Privacy: keys in PROMPT_PRIVACY_GATES (e.g. env.hostname) are omitted unless
   * their opt-in flag is explicitly enabled (defaults off).
   *
   * Backward compatibility: toPromptFragment() and toPromptFragment('structured')
   * with no options produce byte-identical output to Phase 0.
   *
   * @param {'structured'|'compact'|'flat-kv'} [format]
   * @param {object} [options] { query, foreground, sections, selective, maxSectionTokens }
   * @returns {string}
   */
  toPromptFragment(format = 'structured', options = {}) {
    const live = this._liveEntries();
    const keys = Object.keys(live);
    if (!keys.length) return '';

    const maxSectionTokens = Number.isFinite(Number(options.maxSectionTokens))
      ? Number(options.maxSectionTokens) : DEFAULT_MAX_SECTION_TOKENS;
    const sectionFilter = Array.isArray(options.sections) && options.sections.length
      ? options.sections.map((s) => String(s).trim()).filter(Boolean)
      : null;

    // Priority order controls which groups survive if the budget is tight.
    const groupOrder = ['meta', 'env', 'hardware', 'guard', 'flags', 'reg', 'cap'];
    const grouped = {};
    for (const key of keys.sort()) {
      // Privacy gate (stored-but-not-injected unless opt-in flag is true).
      const gateFlag = PROMPT_PRIVACY_GATES[key];
      if (gateFlag) {
        const gateEntry = live[gateFlag];
        const enabled = gateEntry && (gateEntry.value === true || gateEntry.value === 'true');
        if (!enabled) continue;
      }
      // Explicit section allow-list (when provided).
      if (sectionFilter && !sectionFilter.some((s) => key === s || key.startsWith(`${s}.`) || key.split('.')[0] === s)) continue;
      // Selective / relevance-based injection for contextual sections.
      if (!this._isKeyRelevant(key, options)) continue;

      const group = key.split('.')[0];
      (grouped[group] = grouped[group] || []).push({ key, value: live[key].value });
    }

    const orderedGroups = [
      ...groupOrder.filter((g) => grouped[g]),
      ...Object.keys(grouped).filter((g) => !groupOrder.includes(g))
    ];
    if (!orderedGroups.length) return '';

    // Per-section cap: trim entries so a single group cannot dominate.
    const renderGroupBody = (entries, sep) => {
      const parts = [];
      let body = '';
      for (const { key, value } of entries) {
        const piece = format === 'compact' ? `${key.split('.').slice(1).join('.') || key}=${value}` : `${key}=${value}`;
        const next = parts.concat(piece).join(sep);
        if (countTokens(next) > maxSectionTokens) break;
        parts.push(piece);
        body = next;
      }
      return body;
    };

    // ── flat-kv: one key=value per line, no grouping ──
    if (format === 'flat-kv') {
      const header = '## System Self-Awareness';
      const lines = [header];
      for (const group of orderedGroups) {
        for (const { key, value } of grouped[group]) {
          const candidate = [...lines, `${key}=${value}`].join('\n');
          if (countTokens(candidate) > SYSTEM_CONTEXT_TOKEN_BUDGET) return lines.length > 1 ? lines.join('\n') : '';
          lines.push(`${key}=${value}`);
        }
      }
      return lines.length > 1 ? lines.join('\n') : '';
    }

    // ── compact: single dense line ──
    if (format === 'compact') {
      const segs = [];
      for (const group of orderedGroups) {
        const body = renderGroupBody(grouped[group], ',');
        if (!body) continue;
        const candidate = `SelfAwareness :: ${[...segs, `${group}(${body})`].join(' ')}`;
        if (countTokens(candidate) > SYSTEM_CONTEXT_TOKEN_BUDGET) break;
        segs.push(`${group}(${body})`);
      }
      return segs.length ? `SelfAwareness :: ${segs.join(' ')}` : '';
    }

    // ── structured (default): grouped multi-line ──
    const header = '## System Self-Awareness (read-only, grounded)';
    const lines = [header];
    for (const group of orderedGroups) {
      const body = renderGroupBody(grouped[group], '; ');
      if (!body) continue;
      const candidate = [...lines, `- ${group}: ${body}`].join('\n');
      if (countTokens(candidate) > SYSTEM_CONTEXT_TOKEN_BUDGET) {
        verboseLog(`token budget reached; dropping group "${group}" and beyond`);
        break;
      }
      lines.push(`- ${group}: ${body}`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /**
   * Number of BPE tokens the current fragment would consume — for validation.
   * @param {string} [format]
   * @param {object} [options]
   * @returns {number}
   */
  getFragmentTokenCount(format = 'structured', options = {}) {
    return countTokens(this.toPromptFragment(format, options));
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
 * @param {object} [options]
 * @returns {string}
 */
function toPromptFragment(format = 'structured', options = {}) {
  try {
    return getInstance().toPromptFragment(format, options);
  } catch (err) {
    console.warn('[SystemContext] toPromptFragment failed:', err.message);
    return '';
  }
}

/**
 * Convenience: evidence-gated update on the shared instance. Never throws.
 * @param {string|object} delta
 * @param {*} [valueOrOptions]
 * @param {object} [maybeOptions]
 */
function proposeUpdate(delta, valueOrOptions, maybeOptions) {
  try {
    return getInstance().proposeUpdate(delta, valueOrOptions, maybeOptions);
  } catch (err) {
    console.warn('[SystemContext] proposeUpdate failed:', err.message);
    return { accepted: false, applied: [], queued: [], rejected: [], reason: 'internal-error' };
  }
}

/**
 * Convenience: record reflection-quality evidence. Never throws.
 * Clean extension point for the reflection/PostToolUse feedback loop.
 * @param {number} quality 0..1
 * @param {object} [opts]
 */
function recordReflectionQuality(quality, opts = {}) {
  try {
    return getInstance().recordReflectionQuality(quality, opts);
  } catch (err) {
    console.warn('[SystemContext] recordReflectionQuality failed:', err.message);
    return { accepted: false, applied: [], queued: [], rejected: [], reason: 'internal-error' };
  }
}

/**
 * Convenience: record verification/regression-quality evidence. Never throws.
 * @param {number} quality 0..1
 * @param {object} [opts]
 */
function recordVerificationQuality(quality, opts = {}) {
  try {
    return getInstance().recordVerificationQuality(quality, opts);
  } catch (err) {
    console.warn('[SystemContext] recordVerificationQuality failed:', err.message);
    return { accepted: false, applied: [], queued: [], rejected: [], reason: 'internal-error' };
  }
}

/**
 * Convenience: confirm (apply/reject) a pending update. Never throws.
 * @param {string} keyOrId
 * @param {'apply'|'reject'} [action]
 */
function confirmPending(keyOrId, action = 'apply') {
  try {
    return getInstance().confirmPending(keyOrId, action);
  } catch (err) {
    console.warn('[SystemContext] confirmPending failed:', err.message);
    return { ok: false, reason: 'internal-error' };
  }
}

/**
 * Convenience: record a regression / CI outcome. Never throws.
 * @param {string} status
 * @param {object} [opts]
 */
function recordRegressionOutcome(status, opts = {}) {
  try {
    return getInstance().recordRegressionOutcome(status, opts);
  } catch (err) {
    console.warn('[SystemContext] recordRegressionOutcome failed:', err.message);
    return { accepted: false, applied: [], queued: [], rejected: [], reason: 'internal-error' };
  }
}

/**
 * Convenience: refresh live guardrail grounding. Never throws.
 * @param {object} [context]
 */
function refreshGuardRails(context = {}) {
  try {
    return getInstance().refreshGuardRails(context);
  } catch (err) {
    console.warn('[SystemContext] refreshGuardRails failed:', err.message);
    return { applied: [], queued: [] };
  }
}

module.exports = {
  SystemContextManager,
  getInstance,
  autoDetectEnvironment,
  toPromptFragment,
  proposeUpdate,
  recordReflectionQuality,
  recordVerificationQuality,
  recordRegressionOutcome,
  refreshGuardRails,
  confirmPending,
  SCHEMA_VERSION,
  SYSTEM_CONTEXT_TOKEN_BUDGET,
  CONTEXT_FILE,
  HISTORY_DIR,
  PENDING_FILE,
  RELEVANCE_THRESHOLD,
  DEFAULT_CONFIDENCE_THRESHOLD,
  HIGH_RISK_CONFIDENCE_THRESHOLD,
  TRUSTED_UPDATE_SOURCES
};

