# Rune Browser

Electron + SolidJS (StyleX) desktop app; Bun server written with Effect v4 (SQLite; Claude Code, Codex, OpenCode as agents). See [apps/browser/docs/](apps/browser/docs/) for the architecture and concepts, [releasing.md](apps/browser/docs/releasing.md) for releases.

## The repository

A Bun workspace with Turborepo (`turbo.json`):

- `apps/browser`: Rune Browser, the main package. Paths below (`src/…`, `scripts/…`, `tests/…`) are relative to it.
- `apps/landing`: the website, static Astro pages styled with StyleX. It ships no JavaScript and a strict CSP (`default-src 'none'`: no scripts at all); keep it that way, no third-party scripts, fonts or trackers. Its screenshots are of the real app: `bun run --cwd apps/landing screenshots` takes them again (after `bun run --cwd apps/browser build`).

Run commands from the repo's root: `bun run check`, `typecheck`, `test` and `build` go through Turborepo for every package; `dev`, `start`, `package`, `server`, `e2e` and `release` are the browser's (`dev:landing` for the website).

## Working in this repo

- Work on a branch per piece of work and open a pull request against `master`; `master` only changes through pull requests, and CI (`bun run check` on Linux, Windows and macOS) must pass. PR titles become the release notes, so write them for users.
- Never commit anything sensitive: secrets, tokens, credentials, personal data, local databases or `.data/`. Check the staged diff before committing.
- No backward compatibility before 1.0: rename and reshape freely, without migrations or legacy fallbacks.
- Several agents may work in this repo at the same time:
  - Commit only the files you changed (`git add <paths>`, not `git add -A`). Leave others' uncommitted work alone.
  - Never use broad `pkill -f` patterns. They can kill other agents' servers and e2e runs, or your own shell when the pattern matches the command itself. Stop only the processes you started (by PID, or `pkill -x <name>`).
  - Use throwaway data dirs (`RUNE_DATA_DIR=$(mktemp -d)`) and free ports for manual server runs, never `.data/` or a fixed port someone else might use.
- Checks never open windows: e2e runs Electron with `--ozone-platform=headless` and offscreen rendering. Don't use `bun run start`, `bun run dev`, `e2e --visible`, or `xdg-open`/`shell.openExternal` for checks.

## Rules for the product

- Auth is always the user's own logins (Claude subscription, Codex/ChatGPT, OpenCode). Never add an API-key path; `ANTHROPIC_API_KEY` is stripped from Claude's environment on purpose.
- Don't show the user's account email anywhere in the UI. The plan type ("Claude Pro") is fine.
- Secret values never reach agents, prompts, logs, process arguments or the API's responses (see apps/browser/docs/concepts.md: Secrets). Agent processes get the environment via `agentEnv()` (no `RUNE_*`); app processes get exactly what the Runtime/Sandbox give them.
- New capabilities that let an app or agent reach beyond its sandbox go through `Permissions.ask` and are recorded with `Audit.record`.
- Untrusted input never reaches a provider that has tools of its own. This covers web pages (the website agent) and apps' AI requests: they run with `access: "none"`, where every provider has its file, shell, web and connector tools switched off.

## Development

- Bun everywhere: `bun install`, `bun run <script>`.
- Format with `bun fmt` before committing (settings in `bunfig.toml`); `bun run check` and CI fail on unformatted files. Type-check with `bun run typecheck` (`bun check`).
- Verify changes with `bun run check` (formatting, typecheck, unit tests, build, e2e). Chain steps with `&&`, and don't hide failures behind pipes.
  - For UI work, look at the screenshots in `apps/browser/test-results/`.
  - `bun run e2e --agent` exercises real agent runs. They use your own plan; it picks Haiku/low effort.
- `scripts/lib/cdp.ts` is a small DevTools client for driving the running app if you need to inspect something e2e doesn't cover. Launch it headless as above.
- StyleX:
  - No `border`/`background` shorthands: they're silently dropped. Use longhands.
  - Keep conditions inside `stylex.attrs(...)` to a single `fn() && styles.x`. Comparisons, `a || b`, `!x`, local booleans etc. make the compiler fail with "Referenced constant is not defined"; wrap them in a `const fn = () => …` helper.
  - Dynamic styles (`x: (v) => ({ prop: v })`) only work for single-word properties. `stylex.attrs` kebab-cases the generated custom property name (`--x-gridTemplateColumns` → `--x-grid-template-columns`), so it no longer matches the CSS. For multi-word properties use Solid's `style={{ "grid-template-columns": … }}` after the attrs spread.
  - Portaled elements (popovers, menus) need their own `fontFamily`.
  - In `apps/landing`, `stylex.create` goes in `.ts` files next to the pages (`src/styles/`): the compiler doesn't see `.astro` files, which only call `stylex.attrs(...)`.
  - Colors come from `colors` in `theme.stylex.ts` (Rune's palette, [design-system.md](apps/browser/docs/design-system.md)), not hex literals, so themes and dark mode apply.
- Server code is Effect v4 (`effect@4`, `effect/http`, `effect/sql`):
  - Services are `Context.Service` + `Layer`, wired in `src/server/services.ts`.
  - v4 names differ from v3 (e.g. `Effect.catch`, `Effect.forkDetach`, `Schema.optionalKey`); check `node_modules/effect` when unsure.
- Naming: a _workspace_ (`db/Workspaces.ts`, `WorkspaceInfo`) groups tabs; `workspace/Workspace.ts` is an app's project folder. New per-tab features should consider which workspace they belong to (secrets, permissions and the audit log are scoped by it).
- Presets live in `src/server/workspace/presets.ts`, with their files in `templates/` (`*.tpl`, imported as text so they're bundled into the compiled server).
- Rune Browser's agent tools are in `src/server/agent/tools.ts`. They're served over MCP, and their input schemas must be object schemas: one bad schema makes clients drop every tool.
