# Releasing

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

## Versions and channels

Versions follow [SemVer](https://semver.org), starting at 0.1.0; before 1.0
anything may change between minor versions. The version lives in
`package.json`, and every release is a tag `v<version>` on `master`.

- **Stable:** `0.2.0`. Everyone gets it.
- **Daily:** `0.2.1-daily.20261031.42`: a build of `master`, versioned as the
  next patch release (package.json's version if that isn't released yet) with
  the date (UTC) and the release workflow's run number. Published as a GitHub
  pre-release; only copies on the **Daily** channel (Settings → About) get it.
  A daily build's version is only in its tag: `package.json` keeps the stable
  one.

## Cutting a release

Set the new version in `package.json` in a pull request (on its own, or with
the last change that goes into the release) and merge it. Then, from any
branch:

```sh
bun run release           # tags origin/master with its package.json version (v0.2.0) and pushes the tag
```

It stops if that version is released already.

For a daily build:

```sh
bun run release --daily   # starts the release workflow on master
```

The workflow picks the version, tags `master` with it and goes on as below.

Pushing the tag starts the **Release** workflow (`.github/workflows/release.yml`):

1. **Draft:** checks that the tag matches `package.json` (or, for a daily
   build, picks its version and pushes its tag) and creates a draft
   release with GitHub's generated notes: "What's Changed" (the merged pull
   requests since the last release) and the "Full Changelog" compare link.
2. **Checks:** the whole CI workflow (typecheck, unit tests, build, e2e) on
   Linux and Windows.
3. **Build:** on each OS, `bun run build` (with the daily version written into
   `package.json` first) and electron-builder, which uploads
   the installers into the draft, with the update feeds the app reads
   (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`, or `daily*.yml` for
   daily builds) and their blockmaps.
4. **Publish:** adds `SHA256SUMS.txt` and publishes the draft.

Nothing is published unless every step passed. A failed run leaves a draft
release and the tag behind: fix the problem, delete both
(`gh release delete v0.2.0 --cleanup-tag`), and release again (with a new
version if the fix needs a PR).

The notes are only as good as the pull request titles: they're the list.

## What a release contains

| OS      | Files                                                                        | Updates itself                                                                                |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Linux   | `rune-browser-<v>-linux-x86_64.AppImage`, `rune-browser-<v>-linux-amd64.deb` | yes (the AppImage replaces itself; the deb asks for your password to install the new package) |
| Windows | `rune-browser-<v>-setup-x64.exe` (NSIS, per-user)                            | yes                                                                                           |
| macOS   | `rune-browser-<v>-mac-arm64.dmg` and `.zip` (Apple Silicon)                  | no: it shows the new version and links to its release                                         |

macOS is supported but not tested, by hand or by CI: its installers are built,
but the checks only run on Linux and Windows.

## Updates

`src/main/updates.ts` uses [electron-updater](https://www.electron.build/auto-update)
with the GitHub releases as the feed. Installed copies check 15 seconds after
starting and every 4 hours, download a newer release in the background and
install it when the app quits; Settings → About shows the state, "Check for
updates" and "Restart to update", and a notice appears once an update is ready.
Runs from source (`bun run dev`, `bun run start`) never update.

## Signing

Releases aren't signed yet (tracked as NAT-89):

- **Windows** shows a SmartScreen warning on install ("More info" → "Run anyway").
- **macOS** builds are ad-hoc signed: the first start needs right-click → Open
  (or System Settings → Privacy & Security → "Open anyway"), and they can't
  update themselves.
- **Linux** needs no signing; check downloads against `SHA256SUMS.txt`.

Once certificates exist, they go into the repository's Actions secrets
(`CSC_LINK`/`CSC_KEY_PASSWORD` for macOS with `APPLE_ID`… for notarization,
or Azure Trusted Signing for Windows) and the build step stops setting
`CSC_IDENTITY_AUTO_DISCOVERY=false`.
