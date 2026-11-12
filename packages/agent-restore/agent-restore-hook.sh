#!/bin/sh
# Agent Restore — session-start hook (Claude Code, Codex, Cursor CLI, Kimi).
# Usage: agent-restore-hook.sh <agent>   (reads the event JSON from stdin)
# Records which session runs in which shell (PID), so VS Code can
# reopen the right session in each restored terminal.
agent=$1
input=$(cat)
[ "$agent" = cursor ] && printf '{}\n'   # Cursor expects JSON on stdout

field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1; }
sid=$(field session_id); [ -n "$sid" ] || sid=$(field conversation_id)
cwd=$(field cwd); [ -n "$cwd" ] || cwd=$PWD
[ -n "$sid" ] || exit 0

is_agent() {  # $1 = process command line
  case "$agent:$1" in
    claude:claude|claude:claude\ *|claude:*/claude|claude:*/claude\ *|claude:*/claude.js*|claude:*@anthropic-ai/claude-code*) return 0 ;;
    codex:codex|codex:codex\ *|codex:*/codex|codex:*/codex\ *|codex:*@openai/codex*) return 0 ;;
    cursor:cursor-agent|cursor:cursor-agent\ *|cursor:*/cursor-agent|cursor:*/cursor-agent\ *|cursor:*cursor-agent/versions/*|cursor:agent|cursor:agent\ *|cursor:*/agent|cursor:*/agent\ *) return 0 ;;
    kimi:kimi|kimi:kimi\ *|kimi:*/kimi|kimi:*/kimi\ *|kimi:kimi-cli|kimi:kimi-cli\ *|kimi:*/kimi-cli|kimi:*/kimi-cli\ *|kimi:*kimi_cli*|kimi:*@moonshot-ai/kimi*) return 0 ;;
  esac
  return 1
}

# Walk up the process tree: first find the agent, then the shell (zsh/bash/fish) above it.
pid=$PPID; found=""; shell_pid=""
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  args=$(ps -o args= -p "$pid" 2>/dev/null)
  if [ -z "$found" ]; then
    is_agent "$args" && found=1
  else
    comm=$(ps -o comm= -p "$pid" 2>/dev/null); comm=${comm##*/}; comm=${comm#-}
    case "$comm" in zsh|bash|fish) shell_pid=$pid; break ;; esac
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
[ -n "$shell_pid" ] || exit 0

dir="${XDG_CACHE_HOME:-$HOME/.cache}/agent-restore"
mkdir -p "$dir"
printf '%s\n%s\n%s\n' "$agent" "$sid" "$cwd" > "$dir/$shell_pid"
exit 0
