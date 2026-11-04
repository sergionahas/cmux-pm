#!/bin/sh
# Smoke test: pack the package, install it with npx into a clean temp HOME, run init and one overview.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/work"
TGZ=$(cd "$ROOT" && npm pack --silent --pack-destination "$T")
cd "$T/work"
export HOME="$T/home" npm_config_cache="$T/npm-cache"
unset CMUX_WORKSPACE_ID || true
npx --yes --package "$T/$TGZ" cmux-pm init --yes --project Smoke --prefix SMK --no-layout
test -f .cmux-pm/pm.config.json
test -f .cmux-pm/overview.mjs
test -f "$HOME/.claude/skills/smoke-pm/SKILL.md"
node .cmux-pm/overview.mjs --once | tee "$T/overview.txt"
grep -q "SESSIONS" "$T/overview.txt"
echo "smoke OK"
