# Architecture

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

Rune Browser is three processes: the **Electron main process** (window, web tab
sessions, extensions, updates), the **renderer** (the SolidJS UI) and a local
**Bun server** (an Effect v4 program) that owns the data, runs the agents and
the apps. Apps are separate processes again, each in its own sandbox.

```
src/
  main/              Electron main process: server, window, webview sessions
  preload/           Exposes `window.rune` (server URL, API token, web helpers)
  renderer/          SolidJS UI (Vite + StyleX)
    components/      Sidebar, app tabs (preview + agent), web tabs, settings, agent picker
    lib/             Store, API client, hub connection, picker scripts
  server/            Effect program on effect/http + Bun
    services.ts      How the services are wired together
    Http.ts          Routes, auth (token + origin), MCP endpoint
    Hub.ts           WebSocket hub: pushes agent output, app status, logs; RPC to the renderer
    db/              Host database (workspaces, tabs, chat, settings, site customizations)
    providers/       Claude, Codex, OpenCode drivers behind one event stream
    agent/           Agent turns, prompts, Rune Browser's MCP tools
    history/         Snapshots: content store, diffs, undo and restore
    workspace/       Projects: an app's lifecycle (Projects.ts), its files and presets (Workspace.ts, templates/), sandbox, runtime
  shared/            Types and helpers shared by server and renderer
scripts/             Bun scripts for dev / build / start / e2e
tests/               bun:test tests
```

## Processes and security

On startup the main process picks a free port, generates an API token and
spawns the server, then opens the window and passes URL and token to the
renderer through the preload script. The API requires the token and rejects
browser requests from other origins, since web pages and app previews can
reach 127.0.0.1 too. App previews run in a session per app (cookies don't
separate ports).

- **Dev:** the server runs from source with `bun --watch`.
- **Production:** the server is compiled with `bun build --compile` into a
  standalone executable. It doubles as the `bun` apps run on (`BUN_BE_BUN=1`),
  so users don't need Bun.
- **Agents:** Claude Code, Codex and OpenCode are the user's own installs,
  found on `PATH` (or at the path set in Settings → Providers). Rune Browser
  doesn't ship any of them.

Data lives in Electron's userData dir (`~/.config/Rune Browser/data` on Linux), or
`.data/` when running the server standalone.

## The server

The server is one Effect program (`src/server/index.ts`) on `effect/http` and
Bun. Every part of it is a service (`Context.Service` + `Layer`), wired in
`src/server/services.ts`, so tests build the same graph with a throwaway data
folder:

- **Storage:** `db/` keeps the host database (`rune.sqlite`, SQLite through
  `effect/sql`): workspaces, tabs, chats, settings, sites, page changes,
  network rules, response overrides. `security/Vault.ts` encrypts secrets with the key Electron
  keeps in the OS keychain.
- **Security:** `security/Permissions.ts` asks the user (and remembers),
  `security/Audit.ts` records what agents and apps did, `security/Secrets.ts`
  hands secrets to app processes only.
- **Projects:** `workspace/Workspace.ts` is an app's project folder and presets,
  `Sandbox.ts` how its processes are confined (bubblewrap on Linux),
  `Runtime.ts` its dev/live lifecycle, `AppData.ts` its database and files,
  `AppTools.ts` the tools it offers agents.
- **Agents:** `providers/` drives Claude Code (Agent SDK), Codex (app server)
  and OpenCode (its server) behind one event stream; `agent/Agent.ts` runs a
  turn; `agent/Mcp.ts` serves Rune Browser's own tools (`agent/tools.ts`) to
  whichever provider runs it.
- **Around them:** `history/` (snapshots and undo), `scheduler/` (schedules),
  `mods/` (shareable customizations), `ai/` (AI requests from apps).

The renderer talks to it over HTTP (`/api/…`, with the token from the preload
script) and one WebSocket, the hub (`Hub.ts`), which pushes agent output, app
status and logs, and lets the server call back into the renderer (for example
to drive a web tab for an agent).

## The main process

`src/main/` starts the server and the window, and owns everything that needs
Chromium: web tabs are `<webview>` guests with a session per workspace
(`web.ts`), Chrome extensions run in those sessions (`extensions/`), network
recording and rules (`network.ts`), DevTools access for agents (`devtools.ts`),
and updates of the app itself (`updates.ts`, see [Releasing](releasing.md)).

## Data

Everything lives in one folder (Electron's userData, `data/` inside it):

```
rune.sqlite        the host database
apps/<id>/         each app's project (its rune.json, sources, .rune/ state)
appdata/<id>/      each app's database and files, outside the project
history/objects/   the content store snapshots point into
chats/<tab>/<chat>/  each chat's folder: attachments, what its agent saved and its own files
sources/           repositories cloned for agents
agent/, ai/        working folders of agent sessions and AI requests
```
