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

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const processNames = normalizeArray(scope.processNames).map((value) => value.toLowerCase());
  const windowTitles = normalizeArray(scope.windowTitles);
  const domains = normalizeArray(scope.domains).map((value) => extractHost(value) || value.toLowerCase());
  const kind = scope.kind ? String(scope.kind).trim().toLowerCase() : null;
  if (!processNames.length && !windowTitles.length && !domains.length && !kind) return null;
  return {
    ...(kind ? { kind } : {}),
    ...(processNames.length ? { processNames } : {}),
    ...(windowTitles.length ? { windowTitles } : {}),
    ...(domains.length ? { domains } : {})
  };
}

function normalizeSkillEntry(id, entry = {}) {
  const normalized = { ...entry };
  normalized.file = normalized.file || `${id}.md`;
  normalized.keywords = normalizeArray(normalized.keywords);
  normalized.tags = normalizeArray(normalized.tags);
  normalized.scope = normalizeScope(normalized.scope);
  normalized.origin = normalized.origin || (id.startsWith('awm-') ? 'awm' : 'legacy');
  normalized.successCount = Number.isFinite(Number(normalized.successCount)) ? Number(normalized.successCount) : 0;
  normalized.failureCount = Number.isFinite(Number(normalized.failureCount)) ? Number(normalized.failureCount) : 0;
  normalized.consecutiveFailures = Number.isFinite(Number(normalized.consecutiveFailures)) ? Number(normalized.consecutiveFailures) : 0;
  normalized.useCount = Number.isFinite(Number(normalized.useCount)) ? Number(normalized.useCount) : 0;
  normalized.createdAt = normalized.createdAt || new Date().toISOString();
  normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
  normalized.lastOutcome = normalized.lastOutcome || null;
  normalized.signature = normalized.signature || null;

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
  const keywordPart = normalizeArray(keywords).map((value) => value.toLowerCase()).sort().slice(0, 8).join('|');
  const tagPart = normalizeArray(tags).map((value) => value.toLowerCase()).sort().slice(0, 6).join('|');
  const actionPart = Array.from(String(content || '').matchAll(/^\d+\.\s+([a-z_]+)/gmi))
    .map((match) => match[1].toLowerCase())
    .join('>');
  return [keywordPart, tagPart, actionPart].join('::');
}

function getScopeScore(entry, options = {}) {
  const scope = entry?.scope;
  if (!scope) return 0;

  let score = 0;
  const currentProcessName = String(options.currentProcessName || '').trim().toLowerCase();
  if (currentProcessName && Array.isArray(scope.processNames) && scope.processNames.length) {
    if (scope.processNames.some((value) => currentProcessName === value || currentProcessName.includes(value) || value.includes(currentProcessName))) {
      score += 3;
    } else {
      score -= 1.5;
    }
  }

  const queryLower = String(options.query || '').toLowerCase();
  if (queryLower && Array.isArray(scope.domains) && scope.domains.length) {
    if (scope.domains.some((value) => queryLower.includes(value))) {
      score += 1.5;
    }
  }

  const currentWindowTitle = String(options.currentWindowTitle || '').trim().toLowerCase();
  if (currentWindowTitle && Array.isArray(scope.windowTitles) && scope.windowTitles.length) {
    if (scope.windowTitles.some((value) => {
      const normalizedValue = String(value || '').trim().toLowerCase();
      return normalizedValue && (currentWindowTitle.includes(normalizedValue) || normalizedValue.includes(currentWindowTitle));
    })) {
      score += 2;
    }
  }

  const currentWindowKind = String(options.currentWindowKind || '').trim().toLowerCase();
  const scopeKind = String(scope.kind || '').trim().toLowerCase();
  if (currentWindowKind && scopeKind) {
    if (currentWindowKind === scopeKind) score += 2;
    else score -= 1;
  }

  const currentUrlHost = extractHost(options.currentUrlHost || options.currentUrl || '');
  if (currentUrlHost && Array.isArray(scope.domains) && scope.domains.length) {
    if (scope.domains.some((value) => currentUrlHost === value || currentUrlHost.endsWith(`.${value}`) || value.endsWith(`.${currentUrlHost}`))) {
      score += 3;
    } else {
      score -= 1;
    }
  }

  return score;
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

  const scored = entries
    .map(([id, entry]) => {
      if (!isInjectableSkill(entry)) return null;
      const keywordScore = scoreSkill(entry, messageLower);
      const semanticScore = (tfidf.get(id) || 0) * 5;
      const scopeScore = getScopeScore(entry, {
        currentProcessName: options.currentProcessName,
        currentWindowTitle: options.currentWindowTitle,
        currentWindowKind: options.currentWindowKind,
        currentUrlHost: options.currentUrlHost,
        query: userMessage
      });
      const score = keywordScore + semanticScore + scopeScore;
      return { id, entry, score, keywordScore, semanticScore, scopeScore };
    })
    .filter((value) => value && value.score > 0)
    .sort((a, b) => b.score - a.score)
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

  return {
    text: sections.length ? `\n--- Relevant Skills ---\n${sections.join('\n\n')}\n--- End Skills ---\n` : '',
    ids,
    matches: scored.slice(0, ids.length)
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
function addSkill(id, { file, keywords, tags, content, status, origin, scope, signature }) {
  const index = loadIndex();
  const now = new Date().toISOString();
  const normalized = normalizeSkillEntry(id, {
    file: file || `${id}.md`,
    keywords,
    tags,
    status,
    origin,
    scope,
    signature,
    createdAt: now,
    updatedAt: now
  });

  // Write skill file if content provided
  if (content) {
    const skillPath = path.join(SKILLS_DIR, normalized.file);
    fs.writeFileSync(skillPath, content, 'utf-8');
  }

  index[id] = normalized;

  saveIndex(index);
  return index[id];
}

function upsertLearnedSkill({ idHint, keywords, tags, content, scope, signature }) {
  const index = loadIndex();
  const now = new Date().toISOString();
  const normalizedKeywords = normalizeArray(keywords);
  const normalizedTags = normalizeArray(tags);
  const normalizedScope = normalizeScope(scope);
  const learnedSignature = signature || buildLearnedSkillSignature({
    keywords: normalizedKeywords,
    tags: normalizedTags,
    content
  });

  const existingId = Object.keys(index).find((id) => {
    const entry = index[id];
    return entry.origin === 'awm' && entry.signature && entry.signature === learnedSignature;
  });

  const skillId = existingId || idHint || `awm-${Date.now().toString(36)}`;
  const entry = existingId
    ? normalizeSkillEntry(skillId, index[skillId])
    : normalizeSkillEntry(skillId, {
        file: `${skillId}.md`,
        keywords: normalizedKeywords,
        tags: normalizedTags,
        origin: 'awm',
        status: 'candidate',
        scope: normalizedScope,
        signature: learnedSignature,
        createdAt: now,
        updatedAt: now
      });

  entry.keywords = normalizeArray([...entry.keywords, ...normalizedKeywords]);
  entry.tags = normalizeArray([...entry.tags, ...normalizedTags, 'awm', 'auto-generated']);
  entry.scope = normalizedScope || entry.scope || null;
  entry.origin = 'awm';
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
