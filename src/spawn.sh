#!/bin/bash
# Start a worker session: a new cmux workspace running Claude Code on one task.
#   ./spawn.sh ABC-153 "Market module" task.md
# task.md is the task-specific prompt. The shared rules (worker rules file from pm.config.json)
# are appended, unless --no-rules. The worker reports back by printing `STATUS: DONE|BLOCKED ...`;
# watch.mjs relays that line to the PM.
set -euo pipefail
ADMIN="$(cd "$(dirname "$0")" && pwd)"; STATE="$ADMIN/state"; mkdir -p "$STATE"
cfg() { node "$ADMIN/config.mjs" get "$1"; }
CMUX="$(cfg cmuxBin)"; WORKDIR="$(cfg workdir)"; RULES_FILE="$(cfg workerRules)"
RULES=1; [ "${1:-}" = "--no-rules" ] && { RULES=0; shift; }
[ $# -eq 3 ] || { echo "usage: spawn.sh [--no-rules] <TICKET> <title> <prompt-file>"; exit 2; }
TICKET="$1"; TITLE="$2"; FILE="$3"
[ -f "$FILE" ] || { echo "no such prompt file: $FILE"; exit 2; }

PROMPT="$STATE/prompt-$(echo "$TICKET" | tr 'A-Z' 'a-z')-$(date +%s).md"
{ cat "$FILE"; [ $RULES = 1 ] && [ -f "$RULES_FILE" ] && { echo; cat "$RULES_FILE"; }; } > "$PROMPT"

ARGS=""; while IFS= read -r a; do [ -n "$a" ] && ARGS+=" $(printf %q "$a")"; done < <(cfg claudeArgs)
CMD="PATH=\"\$HOME/.local/bin:/opt/homebrew/bin:\$PATH\" claude$ARGS -n $(printf %q "$TICKET $TITLE") \"\$(cat $(printf %q "$PROMPT"))\""
WS="$("$CMUX" workspace create --name "$TICKET · $TITLE" --cwd "$WORKDIR" --command "$CMD" --focus false \
  | grep -o 'workspace:[0-9]*' | head -1)"
[ -n "$WS" ] || { echo "cmux did not create a workspace"; exit 1; }

node "$ADMIN/state.mjs" add "$WS" "$TICKET" "$TITLE"
echo "started $TICKET in $WS"
