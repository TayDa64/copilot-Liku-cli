#!/usr/bin/env bash
set -euo pipefail
raw="${COPILOT_HOOK_INPUT_PATH:-}"
if [[ -n "$raw" && -f "$raw" ]]; then
  input=$(cat "$raw")
else
  input=$(cat)
fi
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
reason=$(printf '%s' "$input" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
cwd="${cwd:-.}"
mkdir -p "$cwd/logs"
printf '%s | SESSION_END | reason=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${reason:-unknown}" >> "$cwd/logs/session.log"
exit 0