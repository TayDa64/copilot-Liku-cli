/**
 * Centralized Liku home directory management.
 *
 * Single source of truth for the ~/.liku/ path and its subdirectory structure.
 * Handles one-time migration from the legacy ~/.liku-cli/ layout.
 *
 * Migration strategy: COPY, never move. Old ~/.liku-cli/ remains as fallback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LIKU_HOME = path.join(os.homedir(), '.liku');
const LIKU_HOME_OLD = path.join(os.homedir(), '.liku-cli');

/**
 * Ensure the full ~/.liku/ directory tree exists.
 * Safe to call multiple times (idempotent).
 */
function ensureLikuStructure() {
  const dirs = [
    '',                 // ~/.liku/ itself
    'memory/notes',     // Phase 1: Agentic memory
    'skills',           // Phase 4: Skill router
    'tools/dynamic',    // Phase 3: Dynamic tool sandbox
    'telemetry/logs',   // Phase 2: RLVR telemetry
    'traces'            // Agent trace writer
  ];
  for (const d of dirs) {
    const fullPath = path.join(LIKU_HOME, d);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Copy (not move) JSON config files from ~/.liku-cli/ to ~/.liku/
 * if the target doesn't already exist.
 */
function migrateIfNeeded() {
  const filesToMigrate = [
    'preferences.json',
    'conversation-history.json',
    'copilot-token.json',
    'copilot-runtime-state.json',
    'model-preference.json'
  ];

  for (const file of filesToMigrate) {
    const oldPath = path.join(LIKU_HOME_OLD, file);
    const newPath = path.join(LIKU_HOME, file);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.copyFileSync(oldPath, newPath);
        console.log(`[Liku] Migrated ${file} to ~/.liku/`);
      }
    } catch (err) {
      console.warn(`[Liku] Could not migrate ${file}: ${err.message}`);
    }
  }

  // Migrate traces directory if it exists
  const oldTraces = path.join(LIKU_HOME_OLD, 'traces');
  const newTraces = path.join(LIKU_HOME, 'traces');
  try {
    if (fs.existsSync(oldTraces) && fs.statSync(oldTraces).isDirectory()) {
      const traceFiles = fs.readdirSync(oldTraces);
      for (const tf of traceFiles) {
        const src = path.join(oldTraces, tf);
        const dst = path.join(newTraces, tf);
        if (!fs.existsSync(dst) && fs.statSync(src).isFile()) {
          fs.copyFileSync(src, dst);
        }
      }
    }
  } catch (err) {
    console.warn(`[Liku] Could not migrate traces: ${err.message}`);
  }
}

/**
 * Return the canonical home directory path.
 */
function getLikuHome() {
  return LIKU_HOME;
}

module.exports = {
  LIKU_HOME,
  LIKU_HOME_OLD,
  ensureLikuStructure,
  migrateIfNeeded,
  getLikuHome
};
