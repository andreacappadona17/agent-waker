#!/usr/bin/env sh
#
# Runs a security tool inside a pinned container, so every contributor and every
# CI job uses byte-identical tooling with nothing to install locally.
#
# CI MUST invoke these through the same pnpm scripts rather than a marketplace
# action, so each tool has exactly one pinned version and local/CI drift is
# structurally impossible.
#
# Images are pinned by digest as well as by tag: a tag can be repointed at new
# content, a digest cannot.

set -eu

case "${1-}" in
gitleaks) image="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f" ;;
actionlint) image="docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667" ;;
syft) image="ghcr.io/anchore/syft:v1.51.1@sha256:95fe0835e5bebc6f8b1f8acef68d47d63d594ef4c0f25c097ff853b23cbac74c" ;;
*)
  echo "usage: ./scripts/tool.sh <gitleaks|actionlint|syft> [args...]" >&2
  exit 2
  ;;
esac
shift

# There is deliberately no fallback to a locally installed binary. It would be a
# different version than CI, and a security gate that silently swaps its ruleset
# is worse than one that visibly refuses to run.
command -v docker >/dev/null 2>&1 || {
  echo "This needs a container runtime: https://docs.docker.com/get-started/get-docker/" >&2
  echo "To commit before installing one (CI still runs this scan): HUSKY=0 git commit" >&2
  exit 1
}

# --network none: none of these tools need the network, so a compromised image
# cannot exfiltrate the repository it is reading. :ro: they only ever read.
exec docker run --rm --network none \
  --volume "$PWD:/repo:ro" --workdir /repo "$image" "$@"
