#!/usr/bin/env bash
set -u
raw="${COPILOT_HOOK_INPUT_PATH:-}"
if [[ -n "$raw" && -f "$raw" ]]; then
  input=$(cat "$raw")
else
  input=$(cat || true)
fi
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
agent=$(printf '%s' "$input" | sed -n 's/.*"agent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p; s/.*"agentType"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
cwd="${cwd:-.}"
mkdir -p "$cwd/logs"
printf '%s | SUBAGENT_STOP | %s | pass\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${agent:-unknown}" >> "$cwd/logs/subagent.log"
exit 0