/**
 * liku memory — Manage agent memory (A-MEM notes)
 *
 * Usage:
 *   liku memory list              List all memory notes
 *   liku memory show <id>         Show a specific note
 *   liku memory search <query>    Search notes by keyword
 *   liku memory stats             Show memory statistics
 */

const path = require('path');
const { log, success, error, dim, highlight } = require('../util/output');

function getMemoryStore() {
  return require('../../main/memory/memory-store');
}

async function run(args, flags) {
  const subcommand = args[0] || 'list';
  const store = getMemoryStore();

  switch (subcommand) {
    case 'list': {
      const notes = store.listNotes();
      if (!notes || notes.length === 0) {
        log('No memory notes found.');
        return { success: true, count: 0 };
      }
      if (flags.json) return { success: true, count: notes.length, notes };
      log(highlight(`Memory Notes (${notes.length}):`));
      for (const note of notes) {
        const preview = (note.content || '').slice(0, 80).replace(/\n/g, ' ');
        log(`  ${highlight(note.id)} [${note.type || 'general'}] ${dim(preview)}`);
      }
      return { success: true, count: notes.length };
    }

    case 'show': {
      const id = args[1];
      if (!id) { error('Usage: liku memory show <id>'); return { success: false }; }
      const note = store.getNote(id);
      if (!note) { error(`Note not found: ${id}`); return { success: false }; }
      if (flags.json) return { success: true, note };
      log(highlight(`Note: ${note.id}`));
      log(`  Type: ${note.type || 'general'}`);
      log(`  Tags: ${(note.tags || []).join(', ') || 'none'}`);
      log(`  Keywords: ${(note.keywords || []).join(', ') || 'none'}`);
      log(`  Created: ${note.createdAt || 'unknown'}`);
      log(`  Updated: ${note.updatedAt || 'unknown'}`);
      log(`\n${note.content}`);
      return { success: true, note };
    }

    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) { error('Usage: liku memory search <query>'); return { success: false }; }
      const context = store.getMemoryContext(query);
      if (!context) {
        log('No matching notes found.');
        return { success: true, count: 0, context: '' };
      }
      if (flags.json) return { success: true, context };
      log(context);
      return { success: true, context };
    }

    case 'stats': {
      const notes = store.listNotes();
      const count = notes ? notes.length : 0;
      const byType = {};
      if (notes) {
        for (const n of notes) {
          const t = n.type || 'general';
          byType[t] = (byType[t] || 0) + 1;
        }
      }
      if (flags.json) return { success: true, count, byType };
      log(highlight('Memory Statistics:'));
      log(`  Total notes: ${count}`);
      for (const [type, ct] of Object.entries(byType)) {
        log(`  ${type}: ${ct}`);
      }
      return { success: true, count, byType };
    }

    default:
      error(`Unknown subcommand: ${subcommand}`);
      log('Usage: liku memory [list|show|search|stats]');
      return { success: false };
  }
}

module.exports = { run };
