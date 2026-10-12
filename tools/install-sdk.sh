#!/usr/bin/env bash
# Install the pinned SDK (tools/sdk.json) into a directory and build it. Prints the
# directory; export it as HYPRUNE_REGISTRY_SDK for the tools.
# Usage: tools/install-sdk.sh <dir>
set -euo pipefail
dir=${1:?usage: install-sdk.sh <dir>}
here=$(cd "$(dirname "$0")" && pwd)
read -r repo commit < <(node -e 'const p=require(process.argv[1]); console.log(p.repository, p.commit)' "$here/sdk.json")
if [[ ! $commit =~ ^[0-9a-f]{40}$ || $commit == 0000000000000000000000000000000000000000 ]]; then
  echo "tools/sdk.json: commit is not set to an exact SDK commit" >&2
  exit 1
fi
mkdir -p "$dir"
git -C "$dir" init -q
git -C "$dir" fetch -q --depth 1 "$repo" "$commit"
git -C "$dir" checkout -q --detach FETCH_HEAD
[[ $(git -C "$dir" rev-parse HEAD) == "$commit" ]]
(cd "$dir" && npm ci --no-audit --no-fund --ignore-scripts && npm run build)
echo "$dir"
