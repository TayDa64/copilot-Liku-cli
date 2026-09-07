#!/usr/bin/env bash
set -euo pipefail
raw="${COPILOT_HOOK_INPUT_PATH:-}"
if [[ -n "$raw" && -f "$raw" ]]; then
  input=$(cat "$raw")
else
  input=$(cat)
fi
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
source=$(printf '%s' "$input" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
cwd="${cwd:-.}"
logs_dir="$cwd/logs"
mkdir -p "$logs_dir"
printf '%s | SESSION_START | source=%s | cwd=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${source:-unknown}" "$cwd" >> "$logs_dir/session.log"
state="$cwd/.github/agent_state.json"
if [[ ! -f "$state" ]]; then
  mkdir -p "$(dirname "$state")"
  printf '%s\n' '{"version":"1.0.0","queue":[],"inProgress":[],"completed":[],"failed":[],"agents":{},"sessions":[]}' > "$state"
fi
exit 0