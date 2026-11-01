# Development

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

## Setup

Requires [Bun](https://bun.sh) (the version in `package.json`'s
`packageManager`), and to try agents, at least one of them installed and
signed in: [Claude Code](https://claude.com/claude-code) (`claude` → `/login`),
[Codex](https://github.com/openai/codex) (`codex login`) or
[OpenCode](https://opencode.ai). On Linux, install
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) so apps run
sandboxed.

```sh
bun install
bun run dev
```

## Scripts

| Command             | What it does                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`       | Vite dev server (HMR) + Electron. Server hot-reloads, main/preload changes restart Electron.                                                                                                                                                                                                                |
| `bun run build`     | Production build into `dist/` (renderer, main/preload, compiled server binary).                                                                                                                                                                                                                             |
| `bun run start`     | Runs the production build (unpackaged).                                                                                                                                                                                                                                                                     |
| `bun run package`   | Builds and packages installers for this OS into `release/` (electron-builder, nothing published).                                                                                                                                                                                                           |
| `bun run server`    | Runs only the Bun server standalone (port 3000), with watch mode.                                                                                                                                                                                                                                           |
| `bun run typecheck` | Type-checks the whole project (`bun check`).                                                                                                                                                                                                                                                                |
| `bun run test`      | Unit tests (`tests/`, bun:test) against the real server with throwaway data. Failed files are run once more; see Flaky checks below.                                                                                                                                                                        |
| `bun run e2e`       | Launches the built app with a throwaway profile and drives the UI over the DevTools protocol; add `--agent` to also have the agents build an app and customize a site (uses your own plan). Runs offscreen on Chromium's headless display backend, so no window opens. Screenshots land in `test-results/`. |
| `bun run check`     | Everything: formatting (`bun fmt --check`), typecheck, tests, build, e2e.                                                                                                                                                                                                                                   |
| `bun run release`   | Releases, see [Releasing](releasing.md).                                                                                                                                                                                                                                                                    |

## Conventions

[CLAUDE.md](../CLAUDE.md) is the short list of rules the code follows: the
product rules (own logins only, secrets never reach agents, untrusted input
never reaches a provider with tools, permissions and audit for anything beyond
the sandbox) and the StyleX and Effect v4 pitfalls. It's written for coding
agents, which do much of the work here, but it's just as true for people.

## Workflow

- Work on a branch and open a pull request against `master`; CI runs
  `bun run check` on Linux, Windows and macOS for every PR.
- **Flaky checks:** `bun run test` runs failed test files once more on their own
  (`scripts/test.ts`), and CI runs `bun run e2e --retries 1`, which runs the whole
  e2e again on a fresh profile when a check fails (the checks build on each other).
  What passes the second time doesn't fail the job, but it's reported as flaky: a
  warning on the run and a section in its summary. Fix those rather than ignoring
  them. A test that fails twice still fails, and so do more than five failing test
  files at once. On Windows, CI doubles every e2e wait (`E2E_TIMEOUT_SCALE=2`).
- **Windows:** paths in tests and tool output go through `node:path` (`join`,
  `relative`) or are normalized to `/`; don't compare against hand-written
  `a/b` paths built from `path.slice`, as they come out as `a\b` on Windows.
- Commits explain what changed for the user, in plain words. Pull request
  titles end up in the release notes.
- Nothing before 1.0 needs backward compatibility: no migrations for renamed
  or reshaped data.
