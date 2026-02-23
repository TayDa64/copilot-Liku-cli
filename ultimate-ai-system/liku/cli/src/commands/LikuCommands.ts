/**
 * Liku command registry — defines all built-in commands.
 *
 * This is the single source of truth for command metadata.
 * Each entry maps a command name to its description, arg hint,
 * and action implementation.
 *
 * Automation commands delegate to the existing JS modules in
 * src/cli/commands/ via dynamic import. AI-system commands
 * (init, checkpoint, status, parse) are implemented inline
 * since they live in this TypeScript package.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AIStreamParser, type CheckpointState } from '@liku/core';
import { CommandKind, type SlashCommand, type CommandContext, type CommandResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProjectRoot(start = process.cwd()): string | null {
  let p = resolve(start);
  while (p !== resolve(p, '..')) {
    if (existsSync(join(p, '.ai', 'manifest.json'))) return p;
    p = resolve(p, '..');
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI-system command actions
// ---------------------------------------------------------------------------

async function initAction(ctx: CommandContext): Promise<CommandResult> {
  const target = ctx.args[0] ?? '.';
  const projectPath = resolve(target);

  if (existsSync(join(projectPath, '.ai', 'manifest.json'))) {
    return { success: false, message: 'Project already initialized.' };
  }

  for (const dir of ['.ai/context', '.ai/instructions', '.ai/logs', 'src', 'tests', 'packages']) {
    const full = join(projectPath, dir);
    if (!existsSync(full)) mkdirSync(full, { recursive: true });
  }

  const manifest = {
    version: '3.1.0',
    project_root: '.',
    system_rules: {
      filesystem_security: {
        immutable_paths: ['.ai/manifest.json'],
        writable_paths: ['src/**', 'tests/**', 'packages/**'],
      },
    },
    agent_profile: {
      default: 'defensive',
      token_limit_soft_cap: 32000,
      context_strategy: 'checkpoint_handover',
    },
    verification: {
      strategies: {
        typescript: {
          tier1_fast: 'pnpm test -- --related ${files}',
          tier2_preflight: 'pnpm build && pnpm test',
        },
      },
    },
    memory: {
      checkpoint_file: '.ai/context/checkpoint.xml',
      provenance_log: '.ai/logs/provenance.csv',
    },
  };

  writeFileSync(join(projectPath, '.ai', 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(projectPath, '.ai', 'context', 'checkpoint.xml'),
    '<?xml version="1.0"?>\n<checkpoint><timestamp></timestamp><context><current_task></current_task></context><pending_tasks></pending_tasks><modified_files></modified_files></checkpoint>',
  );
  writeFileSync(
    join(projectPath, '.ai', 'logs', 'provenance.csv'),
    'timestamp,action,path,agent,checksum,parent_checksum,reason\n',
  );

  return { success: true, message: `Project initialized at ${projectPath}` };
}

async function checkpointAction(_ctx: CommandContext): Promise<CommandResult> {
  const root = findProjectRoot();
  if (!root) return { success: false, message: 'No Liku project found. Run liku init first.' };

  const cpPath = join(root, '.ai', 'context', 'checkpoint.xml');
  const checkpoint: CheckpointState = {
    timestamp: new Date().toISOString(),
    context: `Session checkpoint from ${root}`,
    pendingTasks: [],
    modifiedFiles: [],
  };

  writeFileSync(cpPath, JSON.stringify(checkpoint, null, 2));
  return { success: true, message: `Checkpoint saved: ${cpPath}`, data: checkpoint };
}

async function statusAction(_ctx: CommandContext): Promise<CommandResult> {
  const root = findProjectRoot();
  if (!root) return { success: false, message: 'No Liku project found.' };

  const manifestPath = join(root, '.ai', 'manifest.json');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  const cpPath = join(root, '.ai', 'context', 'checkpoint.xml');
  const hasCheckpoint = existsSync(cpPath);

  return {
    success: true,
    message: `Project root: ${root}`,
    data: { root, manifest, hasCheckpoint },
  };
}

async function parseAction(ctx: CommandContext): Promise<CommandResult> {
  const file = ctx.args[0];
  if (!file) return { success: false, message: 'Usage: liku parse <file>' };
  if (!existsSync(file)) return { success: false, message: `File not found: ${file}` };

  const content = readFileSync(file, 'utf-8');
  const parser = new AIStreamParser();
  const events: Array<{ event: string; data: unknown }> = [];
  parser.on('analysis', (d: unknown) => events.push({ event: 'analysis', data: d }));
  parser.on('hypothesis', (d: unknown) => events.push({ event: 'hypothesis', data: d }));
  parser.on('file_change', (d: unknown) => events.push({ event: 'file_change', data: d }));
  parser.on('checkpoint', (d: unknown) => events.push({ event: 'checkpoint', data: d }));
  parser.on('verify', (d: unknown) => events.push({ event: 'verify', data: d }));
  parser.feed(content);

  return { success: true, message: `Parsed ${events.length} events from ${file}`, data: events };
}

// ---------------------------------------------------------------------------
// Automation command factory — wraps existing src/cli/commands/*.js modules
// ---------------------------------------------------------------------------

/**
 * Creates a SlashCommand that delegates to the existing CommonJS module.
 * The module path is resolved at call time so it only fails if actually invoked.
 */
function automationCommand(
  name: string,
  description: string,
  argHint?: string,
): SlashCommand {
  return {
    name,
    description,
    kind: CommandKind.BUILT_IN,
    argHint,
    action: async (ctx: CommandContext): Promise<CommandResult> => {
      // Resolve relative to the Electron project root, not the monorepo
      const cliCommandsDir = resolve(__dirname, '../../../../src/cli/commands');
      const modPath = join(cliCommandsDir, `${name}.js`);

      if (!existsSync(modPath)) {
        return { success: false, message: `Automation module not found: ${modPath}` };
      }

      // Dynamic require of CommonJS module
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(modPath) as { run: (args: string[], opts: Record<string, unknown>) => Promise<CommandResult> };
      return mod.run(ctx.args, { ...ctx.flags, ...ctx.options });
    },
  };
}

// ---------------------------------------------------------------------------
// Full registry
// ---------------------------------------------------------------------------

/** All built-in Liku commands. */
export const LIKU_COMMANDS: readonly SlashCommand[] = Object.freeze([
  // --- AI system commands ---
  { name: 'init',       description: 'Initialize a new Liku-enabled project',      kind: CommandKind.BUILT_IN, argHint: '[path]',                action: initAction },
  { name: 'checkpoint', description: 'Create a checkpoint for session handover',    kind: CommandKind.BUILT_IN,                                    action: checkpointAction },
  { name: 'status',     description: 'Show current project status',                 kind: CommandKind.BUILT_IN,                                    action: statusAction },
  { name: 'parse',      description: 'Parse an AI output file for structured tags', kind: CommandKind.BUILT_IN, argHint: '<file>',                 action: parseAction },

  // --- Automation commands (delegate to src/cli/commands/*.js) ---
  automationCommand('start',      'Start the Electron agent with overlay'),
  automationCommand('click',      'Click element by text or coordinates',    '<text|x,y>'),
  automationCommand('find',       'Find UI elements matching criteria',      '<text>'),
  automationCommand('type',       'Type text at current cursor position',    '<text>'),
  automationCommand('keys',       'Send keyboard shortcut',                  '<combo>'),
  automationCommand('screenshot', 'Capture screenshot',                      '[path]'),
  automationCommand('window',     'Focus or list windows',                   '[title]'),
  automationCommand('mouse',      'Move mouse to coordinates',               '<x> <y>'),
  automationCommand('drag',       'Drag from one point to another',          '<x1> <y1> <x2> <y2>'),
  automationCommand('scroll',     'Scroll up or down',                       '<up|down> [amount]'),
  automationCommand('wait',       'Wait for element to appear',              '<text> [timeout]'),
  automationCommand('repl',       'Interactive automation shell'),
  automationCommand('agent',      'Run an AI agent task',                    '<prompt>'),
]);
