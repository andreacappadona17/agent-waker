#!/usr/bin/env sh
#
# Every third-party action must be pinned to a full commit SHA, because a tag
# can be repointed. actionlint does not check this.
#
# Portable grep only: macOS has no `grep -P`.

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
