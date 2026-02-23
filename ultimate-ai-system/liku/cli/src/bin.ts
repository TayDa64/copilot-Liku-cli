#!/usr/bin/env node
/**
 * @liku/cli entry point.
 *
 * Uses the loader-based command system:
 *   SlashCommandProcessor  ← orchestrator
 *     └─ BuildCommandLoader ← built-in commands (LikuCommands)
 *     └─ (future: FileCommandLoader for TOML, McpLoader, etc.)
 */

import { SlashCommandProcessor, BuildCommandLoader } from './commands/index.js';

const colors = { reset: '\x1b[0m', bright: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const log = (msg: string, c: keyof typeof colors = 'reset') => console.log(`${colors[c]}${msg}${colors.reset}`);

function showHelp(commands: readonly import('./commands/types.js').SlashCommand[]) {
  console.log(`\n${colors.bright}${colors.cyan}Liku AI System CLI${colors.reset}\n`);
  console.log('Usage: liku <command> [options]\n');
  console.log(`${colors.bright}Commands:${colors.reset}`);

  const maxLen = Math.max(...commands.map(c => c.name.length + (c.argHint?.length ?? 0)));
  for (const cmd of commands) {
    const label = cmd.argHint ? `${cmd.name} ${cmd.argHint}` : cmd.name;
    const pad = ' '.repeat(maxLen - label.length + 4);
    console.log(`  ${colors.cyan}${label}${colors.reset}${pad}${cmd.description}`);
  }
  console.log(`\n${colors.bright}Options:${colors.reset}`);
  console.log('  --help, -h       Show this help message');
  console.log('  --version, -v    Show version');
  console.log('  --json           Output results as JSON');
  console.log('  --quiet, -q      Suppress non-essential output\n');
}

async function main() {
  const ac = new AbortController();

  // Assemble loaders — add future loaders here (FileCommandLoader, McpLoader, etc.)
  const loaders = [new BuildCommandLoader()];

  const processor = await SlashCommandProcessor.create(loaders, ac.signal);
  const { command, context } = SlashCommandProcessor.parseArgs(process.argv);

  if (context.flags.version) {
    console.log('liku (monorepo) 0.1.0');
    return;
  }

  if (context.flags.help || !command) {
    showHelp(processor.getCommands());
    return;
  }

  const result = await processor.execute(command, context);

  if (!result) {
    log(`Unknown command: ${command}`, 'red');
    showHelp(processor.getCommands());
    process.exit(1);
  }

  if (context.flags.json && result.data !== undefined) {
    console.log(JSON.stringify(result.data, null, 2));
  } else if (result.message) {
    log(result.message, result.success ? 'green' : 'red');
  }

  if (!result.success) process.exit(1);
}

main().catch((err: Error) => {
  log(err.message, 'red');
  process.exit(1);
});
