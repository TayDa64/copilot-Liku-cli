/**
 * Semantic Skill Router
 *
 * Prevents context-window bloat by loading only the skills relevant to the
 * current user message. Uses lightweight keyword matching against an index
 * stored at ~/.liku/skills/index.json.
 *
 * Interface: getRelevantSkillsContext(userMessage, limit?) → string
 *            addSkill(id, { file, keywords, tags }) → void
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

// ─── Index I/O ──────────────────────────────────────────────

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
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

// ─── Public API ─────────────────────────────────────────────

/**
 * Return a formatted string of relevant skills for system-prompt injection.
 * Returns empty string if no skills match or no skills exist.
 */
function getRelevantSkillsContext(userMessage, limit) {
  if (!userMessage) return '';
  const index = loadIndex();
  const entries = Object.entries(index);
  if (entries.length === 0) return '';

  limit = limit || DEFAULT_LIMIT;
  const messageLower = userMessage.toLowerCase();

  // Score and rank
  const scored = entries
    .map(([id, entry]) => ({ id, entry, score: scoreSkill(entry, messageLower) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) return '';

  // Load skill content up to TOKEN_BUDGET
  let totalTokens = 0;
  const sections = [];

  for (const { id, entry } of scored) {
    const skillPath = path.join(SKILLS_DIR, entry.file);
    try {
      if (!fs.existsSync(skillPath)) continue;
      const content = fs.readFileSync(skillPath, 'utf-8');
      const trimmed = truncateToTokenBudget(content, TOKEN_BUDGET - totalTokens);
      if (!trimmed) break;
      sections.push(`### Skill: ${id}\n${trimmed}`);
      totalTokens += countTokens(trimmed);

      // Record usage
      entry.lastUsed = new Date().toISOString();
      entry.useCount = (entry.useCount || 0) + 1;
    } catch (err) {
      console.warn(`[SkillRouter] Failed to load skill ${id}:`, err.message);
    }
    if (totalTokens >= TOKEN_BUDGET) break;
  }

  // Persist usage stats
  try { saveIndex(index); } catch { /* non-critical */ }

  if (sections.length === 0) return '';
  return `\n--- Relevant Skills ---\n${sections.join('\n\n')}\n--- End Skills ---\n`;
}

/**
 * Register a skill in the index.
 */
function addSkill(id, { file, keywords, tags, content }) {
  const index = loadIndex();

  // Write skill file if content provided
  if (content) {
    const skillFile = file || `${id}.md`;
    const skillPath = path.join(SKILLS_DIR, skillFile);
    fs.writeFileSync(skillPath, content, 'utf-8');
    index[id] = {
      file: skillFile,
      keywords: keywords || [],
      tags: tags || [],
      lastUsed: null,
      useCount: 0,
      createdAt: new Date().toISOString()
    };
  } else {
    index[id] = {
      file: file || `${id}.md`,
      keywords: keywords || [],
      tags: tags || [],
      lastUsed: null,
      useCount: 0,
      createdAt: new Date().toISOString()
    };
  }

  saveIndex(index);
  return index[id];
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
  getRelevantSkillsContext,
  addSkill,
  removeSkill,
  listSkills,
  SKILLS_DIR,
  TOKEN_BUDGET,
  DEFAULT_LIMIT
};
