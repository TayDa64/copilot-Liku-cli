#!/usr/bin/env bash
set -euo pipefail
raw="${COPILOT_HOOK_INPUT_PATH:-}"
if [[ -n "$raw" && -f "$raw" ]]; then
  input=$(cat "$raw")
else
  input=$(cat || true)
fi
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
tool=$(printf '%s' "$input" | sed -n 's/.*"toolName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
cwd="${cwd:-.}"
mkdir -p "$cwd/logs"
printf '{"timestamp":"%s","tool":"%s","result":"ok"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" "${tool:-unknown}" >> "$cwd/logs/tool-audit.jsonl"
exit 0