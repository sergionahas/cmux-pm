#!/bin/bash
# Same as `npx github:sergionahas/trafficcontrol init`, from a clone of this repo.
#   ./install.sh [init options]     (see ./install.sh --help)
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "--help" ]; then exec node bin/trafficcontrol.mjs --help; fi
exec node bin/trafficcontrol.mjs init "$@"
