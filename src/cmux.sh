#!/bin/bash
# Turns the cmux workspace you run this from into the PM workspace:
#   ┌──────────────────────────┬───────────────────────────────┐
#   │ overview.mjs             │ PM: Claude Code with the PM   │
#   │ usage · sessions ·       │ skill. Starts workers, gets   │
#   │ recent · open PRs ·      │ their results (relayed by     │
#   │ done (24h)               │ watch.mjs), and answers in    │
#   │ (watch.mjs runs behind   │ one line                      │
#   │ it, relaying STATUS      │                               │
#   │ lines to the PM)         │                               │
#   └──────────────────────────┴───────────────────────────────┘
# Idempotent: rerunning replaces the overview and PM panes it made last time.
# Run from a cmux terminal (cmux only takes commands from its own terminals):
#   ./cmux.sh            # this workspace
#   ./cmux.sh --new      # a fresh workspace instead
set -euo pipefail
ADMIN="$(cd "$(dirname "$0")" && pwd)"; STATE="$ADMIN/state"; mkdir -p "$STATE"
cfg() { node "$ADMIN/config.mjs" get "$1"; }
CMUX="$(cfg cmuxBin)"; export CMUX_QUIET=1
NAME="$(cfg workspaceName)"; WORKDIR="$(cfg workdir)"
[ -n "${CMUX_WORKSPACE_ID:-}" ] || { echo "Run this from a cmux terminal."; exit 1; }
ref() { grep -o "$1:[0-9]*" | head -1; }

if [ "${1:-}" = "--new" ]; then
  WS="$("$CMUX" workspace create --name "$NAME" --cwd "$WORKDIR" --focus true | ref workspace)"
else
  WS="$("$CMUX" identify | python3 -c 'import json,sys; print(json.load(sys.stdin)["caller"]["workspace_ref"])')"
fi
WIN="$("$CMUX" identify --workspace "$WS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["caller"]["window_ref"])')"

# Replace what an earlier run made
if [ -f "$STATE/pm.json" ]; then
  for s in $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("surface",""), d.get("overview",""))' "$STATE/pm.json"); do
    "$CMUX" close-surface --surface "$s" >/dev/null 2>&1 || true
  done
fi
pkill -f "$ADMIN/watch.mjs" 2>/dev/null || true

"$CMUX" workspace rename "$WS" --title "$NAME" >/dev/null
ANCHOR="$("$CMUX" list-pane-surfaces --workspace "$WS" | ref surface)"
RIGHT_PANE="$("$CMUX" list-panes --workspace "$WS" | ref pane)"

# Left: overview, with the watcher looping behind it (closing the pane stops both)
OVERVIEW="$("$CMUX" new-split left --workspace "$WS" --surface "$ANCHOR" --focus false | ref surface)"
# New panes can start in a bare sh, so each command runs in a login shell to get PATH (node, claude, gh).
SHELL_BIN="${SHELL:-/bin/zsh}"
inshell() { printf '%q -lc %q' "$SHELL_BIN" "$1"; }
Q="$(printf %q "$ADMIN")"
"$CMUX" respawn-pane --workspace "$WS" --surface "$OVERVIEW" --command "$(inshell \
  "cd $Q && (while :; do node $Q/watch.mjs >>state/watch.log 2>&1; sleep 5; done) & cd $Q && while :; do node overview.mjs; sleep 3; done")" >/dev/null

# Right: the PM, as a new tab in the existing pane
PM="$("$CMUX" new-surface --type terminal --pane "$RIGHT_PANE" --workspace "$WS" --focus true | ref surface)"
python3 - "$STATE/pm.json" "$WIN" "$WS" "$PM" "$OVERVIEW" <<'PY'
import json, sys
p, win, ws, pm, ov = sys.argv[1:]
json.dump({"window": win, "workspace": ws, "surface": pm, "overview": ov}, open(p, "w"), indent=2)
PY
"$CMUX" respawn-pane --workspace "$WS" --surface "$PM" --command "$(printf %q "$ADMIN/pm.sh")" >/dev/null
"$CMUX" rename-tab --workspace "$WS" --surface "$PM" "PM" >/dev/null 2>&1 || true
"$CMUX" rename-tab --workspace "$WS" --surface "$OVERVIEW" "Overview" >/dev/null 2>&1 || true

"$CMUX" workspace-action --action move-top --workspace "$WS" >/dev/null 2>&1 || true
"$CMUX" workspace-action --action pin --workspace "$WS" >/dev/null 2>&1 || true
echo "✓ $NAME is $WS: overview $OVERVIEW, PM $PM"
