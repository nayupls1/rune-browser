# Concepts

[README](../../../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Benchmarks](benchmarks.md) · [Releasing](releasing.md)

The building blocks Rune Browser is made of: workspaces group tabs; each tab has
the website agent beside its page, which reads, customizes and uses the page
with Rune Browser's tools; everything it does is recorded, reversible and asks
before it reaches beyond its tab.

## Workspaces

Workspaces keep projects and contexts apart, like Zen Browser's: each is a collection of tabs, shown as icons at the bottom of the tab sidebar. Click one to switch (or Ctrl+Alt+1…9, also from inside web pages), "+" makes a new one, dragging an icon reorders them (`PUT /api/workspaces/order`), dropping a tab on one moves the tab there, and an icon's menu renames it, changes its icon, moves it or deletes it. Its name and icon are edited together in one popover next to its icon (`components/WorkspaceEditor.tsx`): it opens right after "+" (the name ready to type), from Rename or Change icon… in its menu, on a double-click, or from the icon in Settings → Workspace. A picked icon applies at once; the name on Enter, Done or a click elsewhere, and Escape leaves it as it was. The current workspace's icon is the highlighted one (its name is in the tooltip). Each has:

- its own tabs. Tabs can be moved between workspaces (tab menu → Move to);
- its own default agent and instructions, added after the global ones (Settings → Workspace), and its own tab cleanup setting (see [Interface](interface.md#tab-cleanup));
- remembered permissions: an answer can be remembered for one tab or for every tab in the workspace (the tab's own choice wins);
- its own web session, so cookies and logins don't cross workspaces. The first workspace keeps the original session;
- its own view of the Activity page (plus what belongs to no workspace, like settings).

Switching keeps every opened tab running, and each workspace reopens on the tab you were last on. Deleting a workspace deletes its tabs with their chats, its permissions and browsing history, and clears its web session. The last workspace can't be deleted. In the code, `db/Workspaces.ts` is this grouping.

## Agents

Every tab has the website agent in its sidebar (Ctrl+I). Providers are detected
at startup (Settings → Agents shows their status, version and models). The
picker in the composer chooses provider, model and effort per tab. Every
provider gets the same instructions (`agent/prompts.ts`) and only Rune Browser's
tools, served over MCP at a per-turn URL: the page tools (`get_page`,
`inspect`, `run_js`, `screenshot`, `navigate`, `reload`), page changes and site
overrides, using pages (`click`, `type_text`, `fill_form`…), headless tabs, the
network tools and the API map (see [Browsing](browsing.md)), DevTools (below),
background jobs, snapshots, attached code, the tab tools (`list_tabs`,
`read_tab`) and the chat's folder.

**No tools of its own.** Web pages are untrusted input, so every turn runs with
the provider's own tools switched off: no files, shell, web or connectors.

- Claude: `tools: []`, strict MCP config, no claude.ai connectors.
- Codex: shell, code mode, image viewing, apps and web search turned off, and the user's MCP servers disabled.
- OpenCode: every tool asks for permission, and Rune Browser refuses all but its own (its free models need the tools to be defined).
- Each provider was tested by asking it to read a file.

**DevTools.** The agent gets most of Chrome DevTools on its tab's page (`agent/devtoolsTools.ts`; the work happens in Electron's main process over the DevTools protocol, `main/devtools.ts`), so they can test pages and find causes on their own:

- `console_logs`: console messages, uncaught errors with their stack, and the browser's own messages (failed requests, CSP, deprecations), captured once the agent asks, since pages can notice it.
- `page_metrics` and `performance_trace`: web vitals, load timing, DOM and heap size; a trace (of a reload, or of an interaction the agent runs in the page) analyzed like the Performance panel (`shared/trace.ts`): long tasks and what ran in them, main-thread time by kind, the hottest functions with file:line, forced reflows, layout shifts, slow, large, render-blocking and failed requests. The trace is saved in `<data>/traces/` (the last 20) for Chrome DevTools' Performance panel, and the chat says where.
- `screenshot` also takes one element (`selector`, even scrolled out of view) or the whole page (`full_page`), so agents can look at what they're working on.
- `accessibility_tree`, `element_styles` (the CSS rules that apply, winning first, with their file:line, the box model and computed values), `page_storage` (cookies, local and session storage, IndexedDB with record counts, caches, service workers) and `code_coverage` (unused JavaScript and CSS per file).
- `emulate`: devices (iPhone, Pixel, iPad, laptop), sizes, offline and slow networks, slower CPUs, dark mode and reduced motion. It's undone when the agent's turn ends.
- Cookie values and credential-like storage values never leave the main process, and tokens in console text and URLs are redacted. Every call is in Activity like any tool call.

**Background jobs.** Work that takes longer than one tool call (`run_js` stops after 30 s, `wait_for` after 60 s, and some agents give a tool call 60 s) runs as a background job (`agent/Jobs.ts`, `agent/jobTools.ts`): a request for each item in a list (`batch_requests`) or a script left running in the tab's page (`start_script_job`). The agent starts one, gets its id back, and checks on it later instead of polling a page global or sleeping with `wait_for`:

- `job_status(id?, wait_seconds?)` says how far a job got (items done of the total, the last progress note), how it ended and where its results are; with `wait_seconds` it first waits until the job ends (up to 10 minutes per call). `cancel_job` stops one, and `wait(seconds)` is a plain pause.
- A page script runs in the page like `run_js` (the same page, the same rules: its result is page data, and the provider has no tools of its own). It's started there and Rune Browser checks on it every second, so no call stays open; it gets `progress(done, total)` / `progress("note")` and `signal`, an AbortSignal that fires when it's stopped. Its state lives under a property name only Rune Browser knows. A reload or navigation ends it, and so does a page that stops answering.
- **Owned by the chat:** jobs outlive the agent's turn (stopping the agent doesn't stop them), but end when their chat is closed (a new chat, another chat opened, the chat cleared) or their tab is. At most 5 run at once per tab, and none longer than 2 hours. A tab with a running job isn't unloaded.
- **Visible:** running jobs show above the composer with what they do, how far they got and Stop (`components/JobsBar.tsx`, `GET /api/apps/:id/jobs`, `POST /api/apps/:id/jobs/:job/stop`, recorded as `job.stop`). When one ends, its results so far (also after a failure or a stop) go into a file in the chat's folder (`save_as`, by default `jobs/<id>.json`) and the chat gets a line with that file.

**Images and files.** Paste a screenshot into the composer, drop files on it or pick them with the paperclip (`lib/attachments.ts`, `agent/Attachments.ts`, `/api/apps/:id/attachments`). They go into the chat's folder (below) and show in the chat. Images (scaled to at most 2000 px) reach every provider as images the model sees, PDFs too for Claude; text files go into the prompt; anything else is given by its path. Up to 10 files of 20 MB per message.

**A folder per chat.** Everything that goes into or comes out of a chat lives in its own folder, `<data>/chats/<tab>/<chat>/` (`agent/ChatFiles.ts`): the user's attachments (`attachments/`), what the agent saved and its own files.

- **The agent's workspace:** the agent has `list_files`, `read_file`, `write_file`, `edit_file` and `delete_file` there (`agent/fileTools.ts`), without asking: notes, a list of what it has done in a long task, temporary files, data it collected. Nothing beyond the folder is reachable (paths are checked, symlinks too), and Rune Browser's own `.rune/` in it is off limits.
- **Outputs as files:** every tool that returns data (`run_js`, `get_page`, `network_request`, `replay_request`, `send_saved_request`, the DevTools tools, `api_map`…) takes `save_as`, which saves the whole result there instead of putting it in the agent's context, and `fields`, which keeps only the parts of a JSON result it names (`results[].issue.number`), returned or saved (`agent/output.ts`). Results that go into the context are cut off at 20 kB. `screenshot(save_as)` keeps a screenshot. Files cost no context until the agent reads one, and `read_file` reads a part at a time (images are shown to the model).
- **Inputs by path:** `upload_file` puts files from the folder into a page's file field (after the site's OK, and confirmed every time: the files leave Rune Browser).
- **Visible:** files a tool saved show under its line in the chat, `show_files` shows files as cards, and paths the agent mentions in backticks become chips. Clicking one opens the file in a web tab (images, PDFs, video, audio, text, pages) or, if a tab can't show it, in the system's app; right-click to open it with its app, show it in its folder or copy its path. The chat's thumbnails come from `/api/apps/:id/files/raw`, which serves only the tab's own chat files, and only images inline.
- **File links:** files and folders the agent links in a reply (`[report.csv](<exports/report.csv>)`: relative, absolute, `~/…` or `file://`) become chips with the file type's icon, the link's text and the full path on hover (`shared/markdown.ts` marks them, `FileLink` in `components/FileChip.tsx` shows them); web links stay links, other schemes stay text. A folder opens in the file manager. What a path is comes from `POST /api/apps/:id/files/lookup` (`lookupPath` in `agent/ChatFiles.ts`), which only answers inside the tab's chat folders (relative paths: the chat's folder first), symlinks resolved: a path that's gone shows as unavailable (struck through), and anything outside, or in `.rune/`, shows as unavailable without the renderer learning whether it exists. Only Rune Browser's own window can ask (the window's token), so pages can't probe the file system through it.
- **Nothing runs from the chat:** opening with the system's app goes through the main process (`rune:open-path`), which works from an allowlist (`systemOpenAction` in `shared/web.ts`): only documents without macros, images, audio, video, plain text and archives open with their app, and plain folders in the file manager. Everything else (programs, scripts, installers, shortcuts, disk images, macro documents, settings files, files marked executable, and macOS bundles such as `.app`, recognized by their extension or their `Contents/Info.plist`) is only shown in its folder.
- **Kept with the chat:** an earlier chat keeps its folder. Clearing a chat, deleting an earlier one or deleting the tab deletes its folder.

**Code for the agent.** A tab can have code attached for its agent ("Add a folder of code" in the composer's + menu; `sources/Sources.ts`, `/api/apps/:id/sources`): folders of yours, used in place. The API also takes Git repositories (https and SSH links, GitHub's `owner/repo`, a page showing a branch; with your own Git credentials, never prompting, no hooks), cloned into `<data>/sources/` and pulled again from their chip; the sidebar only adds folders. The agent gets `list_sources`, `list_source_files`, `read_source_file`, `search_source` and `source_git` (status, log, diff, show, blame) to find where a problem it saw in a page or a trace comes from, and `edit_source_file` / `write_source_file` to fix it:

- **Every change asks first,** with its diff in the dialog (permission `agent.source`, rememberable per folder). Changes to your folders aren't in Rune Browser's snapshots: undo them with your own Git. Changes to a cloned repository stay in Rune Browser's clone; nothing is pushed.
- **Never read or written:** paths outside the source (symlinks too), files that hold credentials (`.env`, keys, `.npmrc`, `credentials.json`…; `.env.example` is fine) and `.git`'s internals. Dependencies and builds are left out of listings and searches. Rune Browser's own data, a whole disk or your home folder can't be attached.
- Removing a source deletes Rune Browser's clone, never your folder. Every call is in Activity.

Auth is always the provider's own login: no API keys (Rune Browser strips
`ANTHROPIC_API_KEY` from Claude's environment on purpose).

## Shared tab context

Agents can use what's in other tabs of the workspace, when the user shares it:

- **Mentions:** typing `@` in a composer lists the workspace's other tabs; picking one shares it with the next message (a chip above the text, removable).
- **Hand-off:** "Send to…" under an agent's reply passes it to another tab's agent: that tab opens with the reply attached to its next message.
- **Agents asking:** `list_tabs` names the other tabs; `read_tab` reads one after the user allows it (permission `agent.tab`, per tab, rememberable).

What the agent gets (`agent/sharedTabs.ts`, built on the server): the page's URL, title, selected text and visible text (the main content, up to 30k characters, read by the renderer and waking an unloaded tab), and the handed-over reply. It's wrapped in `<shared-tab>`, marked as the tab's content rather than the user's instructions, and every share is in Activity. Only tabs of the same workspace can be shared, never private ones (`shareRefusal`, checked by the server). Pages are untrusted, which is why the agent has no tools of its own.

## Schedules

Scheduled tasks are prompts for an agent that run on their own (`scheduler/Scheduler.ts`): each run starts a new chat in the task's tab (the current chat goes to its earlier chats) and sends the prompt as if you had, so the run can be read and continued there; its tools ask for permissions as usual. There are no other kinds of task: what a command would do, the agent does when the prompt asks for it. The Schedules page (in Settings) shows every task, whatever its workspace, with what's running, what's coming up and the past runs with the agent's replies. Each task can be paused, edited, run now or deleted.

- **When:** picked in words on the page, and read back the same way with the next run ("Every weekday at 9:00 · next Thu, Nov 12, 9:00"):
  - once at a date and time;
  - every day, every weekday, every week on the days picked, or every month on a day (1 to 28), at a time;
  - every few hours (1, 2, 3, 4, 6, 8 or 12) or minutes (5 to 30);
  - when Rune Browser starts.

  Repeats are stored as cron expressions in local time (`shared/cron.ts`: `repeatToCron`, `cronToRepeat`, `describeRepeat`). An agent can give any cron expression; one the picker doesn't offer is shown as it is and edited as "Custom".

- **Where:** a tab of a workspace, or a new tab (empty or at a website) opened on its first run, which the task then keeps. Tasks belong to you, not to a tab: closing its tab keeps the task, and its next run opens a new tab in the same workspace at the address the old one was on (`targetWithoutTab` in `shared/schedule.ts`). Each run records the tab its chat is in: the page opens that chat while the tab is open, and keeps the agent's reply after it's gone. Deleting a workspace moves its tasks to another one, paused, since its logins aren't that workspace's. Private tabs can't have tasks.
- **Model:** each task can pick the provider, model and reasoning effort that run it (the same picker as the composer); without one, the workspace's default agent runs it. The choice is shown on the task.
- **/schedule:** typed in a chat with one request and one reply, it opens the page's editor with the request as the prompt, the chat's tab as where it runs and the chat's model and effort; you pick when and confirm.
- **Runs:** a run fails if the tab's agent is busy, and the agent is stopped at the time limit. The run's result is the agent's last reply, or its error.
- **Who:** you, on the page or with /schedule.
- **Limits:**
  - recurring schedules run at most every 5 minutes, and at most two runs happen at once (the rest wait);
  - a task never overlaps itself (the extra run is recorded as skipped), and every run has a time limit (5 s to 30 min, 5 min by default);
  - output is capped at 20 kB, and the last 50 runs per task are kept.
- **Missed runs:** a run missed while Rune Browser wasn't running happens once when it starts. Runs that were going when it stopped are marked as failed.
- **Notifications:** a notice when a run fails (or after every run, per task), and a system notification when Rune Browser isn't focused. Every run is in Activity.

## Permissions and activity

Anything the agent does beyond its own tab needs your OK:

- the website agent customizing a site or changing pages (per host or pattern);
- the website agent using a site for you (per host), and each action with consequences (every time);
- the website agent reading a site in a headless tab with your login (per host);
- the website agent sending requests with your session, or changing what a site's requests return (per host);
- an agent reading another tab;
- an agent changing code attached to its tab (every change, with its diff).

Rune Browser asks in a dialog; you can remember the answer. Unanswered requests are denied after a while. Settings → Agent permissions lists remembered decisions, each revocable.

**Full access** (Settings → Agent → Permissions, after a warning) lets agents do all of this without asking: what the website agent does on sites (customizing, acting with your logins, confirming purchases and messages, sending requests), reading other tabs, changing attached code. While it's on, the agent sidebar shows "Full access" in red under its composer (its menu goes back to asking) and working agents a red dot in the tab list. Every request allowed this way is in Activity (`permission.auto`), and Snapshots can still undo what an agent changed in site customizations (not what it did on websites).

The **Activity** page (in Settings) is the audit log: who, what, which tab and when. It records:

- every agent turn and tool call (arguments summarized, long text only as a size);
- permission decisions;
- what you changed (settings, workspaces, sources, snapshots restored).

Cookie values and tokens are never logged.

Agents' processes don't get Rune Browser's own environment variables (`RUNE_*`). In particular they don't get the API token, so they can't call Rune Browser's API around these checks.

## Snapshots

Every change to site customizations and settings is saved as a snapshot you can look at and take back (Settings → Snapshots). The pages you visited are in History instead (see [Browsing](browsing.md#browsing-history)). A snapshot covers one of:

- the **site customizations** and **page changes** the website agent (or you) made;
- Rune Browser's **settings**, including each workspace's.

Snapshots are taken before and after every agent turn (so what you changed in between is kept apart from what the agent did), and when you change settings or site customizations (changes made in a row are folded together). "Save a snapshot" takes one by hand.

Each entry shows who made the change (which agent, you, Rune Browser) and its files with line diffs. Two ways back:

- **Undo this change** reverts only that step. It refuses if those files were changed again since.
- **Restore this version** puts everything back the way it was then.

- **Restore everything to here** (on the Snapshots page) puts Rune Browser back to that moment in one step: its settings and the site customizations, each as its own restore that can be undone.

Restoring or undoing first saves the current state, so it can be undone too.

If something breaks Rune Browser's own UI, **safe mode** starts it without the theme and site customizations. Start it with `--safe-mode` or press Ctrl+Alt+Shift+S, undo the change in Snapshots, then restart normally.

When Rune Browser crashes, the next start says so; when its background server stops or its window keeps crashing, it says so right away. Either way you can copy the details or open a GitHub issue with them filled in (your folder paths and tokens are left out, and nothing is sent unless you submit the issue). Crash reports (minidumps) stay on your computer, in the profile's `Crashpad` folder, and what went wrong is logged in `logs/crashes.log`: processes that died and their exit codes, the server stopping, errors the app survived.

Contents are stored once (content-addressed, gzipped) under `<data dir>/history/`. The last 200 snapshots are kept for site customizations and for settings.

## Mods

Customizations packaged to share with others (Settings → Mods). A mod is one JSON document (`shared/mods.ts`, format `rune-mod`, version 1):

- **What's in it:** page changes (how sites look and work), Rune Browser's theme, and Chrome Web Store extensions (by id: they're installed from the store, not their settings).
- **Making one:** "Make a mod" picks your own page changes, your theme and your store extensions, and gives a share code (`RUNE-MOD:` and the compressed JSON), copied right away, or a file.
- **Installing:** paste a share code or an https link into "Install a mod" (or the command bar), or open a file. A review comes first: what it changes, where it runs its own JavaScript (scripts, buttons, HTML with handlers: flagged as able to read everything there, with your logins), which extensions it installs, whether it changes the theme. A mod with the same id updates the installed one.
- **Gallery:** Rune Browser's examples (`mods/gallery.ts`), plus galleries you add: https links to JSON files listing mods (`{ "mods": [...] }`). There's no central gallery service: a gallery is any file someone publishes.
- **Undo:** an installed mod can be turned off or removed. Its page changes are marked with it (`mod_id`) and go with it; the theme it replaced comes back (unless you changed the theme since); the extensions it installed are disabled or removed, ones you had before stay.
- **Recorded:** installs, updates, switches and removals are snapshots (site customizations, settings) and in Activity. `/api/mods`, `/api/mods/review`, `/api/mods/package`, `/api/mods/gallery`.
- **Limits:** extensions' own permissions are only known once they're installed (Settings → Extensions shows them). Restoring an older site-customizations snapshot can bring back or drop a mod's page changes without changing the mod's entry.
