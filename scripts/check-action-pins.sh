#!/usr/bin/env sh
#
# Every third-party GitHub Action must be pinned to a full 40-character commit
# SHA. A tag can be repointed at new content by whoever controls the action.
# actionlint does not check this, so this does.
#
# Written with portable grep: macOS has no `grep -P`.

set -eu

unpinned=$(
  grep -rhE '^[[:space:]]*(-[[:space:]]*)?uses:' .github/workflows .github/actions |
    sed -E 's/.*uses:[[:space:]]*//; s/[[:space:]]*(#.*)?$//' |
    grep -v '^\./' |
    grep -vE '@[0-9a-f]{40}$' ||
    true
)

if [ -n "$unpinned" ]; then
  echo "These actions are not pinned to a commit SHA:" >&2
  echo "$unpinned" | sed 's/^/  /' >&2
  echo "Pin with: gh api repos/OWNER/REPO/commits/TAG --jq .sha" >&2
  exit 1
fi
