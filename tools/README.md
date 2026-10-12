# Registry tools

Node 22 or later, ES modules, dependencies pinned exactly in `package.json` (install with
`npm ci --prefix tools --ignore-scripts`). Every script documents its options in its header.

| Script | Network | What it does |
| --- | --- | --- |
| `check-pr.mjs` | `fetch` step only | The pull request checks 1-14 of RFC-0015. |
| `build-index.mjs` | none | Writes `public/v0.1/official.json`, `community.json` and `index.html`. |
| `reverify.mjs` | yes | Re-downloads every listed version; marks and removes unavailable ones. |
| `sync-official.mjs` | yes | Writes `entries/official/` from the meta repository's pins. |
| `make-entry.mjs` | yes | Writes the community entry of a published release. |

## The SDK

The archive checks reuse the SDK: its safe extractor and data-only rules, world
validation, library validation and image header reader. The SDK commit is pinned in
`sdk.json`; `install-sdk.sh <dir>` fetches exactly that commit, runs `npm ci` with the
SDK's own lockfile and builds it. Point `HYPRUNE_REGISTRY_SDK` at the directory:

```sh
tools/install-sdk.sh /tmp/hyprune-sdk
export HYPRUNE_REGISTRY_SDK=/tmp/hyprune-sdk
```

A local SDK checkout works the same way (build it with `npm run build`). `hyprune-world-check`
(core) also runs on worlds when it is on `PATH`; without it CI prints a warning.

## Pull request checks

In CI the checks are trusted code: `check.yml` checks out the pull request (the merge
commit) as `pr/`, adds a worktree of the base revision (the merge commit's first parent;
for dispatched runs the merge base with `main`) and runs `tools/`, `schema/` and the pinned
SDK from that base revision with `--root pr`. The repository under check is only read
through git: existing entries and tombstones at the base revision, the changed files at
the head revision, parsed as JSON. Nothing from the pull request is executed by this job
(the workflow file itself is the pull request's, which is why `.github/` changes need a
code owner's review).

```sh
node tools/check-pr.mjs scope  --root <repo> --base <base rev> --head HEAD --author <login> [--association A] [--head-ref B] --work DIR
node tools/check-pr.mjs fetch  --root <repo> --work DIR                     # GitHub API and downloads
node tools/check-pr.mjs verify --root <repo> --work DIR [--expect-offline]  # everything else, no network
node tools/check-pr.mjs all    --base origin/main --author <login> --work DIR
```

`scope` decides what kind of change the pull request is:

| Kind | Allowed changes | Who |
| --- | --- | --- |
| community | exactly one `entries/community/<id>.json`, added or changed | anyone |
| official | `entries/official/*.json` | `github-actions[bot]` from a `sync-official/` branch |
| removal | `entries/community/<id>.json` deleted or reduced, plus `removed/<id>.json` | owner, member or collaborator |
| reverify | `versions[].status`, unavailable removals with tombstones, `state/reverify.json` | `github-actions[bot]` from a `reverify/` branch |
| maintenance | nothing under `entries/`, `removed/` or `state/` (tools, schemas, workflows, docs) | anyone; needs a code owner's review |

Changes to `tools/`, `schema/` or `.github/` are only accepted as a maintenance change: a
pull request that mixes them with entries, tombstones or state fails the scope. A
maintenance change's own tools take effect after it is merged; the `tool tests` job runs
its tests.

Only versions that aren't listed yet are downloaded and checked; listed versions are
compared with the base revision (check 14). CI runs `verify` in a network namespace
(`sudo unshare --net`, then `setpriv` back to the runner user, no token in the
environment); `--expect-offline` refuses to run when the network is reachable.

Write access (check 2): GitHub answers `collaborators/<user>/permission` only to tokens with
push access to that repository, which the registry's token doesn't have for creators'
repositories. The check therefore accepts the author when that endpoint reports write,
maintain or admin access, when the author owns the repository (a user account), or when
the author created the release of every new version.

## Tombstones

`removed/<id>.json`:

```json
{
  "id": "io.github.ada.tidepool",
  "versions": "*",
  "sha256": ["5d2f0c6e3b9a41d8e7c2b0f4a6d9e1c3b5a7f9e2d4c6b8a0f1e3d5c7b9a2e4f6"],
  "reason": "rights",
  "date": "2026-11-02",
  "report": 42
}
```

`versions` is `"*"` (the id) or a list of versions; `sha256` lists every removed archive
hash; `reason` is one of `rights`, `licence`, `safety`, `policy`, `broken`, `unavailable`,
`creator-request`; `report` is the issue number, `null` for removals by the
re-verification. Relisting keeps the file: move the old values into a `history` list and
narrow `versions` and `sha256` to what stays removed. `check-pr` refuses tombstoned ids,
versions and hashes; `build-index` leaves them out.

## Re-verification state

`state/reverify.json` keeps, per id and tag, the commit the tag pointed to when the version
was first verified (the record's `source.commit` takes precedence) and, for unavailable
versions, `unavailableSince` and `reason`. Entry files carry only `status`. A version that
verifies again (same bytes, same commit) becomes available again. Network and server errors
never mark anything.

## Tests

```sh
HYPRUNE_REGISTRY_SDK=/tmp/hyprune-sdk node --test tools/test/
```

The tests use a fake GitHub on 127.0.0.1 (`test-support/fake-github.mjs`) and fixture
packages; they make no other network connections. Tests that open archives are skipped
when `HYPRUNE_REGISTRY_SDK` is not set.
