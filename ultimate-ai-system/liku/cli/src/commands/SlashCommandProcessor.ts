/**
 * Orchestrates the discovery, deduplication, and dispatch of
 * slash commands from multiple loader sources.
 *
 * Architecture (mirrors gemini-cli's CommandService):
 *
 *   ┌─────────────────────┐
 *   │ SlashCommandProcessor│  ← orchestrator
 *   └─────┬───────┬───────┘
 *         │       │
 *   ┌─────▼──┐ ┌──▼──────────┐  ┌──────────────┐
 *   │BuiltIn │ │FileCommands │  │ McpLoader... │  ← future loaders
 *   │Loader  │ │Loader (TOML)│  │              │
 *   └────────┘ └─────────────┘  └──────────────┘
 *
 * Loaders are run in parallel. Results are aggregated with
 * last-writer-wins for same-kind commands, and rename-on-conflict
 * for extension commands — exactly like gemini-cli.
 */

import type {
  ICommandLoader,
  SlashCommand,
  CommandConflict,
  CommandContext,
  CommandResult,
  CommandFlags,
} from './types.js';

export class SlashCommandProcessor {
  private readonly commands: ReadonlyMap<string, SlashCommand>;
  private readonly conflicts: readonly CommandConflict[];

  private constructor(
    commands: Map<string, SlashCommand>,
    conflicts: CommandConflict[],
  ) {
    this.commands = commands;
    this.conflicts = Object.freeze(conflicts);
  }

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  /**
   * Create and initialise a processor from one or more command loaders.
   * Loaders run in parallel. Order matters for conflict resolution:
   *  - Built-in first, then user, then project, then extensions.
   *  - Non-extension commands: last wins (project overrides user).
   *  - Extension commands: renamed to `extensionName.commandName`.
   */
  static async create(
    loaders: ICommandLoader[],
    signal: AbortSignal,
  ): Promise<SlashCommandProcessor> {
    const results = await Promise.allSettled(
      loaders.map((loader) => loader.loadCommands(signal)),
    );

    const allCommands: SlashCommand[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allCommands.push(...result.value);
      }
      // Silently skip failed loaders — matches gemini-cli behavior.
    }

    const commandMap = new Map<string, SlashCommand>();
    const conflictsMap = new Map<string, CommandConflict>();

    for (const cmd of allCommands) {
      let finalName = cmd.name;

      // Extension commands get renamed on conflict
      if (cmd.extensionName && commandMap.has(cmd.name)) {
        const winner = commandMap.get(cmd.name)!;
        let renamedName = `${cmd.extensionName}.${cmd.name}`;
        let suffix = 1;
        while (commandMap.has(renamedName)) {
          renamedName = `${cmd.extensionName}.${cmd.name}${suffix}`;
          suffix++;
        }
        finalName = renamedName;

        if (!conflictsMap.has(cmd.name)) {
          conflictsMap.set(cmd.name, { name: cmd.name, winner, losers: [] });
        }
        conflictsMap.get(cmd.name)!.losers.push({ command: cmd, renamedTo: finalName });
      }

      commandMap.set(finalName, { ...cmd, name: finalName });
    }

    return new SlashCommandProcessor(
      commandMap,
      Array.from(conflictsMap.values()),
    );
  }

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  /** Get a command by name, or undefined if not found. */
  getCommand(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /** All registered commands in load order. */
  getCommands(): readonly SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /** All conflicts detected during loading. */
  getConflicts(): readonly CommandConflict[] {
    return this.conflicts;
  }

  /** Execute a named command. Returns null if command not found. */
  async execute(name: string, context: CommandContext): Promise<CommandResult | null> {
    const cmd = this.commands.get(name);
    if (!cmd) return null;
    return cmd.action(context);
  }

  // -----------------------------------------------------------------------
  // CLI helpers
  // -----------------------------------------------------------------------

  /** Parse process.argv into a CommandContext. */
  static parseArgs(argv: string[]): { command: string | null; context: CommandContext } {
    const raw = argv.slice(2);
    const flags: CommandFlags = {
      help: false,
      version: false,
      json: process.env.LIKU_JSON === '1',
      quiet: false,
      debug: process.env.LIKU_DEBUG === '1',
    };
    const options: Record<string, string | boolean> = {};
    const positional: string[] = [];
    let command: string | null = null;

    let i = 0;
    while (i < raw.length) {
      const arg = raw[i];
      if (arg === '--help' || arg === '-h') flags.help = true;
      else if (arg === '--version' || arg === '-v') flags.version = true;
      else if (arg === '--json') flags.json = true;
      else if (arg === '--quiet' || arg === '-q') flags.quiet = true;
      else if (arg === '--debug') flags.debug = true;
      else if (arg.startsWith('--')) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx !== -1) {
          options[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
        } else if (i + 1 < raw.length && !raw[i + 1].startsWith('-')) {
          options[arg.slice(2)] = raw[++i];
        } else {
          options[arg.slice(2)] = true;
        }
      } else if (command === null) {
        command = arg;
      } else {
        positional.push(arg);
      }
      i++;
    }

    return {
      command,
      context: { args: positional, flags, options, rawArgv: raw },
    };
  }
}
