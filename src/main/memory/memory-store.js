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
 * Token budget: hard cap on injected memory context (default 2000 chars).
 */

const fs = require('fs');
const path = require('path');
const { LIKU_HOME } = require('../../shared/liku-home');
const linker = require('./memory-linker');

const MEMORY_DIR = path.join(LIKU_HOME, 'memory');
const NOTES_DIR = path.join(MEMORY_DIR, 'notes');
const INDEX_FILE = path.join(MEMORY_DIR, 'index.json');

const MEMORY_TOKEN_BUDGET = 2000;
const DEFAULT_NOTE_LIMIT = 5;

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

  const note = {
    id,
    type: noteData.type || 'episodic',
    content: noteData.content,
    context: noteData.context || '',
    keywords: noteData.keywords || [],
    tags: noteData.tags || [],
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
    links: [],
    createdAt: now,
    updatedAt: now
  };

  // Find and create links to related notes
  linker.linkNote(id, note, index);
  writeNote(note); // re-write with links

  saveIndex(index);
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
  if (updates.links) note.links = updates.links;
  note.updatedAt = now;

  writeNote(note);

  // Update index
  const index = loadIndex();
  if (index.notes[id]) {
    index.notes[id].keywords = note.keywords;
    index.notes[id].tags = note.tags;
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
function getRelevantNotes(query, limit) {
  if (!query) return [];
  limit = limit || DEFAULT_NOTE_LIMIT;

  const index = loadIndex();
  const entries = Object.entries(index.notes || {});
  if (entries.length === 0) return [];

  const queryLower = query.toLowerCase();

  const scored = entries
    .map(([id, entry]) => ({ id, entry, score: scoreNote(entry, queryLower) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored
    .map(s => readNote(s.id))
    .filter(Boolean);
}

/**
 * Format relevant notes as a system-prompt–injectable string.
 * Respects MEMORY_TOKEN_BUDGET.
 */
function getMemoryContext(query, limit) {
  const notes = getRelevantNotes(query, limit);
  if (notes.length === 0) return '';

  let totalLen = 0;
  const sections = [];

  for (const note of notes) {
    const entry = `[${note.type}] ${note.content}`;
    if (totalLen + entry.length > MEMORY_TOKEN_BUDGET) break;
    sections.push(entry);
    totalLen += entry.length;
  }

  if (sections.length === 0) return '';
  return `\n--- Memory Context ---\n${sections.join('\n')}\n--- End Memory ---\n`;
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
  getRelevantNotes,
  getMemoryContext,
  listNotes,
  generateNoteId,
  MEMORY_DIR,
  NOTES_DIR,
  MEMORY_TOKEN_BUDGET,
  DEFAULT_NOTE_LIMIT
};
