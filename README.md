# Hyprune registry

The indexes behind Hyprune's two built-in sources ([RFC-0015](https://hyprune.com/rfcs/0015-registry/)):

| Source | Index | Entries |
| --- | --- | --- |
| **Official** | `https://hyprune.github.io/registry/v0.1/official.json` | `entries/official/`, generated from the meta repository's pins |
| **Community registry** | `https://hyprune.github.io/registry/v0.1/community.json` | `entries/community/`, added by pull request |

This repository **only links**. Every entry points to its creator's own GitHub Release assets
and pins them by sha256; nothing here hosts package bytes or thumbnails. Hyprune installs
every package, from any source, with the same hash check, safe extractor and data-only rule:
worlds and libraries contain no code, and installing one never runs anything.

## Listing a package

1. **Publish a release from your own repository.** Tag the commit (`v1.2.0`; a repository
   holding several packages uses `<name>-v1.2.0`) and create a GitHub Release for the tag with:
   - `<id>-<version>.tar.zst`: the package archive,
   - `<id>-<version>.tar.zst.sha256`: its `sha256sum` line,
   - `<id>-<version>.release.json`: the release record,
   - optionally `<id>-<version>.thumb-1.png` (up to 4 thumbnails, at most 1280 x 720 and 512 KiB).

   `hyprune library pack <dir> --release --tag v1.2.0` (or `hyprune world pack`) writes all
   of them. Never replace or delete a published asset, and never move a tag: a fix is a new
   version. Enable GitHub's immutable releases if your account has them.
2. **Write the entry.** `hyprune registry entry github:<owner>/<repo>@<tag>` prints
   `entries/community/<id>.json` for a published release. Fill in `summary`, `description`
   and `tags` if you want them.
3. **Check it locally.** `hyprune registry check entries/community/<id>.json` runs the same
   checks as CI.
4. **Open a pull request** that adds or changes exactly that one file. CI checks it; a
   maintainer merges once every check passes. Merging is not a content review.

For a new version, add it at the top of `versions` in your existing entry file (newest first)
and open another pull request. Existing versions never change.

### Rules the checks enforce

- **You maintain the repository.** The pull request author must have write access to the
  entry's `repo`. Nobody can list someone else's repository.
- **Ids.** `com.hyprune.*` is reserved for official entries. An id under
  `io.github.<owner>.` must belong to a repository owned by `<owner>`. Other ids are first
  come, first served, and stay with their repository.
- **Tags and releases.** The tag exists, names the entry's version (`v<version>` or
  `<name>-v<version>`), points to the release record's `source.commit`, and its release is
  published (not a draft; a pre-release version is marked as one). `url` is an asset of that
  release.
- **Hashes and sizes.** The archive's sha256 matches the entry, the `.sha256` asset and the
  release record; its size matches `bytes`. An `id@version` maps to one hash forever.
- **Safe and data only.** One root directory named exactly the id; no links, devices,
  traversal or unsafe names; size and file limits; only data files (JSON, glTF, images, SVG,
  audio, docs); no executable bits or signatures.
- **Valid package.** The manifest validates; id, version, format, licence, sizes,
  requirements and thumbnails agree between manifest, record and entry; required libraries
  are listed in the official or community index.
- **Declared licence.** A valid SPDX expression, and the manifest's attribution covers every
  file. Only presence and form are checked, never the claim: the creator is responsible for
  licensing their own work.
- **Not removed.** A tombstoned id, version or archive hash can't be listed again.

### Repository naming (recommended)

Name your repository `<owner>/hyprune-<kind>-<name>` with a lowercase slug, and add the
GitHub topics `hyprune` and `hyprune-<kind>`:

| Kind | For | Example |
| --- | --- | --- |
| `world` | A world package | `hyprune-world-tidepool` |
| `objects` | An object, character or machine library | `hyprune-objects-garden-kit` |
| `companion` | A library whose main item is a companion character | `hyprune-companion-drunk-ash` |
| `extension` | An RFC-0007 process extension | `hyprune-extension-weather` |
| `shell` | An alternative shell | `hyprune-shell-minimal` |

This is a convention, never a requirement: CI prints a warning for other names and never
fails on them. Repositories with several packages (tags `<name>-v<version>`) are exempt.

## Reports and removal

The community registry doesn't review content, so its one tool is removing a link.

- **Report** an entry with the "Report an entry" issue form: the id, the versions, the kind
  of problem (rights, licence, safety, content policy, broken, creator request) and a
  contact. Personal data and exploit details go to the security contact instead.
- **Removal at the first credible report.** When a report identifies the entry and describes
  a plausible problem, a maintainer removes the entry (or the versions) and adds a tombstone
  in `removed/<id>.json` (`{id, versions, sha256, reason, date, report}`), usually within three
  working days and without waiting for the creator. The registry doesn't judge the claim.
- **Relisting** only when the reporter withdraws the report, or the creator shows the problem
  is fixed in a new version with a new hash.
- Installed copies are never deleted remotely: on their next refresh users see the entry
  marked "removed from source" and get no further updates from it.

Official entries are handled in the building repositories as ordinary bug or rights work.

## How it works

| Path | What |
| --- | --- |
| `entries/official/<id>.json` | Official entries, written only by the sync job (`tools/sync-official.mjs`) from the meta repository's `worlds/releases.json` and `libraries/releases.json`. |
| `entries/community/<id>.json` | One community entry per package: an index `entries[]` object with a `$schema` pointer. |
| `removed/<id>.json` | Tombstones. |
| `schema/` | Pinned copies of the index and release record schemas (0.1). |
| `tools/` | The checks, the index builder, the re-verifier and the official sync. |
| `.github/workflows/check.yml` | Pull request checks (`pull_request` only, read-only token, no other secrets). |
| `.github/workflows/publish.yml` | On `main`: build both indexes and publish them to GitHub Pages. |
| `.github/workflows/reverify.yml` | Weekly: re-download every listed version; mark missing or changed ones `unavailable`. |
| `.github/workflows/sync-official.yml` | Daily and on demand: open a pull request when the meta repository's pins changed. |

Each publication's `serial` is the number of commits on `main`, so it only increases.

The code in this repository is MIT licensed. Entries are metadata about packages that their
creators publish under their own licences.
