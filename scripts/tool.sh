#!/usr/bin/env sh
#
# Runs a security tool in a pinned container, so local and CI use the same
# version with nothing to install. CI calls these through the same pnpm
# scripts, so each tool is defined once, here.
#
# Pinned by digest as well as tag, because a tag can be repointed.

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

# No fallback to a local binary: a different version means a different ruleset,
# and a scanner that quietly changes behaviour is not a gate.
command -v docker >/dev/null 2>&1 || {
  echo "This needs a container runtime: https://docs.docker.com/get-started/get-docker/" >&2
  echo "To commit before installing one (CI still runs this scan): HUSKY=0 git commit" >&2
  exit 1
}

# None of these need the network, and none of them write.
exec docker run --rm --network none \
  --volume "$PWD:/repo:ro" --workdir /repo "$image" "$@"
