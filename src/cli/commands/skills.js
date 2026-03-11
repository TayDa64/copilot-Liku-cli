/**
 * liku skills — Manage the skill library
 *
 * Usage:
 *   liku skills list              List all registered skills
 *   liku skills search <query>    Find relevant skills for a query
 *   liku skills show <id>         Show skill details
 */

const path = require('path');
const fs = require('fs');
const { log, success, error, dim, highlight } = require('../util/output');

function getSkillRouter() {
  return require('../../main/memory/skill-router');
}

async function run(args, flags) {
  const subcommand = args[0] || 'list';
  const router = getSkillRouter();

  switch (subcommand) {
    case 'list': {
      const skills = router.listSkills();
      const entries = Object.entries(skills);
      if (entries.length === 0) {
        log('No skills registered.');
        return { success: true, count: 0 };
      }
      if (flags.json) return { success: true, count: entries.length, skills };
      log(highlight(`Skills (${entries.length}):`));
      for (const [id, entry] of entries) {
        const tags = (entry.tags || []).join(', ') || 'none';
        log(`  ${highlight(id)} — ${entry.file} ${dim(`[${tags}]`)}`);
        if (entry.useCount) log(`    ${dim(`Used ${entry.useCount} time(s), last: ${entry.lastUsed || 'never'}`)}`);
      }
      return { success: true, count: entries.length };
    }

    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) { error('Usage: liku skills search <query>'); return { success: false }; }
      const context = router.getRelevantSkillsContext(query);
      if (!context) {
        log('No matching skills found.');
        return { success: true, count: 0, context: '' };
      }
      if (flags.json) return { success: true, context };
      log(context);
      return { success: true, context };
    }

    case 'show': {
      const id = args[1];
      if (!id) { error('Usage: liku skills show <id>'); return { success: false }; }
      const skills = router.listSkills();
      const entry = skills[id];
      if (!entry) { error(`Skill not found: ${id}`); return { success: false }; }
      const skillPath = path.join(router.SKILLS_DIR, entry.file);
      let content = '';
      try { content = fs.readFileSync(skillPath, 'utf-8'); } catch { content = '(file not found)'; }
      if (flags.json) return { success: true, id, entry, content };
      log(highlight(`Skill: ${id}`));
      log(`  File: ${entry.file}`);
      log(`  Tags: ${(entry.tags || []).join(', ') || 'none'}`);
      log(`  Keywords: ${(entry.keywords || []).join(', ') || 'none'}`);
      log(`  Uses: ${entry.useCount || 0}`);
      log(`\n${content}`);
      return { success: true, id, entry, content };
    }

    default:
      error(`Unknown subcommand: ${subcommand}`);
      log('Usage: liku skills [list|search|show]');
      return { success: false };
  }
}

module.exports = { run };
