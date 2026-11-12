# Architecture

[README](../../../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Benchmarks](benchmarks.md) · [Releasing](releasing.md)

Rune Browser is three processes: the **Electron main process** (window, web tab
sessions, extensions, updates), the **renderer** (the SolidJS UI) and a local
**Bun server** (an Effect v4 program) that owns the data and runs the agent.

```
src/
  main/              Electron main process: server, window, webview sessions
  preload/           Exposes `window.rune` (server URL, API token, web helpers)
  renderer/          SolidJS UI (Vite + StyleX)
    components/      Sidebar, web tabs, the agent sidebar, settings, agent picker
    lib/             Store, API client, hub connection, picker scripts
  server/            Effect program on effect/http + Bun
    services.ts      How the services are wired together
    Http.ts          Routes, auth (token + origin), MCP endpoint
    Hub.ts           WebSocket hub: pushes agent output and changes; RPC to the renderer
    Tabs.ts          A tab's life: publishing changes, moving it, deleting it with what belongs to it
    db/              Host database (workspaces, tabs, chat, settings, browsing history, site customizations)
    bookmarks/       Bookmarks, and reading other browsers' to import them
    providers/       Claude, Codex, OpenCode drivers behind one event stream
    agent/           Agent turns, prompts, Rune Browser's MCP tools
    history/         Snapshots: content store, diffs, undo and restore
    sources/         Code attached to a tab for its agent (Sources.ts), and git (git.ts)
  shared/            Types and helpers shared by server and renderer
scripts/             Bun scripts for dev / build / start / e2e
tests/               bun:test tests
```

## Processes and security

On startup the main process picks a free port, generates an API token and
spawns the server, then opens the windows and passes URL, token and the window's id to
each window's renderer through the preload script. The API requires the token and rejects
browser requests from other origins, since web pages can reach 127.0.0.1
too.

- **Dev:** the server runs from source with `bun --watch`.
- **Production:** the server is compiled with `bun build --compile` into a
  standalone executable, so users don't need Bun.
- **Agents:** Claude Code, Codex and OpenCode are the user's own installs,
  found on `PATH` (or at the path set in Settings → Agents). Rune Browser
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
  network rules, response overrides, browsing history (tabs are still in a
  table called `apps`, from when tabs could be apps); `bookmarks/` the
  bookmarks.
- **Security:** `security/Permissions.ts` asks the user (and remembers),
  `security/Audit.ts` records what agents and the user did.
- **Tabs:** `Tabs.ts` publishes a tab's changes, moves it between workspaces
  and windows, and deletes it with its chats, attached code and permissions.
- **Agents:** `providers/` drives Claude Code (Agent SDK), Codex (app server)
  and OpenCode (its server) behind one event stream, always without their own
  tools; `agent/Agent.ts` runs a turn; `agent/Mcp.ts` serves Rune Browser's own
  tools (`agent/tools.ts` and the `*Tools.ts` next to it) to whichever provider
  runs it. `agent/ChatFiles.ts`, `Attachments.ts` and `Jobs.ts` are the chat's
  folder, its attachments and background jobs; `sources/` the code attached to
  a tab.
- **Around them:** `history/` (snapshots and undo), `scheduler/` (schedules),
  `mods/` (shareable customizations).

The renderer talks to it over HTTP (`/api/…`, with the token from the preload
script) and one WebSocket, the hub (`Hub.ts`), which pushes agent output and
changes, and lets the server call back into the renderer (for example
to drive a web tab for an agent).

## The main process

`src/main/` starts the server and the windows (`windows.ts`: opening, restoring and reopening them, see [Windows](interface.md#windows)), and owns everything that needs
Chromium: web tabs are `<webview>` guests with a session per workspace
(`web.ts`), Chrome extensions run in those sessions (`extensions/`), network
recording and rules (`network.ts`), DevTools access for agents (`devtools.ts`),
links from other apps and the default browser (`defaultBrowser.ts`, see
[Browsing](browsing.md#web-tabs)), what the internal pages show and rune://flags applied at startup (`internals.ts`, `flags.ts`, see
[Chromium parity](chromium-parity.md)), downloads (`downloads.ts`, with their list in `downloads.json` in the profile), web push for sites (`push.ts`: the push service the Push API needs, through ntfy, with the subscriptions and their sealed keys in `push.json` in the profile; see [Browsing](browsing.md#push-notifications)), and updates of the app itself (`updates.ts`, see [Releasing](releasing.md)).

## Data

Everything lives in one folder (Electron's userData, `data/` inside it):

```
rune.sqlite        the host database
history/objects/   the content store snapshots point into
chats/<tab>/<chat>/  each chat's folder: attachments, what its agent saved and its own files
sources/           repositories cloned for agents
agent/             the working folder of agent sessions
cache/             Rune Browser's own caches (an empty hooks folder for git)
traces/            performance traces the agent recorded (the last 20)
```

Profiles from when Rune Browser built apps may still have `apps/` and `appdata/`
folders: the projects in them are left as they were, for you to keep or delete.
