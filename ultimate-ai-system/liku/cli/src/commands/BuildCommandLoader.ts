/**
 * Loads the hard-coded built-in commands that ship with @liku/cli.
 *
 * This is the simplest loader — it just returns the LIKU_COMMANDS
 * registry as-is. Keeping it behind the ICommandLoader interface
 * means the processor treats all sources uniformly: built-in,
 * user TOML, project TOML, MCP, extensions — same contract.
 */

import type { ICommandLoader, SlashCommand } from './types.js';
import { LIKU_COMMANDS } from './LikuCommands.js';

export class BuildCommandLoader implements ICommandLoader {
  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    // Return a mutable copy so the processor can rename on conflict
    // without mutating the frozen registry.
    return LIKU_COMMANDS.map((cmd) => ({ ...cmd }));
  }
}
