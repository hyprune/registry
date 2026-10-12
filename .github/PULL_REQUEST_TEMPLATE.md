<!-- One package per pull request. Add or change exactly one file:
     entries/community/<id>.json. `hyprune registry entry github:<owner>/<repo>@<tag>`
     prints it for a published release. -->

**Package:** `<id>` (world / library)
**Repository:** https://github.com/<owner>/<repo>
**Tag(s) added:** `v…`

- [ ] I maintain this repository (write access); the checks verify it.
- [ ] The release for each tag has `<id>-<version>.tar.zst`, `.tar.zst.sha256` and `.release.json` assets, and they will never be replaced.
- [ ] The declared licence is mine to give, and the package's attribution covers every file.
- [ ] The package is data only (no executables, scripts or code).
- [ ] `hyprune registry check entries/community/<id>.json` passes locally.

Merging is not a content review: maintainers merge entries whose automated checks pass.
Problems are handled by removing the link (see the README).
