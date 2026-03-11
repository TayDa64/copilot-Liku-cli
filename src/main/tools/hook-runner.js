/**
 * Hook Runner — Invokes .github/hooks/ scripts for tool security gates.
 *
 * Handles the PreToolUse hook contract:
 *   1. Write a JSON input file with { toolName, toolArgs }
 *   2. Run the hook script with COPILOT_HOOK_INPUT_PATH env var
 *   3. Parse stdout — empty means allow, JSON with permissionDecision:"deny" means deny
 *   4. Clean up the temp file
 *
 * The hook scripts (security-check.ps1) enforce per-agent and per-tool policies.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOKS_CONFIG = path.join(REPO_ROOT, '.github', 'hooks', 'copilot-hooks.json');
const HOOK_TIMEOUT = 5000; // 5 seconds

/**
 * Load the hooks configuration file.
 * @returns {object|null} The hooks config or null if not found
 */
function loadHooksConfig() {
  try {
    if (fs.existsSync(HOOKS_CONFIG)) {
      return JSON.parse(fs.readFileSync(HOOKS_CONFIG, 'utf-8'));
    }
  } catch (err) {
    console.warn('[HookRunner] Failed to load hooks config:', err.message);
  }
  return null;
}

/**
 * Run the PreToolUse hook for a given tool invocation.
 *
 * @param {string} toolName - The tool being invoked (e.g. "dynamic_myTool")
 * @param {object} toolArgs - Arguments passed to the tool
 * @returns {{ denied: boolean, reason: string }}
 */
function runPreToolUseHook(toolName, toolArgs) {
  const config = loadHooksConfig();
  if (!config || !config.hooks || !config.hooks.PreToolUse) {
    return { denied: false, reason: 'no PreToolUse hook configured' };
  }

  const hookEntries = config.hooks.PreToolUse;
  if (!Array.isArray(hookEntries) || hookEntries.length === 0) {
    return { denied: false, reason: 'no PreToolUse hook entries' };
  }

  // Write temp input file
  const tmpFile = path.join(os.tmpdir(), `liku-hook-input-${Date.now()}.json`);
  try {
    const hookInput = JSON.stringify({ toolName, toolArgs: toolArgs || {} });
    fs.writeFileSync(tmpFile, hookInput, 'utf-8');

    for (const hookEntry of hookEntries) {
      if (hookEntry.type !== 'command') continue;

      const isWin = os.platform() === 'win32';
      const cmd = isWin ? hookEntry.windows : hookEntry.command;
      if (!cmd) continue;

      const cwd = hookEntry.cwd
        ? path.resolve(REPO_ROOT, hookEntry.cwd)
        : REPO_ROOT;

      const timeout = (hookEntry.timeout || 5) * 1000;

      try {
        let stdout;
        if (isWin) {
          // Parse the windows command: "powershell -NoProfile -File scripts\\security-check.ps1"
          const parts = cmd.split(/\s+/);
          const executable = parts[0];
          const args = parts.slice(1);
          stdout = execFileSync(executable, args, {
            cwd,
            env: { ...process.env, COPILOT_HOOK_INPUT_PATH: tmpFile },
            encoding: 'utf8',
            timeout
          }).trim();
        } else {
          stdout = execFileSync('/bin/sh', ['-c', cmd], {
            cwd,
            env: { ...process.env, COPILOT_HOOK_INPUT_PATH: tmpFile },
            encoding: 'utf8',
            timeout
          }).trim();
        }

        if (stdout) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.permissionDecision === 'deny') {
              return {
                denied: true,
                reason: parsed.permissionDecisionReason || 'Denied by PreToolUse hook'
              };
            }
          } catch {
            // Non-JSON output — treat as allow
          }
        }
      } catch (hookErr) {
        // Hook script error — fail closed (deny) for security
        console.warn(`[HookRunner] PreToolUse hook error: ${hookErr.message}`);
        return {
          denied: true,
          reason: `PreToolUse hook error: ${hookErr.message}`
        };
      }
    }

    return { denied: false, reason: 'all hooks passed' };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Run the PostToolUse hook for audit logging after tool execution.
 *
 * @param {string} toolName - The tool that was invoked
 * @param {object} toolArgs - Arguments that were passed
 * @param {object} toolResult - Execution result { success, result?, error? }
 * @returns {{ logged: boolean, error?: string }}
 */
function runPostToolUseHook(toolName, toolArgs, toolResult) {
  const config = loadHooksConfig();
  if (!config || !config.hooks || !config.hooks.PostToolUse) {
    return { logged: false, error: 'no PostToolUse hook configured' };
  }

  const hookEntries = config.hooks.PostToolUse;
  if (!Array.isArray(hookEntries) || hookEntries.length === 0) {
    return { logged: false, error: 'no PostToolUse hook entries' };
  }

  const tmpFile = path.join(os.tmpdir(), `liku-posthook-input-${Date.now()}.json`);
  try {
    const hookInput = JSON.stringify({
      toolName,
      toolArgs: toolArgs || {},
      toolResult: {
        resultType: toolResult.success ? 'success' : 'error',
        ...(toolResult.result !== undefined ? { result: toolResult.result } : {}),
        ...(toolResult.error ? { error: toolResult.error } : {})
      },
      cwd: path.resolve(REPO_ROOT, '.github', 'hooks')
    });
    fs.writeFileSync(tmpFile, hookInput, 'utf-8');

    for (const hookEntry of hookEntries) {
      if (hookEntry.type !== 'command') continue;

      const isWin = os.platform() === 'win32';
      const cmd = isWin ? hookEntry.windows : hookEntry.command;
      if (!cmd) continue;

      const cwd = hookEntry.cwd
        ? path.resolve(REPO_ROOT, hookEntry.cwd)
        : REPO_ROOT;

      const timeout = (hookEntry.timeout || 5) * 1000;

      try {
        if (isWin) {
          const parts = cmd.split(/\s+/);
          execFileSync(parts[0], parts.slice(1), {
            cwd,
            env: { ...process.env, COPILOT_HOOK_INPUT_PATH: tmpFile },
            encoding: 'utf8',
            timeout,
            input: fs.readFileSync(tmpFile, 'utf-8')
          });
        } else {
          execFileSync('/bin/sh', ['-c', cmd], {
            cwd,
            env: { ...process.env, COPILOT_HOOK_INPUT_PATH: tmpFile },
            encoding: 'utf8',
            timeout,
            input: fs.readFileSync(tmpFile, 'utf-8')
          });
        }
      } catch (hookErr) {
        // PostToolUse errors are non-fatal (audit logging)
        console.warn(`[HookRunner] PostToolUse hook error (non-fatal): ${hookErr.message}`);
        return { logged: false, error: hookErr.message };
      }
    }

    return { logged: true };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

module.exports = { runPreToolUseHook, runPostToolUseHook, loadHooksConfig };
