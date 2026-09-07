#!/usr/bin/env bash
set -u
raw="${COPILOT_HOOK_INPUT_PATH:-}"
if [[ -n "$raw" && -f "$raw" ]]; then
  input=$(cat "$raw")
else
  input=$(cat || true)
fi
tool=$(printf '%s' "$input" | tr 'A-Z' 'a-z')
agent=$(printf '%s' "$input" | sed -n 's/.*"agentType"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p; s/.*"agent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)

deny() {
  printf '{"permissionDecision":"deny","permissionDecisionReason":"%s"}\n' "$1"
  exit 0
}

case "$agent" in
  recursive-researcher|recursive-architect|recursive-verifier|recursive-diagnostician|recursive-vision-operator)
    if printf '%s' "$tool" | grep -Eq '"toolname":[[:space:]]*"(edit|write)"|"tool_name":[[:space:]]*"(edit|write)"'; then
      if ! printf '%s' "$input" | grep -Eq "[.]github[/\\\\]+hooks[/\\\\]+artifacts[/\\\\]+${agent}[.]md"; then
        deny "Blocked by security hook: $agent is read-only for file mutations"
      fi
    fi
    ;;
esac

case "$agent" in
  recursive-researcher|recursive-architect)
    if printf '%s' "$tool" | grep -Eq '"toolname":[[:space:]]*"(bash|execute|shell)"|"tool_name":[[:space:]]*"(bash|execute|shell)"'; then
      deny "Blocked by security hook: $agent is not allowed to run shell or execute commands"
    fi
    ;;
esac

if [[ -n "$cmd" ]]; then
  echo "$cmd" | grep -Eqi 'rm[[:space:]]+-rf[[:space:]]+/|git[[:space:]]+push[[:space:]]+--force|git[[:space:]]+reset[[:space:]]+--hard|DROP[[:space:]]+TABLE|DROP[[:space:]]+DATABASE|mkfs\.|dd[[:space:]]+if=.*of=/dev/|shutdown[[:space:]]+' && \
    deny "Blocked by security hook: matches dangerous pattern"
fi
exit 0