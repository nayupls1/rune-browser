# Concepts

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

The building blocks Rune Browser is made of: workspaces group tabs; a tab is an
app or a web page; agents build apps and customize pages with Rune Browser's
tools; everything they do is recorded, reversible and asks before it reaches
beyond its sandbox.

## Workspaces

Workspaces keep projects and contexts apart, like Zen Browser's: each is a collection of tabs, shown as icons at the bottom of the tab sidebar. Click one to switch (or Ctrl+Alt+1…9, also from inside web pages), "+" makes a new one (and asks for its name), dragging an icon reorders them (`PUT /api/workspaces/order`), dropping a tab on one moves the tab there, and an icon's menu renames it, changes its icon, moves it or deletes it. The current workspace's icon is the highlighted one (its name is in the tooltip). Each has:

- its own tabs. Tabs can be moved between workspaces (tab menu → Move to);
- its own default agent and instructions, added after the global ones (Settings → Workspace);
- secrets every app in it gets (an app's own secret of the same name wins);
- remembered permissions: an answer can be remembered for one app or for every app in the workspace (the app's own choice wins);
- its own web session, so cookies and logins don't cross workspaces. The first workspace keeps the original session;
- its own view of the Activity page (plus what belongs to no workspace, like global secrets).

Switching keeps every opened tab running, and each workspace reopens on the tab you were last on. Deleting a workspace deletes its tabs with their projects and data, its secrets and permissions, and clears its web session. The last workspace can't be deleted. In the code, `db/Workspaces.ts` is this grouping; `workspace/Workspace.ts` is an app's project folder.

## Apps

Every app is a project folder (`<data>/apps/<id>`) with a `rune.json` that says
how to run it:

```json
{ "install": "bun install", "dev": "bun run dev", "build": "bun run build", "start": "bun run start" }
```

The agent starts from a **preset** (React, vanilla TypeScript, API only; see
`src/server/workspace/presets.ts`): a Bun fullstack server with a SQLite
database, a small realtime library (server `publish`, client `subscribe` /
`useLive`) and `src/tokens.css`, the design tokens generated from your Rune Browser
theme. It can also write any other stack itself. Rune Browser gives every app:

- `PORT` (a stable port per app on 127.0.0.1), `APP_URL`
- `DATABASE_PATH` / `DATABASE_URL=file:…` (its SQLite database) and `RUNE_FILES_DIR` (a folder for uploads and other files), both kept by Rune Browser outside the project (see App data)
- `RUNE_API_URL` / `RUNE_API_TOKEN` for Rune Browser's app API (other apps' data)
- `NODE_ENV` / `RUNE_MODE`: development while editing, production when done

Editing follows the agent sidebar. While it's open the app is being **edited**: Rune Browser
runs the `dev` command (Bun `--hot` with HMR), so the agent's changes show up in the
preview right away. Closing it (Ctrl+J) means **done**: Rune Browser runs `build` and then
`start` and shows the finished app; "Edit" brings the agent back and the dev server
with it. An agent turn always edits, so it reopens the panel. Dependencies are installed when `package.json` or the
lockfile change.

**Bring your own.** A new app tab can also start from a project you have (`POST /api/apps/:id/import`):

- **Cloned from Git:** an https link, `owner/repo` (GitHub), a page showing a branch (`…/tree/<branch>`), an SSH link (`git@github.com:owner/repo.git`), with an optional branch. It's a shallow clone with submodules. The tab shows git's progress (receiving objects, resolving deltas) and can cancel it (`DELETE /api/apps/:id/import`).
- **Private repositories** work with your own Git setup: credential helpers (`gh auth login`, Git Credential Manager) and SSH keys in ssh-agent. Git never prompts (there's no terminal to answer in), and no hooks run. Errors say what's missing.
- **Copied from a folder** (without `node_modules`).
- **Running it:** without a `rune.json`, Rune Browser writes one from `package.json`'s `dev`, `start`, `build` and `preview` scripts. Servers that don't read `$PORT` themselves (Vite and what's built on it, Astro, Angular) are given the port, and a Vite site's build is served with `vite preview`. If Rune Browser can't tell how to run the project, the agent is asked to set it up. When an app's output names another port than `$PORT`, its logs say so.

**One lifecycle.** However an app came to be (the agent's `create_project` or a `rune.json` it wrote itself, a template you picked, a project you imported or cloned, a copy of another app), it goes through the same steps in `workspace/Projects.ts`: setting up, opening, editing and publishing, copying, moving and deleting. Building (the project's files: `Workspace.ts`, its data: `AppData.ts`), running (`Runtime.ts`) and displaying (the renderer, which only sees `AppDetail` and the hub's messages) stay separate. A copy brings the project along as its first snapshot, but not its data, chat or secrets.

**Sandbox.** With bubblewrap every app process (installs, dev server, the
agent's `run_command`) sees the system read-only, its own project and data folder
read-write, a private `/tmp`, and its own PID/IPC namespaces. Your files and other apps are
invisible, and the environment is cleared. Settings → Apps can turn it off.

- **Developer tools:** the system (`/usr`, `/etc`, `/opt`, `/nix`) is there read-only, so git, curl, Python, compilers and the like work. Git has an identity of its own ("Rune Browser", in the app's `.rune/home/.gitconfig`), not yours.
- **Your toolchains:** what version managers installed in your home folder (mise, asdf, nvm, Volta, rustup, pyenv, Bun, Deno, Go…) is shown read-only and kept on PATH; their shims, which need your config, aren't. Settings → Apps can turn this off and add more read-only folders. Nothing else of your home is visible: no `~/.ssh`, `~/.gitconfig` or credentials, and Rune Browser's own data stays hidden even inside a folder you add.
- **Shell:** commands run in the shell chosen in Settings → Apps (`workspace/shells.ts`): `/bin/sh` by default, Bun's cross-platform shell (`bun exec`) on Windows, or bash, zsh, fish, PowerShell, cmd, Git Bash or any program that takes `-c`.
- **Windows and macOS** have no sandbox: processes run in the project folder with a cleared environment (plus what Windows programs need), without a console window, and stopping an app ends its whole process tree (`taskkill /T`).

## App data

What an app stores belongs to Rune Browser, not to the project: its database and
files live in `<data>/appdata/<id>`, mounted into the app's sandbox. Rebuilding,
resetting or rewriting the project leaves them alone, and the agent's file
tools never touch them (it reads them with `app_data`). Projects from before
this keep their old `.rune/data.sqlite`: it moves there on first start.

- **Look at it:** the database button in an app tab lists the tables and pages through their rows, with search.
- **Export:** a `.tar.gz` with the database, every table as JSON and the files.
- **Delete:** stops the app, deletes its database and files and restarts it. A snapshot is taken first, so History can bring them back.
- **Snapshots:** an app's data is part of its snapshots (`@data/…`). Undo and restore leave it alone unless asked.
- **Other apps' data:** an app can read (never write) another app's tables in the same workspace, after you allow it:

```
GET $RUNE_API_URL/data                      Authorization: Bearer $RUNE_API_TOKEN
GET $RUNE_API_URL/data/<app id>             → its tables (name, row count, columns)
GET $RUNE_API_URL/data/<app id>/<table>?offset=&limit=&search=&order=&desc=1&where.<column>=
```

Like the AI API, it only answers the app's server (no `Origin` header). Every read of another app's data is in Activity. Apps in other workspaces aren't listed and can't ask.

## Agents

Providers are detected at startup (Settings → Providers shows their status,
version and models). The picker in the composer chooses provider, model and
effort per tab. Every provider gets the same instructions and Rune Browser's tools,
served over MCP at a per-turn URL: `create_project`, `app_status`,
`restart_app`, `app_logs`, `app_data`, `run_command`, `list_app_tools`, `use_app_tool`, the schedule tools, `set_app_info`, `search_icons`, the
tab tools (`list_tabs`, `read_tab`), the
page tools (`get_page`, `inspect`, `run_js`, `screenshot`, `navigate`, `reload`)
that work on the preview or the web page, and DevTools (below). File editing is the provider's own.

**DevTools.** Both agents get most of Chrome DevTools on their tab's page, the app's preview or the website (`agent/devtoolsTools.ts`; the work happens in Electron's main process over the DevTools protocol, `main/devtools.ts`), so they can test pages and find causes on their own:

- `console_logs`: console messages, uncaught errors with their stack, and the browser's own messages (failed requests, CSP, deprecations). App previews are captured from the start; websites once an agent asks, since pages can notice it.
- `network_requests` / `network_request`: app previews' traffic too, for app builders.
- `page_metrics` and `performance_trace`: web vitals, load timing, DOM and heap size; a trace (of a reload, or of an interaction the agent runs in the page) analyzed like the Performance panel (`shared/trace.ts`): long tasks and what ran in them, main-thread time by kind, the hottest functions with file:line, forced reflows, layout shifts, slow, large, render-blocking and failed requests. The trace is saved in `<data>/traces/` (the last 20) for Chrome DevTools' Performance panel, and the chat says where.
- `screenshot` also takes one element (`selector`, even scrolled out of view) or the whole page (`full_page`), so agents can look at what they're working on.
- `accessibility_tree`, `element_styles` (the CSS rules that apply, winning first, with their file:line, the box model and computed values), `page_storage` (cookies, local and session storage, IndexedDB with record counts, caches, service workers) and `code_coverage` (unused JavaScript and CSS per file).
- `emulate`: devices (iPhone, Pixel, iPad, laptop), sizes, offline and slow networks, slower CPUs, dark mode and reduced motion. It's undone when the agent's turn ends.
- On websites, cookie values and credential-like storage values never leave the main process, and tokens in console text and URLs are redacted. Every call is in Activity like any tool call.

**Images and files.** Paste a screenshot into the composer, drop files on it or pick them with the paperclip (`lib/attachments.ts`, `agent/Attachments.ts`, `/api/apps/:id/attachments`). They go into the chat's folder (below) and show in the chat. Images (scaled to at most 2000 px) reach every provider as images the model sees, PDFs too for Claude; text files go into the prompt; anything else is given by its path. Up to 10 files of 20 MB per message.

**A folder per chat.** Everything that goes into or comes out of a chat lives in its own folder, `<data>/chats/<tab>/<chat>/` (`agent/ChatFiles.ts`): the user's attachments (`attachments/`), what the agent saved and its own files.

- **The agent's workspace:** every agent, the website agent too, has `list_files`, `read_file`, `write_file`, `edit_file` and `delete_file` there (`agent/fileTools.ts`), without asking: notes, a list of what it has done in a long task, temporary files, data it collected. Nothing beyond the folder is reachable (paths are checked, symlinks too), and Rune Browser's own `.rune/` in it is off limits.
- **Outputs as files:** `screenshot(save_as)` and `run_js(save_as)` save their result there instead of putting it in the agent's context (a screenshot to keep, a page's data as JSON). Files cost no context until the agent reads one, and `read_file` reads a part at a time (images are shown to the model).
- **Inputs by path:** the website agent's `upload_file` puts files from the folder into a page's file field (after the site's OK, and confirmed every time: the files leave Rune Browser); the app builder's `copy_to_project` copies one into the app.
- **Visible:** files a tool saved show under its line in the chat, `show_files` shows files as cards, and paths the agent mentions in backticks become chips. Clicking one opens the file in a web tab (images, PDFs, video, audio, text, pages; anything else downloads). The chat's thumbnails come from `/api/apps/:id/files/raw`, which serves only the tab's own chat files, and only images inline.
- **Kept with the chat:** an earlier chat keeps its folder. Clearing a chat, deleting an earlier one or deleting the tab deletes its folder.

**Code for the agent.** A tab can have code attached for its agent (the folder button next to the composer; `workspace/Sources.ts`, `/api/apps/:id/sources`): folders of yours, used in place, and Git repositories (the same links as cloning an app, with your own Git credentials), cloned into `<data>/sources/` and pulled again from their chip. Both agents get `list_sources`, `list_source_files`, `read_source_file`, `search_source` and `source_git` (status, log, diff, show, blame) to find where a problem they saw in a page or a trace comes from, and `edit_source_file` / `write_source_file` to fix it:

- **Every change asks first,** with its diff in the dialog (permission `agent.source`, rememberable per folder). Changes to your folders aren't in Rune Browser's History: undo them with your own Git. Changes to a cloned repository stay in Rune Browser's clone; nothing is pushed.
- **Never read or written:** paths outside the source (symlinks too), files that hold credentials (`.env`, keys, `.npmrc`, `credentials.json`…; `.env.example` is fine) and `.git`'s internals. Dependencies and builds are left out of listings and searches. Rune Browser's own data, a whole disk or your home folder can't be attached.
- Removing a source deletes Rune Browser's clone, never your folder. Every call is in Activity.

Auth is always the provider's own login: no API keys (Rune Browser strips
`ANTHROPIC_API_KEY` from Claude's environment on purpose).

## Shared tab context

Agents can use what's in other tabs of the workspace, when the user shares it:

- **Mentions:** typing `@` in a composer lists the workspace's other tabs; picking one shares it with the next message (a chip above the text, removable).
- **Hand-off:** "Send to…" under an agent's reply passes it to another tab's agent: that tab opens with the reply attached to its next message.
- **Agents asking:** `list_tabs` names the other tabs; `read_tab` reads one after the user allows it (permission `agent.tab`, per tab, rememberable).

What the agent gets (`agent/sharedTabs.ts`, built on the server): a web page's URL, title, selected text and visible text (the main content, up to 30k characters, read by the renderer and waking an unloaded tab); for an app, its tools and how its data is laid out (tables and columns, never rows); and the handed-over reply. It's wrapped in `<shared-tab>`, marked as the tab's content rather than the user's instructions, and every share is in Activity. Only tabs of the same workspace can be shared.

Web pages are untrusted, and so is what a website agent made of one: they only go to website agents, which have no tools of their own (`access: "none"`), never to an app builder (`shareRefusal`, checked by the server). An app's page isn't shared with app builders either, since it can show data from anywhere; they get its tools and data layout.

## AI in apps

Apps can use AI through Rune Browser, on the user's own subscription, so apps never
hold API keys. The presets ship `src/ai.ts` (`ai.chat`, `ai.json`, `ai.stream`);
other stacks call the HTTP API directly:

```
POST $RUNE_AI_URL/chat          Authorization: Bearer $RUNE_AI_TOKEN
{ "messages": [{ "role": "user", "content": "…" }], "system"?: "…", "json"?: true, "stream"?: true }
→ { "text": "…", "json"?: …, "provider": "claude", "model": "haiku" }
GET  $RUNE_AI_URL/models        → enabled, model, models, today's usage
```

- **Per-app keys:** every app gets its own random token in its environment (new on each server start, revoked when the app is deleted).
  - The token only works on `/ai/`, not on the rest of Rune Browser's API.
  - Requests carrying an `Origin` header are refused, so only the app's server can ask, never a page in a browser.
- **No tools:** requests run with the provider's own tools switched off: no files, shell, web or connectors.
  - Claude: `tools: []`, strict MCP config, no claude.ai connectors.
  - Codex: shell, code mode, image viewing, apps and web search turned off, and the user's MCP servers disabled.
  - OpenCode: every tool asks for permission, and Rune Browser refuses (its free models need the tools to be defined).
  - Each provider was tested by asking it to read a file. The website agent uses the same mode.
- **Limits and visibility:** a daily request limit per app, at most two requests per app at a time, and one line per request in the app's logs (sizes and timing, not content).
- **Settings → AI in apps** turns the feature on or off and picks the model. The default is a fast model (Haiku on Claude).

## Tool registry

Actions are part of a registry of what apps can do, for you, agents and other apps (`workspace/AppTools.ts`). An app's tools are:

- its **actions** (above). `"params": { "month": { "type": "string", "required": true } }` gives agents and apps typed arguments; they arrive as `{ input, params }`, with `X-Rune-Caller: user | agent | app:<id>`, and the whole JSON reply comes back;
- the **basic tools from its data**: `list-`, `get-`, `add-`, `update-` and `delete-<table>` for each table (not those starting with `_`). `"dataTools": "read"` keeps only list and get, `"none"` turns them off, and an action with the same id replaces one.

Every call goes through Rune Browser, the hub between apps:

- **You**: the Tools panel (wrench button in an app tab) lists them with a form to run each; actions are also in the command bar.
- **Agents**: `list_app_tools` and `use_app_tool`.
- **Apps**: `GET $RUNE_API_URL/tools` lists the workspace's apps and their tools; `POST $RUNE_API_URL/tools/<app>/<tool>` with `{ params?, input? }` runs one. Server-only, like the data API.
- **Permissions**: an app and its agent may use the app's own tools. Another app's tools are limited to the same workspace and need your OK: reading data is the app-data permission, anything else is asked per tool. Opening pages is only for you. Every call is in Activity.

Data tools write the app's database directly: the app sees the change on its next read, but open windows aren't told (no realtime publish), and the app's own rules are skipped. Apps with rules worth keeping should replace those tools with actions or set `"dataTools": "read"`.

## Schedules

Schedules run apps' tools and commands in the background, without a tab open, and prompts for a tab's agent (`scheduler/Scheduler.ts`). The Schedules page (in Settings) shows the workspace's schedules, what's running, what's coming up and the past runs with their results and output. Each schedule can be paused, edited, run now or deleted.

- **What:** one of an app's tools from the registry, with params; the call goes through the registry's permissions and audit log, as the user (or as the agent that made it). Or a command in the app's sandbox, without its secrets, like `run_command`.
- **Prompts:** or a prompt for an agent (made by you, not by agents). It runs in a tab of the workspace, or in a new app or web tab opened on its first run, which the schedule then keeps. Each run starts a new chat in that tab (the current chat goes to its earlier chats) and sends the prompt as if you had, so the run can be read and continued there; its tools ask for permissions as usual. A run fails if the tab's agent is busy, and the agent is stopped at the time limit. The run's result is the agent's last reply, or its error.
- **When:**
  - once at a time;
  - a cron expression in local time (`0 8 * * 1-5`);
  - an event: Rune Browser started, an app started or crashed, or one an app sends itself with `POST $RUNE_API_URL/events {"name": "new-order"}`.
- **Who:** you on the page, or an app's agent (`create_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`, `list_schedules`) for its own app, after you allow it once per app (`agent.schedule`).
- **Limits:**
  - recurring schedules run at most every 5 minutes, and at most two runs happen at once (the rest wait);
  - a schedule never overlaps itself (the extra run is recorded as skipped), and every run has a time limit (5 s to 30 min, 5 min by default);
  - event runs happen at most every 30 s per schedule;
  - output is capped at 20 kB, and the last 50 runs per schedule are kept.
- **Missed runs:** a run missed while Rune Browser wasn't running happens once when it starts. Runs that were going when it stopped are marked as failed.
- **Notifications:** a notice when a run fails (or after every run, per schedule), and a system notification when Rune Browser isn't focused. Every run is in Activity.

## Secrets

Apps get secrets (API keys, passwords) as environment variables. A secret belongs to one app (key button in its tab), to a workspace (Settings → Workspace, for all its apps) or is global (Settings → Secrets, behind a warning). Global ones reach only the apps you allow.

- **At rest:** values are encrypted with AES-256-GCM, bound to the secret's scope and name.
  - Electron keeps the key in the OS keychain (`safeStorage`) and passes it to the server over stdin.
  - Without a keychain, the key is a 0600 file, and Settings say so.
  - On Linux desktops Chromium doesn't recognize (Hyprland, Sway…), Rune Browser asks for the Secret Service (gnome-keyring, KeePassXC…) itself (`--password-store=gnome-libsecret`). KDE's KWallet is found on its own.
- **Never shown again:** the API never returns a value after it's saved. You can replace or delete one, not view it.
- **Only the app's own processes:** the dev, build and start commands get secrets; dependency installs and the agents' `run_command` don't.
  - Secrets go in through the environment, never through process arguments. bwrap gets its environment directly instead of `--setenv`.
  - Values are masked in the app's logs and in command output.
- **Agents never see values:** `list_secrets` shows names; `request_secret` puts a form in the chat for you to fill in.
- **Changes apply right away:** changing, deleting or revoking a secret restarts the apps using it.
- **Limits:** this keeps secrets away from everything that shouldn't have them. An app that legitimately has a secret can still leak it, through its own code or its dependencies.

## Permissions and activity

Anything an app or agent does beyond its own sandbox needs your OK:

- an app using AI;
- an app using a global secret;
- an app reading another app's data;
- an app (or its agent) using another app's tools;
- an app's agent creating schedules (once per app);
- the website agent customizing a site or changing pages (per host or pattern);
- the website agent using a site for you (per host), and each action with consequences (every time);
- an agent reading another tab.

Rune Browser asks in a dialog; you can remember the answer. Unanswered requests are denied after a while. Settings → Permissions lists remembered decisions, each revocable.

**Full access** (Settings → Agent → Permissions, after a warning) lets agents do all of this without asking: what the website agent does on sites (customizing, acting with your logins, confirming purchases and messages, sending requests), reading other tabs, using other apps' tools and data, scheduling. Apps' own requests (AI, global secrets, other apps' data from their servers) still ask. While it's on, the agent sidebar shows a red "Full access" badge (click it to go back to asking) and working agents a red dot in the tab list. Every request allowed this way is in Activity (`permission.auto`), and History can still undo what an agent changed in apps and customizations (not what it did on websites).

The **Activity** page (in Settings) is the audit log: who, what, which tab and when. It records:

- every agent turn and tool call (arguments summarized, long text only as a size);
- AI requests;
- secret changes and injections;
- permission decisions;
- runtime actions.

Values are never logged.

Agents' processes don't get Rune Browser's own environment variables (`RUNE_*`). In particular they don't get the API token, so they can't call Rune Browser's API around these checks.

## History

Every change is saved as a snapshot you can look at and take back (Settings → History; the clock button in an app tab). A snapshot covers one of:

- an **app**: its project files (without `node_modules`, builds, `.git`) and its data (see App data). SQLite databases are copied consistently even while the app runs, and the timeline shows how their tables' row counts changed;
- the **site customizations** and **page changes** the website agent (or you) made;
- Rune Browser's **settings**, including each workspace's.

Snapshots are taken before and after every agent turn (so what you or the app changed in between is kept apart from what the agent did), when an app starts from a template, and when you change settings or site customizations (changes made in a row are folded together). "Save a snapshot" takes one by hand.

Each entry shows who made the change (which agent, you, Rune Browser) and its files with line diffs. Two ways back:

- **Undo this change** reverts only that step. It refuses if those files were changed again since.
- **Restore this version** puts everything back the way it was then.

- **Restore everything to here** (on the History page) puts Rune Browser back to that moment in one step: its settings, the site customizations and every app of the workspace (or of all of them, with "All workspaces"), each as its own restore that can be undone. Apps made since are left as they are.

Both keep the app's current data unless you tick "also its data". Restoring or undoing first saves the current state, so it can be undone too. When an app crashes, its tab offers to undo the agent's last change.

If something breaks Rune Browser's own UI, **safe mode** starts it without the theme and site customizations. Start it with `--safe-mode` or press Ctrl+Alt+Shift+S, undo the change in History, then restart normally.

Contents are stored once (content-addressed, gzipped) under `<data dir>/history/`. The last 200 snapshots are kept per app, for site customizations and for settings.

## Mods

Customizations packaged to share with others (Settings → Mods). A mod is one JSON document (`shared/mods.ts`, format `rune-mod`, version 1):

- **What's in it:** page changes (how sites look and work), Rune Browser's theme, and Chrome Web Store extensions (by id: they're installed from the store, not their settings).
- **Making one:** "Make a mod" picks your own page changes, your theme and your store extensions, and gives a share code (`RUNE-MOD:` and the compressed JSON), copied right away, or a file.
- **Installing:** paste a share code or an https link into "Install a mod" (or the command bar), or open a file. A review comes first: what it changes, where it runs its own JavaScript (scripts, buttons, HTML with handlers: flagged as able to read everything there, with your logins), which extensions it installs, whether it changes the theme. A mod with the same id updates the installed one.
- **Gallery:** Rune Browser's examples (`mods/gallery.ts`), plus galleries you add: https links to JSON files listing mods (`{ "mods": [...] }`). There's no central gallery service: a gallery is any file someone publishes.
- **Undo:** an installed mod can be turned off or removed. Its page changes are marked with it (`mod_id`) and go with it; the theme it replaced comes back (unless you changed the theme since); the extensions it installed are disabled or removed, ones you had before stay.
- **Recorded:** installs, updates, switches and removals are snapshots (site customizations, settings) and in Activity. `/api/mods`, `/api/mods/review`, `/api/mods/package`, `/api/mods/gallery`.
- **Limits:** extensions' own permissions are only known once they're installed (Settings → Extensions shows them). Restoring an older site-customizations snapshot can bring back or drop a mod's page changes without changing the mod's entry.
