/**
 * Semantic Skill Router
 *
 * Prevents context-window bloat by loading only the skills relevant to the
 * current user message. Uses lightweight keyword matching against an index
 * stored at ~/.liku/skills/index.json.
 *
 * Interface: getRelevantSkillsContext(userMessage, limit?) → string
 *            getRelevantSkillsSelection(userMessage, options?) → { text, ids, matches }
 *            addSkill(id, { file, keywords, tags }) → void
 *            upsertLearnedSkill(skillData) → object
 *            recordSkillOutcome(skillIds, outcome, context?) → object
 *            removeSkill(id) → void
 *            listSkills() → object
 *
 * Hard caps:
 *  - Maximum skills per query: 3 (configurable via `limit`)
 *  - Maximum total token budget: 1500 BPE tokens (cl100k_base encoding)
 */

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const { countTokens, truncateToTokenBudget } = require('../../shared/token-counter');

const SKILLS_DIR = path.join(LIKU_HOME, 'skills');
const INDEX_FILE = path.join(SKILLS_DIR, 'index.json');

const DEFAULT_LIMIT = 3;
const TOKEN_BUDGET = 1500;
const PROMOTION_SUCCESS_THRESHOLD = 2;
const QUARANTINE_FAILURE_THRESHOLD = 2;
const GENERIC_SKILL_TAGS = new Set(['awm', 'auto-generated', 'reflection', 'success', 'failure']);

function extractHost(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = /^https?:\/\//i.test(text) ? new URL(text) : new URL(`https://${text}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeArray(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function normalizeScopeTier(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['global', 'domain', 'local'].includes(normalized) ? normalized : null;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const processNames = normalizeArray(scope.processNames).map((value) => value.toLowerCase());
  const windowTitles = normalizeArray(scope.windowTitles);
  const domains = normalizeArray(scope.domains).map((value) => extractHost(value) || value.toLowerCase());
  const repoNames = normalizeArray(scope.repoNames).map((value) => value.toLowerCase());
  const projectRoots = normalizeArray(scope.projectRoots).map((value) => path.resolve(String(value || '')).toLowerCase());
  const appIds = normalizeArray(scope.appIds).map((value) => value.toLowerCase());
  const taskFamilies = normalizeArray(scope.taskFamilies).map((value) => value.toLowerCase());
  const compartmentKeys = normalizeArray(scope.compartmentKeys).map((value) => value.toLowerCase());
  const kind = scope.kind ? String(scope.kind).trim().toLowerCase() : null;
  const tier = normalizeScopeTier(scope.tier || scope.scopeTier);
  if (!processNames.length
    && !windowTitles.length
    && !domains.length
    && !repoNames.length
    && !projectRoots.length
    && !appIds.length
    && !taskFamilies.length
    && !compartmentKeys.length
    && !kind
    && !tier) return null;
  return {
    ...(tier ? { tier } : {}),
    ...(kind ? { kind } : {}),
    ...(processNames.length ? { processNames } : {}),
    ...(windowTitles.length ? { windowTitles } : {}),
    ...(domains.length ? { domains } : {}),
    ...(repoNames.length ? { repoNames } : {}),
    ...(projectRoots.length ? { projectRoots } : {}),
    ...(appIds.length ? { appIds } : {}),
    ...(taskFamilies.length ? { taskFamilies } : {}),
    ...(compartmentKeys.length ? { compartmentKeys } : {})
  };
}

function normalizeScopeContext(options = {}) {
  const envelope = options.executionContextEnvelope && typeof options.executionContextEnvelope === 'object'
    ? options.executionContextEnvelope
    : null;
  const repoName = String(
    options.repoName
    || envelope?.repo?.name
    || ''
  ).trim().toLowerCase() || null;
  const projectRootRaw = String(
    options.projectRoot
    || envelope?.repo?.projectRoot
    || ''
  ).trim();
  const projectRoot = projectRootRaw ? path.resolve(projectRootRaw).toLowerCase() : null;
  const appId = String(
    options.appId
    || envelope?.foreground?.appId
    || ''
  ).trim().toLowerCase() || null;
  const processName = String(
    options.currentProcessName
    || options.processName
    || envelope?.foreground?.processName
    || ''
  ).trim().toLowerCase() || null;
  const windowTitle = String(
    options.currentWindowTitle
    || options.windowTitle
    || envelope?.foreground?.windowTitle
    || ''
  ).trim() || null;
  const windowKind = String(
    options.currentWindowKind
    || options.windowKind
    || envelope?.foreground?.surfaceClass
    || ''
  ).trim().toLowerCase() || null;
  const taskFamily = String(
    options.taskFamily
    || envelope?.taskFamily
    || ''
  ).trim().toLowerCase() || null;
  const compartmentKey = String(
    options.compartmentKey
    || envelope?.compartmentKey
    || ''
  ).trim().toLowerCase() || null;
  const currentUrlHost = extractHost(options.currentUrlHost || options.currentUrl || '');

  return {
    repoName,
    projectRoot,
    appId,
    currentProcessName: processName,
    currentWindowTitle: windowTitle,
    currentWindowKind: windowKind,
    taskFamily,
    compartmentKey,
    currentUrlHost,
    currentUrl: options.currentUrl || null,
    query: options.query || ''
  };
}

function matchesNormalizedValue(currentValue, candidateValue) {
  const current = String(currentValue || '').trim().toLowerCase();
  const candidate = String(candidateValue || '').trim().toLowerCase();
  if (!current || !candidate) return false;
  return current === candidate || current.includes(candidate) || candidate.includes(current);
}

function evaluateScopeSignal(values, currentValue, options = {}) {
  const normalizedValues = normalizeArray(values).map((value) => String(value || '').trim()).filter(Boolean);
  const current = String(currentValue || '').trim();
  if (normalizedValues.length === 0) {
    return { applicable: false, matched: false, mismatched: false, value: null };
  }
  if (!current) {
    return { applicable: true, matched: false, mismatched: false, value: null };
  }

  const matcher = typeof options.matcher === 'function'
    ? options.matcher
    : (candidate, liveValue) => matchesNormalizedValue(liveValue, candidate);
  const matchedValue = normalizedValues.find((candidate) => matcher(candidate, current));
  if (matchedValue) {
    return { applicable: true, matched: true, mismatched: false, value: matchedValue };
  }

  return { applicable: true, matched: false, mismatched: true, value: normalizedValues[0] };
}

function analyzeScopeMatch(entry, options = {}) {
  const scope = entry?.scope;
  if (!scope) {
    return {
      score: 0,
      matchedSignals: 0,
      mismatchedSignals: 0,
      fallbackEligible: true,
      classification: 'unscoped-fallback',
      scopeTier: 'unscoped'
    };
  }

  const scopeTier = normalizeScopeTier(scope.tier) || 'legacy';

  const context = normalizeScopeContext(options);
  const evaluations = [
    {
      key: 'compartmentKey',
      weight: 7,
      mismatchPenalty: -4.5,
      evaluation: evaluateScopeSignal(scope.compartmentKeys, context.compartmentKey)
    },
    {
      key: 'repoName',
      weight: 4,
      mismatchPenalty: -2.5,
      evaluation: evaluateScopeSignal(scope.repoNames, context.repoName)
    },
    {
      key: 'projectRoot',
      weight: 4,
      mismatchPenalty: -2.5,
      evaluation: evaluateScopeSignal(scope.projectRoots, context.projectRoot)
    },
    {
      key: 'appId',
      weight: 4,
      mismatchPenalty: -3,
      evaluation: evaluateScopeSignal(scope.appIds, context.appId)
    },
    {
      key: 'taskFamily',
      weight: 3,
      mismatchPenalty: -2,
      evaluation: evaluateScopeSignal(scope.taskFamilies, context.taskFamily)
    },
    {
      key: 'processName',
      weight: 3,
      mismatchPenalty: -1.5,
      evaluation: evaluateScopeSignal(scope.processNames, context.currentProcessName)
    },
    {
      key: 'windowTitle',
      weight: 2,
      mismatchPenalty: -0.75,
      evaluation: evaluateScopeSignal(scope.windowTitles, context.currentWindowTitle)
    },
    {
      key: 'windowKind',
      weight: 2,
      mismatchPenalty: -1,
      evaluation: evaluateScopeSignal(scope.kind ? [scope.kind] : [], context.currentWindowKind)
    },
    {
      key: 'domain',
      weight: 3,
      mismatchPenalty: -1,
      evaluation: evaluateScopeSignal(scope.domains, context.currentUrlHost, {
        matcher: (candidate, liveValue) => {
          const normalizedCandidate = extractHost(candidate) || String(candidate || '').trim().toLowerCase();
          const normalizedLive = extractHost(liveValue) || String(liveValue || '').trim().toLowerCase();
          if (!normalizedCandidate || !normalizedLive) return false;
          return normalizedLive === normalizedCandidate
            || normalizedLive.endsWith(`.${normalizedCandidate}`)
            || normalizedCandidate.endsWith(`.${normalizedLive}`);
        }
      })
    }
  ];

  let score = 0;
  let matchedSignals = 0;
  let mismatchedSignals = 0;
  let constrainedSignals = 0;

  const matchedMultiplier = scopeTier === 'global'
    ? 0.35
    : scopeTier === 'domain'
      ? 0.8
      : 1;
  const mismatchMultiplier = scopeTier === 'global'
    ? 0
    : scopeTier === 'domain'
      ? 0.25
      : 1;

  evaluations.forEach(({ weight, mismatchPenalty, evaluation }) => {
    if (!evaluation.applicable) return;
    constrainedSignals += 1;
    if (evaluation.matched) {
      matchedSignals += 1;
      score += weight * matchedMultiplier;
      return;
    }
    if (evaluation.mismatched) {
      mismatchedSignals += 1;
      score += mismatchPenalty * mismatchMultiplier;
    }
  });

  if (scopeTier === 'global') {
    score += 1.25;
  } else if (scopeTier === 'domain' && matchedSignals > 0) {
    score += 1.5;
  }

  let classification = 'scoped-neutral';
  if (matchedSignals > 0 && mismatchedSignals === 0) classification = 'scoped-match';
  else if (matchedSignals > 0 && mismatchedSignals > 0) classification = 'scoped-mixed';
  else if (mismatchedSignals > 0) classification = 'scoped-mismatch';

  if (scopeTier === 'global') classification = matchedSignals > 0 ? 'global-match' : 'global-fallback';
  else if (scopeTier === 'domain' && matchedSignals > 0) classification = mismatchedSignals > 0 ? 'domain-mixed' : 'domain-match';
  else if (scopeTier === 'domain' && mismatchedSignals > 0) classification = 'domain-mismatch';
  else if (scopeTier === 'local' && classification === 'scoped-match') classification = 'local-match';
  else if (scopeTier === 'local' && classification === 'scoped-mixed') classification = 'local-mixed';
  else if (scopeTier === 'local' && classification === 'scoped-mismatch') classification = 'local-mismatch';

  return {
    score,
    matchedSignals,
    mismatchedSignals,
    constrainedSignals,
    fallbackEligible: matchedSignals === 0 || scopeTier === 'global',
    classification,
    scopeTier
  };
}

function normalizeSkillEntry(id, entry = {}) {
  const normalized = { ...entry };
  normalized.file = normalized.file || `${id}.md`;
  normalized.keywords = normalizeArray(normalized.keywords);
  normalized.tags = normalizeArray(normalized.tags);
  normalized.verificationHints = normalizeArray(normalized.verificationHints);
  normalized.scope = normalizeScope(normalized.scope);
  normalized.origin = normalized.origin || (id.startsWith('awm-') ? 'awm' : 'legacy');
  normalized.successCount = Number.isFinite(Number(normalized.successCount)) ? Number(normalized.successCount) : 0;
  normalized.failureCount = Number.isFinite(Number(normalized.failureCount)) ? Number(normalized.failureCount) : 0;
  normalized.consecutiveFailures = Number.isFinite(Number(normalized.consecutiveFailures)) ? Number(normalized.consecutiveFailures) : 0;
  normalized.useCount = Number.isFinite(Number(normalized.useCount)) ? Number(normalized.useCount) : 0;
  normalized.createdAt = normalized.createdAt || new Date().toISOString();
  normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
  normalized.lastOutcome = normalized.lastOutcome || null;
  normalized.familySignature = normalized.familySignature || null;
  normalized.variantSignature = normalized.variantSignature || normalized.signature || null;
  normalized.signature = normalized.variantSignature || normalized.signature || null;
  if (!normalized.familySignature && normalized.origin === 'awm' && normalized.signature) {
    normalized.familySignature = normalized.signature;
  }

  if (!normalized.status) {
    normalized.status = normalized.origin === 'awm' ? 'promoted' : 'manual';
  }

  return normalized;
}

function normalizeIndex(index) {
  const out = {};
  for (const [id, entry] of Object.entries(index || {})) {
    out[id] = normalizeSkillEntry(id, entry);
  }
  return out;
}

function isInjectableSkill(entry) {
  const status = String(entry?.status || '').toLowerCase();
  return status === 'promoted' || status === 'manual' || status === 'legacy';
}

function buildLearnedSkillSignature({ keywords = [], tags = [], content = '' } = {}) {
  return buildSkillVariantSignature({ keywords, tags, content });
}

function extractActionSignature(content = '') {
  return Array.from(String(content || '').matchAll(/^\d+\.\s+([a-z_]+)/gmi))
    .map((match) => match[1].toLowerCase())
    .join('>');
}

function extractIntentHints(text = '') {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((value) => value.length >= 3);
  return Array.from(new Set(normalized)).slice(0, 8);
}

function extractProcedureHeading(content = '') {
  const text = String(content || '');
  const markdownHeading = text.match(/^#\s+(.+)$/m);
  if (markdownHeading?.[1]) return markdownHeading[1].trim();
  const procedureHeading = text.match(/^Procedure:\s*(.+)$/mi);
  return procedureHeading?.[1] ? procedureHeading[1].trim() : '';
}

function buildScopeSignature(scope) {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope) return '';
  const tierPart = normalizedScope.tier || '';
  const processPart = (normalizedScope.processNames || []).join('|');
  const titlePart = (normalizedScope.windowTitles || []).map((value) => value.toLowerCase()).join('|');
  const domainPart = (normalizedScope.domains || []).join('|');
  const repoPart = (normalizedScope.repoNames || []).join('|');
  const rootPart = (normalizedScope.projectRoots || []).join('|');
  const appPart = (normalizedScope.appIds || []).join('|');
  const taskFamilyPart = (normalizedScope.taskFamilies || []).join('|');
  const compartmentPart = (normalizedScope.compartmentKeys || []).join('|');
  const kindPart = normalizedScope.kind || '';
  return [tierPart, processPart, titlePart, domainPart, repoPart, rootPart, appPart, taskFamilyPart, compartmentPart, kindPart].join('::');
}

function buildSkillFamilySignature({ keywords = [], tags = [], content = '', verification = '' } = {}) {
  const keywordPart = normalizeArray(keywords).map((value) => value.toLowerCase()).sort().slice(0, 8).join('|');
  const tagPart = normalizeArray(tags)
    .map((value) => value.toLowerCase())
    .filter((value) => !GENERIC_SKILL_TAGS.has(value))
    .sort()
    .slice(0, 6)
    .join('|');
  const actionPart = extractActionSignature(content);
  return [keywordPart, tagPart, actionPart].join('::');
}

function buildSkillVariantSignature({ familySignature, keywords = [], tags = [], content = '', scope, verification = '' } = {}) {
  const resolvedFamilySignature = familySignature || buildSkillFamilySignature({ keywords, tags, content, verification });
  const verificationPart = extractIntentHints(verification).join('|');
  const scopePart = buildScopeSignature(scope);
  return [resolvedFamilySignature, verificationPart, scopePart].join('::');
}

function createVariantId(index, idHint) {
  const baseId = String(idHint || `awm-${Date.now().toString(36)}`).trim() || `awm-${Date.now().toString(36)}`;
  if (!index[baseId]) return baseId;
  let suffix = 2;
  while (index[`${baseId}-v${suffix}`]) suffix += 1;
  return `${baseId}-v${suffix}`;
}

function scoreVariantSpecificity(entry, options = {}) {
  let score = 0;
  const status = String(entry?.status || '').toLowerCase();
  const scope = entry?.scope;
  const matchedSignals = getMatchedScopeSignals(entry, options);

  if (entry?.origin === 'awm' && status === 'promoted') score += 1.5;
  if (!scope) return { score, matchedSignals };

  if (matchedSignals >= 1) score += 2.5;
  if (matchedSignals >= 2) score += 2;
  if (matchedSignals >= 3) score += 1;
  return { score, matchedSignals };
}

function getScopePriority(scopeMatch = {}) {
  const matchedSignals = Number(scopeMatch?.matchedSignals || 0);
  const mismatchedSignals = Number(scopeMatch?.mismatchedSignals || 0);
  const scopeTier = String(scopeMatch?.scopeTier || 'legacy').toLowerCase();

  let priority = matchedSignals;
  if (scopeTier === 'domain' && matchedSignals > 0) priority += 2;
  if (scopeTier === 'local' && matchedSignals > 0 && mismatchedSignals === 0) priority += 1.5;
  if (scopeTier === 'global') priority += 0.25;
  if (mismatchedSignals > 0) priority -= Math.min(1.5, mismatchedSignals * 0.5);
  return priority;
}

function getMatchedScopeSignals(entry, options = {}) {
  return analyzeScopeMatch(entry, options).matchedSignals;
}

function getScopeScore(entry, options = {}) {
  return analyzeScopeMatch(entry, options).score;
}

// ─── Index I/O ──────────────────────────────────────────────

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = normalizeIndex(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')));
      // Prune stale entries — remove skills whose files no longer exist (R7)
      let pruned = false;
      for (const [id, entry] of Object.entries(raw)) {
        const skillPath = path.join(SKILLS_DIR, entry.file || `${id}.md`);
        if (!fs.existsSync(skillPath)) {
          delete raw[id];
          pruned = true;
          console.log(`[SkillRouter] Pruned stale skill: ${id} (file missing)`);
        }
      }
      if (pruned) {
        try { saveIndex(raw); } catch { /* non-critical */ }
      }
      return raw;
    }
  } catch (err) {
    console.warn('[SkillRouter] Failed to read index:', err.message);
  }
  return {};
}

function saveIndex(index) {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

// ─── TF-IDF Scoring ────────────────────────────────────────

/**
 * Tokenize text into lowercase terms, stripping punctuation.
 * Returns an array of terms (words with length >= 2).
 */
function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
}

/**
 * Compute term frequency map for a token array.
 * Returns { term: frequency } where frequency = count / totalTokens.
 */
function termFrequency(tokens) {
  const counts = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
  const total = tokens.length || 1;
  const tf = {};
  for (const [term, count] of Object.entries(counts)) tf[term] = count / total;
  return tf;
}

/**
 * Build IDF map from an array of TF maps.
 * idf(term) = log(N / df(term)) where df = number of docs containing term.
 */
function inverseDocFrequency(tfMaps) {
  const N = tfMaps.length || 1;
  const df = {};
  for (const tf of tfMaps) {
    for (const term of Object.keys(tf)) df[term] = (df[term] || 0) + 1;
  }
  const idf = {};
  for (const [term, count] of Object.entries(df)) idf[term] = Math.log(N / count);
  return idf;
}

/**
 * Convert a TF map into a TF-IDF vector using the given IDF map.
 */
function tfidfVector(tf, idf) {
  const vec = {};
  for (const [term, freq] of Object.entries(tf)) {
    vec[term] = freq * (idf[term] || 0);
  }
  return vec;
}

/**
 * Cosine similarity between two sparse vectors.
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (const term of Object.keys(a)) {
    magA += a[term] * a[term];
    if (b[term]) dot += a[term] * b[term];
  }
  for (const val of Object.values(b)) magB += val * val;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Score all skills using TF-IDF cosine similarity against the query.
 * Returns Map<id, similarity> for entries with similarity > 0.
 */
function tfidfScores(index, queryText) {
  const entries = Object.entries(index);
  if (entries.length === 0) return new Map();

  // Build document text for each skill: keywords + tags + id
  const docTexts = entries.map(([id, entry]) =>
    [id, ...(entry.keywords || []), ...(entry.tags || [])].join(' ')
  );

  // Compute TF for each doc + query
  const docTFs = docTexts.map(t => termFrequency(tokenize(t)));
  const queryTF = termFrequency(tokenize(queryText));

  // IDF from the corpus (docs only, not query)
  const idf = inverseDocFrequency(docTFs);

  // TF-IDF vectors
  const queryVec = tfidfVector(queryTF, idf);

  const scores = new Map();
  entries.forEach(([id], i) => {
    const docVec = tfidfVector(docTFs[i], idf);
    const sim = cosineSimilarity(queryVec, docVec);
    if (sim > 0) scores.set(id, sim);
  });

  return scores;
}

// ─── Scoring ────────────────────────────────────────────────

/**
 * Score a skill against a user message.
 * Returns a number ≥ 0. Higher = more relevant.
 *
 * Scoring strategy:
 *   +2 for each keyword that appears as a whole word in the message
 *   +1 for each tag that appears as a whole word in the message
 *   Recency bonus: +0.5 if used within the last 24h
 */
function scoreSkill(entry, messageLower) {
  let score = 0;

  const keywords = entry.keywords || [];
  for (const kw of keywords) {
    const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(messageLower)) {
      score += 2;
    }
  }

  const tags = entry.tags || [];
  for (const tag of tags) {
    const escaped = tag.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(messageLower)) {
      score += 1;
    }
  }

  // Recency bonus — only applies when there's already a base match
  if (score > 0 && entry.lastUsed) {
    const elapsed = Date.now() - new Date(entry.lastUsed).getTime();
    if (elapsed < 24 * 60 * 60 * 1000) {
      score += 0.5;
    }
  }

  return score;
}

function getRelevantSkillsSelection(userMessage, options = {}) {
  if (!userMessage) return { text: '', ids: [], matches: [] };

  const index = loadIndex();
  const entries = Object.entries(index);
  if (entries.length === 0) return { text: '', ids: [], matches: [] };

  const limit = options.limit || DEFAULT_LIMIT;
  const messageLower = userMessage.toLowerCase();
  const tfidf = tfidfScores(index, userMessage);
  const scopeContext = normalizeScopeContext({ ...options, query: userMessage });

  const scored = entries
    .map(([id, entry]) => {
      if (!isInjectableSkill(entry)) return null;
      const keywordScore = scoreSkill(entry, messageLower);
      const semanticScore = (tfidf.get(id) || 0) * 5;
      const scopeMatch = analyzeScopeMatch(entry, scopeContext);
      const scopeScore = scopeMatch.score;
      const variantSpecificity = scoreVariantSpecificity(entry, scopeContext);
      const variantSpecificityScore = variantSpecificity.score;
      const matchedScopeSignals = variantSpecificity.matchedSignals;
      const scopePriority = getScopePriority(scopeMatch);
      const score = keywordScore + semanticScore + scopeScore + variantSpecificityScore;
      return {
        id,
        entry,
        score,
        keywordScore,
        semanticScore,
        scopeScore,
        scopePriority,
        scopeMatch,
        variantSpecificityScore,
        matchedScopeSignals
      };
    })
    .filter((value) => value && value.score > 0)
    .sort((a, b) =>
      (b.scopePriority - a.scopePriority)
      || (b.score - a.score)
      || ((a.scopeMatch?.mismatchedSignals || 0) - (b.scopeMatch?.mismatchedSignals || 0))
      || (b.variantSpecificityScore - a.variantSpecificityScore)
      || (b.scopeScore - a.scopeScore)
      || (b.keywordScore - a.keywordScore)
    )
    .slice(0, limit);

  if (scored.length === 0) return { text: '', ids: [], matches: [] };

  let totalTokens = 0;
  const sections = [];
  const ids = [];

  for (const match of scored) {
    const { id, entry } = match;
    const skillPath = path.join(SKILLS_DIR, entry.file);
    try {
      if (!fs.existsSync(skillPath)) continue;
      const content = fs.readFileSync(skillPath, 'utf-8');
      const trimmed = truncateToTokenBudget(content, TOKEN_BUDGET - totalTokens);
      if (!trimmed) break;
      sections.push(`### Skill: ${id}\n${trimmed}`);
      ids.push(id);
      totalTokens += countTokens(trimmed);

      entry.lastUsed = new Date().toISOString();
      entry.useCount = (entry.useCount || 0) + 1;
      entry.updatedAt = entry.lastUsed;
    } catch (err) {
      console.warn(`[SkillRouter] Failed to load skill ${id}:`, err.message);
    }
    if (totalTokens >= TOKEN_BUDGET) break;
  }

  try { saveIndex(index); } catch { /* non-critical */ }

  const selectedMatches = scored.slice(0, ids.length);
  const scopedMatchCount = selectedMatches.filter((match) => match.scopeMatch?.classification === 'scoped-match').length;
  const fallbackCount = selectedMatches.filter((match) => ['unscoped-fallback', 'global-fallback'].includes(match.scopeMatch?.classification)).length;
  const mismatchCount = selectedMatches.filter((match) => String(match.scopeMatch?.classification || '').includes('mismatch')).length;
  const globalTierCount = selectedMatches.filter((match) => match.scopeMatch?.scopeTier === 'global').length;
  const domainTierCount = selectedMatches.filter((match) => match.scopeMatch?.scopeTier === 'domain').length;
  const localTierCount = selectedMatches.filter((match) => match.scopeMatch?.scopeTier === 'local').length;

  return {
    text: sections.length ? `\n--- Relevant Skills ---\n${sections.join('\n\n')}\n--- End Skills ---\n` : '',
    ids,
    matches: selectedMatches,
    summary: {
      selectedCount: ids.length,
      scopedMatchCount,
      fallbackCount,
      mismatchCount,
      globalTierCount,
      domainTierCount,
      localTierCount,
      scopeContext: {
        repoName: scopeContext.repoName,
        projectRoot: scopeContext.projectRoot,
        appId: scopeContext.appId,
        currentProcessName: scopeContext.currentProcessName,
        currentWindowKind: scopeContext.currentWindowKind,
        taskFamily: scopeContext.taskFamily,
        compartmentKey: scopeContext.compartmentKey,
        currentUrlHost: scopeContext.currentUrlHost
      }
    }
  };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Return a formatted string of relevant skills for system-prompt injection.
 * Returns empty string if no skills match or no skills exist.
 */
function getRelevantSkillsContext(userMessage, limit) {
  return getRelevantSkillsSelection(userMessage, { limit }).text;
}

/**
 * Register a skill in the index.
 */
function addSkill(id, { file, keywords, tags, content, status, origin, scope, signature, familySignature, variantSignature, verificationHints }) {
  const index = loadIndex();
  const now = new Date().toISOString();
  const resolvedFamilySignature = familySignature || (origin === 'awm' ? buildSkillFamilySignature({ keywords, tags, content, verification: (verificationHints || []).join(' ') }) : null);
  const resolvedVariantSignature = variantSignature || signature || (origin === 'awm' ? buildSkillVariantSignature({
    familySignature: resolvedFamilySignature,
    keywords,
    tags,
    content,
    scope,
    verification: (verificationHints || []).join(' ')
  }) : null);
  const normalized = normalizeSkillEntry(id, {
    file: file || `${id}.md`,
    keywords,
    tags,
    verificationHints,
    status,
    origin,
    scope,
    familySignature: resolvedFamilySignature,
    variantSignature: resolvedVariantSignature,
    signature: resolvedVariantSignature,
    createdAt: now,
    updatedAt: now
  });

  // Write skill file if content provided
  if (content) {
    if (!fs.existsSync(SKILLS_DIR)) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
    }
    const skillPath = path.join(SKILLS_DIR, normalized.file);
    fs.writeFileSync(skillPath, content, 'utf-8');
  }

  index[id] = normalized;

  saveIndex(index);
  return index[id];
}

function upsertLearnedSkill({ idHint, keywords, tags, content, scope, signature, verification }) {
  const index = loadIndex();
  const now = new Date().toISOString();
  const normalizedKeywords = normalizeArray(keywords);
  const normalizedTags = normalizeArray(tags);
  const normalizedVerificationHints = extractIntentHints(verification);
  const normalizedScope = normalizeScope(scope);
  const familySignature = buildSkillFamilySignature({
    keywords: normalizedKeywords,
    tags: normalizedTags,
    content,
    verification
  });
  const learnedSignature = signature || buildSkillVariantSignature({
    familySignature,
    keywords: normalizedKeywords,
    tags: normalizedTags,
    content,
    scope: normalizedScope,
    verification
  });

  const existingId = Object.keys(index).find((id) => {
    const entry = index[id];
    return entry.origin === 'awm' && (entry.variantSignature || entry.signature) && (entry.variantSignature || entry.signature) === learnedSignature;
  });

  const skillId = existingId || createVariantId(index, idHint);
  const entry = existingId
    ? normalizeSkillEntry(skillId, index[skillId])
    : normalizeSkillEntry(skillId, {
        file: `${skillId}.md`,
        keywords: normalizedKeywords,
        tags: normalizedTags,
        verificationHints: normalizedVerificationHints,
        origin: 'awm',
        status: 'candidate',
        scope: normalizedScope,
        familySignature,
        variantSignature: learnedSignature,
        signature: learnedSignature,
        createdAt: now,
        updatedAt: now
      });

  entry.keywords = normalizeArray([...entry.keywords, ...normalizedKeywords]);
  entry.tags = normalizeArray([...entry.tags, ...normalizedTags, 'awm', 'auto-generated']);
  entry.verificationHints = normalizeArray([...(entry.verificationHints || []), ...normalizedVerificationHints]);
  entry.scope = normalizedScope || entry.scope || null;
  entry.origin = 'awm';
  entry.familySignature = familySignature;
  entry.variantSignature = learnedSignature;
  entry.signature = learnedSignature;
  entry.successCount += 1;
  entry.consecutiveFailures = 0;
  entry.lastOutcome = 'success';
  entry.updatedAt = now;

  if (entry.status === 'candidate' && entry.successCount >= PROMOTION_SUCCESS_THRESHOLD) {
    entry.status = 'promoted';
    entry.promotedAt = now;
  }

  index[skillId] = normalizeSkillEntry(skillId, entry);
  if (content) {
    if (!fs.existsSync(SKILLS_DIR)) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(path.join(SKILLS_DIR, index[skillId].file), content, 'utf-8');
  }
  saveIndex(index);

  return {
    id: skillId,
    entry: index[skillId],
    promoted: index[skillId].status === 'promoted',
    created: !existingId
  };
}

function recordSkillOutcome(skillIds, outcome, context = {}) {
  const ids = normalizeArray(skillIds);
  if (!ids.length) return { updated: [], quarantined: [] };

  const index = loadIndex();
  const now = new Date().toISOString();
  const updated = [];
  const quarantined = [];

  for (const id of ids) {
    if (!index[id]) continue;
    const entry = normalizeSkillEntry(id, index[id]);
    entry.lastOutcome = outcome;
    entry.updatedAt = now;

    if (context.currentProcessName) {
      entry.scope = normalizeScope({
        ...(entry.scope || {}),
        processNames: normalizeArray([...(entry.scope?.processNames || []), context.currentProcessName])
      });
    }

    if (context.currentWindowTitle) {
      entry.scope = normalizeScope({
        ...(entry.scope || {}),
        windowTitles: normalizeArray([...(entry.scope?.windowTitles || []), context.currentWindowTitle])
      });
    }

    if (context.currentWindowKind) {
      entry.scope = normalizeScope({
        ...(entry.scope || {}),
        kind: context.currentWindowKind,
        processNames: entry.scope?.processNames || [],
        windowTitles: entry.scope?.windowTitles || [],
        domains: entry.scope?.domains || []
      });
    }

    const currentUrlHost = extractHost(context.currentUrlHost || context.currentUrl || '');
    if (currentUrlHost) {
      entry.scope = normalizeScope({
        ...(entry.scope || {}),
        domains: normalizeArray([...(entry.scope?.domains || []), currentUrlHost])
      });
    }

    if (Array.isArray(context.runningPids) && context.runningPids.length) {
      entry.lastEvidence = {
        ...(entry.lastEvidence || {}),
        runningPids: context.runningPids.filter(Number.isFinite),
        recordedAt: now
      };
    }

    if (outcome === 'success') {
      entry.successCount += 1;
      entry.consecutiveFailures = 0;
      if (entry.status === 'candidate' && entry.successCount >= PROMOTION_SUCCESS_THRESHOLD) {
        entry.status = 'promoted';
        entry.promotedAt = now;
      }
    } else if (outcome === 'failure') {
      entry.failureCount += 1;
      entry.consecutiveFailures += 1;
      if (entry.status === 'promoted' && entry.consecutiveFailures >= QUARANTINE_FAILURE_THRESHOLD) {
        entry.status = 'quarantined';
        entry.quarantinedAt = now;
        quarantined.push(id);
      }
    }

    index[id] = normalizeSkillEntry(id, entry);
    updated.push(id);
  }

  if (updated.length) saveIndex(index);
  return { updated, quarantined };
}

function applyReflectionSkillUpdate(details = {}, rootCause = '') {
  const skillId = String(details.skillId || '').trim();
  if (!skillId) {
    return { applied: false, action: 'skill_update_missing_skill', detail: 'Reflection skill update missing skillId' };
  }

  const index = loadIndex();
  if (!index[skillId]) {
    return { applied: false, action: 'skill_update_missing_skill', detail: `Skill not found: ${skillId}` };
  }

  const entry = normalizeSkillEntry(skillId, index[skillId]);
  const now = new Date().toISOString();
  const updateAction = String(details.skillAction || details.action || 'annotate').trim().toLowerCase();

  if (updateAction === 'quarantine') {
    entry.status = 'quarantined';
    entry.quarantinedAt = now;
    entry.updatedAt = now;
  } else if (updateAction === 'promote') {
    entry.status = 'promoted';
    entry.promotedAt = now;
    entry.updatedAt = now;
  } else {
    entry.updatedAt = now;
  }

  entry.keywords = normalizeArray([...(entry.keywords || []), ...(details.keywords || [])]);
  entry.tags = normalizeArray([...(entry.tags || []), 'reflection']);
  entry.scope = normalizeScope({
    ...(entry.scope || {}),
    processNames: normalizeArray([...(entry.scope?.processNames || []), ...(details.processNames || [])]),
    windowTitles: normalizeArray([...(entry.scope?.windowTitles || []), ...(details.windowTitles || [])]),
    domains: normalizeArray([...(entry.scope?.domains || []), ...(details.domains || [])])
  }) || entry.scope || null;
  entry.reflection = {
    action: updateAction,
    rootCause,
    noteContent: details.noteContent || '',
    updatedAt: now
  };

  index[skillId] = normalizeSkillEntry(skillId, entry);
  saveIndex(index);
  return { applied: true, action: `skill_${updateAction}`, detail: `${skillId}: ${rootCause || 'reflection update applied'}` };
}

/**
 * Remove a skill from the index (does not delete the file).
 */
function removeSkill(id) {
  const index = loadIndex();
  if (index[id]) {
    delete index[id];
    saveIndex(index);
    return true;
  }
  return false;
}

/**
 * List all registered skills.
 */
function listSkills() {
  return loadIndex();
}

module.exports = {
  getRelevantSkillsSelection,
  getRelevantSkillsContext,
  addSkill,
  upsertLearnedSkill,
  recordSkillOutcome,
  applyReflectionSkillUpdate,
  removeSkill,
  listSkills,
  buildLearnedSkillSignature,
  buildSkillFamilySignature,
  buildSkillVariantSignature,
  extractHost,
  // TF-IDF internals (exported for testing)
  tokenize,
  termFrequency,
  inverseDocFrequency,
  tfidfVector,
  cosineSimilarity,
  tfidfScores,
  SKILLS_DIR,
  TOKEN_BUDGET,
  DEFAULT_LIMIT,
  PROMOTION_SUCCESS_THRESHOLD,
  QUARANTINE_FAILURE_THRESHOLD
};
