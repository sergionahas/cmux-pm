#!/bin/bash
# Close a worker session: record it as closed (its last DONE result stays on the overview's
# "DONE · last 24h" section), then close its cmux workspace.
#   ./close.sh workspace:N
set -euo pipefail
ADMIN="$(cd "$(dirname "$0")" && pwd)"
CMUX="$(node "$ADMIN/config.mjs" get cmuxBin)"
[ $# -eq 1 ] && [[ "$1" =~ ^workspace:[0-9]+$ ]] || { echo "usage: close.sh workspace:N"; exit 2; }
WS="$1"
PM_WS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("workspace",""))' "$ADMIN/state/pm.json" 2>/dev/null || true)"
[ "$WS" != "$PM_WS" ] || { echo "$WS is the PM workspace; not closing it"; exit 2; }

node "$ADMIN/state.mjs" close "$WS"
CMUX_QUIET=1 "$CMUX" workspace close "$WS" >/dev/null && echo "closed $WS"
