/**
 * Memory Linker — Zettelkasten-style note linking
 *
 * Detects keyword/tag overlap between notes and maintains bidirectional links.
 * Called by memory-store.js after adding or updating a note.
 *
 * A-MEM adaptation: as new memories are integrated, they trigger updates
 * to existing memories' link representations, enabling continuous refinement.
 */

const LINK_THRESHOLD = 2; // minimum overlap score to create a link

/**
 * Calculate overlap score between two sets of keywords/tags.
 */
function overlapScore(noteA, noteB) {
  let score = 0;

  const kwA = new Set((noteA.keywords || []).map(k => k.toLowerCase()));
  const kwB = new Set((noteB.keywords || []).map(k => k.toLowerCase()));
  for (const kw of kwA) {
    if (kwB.has(kw)) score += 2;
  }

  const tagA = new Set((noteA.tags || []).map(t => t.toLowerCase()));
  const tagB = new Set((noteB.tags || []).map(t => t.toLowerCase()));
  for (const tag of tagA) {
    if (tagB.has(tag)) score += 1;
  }

  return score;
}

/**
 * Scan the index for notes that overlap with a new/updated note,
 * and create bidirectional links where the score meets the threshold.
 *
 * Mutates the index in-place (caller must save it).
 *
 * @param {string} noteId - ID of the new/updated note
 * @param {object} note - The full note object
 * @param {object} index - The index object { notes: { ... } }
 */
function linkNote(noteId, note, index) {
  const entries = Object.entries(index.notes || {});

  for (const [otherId, otherEntry] of entries) {
    if (otherId === noteId) continue;

    const score = overlapScore(note, otherEntry);
    if (score < LINK_THRESHOLD) continue;

    // Add link from new note → other
    if (!note.links) note.links = [];
    if (!note.links.includes(otherId)) {
      note.links.push(otherId);
    }

    // Add reverse link from other → new note (in index only; caller
    // persists the full note separately if needed)
    if (!otherEntry.links) otherEntry.links = [];
    if (!otherEntry.links.includes(noteId)) {
      otherEntry.links.push(noteId);
    }
  }
}

module.exports = {
  linkNote,
  overlapScore,
  LINK_THRESHOLD
};
