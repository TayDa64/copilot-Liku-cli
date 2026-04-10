/**
 * Agentic Memory Store — A-MEM–inspired structured memory
 *
 * Manages a Zettelkasten-style note system persisted to ~/.liku/memory/.
 * Each note has type (episodic/procedural/semantic), keywords, tags,
 * and links to related notes.
 *
 * Integration:
 *   - getRelevantNotes(query, limit) → for system-prompt injection
 *   - getMemoryContext(query) → formatted string for system prompt
 *   - addNote(noteData) → after completed interactions
 *   - updateNote(id, updates) → memory evolution
 *
 * Token budget: hard cap on injected memory context (default 2000 BPE tokens).
 */

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const linker = require('./memory-linker');
const { countTokens, truncateToTokenBudget } = require('../../shared/token-counter');

const MEMORY_DIR = path.join(LIKU_HOME, 'memory');
const NOTES_DIR = path.join(MEMORY_DIR, 'notes');
const INDEX_FILE = path.join(MEMORY_DIR, 'index.json');

const MEMORY_TOKEN_BUDGET = 2000;
const DEFAULT_NOTE_LIMIT = 5;
const MAX_NOTES = 500;
const MEMORY_VERBOSE = /^(1|true|yes)$/i.test(String(process.env.LIKU_MEMORY_VERBOSE || '').trim());

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

  const repoNames = normalizeArray(scope.repoNames).map((value) => value.toLowerCase());
  const projectRoots = normalizeArray(scope.projectRoots).map((value) => path.resolve(String(value || '')).toLowerCase());
  const appIds = normalizeArray(scope.appIds).map((value) => value.toLowerCase());
  const processNames = normalizeArray(scope.processNames).map((value) => value.toLowerCase());
  const taskFamilies = normalizeArray(scope.taskFamilies).map((value) => value.toLowerCase());
  const compartmentKeys = normalizeArray(scope.compartmentKeys).map((value) => value.toLowerCase());
  const tier = normalizeScopeTier(scope.tier || scope.scopeTier);

  if (!repoNames.length
    && !projectRoots.length
    && !appIds.length
    && !processNames.length
    && !taskFamilies.length
    && !compartmentKeys.length
    && !tier) {
    return null;
  }

  return {
    ...(tier ? { tier } : {}),
    ...(repoNames.length ? { repoNames } : {}),
    ...(projectRoots.length ? { projectRoots } : {}),
    ...(appIds.length ? { appIds } : {}),
    ...(processNames.length ? { processNames } : {}),
    ...(taskFamilies.length ? { taskFamilies } : {}),
    ...(compartmentKeys.length ? { compartmentKeys } : {})
  };
}

function normalizeSelectionOptions(limitOrOptions, fallbackOptions = {}) {
  if (typeof limitOrOptions === 'number') {
    return { ...fallbackOptions, limit: limitOrOptions };
  }
  if (limitOrOptions && typeof limitOrOptions === 'object') {
    return { ...limitOrOptions };
  }
  return { ...fallbackOptions };
}

function buildSelectionContext(options = {}) {
  const envelope = options.executionContextEnvelope && typeof options.executionContextEnvelope === 'object'
    ? options.executionContextEnvelope
    : null;
  const projectRootRaw = String(options.projectRoot || envelope?.repo?.projectRoot || '').trim();
  return {
    repoName: String(options.repoName || envelope?.repo?.name || '').trim().toLowerCase() || null,
    projectRoot: projectRootRaw ? path.resolve(projectRootRaw).toLowerCase() : null,
    appId: String(options.appId || envelope?.foreground?.appId || '').trim().toLowerCase() || null,
    processName: String(options.processName || options.currentProcessName || envelope?.foreground?.processName || '').trim().toLowerCase() || null,
    taskFamily: String(options.taskFamily || envelope?.taskFamily || '').trim().toLowerCase() || null,
    compartmentKey: String(options.compartmentKey || envelope?.compartmentKey || '').trim().toLowerCase() || null
  };
}

function evaluateScopeSignal(values, currentValue) {
  const candidates = normalizeArray(values).map((value) => String(value || '').trim().toLowerCase());
  const current = String(currentValue || '').trim().toLowerCase();
  if (!candidates.length) return { applicable: false, matched: false, mismatched: false };
  if (!current) return { applicable: true, matched: false, mismatched: false };
  const matched = candidates.some((candidate) => current === candidate || current.includes(candidate) || candidate.includes(current));
  return {
    applicable: true,
    matched,
    mismatched: !matched
  };
}

function analyzeNoteScope(scope, selectionContext = {}) {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope) {
    return {
      score: 0,
      matchedSignals: 0,
      mismatchedSignals: 0,
      classification: 'unscoped-fallback',
      scopeTier: 'unscoped'
    };
  }

  const scopeTier = normalizeScopeTier(normalizedScope.tier) || 'legacy';

  const signals = [
    { evaluation: evaluateScopeSignal(normalizedScope.compartmentKeys, selectionContext.compartmentKey), weight: 6, mismatchPenalty: -4 },
    { evaluation: evaluateScopeSignal(normalizedScope.repoNames, selectionContext.repoName), weight: 4, mismatchPenalty: -2.5 },
    { evaluation: evaluateScopeSignal(normalizedScope.projectRoots, selectionContext.projectRoot), weight: 4, mismatchPenalty: -2.5 },
    { evaluation: evaluateScopeSignal(normalizedScope.appIds, selectionContext.appId), weight: 3.5, mismatchPenalty: -2.5 },
    { evaluation: evaluateScopeSignal(normalizedScope.processNames, selectionContext.processName), weight: 2.5, mismatchPenalty: -1.5 },
    { evaluation: evaluateScopeSignal(normalizedScope.taskFamilies, selectionContext.taskFamily), weight: 3, mismatchPenalty: -2 }
  ];

  let score = 0;
  let matchedSignals = 0;
  let mismatchedSignals = 0;

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

  signals.forEach(({ evaluation, weight, mismatchPenalty }) => {
    if (!evaluation.applicable) return;
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
    classification,
    scopeTier
  };
}

// ─── ULID-lite (monotonic, no dependency) ──────────────────

let lastTs = 0;
let counter = 0;

function generateNoteId() {
  const now = Date.now();
  if (now === lastTs) {
    counter++;
  } else {
    lastTs = now;
    counter = 0;
  }
  const ts = now.toString(36).padStart(9, '0');
  const seq = counter.toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `note-${ts}${seq}${rand}`;
}

// ─── Index I/O ──────────────────────────────────────────────

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch (err) {
    console.warn('[Memory] Failed to read index:', err.message);
  }
  return { notes: {} };
}

function saveIndex(index) {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

// ─── Note I/O ───────────────────────────────────────────────

function readNote(id) {
  const notePath = path.join(NOTES_DIR, `${id}.json`);
  try {
    if (fs.existsSync(notePath)) {
      return JSON.parse(fs.readFileSync(notePath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[Memory] Failed to read note ${id}:`, err.message);
  }
  return null;
}

function writeNote(note) {
  if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
  }
  const notePath = path.join(NOTES_DIR, `${note.id}.json`);
  fs.writeFileSync(notePath, JSON.stringify(note, null, 2), 'utf-8');
}

function deleteNoteFile(id) {
  const notePath = path.join(NOTES_DIR, `${id}.json`);
  try {
    if (fs.existsSync(notePath)) {
      fs.unlinkSync(notePath);
    }
  } catch (err) {
    console.warn(`[Memory] Failed to delete note file ${id}:`, err.message);
  }
}

// ─── LRU Pruning ────────────────────────────────────────────

/**
 * Prune oldest notes when the index exceeds MAX_NOTES.
 * Removes least-recently-updated notes first.
 */
function pruneOldNotes() {
  const index = loadIndex();
  const noteIds = Object.keys(index.notes || {});
  if (noteIds.length <= MAX_NOTES) return 0;

  const sortedByAge = noteIds
    .map(id => ({ id, updatedAt: index.notes[id].updatedAt || index.notes[id].createdAt || '' }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const toRemove = sortedByAge.slice(0, noteIds.length - MAX_NOTES);
  for (const { id } of toRemove) {
    deleteNoteFile(id);
    delete index.notes[id];
  }

  saveIndex(index);
  if (MEMORY_VERBOSE) {
    console.log(`[Memory] Pruned ${toRemove.length} old notes (limit: ${MAX_NOTES})`);
  }
  return toRemove.length;
}

// ─── Scoring ────────────────────────────────────────────────

/**
 * Score a note's relevance to a query.
 * +2 per keyword match, +1 per tag match, +0.5 recency bonus.
 */
function scoreNote(indexEntry, queryLower) {
  let score = 0;

  for (const kw of (indexEntry.keywords || [])) {
    if (queryLower.includes(kw.toLowerCase())) {
      score += 2;
    }
  }

  for (const tag of (indexEntry.tags || [])) {
    if (queryLower.includes(tag.toLowerCase())) {
      score += 1;
    }
  }

  // Recency bonus — only applies when there's already a base match
  if (score > 0) {
    const ts = indexEntry.updatedAt || indexEntry.createdAt;
    if (ts) {
      const elapsed = Date.now() - new Date(ts).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) score += 0.5;
    }
  }

  return score;
}

function buildSelectionSummary(selected = [], selectionContext = {}) {
  return {
    selectedCount: selected.length,
    scopedMatchCount: selected.filter((entry) => entry.scopeMatch?.classification === 'scoped-match').length,
    fallbackCount: selected.filter((entry) => ['unscoped-fallback', 'global-fallback'].includes(entry.scopeMatch?.classification)).length,
    mismatchCount: selected.filter((entry) => String(entry.scopeMatch?.classification || '').includes('mismatch')).length,
    globalTierCount: selected.filter((entry) => entry.scopeMatch?.scopeTier === 'global').length,
    domainTierCount: selected.filter((entry) => entry.scopeMatch?.scopeTier === 'domain').length,
    localTierCount: selected.filter((entry) => entry.scopeMatch?.scopeTier === 'local').length,
    scopeContext: {
      repoName: selectionContext.repoName,
      projectRoot: selectionContext.projectRoot,
      appId: selectionContext.appId,
      processName: selectionContext.processName,
      taskFamily: selectionContext.taskFamily,
      compartmentKey: selectionContext.compartmentKey
    }
  };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Add a new memory note.
 *
 * @param {{ type: 'episodic'|'procedural'|'semantic', content: string,
 *           context?: string, keywords?: string[], tags?: string[],
 *           source?: object }} noteData
 * @returns {object} The full note object
 */
function addNote(noteData) {
  const id = generateNoteId();
  const now = new Date().toISOString();
  const normalizedScope = normalizeScope(noteData.scope);

  const note = {
    id,
    type: noteData.type || 'episodic',
    content: noteData.content,
    context: noteData.context || '',
    keywords: noteData.keywords || [],
    tags: noteData.tags || [],
    scope: normalizedScope,
    source: noteData.source || null,
    links: [],
    createdAt: now,
    updatedAt: now
  };

  writeNote(note);

  // Update index
  const index = loadIndex();
  index.notes[id] = {
    type: note.type,
    keywords: note.keywords,
    tags: note.tags,
    scope: note.scope,
    links: [],
    createdAt: now,
    updatedAt: now
  };

  // Find and create links to related notes
  linker.linkNote(id, note, index);
  writeNote(note); // re-write with links

  saveIndex(index);

  // LRU pruning — keep index within MAX_NOTES
  pruneOldNotes();

  return note;
}

/**
 * Update an existing note (memory evolution).
 */
function updateNote(id, updates) {
  const note = readNote(id);
  if (!note) return null;

  const now = new Date().toISOString();
  if (updates.content !== undefined) note.content = updates.content;
  if (updates.context !== undefined) note.context = updates.context;
  if (updates.keywords) note.keywords = updates.keywords;
  if (updates.tags) note.tags = updates.tags;
  if (updates.scope !== undefined) note.scope = normalizeScope(updates.scope);
  if (updates.links) note.links = updates.links;
  note.updatedAt = now;

  writeNote(note);

  // Update index
  const index = loadIndex();
  if (index.notes[id]) {
    index.notes[id].keywords = note.keywords;
    index.notes[id].tags = note.tags;
    index.notes[id].scope = note.scope || null;
    index.notes[id].updatedAt = now;

    // Re-link after keyword/tag changes
    linker.linkNote(id, note, index);
    writeNote(note);
    saveIndex(index);
  }

  return note;
}

/**
 * Remove a note from memory.
 */
function removeNote(id) {
  const index = loadIndex();
  if (!index.notes[id]) return false;

  // Remove reverse links from connected notes
  const noteObj = readNote(id);
  if (noteObj && noteObj.links) {
    for (const linkedId of noteObj.links) {
      const linked = readNote(linkedId);
      if (linked && linked.links) {
        linked.links = linked.links.filter(l => l !== id);
        writeNote(linked);
      }
      // Also clean index links
      if (index.notes[linkedId] && index.notes[linkedId].links) {
        index.notes[linkedId].links = index.notes[linkedId].links.filter(l => l !== id);
      }
    }
  }

  deleteNoteFile(id);
  delete index.notes[id];
  saveIndex(index);
  return true;
}

/**
 * Retrieve a single note by ID.
 */
function getNote(id) {
  return readNote(id);
}

/**
 * Retrieve notes relevant to a query, ranked by keyword/tag overlap.
 * @param {string} query - The user's message or task description
 * @param {number} [limit] - Maximum notes to return (default: 5)
 * @returns {object[]} Array of full note objects, highest relevance first
 */
function getRelevantNotesSelection(query, options = {}) {
  if (!query) {
    return {
      text: '',
      ids: [],
      notes: [],
      matches: [],
      summary: buildSelectionSummary([], buildSelectionContext(normalizeSelectionOptions(options, { limit: DEFAULT_NOTE_LIMIT })))
    };
  }

  const normalizedOptions = normalizeSelectionOptions(options, { limit: DEFAULT_NOTE_LIMIT });
  const limit = normalizedOptions.limit || DEFAULT_NOTE_LIMIT;

  const index = loadIndex();
  const entries = Object.entries(index.notes || {});
  if (entries.length === 0) return { text: '', ids: [], notes: [], matches: [], summary: buildSelectionSummary([], buildSelectionContext(normalizedOptions)) };

  const queryLower = query.toLowerCase();
  const selectionContext = buildSelectionContext(normalizedOptions);

  const scored = entries
    .map(([id, entry]) => {
      const baseScore = scoreNote(entry, queryLower);
      const scopeMatch = analyzeNoteScope(entry.scope, selectionContext);
      return {
        id,
        entry,
        baseScore,
        score: baseScore + scopeMatch.score,
        scopeMatch
      };
    })
    .filter(s => s.score > 0)
    .sort((a, b) =>
      (b.score - a.score)
      || ((a.scopeMatch?.mismatchedSignals || 0) - (b.scopeMatch?.mismatchedSignals || 0))
      || ((b.scopeMatch?.matchedSignals || 0) - (a.scopeMatch?.matchedSignals || 0))
    )
    .slice(0, limit);

  const notes = scored
    .map((selection) => {
      const note = readNote(selection.id);
      if (!note) return null;
      return {
        ...selection,
        note
      };
    })
    .filter(Boolean);

  let totalTokens = 0;
  const sections = [];
  const selectedIds = [];
  const selectedMatches = [];

  for (const selection of notes) {
    const entry = `[${selection.note.type}] ${selection.note.content}`;
    const entryTokens = countTokens(entry);
    if (totalTokens + entryTokens > MEMORY_TOKEN_BUDGET) break;
    sections.push(entry);
    totalTokens += entryTokens;
    selectedIds.push(selection.id);
    selectedMatches.push(selection);
  }

  return {
    text: sections.length ? `\n--- Memory Context ---\n${sections.join('\n')}\n--- End Memory ---\n` : '',
    ids: selectedIds,
    notes: selectedMatches.map((selection) => selection.note),
    matches: selectedMatches,
    summary: buildSelectionSummary(selectedMatches, selectionContext)
  };
}

function getRelevantNotes(query, limitOrOptions) {
  const selection = getRelevantNotesSelection(query, limitOrOptions);
  return Array.isArray(selection.notes) ? selection.notes : [];
}

/**
 * Format relevant notes as a system-prompt–injectable string.
 * Respects MEMORY_TOKEN_BUDGET.
 */
function getMemoryContext(query, limitOrOptions) {
  return getRelevantNotesSelection(query, limitOrOptions).text || '';
}

/**
 * List all note IDs and their index metadata.
 */
function listNotes() {
  return loadIndex().notes || {};
}

module.exports = {
  addNote,
  updateNote,
  removeNote,
  getNote,
  getRelevantNotesSelection,
  getRelevantNotes,
  getMemoryContext,
  listNotes,
  pruneOldNotes,
  generateNoteId,
  MEMORY_DIR,
  NOTES_DIR,
  MEMORY_TOKEN_BUDGET,
  DEFAULT_NOTE_LIMIT,
  MAX_NOTES
};
