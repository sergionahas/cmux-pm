#!/bin/zsh -l
# The PM session: Claude Code with the PM skill. Started by cmux.sh in the PM workspace.
ADMIN="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
cfg() { node "$ADMIN/config.mjs" get "$1"; }
cd "$(cfg workdir)" || exit 1
claude ${(f)"$(cfg claudeArgs)"} -n "$(cfg project) PM" \
  --append-system-prompt "$(cat "$ADMIN/pm-prompt.md")" "/$(cfg skill)"
echo "PM session ended (exit $?). Restart: $ADMIN/pm.sh"
exec /bin/zsh -l
