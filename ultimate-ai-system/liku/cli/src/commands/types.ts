/**
 * Command system type definitions.
 *
 * Modeled on the loader-based pattern from gemini-cli's CommandService.
 * Each ICommandLoader discovers commands from a specific source
 * (built-in, TOML files, MCP, extensions). The processor aggregates
 * and deduplicates them.
 */

/** Kind of command, used for conflict resolution ordering. */
export enum CommandKind {
  /** Hard-coded built-in command. */
  BUILT_IN = 'built-in',
  /** User-defined command from ~/.liku/commands/ */
  USER = 'user',
  /** Project-scoped command from <project>/.liku/commands/ */
  PROJECT = 'project',
  /** Extension-provided command. */
  EXTENSION = 'extension',
}

/** Runtime context passed to a command's action function. */
export interface CommandContext {
  /** Positional arguments after the command name. */
  args: string[];
  /** Parsed --flag values. */
  flags: CommandFlags;
  /** Named --key=value options. */
  options: Record<string, string | boolean>;
  /** Raw argv for edge cases. */
  rawArgv: string[];
}

export interface CommandFlags {
  help: boolean;
  version: boolean;
  json: boolean;
  quiet: boolean;
  debug: boolean;
}

/** The result returned from a command action. */
export interface CommandResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

/** A single executable slash command. */
export interface SlashCommand {
  /** The command name (e.g. "click", "init"). Used for dispatch. */
  name: string;
  /** One-line description for help output. */
  description: string;
  /** Where this command originated. */
  kind: CommandKind;
  /** Argument hint shown in help (e.g. "<text|x,y>"). */
  argHint?: string;
  /** The action to execute. */
  action: (context: CommandContext) => Promise<CommandResult>;
  /** Source extension name, if kind === EXTENSION. */
  extensionName?: string;
}

/** A provider that discovers commands from a specific source. */
export interface ICommandLoader {
  /** Load all commands this provider knows about. */
  loadCommands(signal: AbortSignal): Promise<SlashCommand[]>;
}

/**
 * Conflict record produced during deduplication.
 * When two loaders provide the same command name, the processor
 * keeps one and renames the other.
 */
export interface CommandConflict {
  name: string;
  winner: SlashCommand;
  losers: Array<{ command: SlashCommand; renamedTo: string }>;
}
