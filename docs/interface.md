# Interface

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Releasing](releasing.md)

## Windows

Rune Browser opens as many windows as you like, each with its own tabs (`main/windows.ts`, `shared/windows.ts`). Workspaces are shared: every window shows one of them, with that window's tabs in it.

- **New window:** Ctrl+N, "New window" in the sidebar's New tab menu, the command bar, or File → New Window on macOS. It opens with a new tab.
- **Moving tabs:** drag a tab out of the sidebar and let go outside the window: it opens in a window of its own (where you let go, on platforms that say). Drop it on another window's tabs to move it there. A tab's menu has "Move to new window" and "Move to window …" too. A window whose last tab leaves closes. A tab that moves leaves its split view; agents keep working in it (their page requests go to whichever window has the tab, `Hub.ts`).
- **Closing and reopening:** a closed window (with other windows still open) can be reopened with its tabs: Ctrl+Shift+T reopens whatever was closed last, a tab or a window, and the command bar has "Reopen closed window". The last 10 are kept; older ones are forgotten, their web tabs closed and their apps put back in the library.
- **After a restart:** Settings → Browser → On startup. "Continue where you left off" brings every window back where it was (size, place where the platform says, maximized), with its tabs, its workspace and the tab you were on. With "Open the New Tab page" or "Open a specific page or set of pages", only the first window comes back and does that (`lib/browser.ts`, only there: new windows don't); the others become closed windows to reopen. Closing the last window keeps it for the next start.
- **The server** keeps which window each tab is in (`apps.window_id`). The main process tells it which windows are open, closed and forgotten (`POST /api/windows`), so tabs of a window that's gone go where they belong.

### Private windows

Ctrl+Shift+N (or "New private window") opens a private window, like Chrome's incognito:

- **Marked:** a "Private" badge in the sidebar's top row, a tinted sidebar, "(Private)" in the window's title, and its new tab page says what's kept.
- **Nothing kept:** its web tabs share one session of their own (`persist:private-web`), wiped when the last private window closes and whenever Rune Browser starts (Electron runs no extensions in a session kept only in memory). Its tabs are deleted when it closes, it's never saved for a restart or reopened, and it doesn't remember closed tabs. Pages there feed no API map, sites' zoom isn't remembered, and their site settings can only be looked at, not changed (both are saved with the settings). Downloaded files stay where they were saved.
- **No agents:** there's no agent sidebar, no apps (agents build them) and no workspaces. Agents can't see its tabs: they're left out of `list_tabs` and can't be shared, a chat can't start there, permission prompts and schedule notices show in normal windows only, and page requests never go to a private window.
- **Extensions** run there only if you allow it in their details (Settings → Extensions → "Allow in private windows"). Tabs don't move between private and normal windows.

## Window

Each window has no title bar, like Zen Browser. On Linux and Windows it's frameless and Rune Browser draws one button, close, as a red macOS-style light first in the sidebar's top row (gray while the window isn't focused; `components/WindowControls.tsx`). There's no minimize or maximize button: drag the row to move the window, double-click it to maximize. macOS keeps its traffic lights, top left. That row and the agent sidebar's header are where the window is dragged, and double-clicking one maximizes it (`lib/windowChrome.ts`).

## Sidebar

The sidebar is the browser's chrome, like Zen Browser's: pages get the whole content area, without a toolbar (`components/TopBar.tsx`, each tab's part in `lib/tabChrome.ts`). The page sits inset from the window and the sidebars, with rounded corners; each pane of a split view is its own card. Fullscreen video still fills the screen.

- **Top row:** close, the agent (Ctrl+I; a dot while it works), a web tab's extensions (the puzzle: one menu, pinned ones first, with their badges and popups), downloads (once something was downloaded; see [Browsing](browsing.md#downloads)), then back, forward and reload. It drags the window.
- **Address:** the tab on screen's address (an app's localhost URL). A new web tab (Ctrl+T) opens blank with it focused and empty. Typing suggests the open tabs that match (every workspace; Enter switches to the first), the address and a web search; Ctrl+L focuses it. Paths and localhost addresses open in an app's preview; anything else in a new web tab. A web tab's page changes are behind the paintbrush in it, and its site settings behind the sliders, which show the camera, microphone, location or screen while the page uses them.
- **The tab's tools:** an app's state (editing, running…), restart, logs, secrets, history, data, tools and "open in your browser". The Network panel is in the command bar ("Network requests"); picking elements is in the agent's composer.
- **Pinned tabs** are tiles above the list (and stay loaded).
- **Tabs** have an × (or middle-click, Ctrl+W). Closing a web tab removes it; Ctrl+Shift+T opens the last one again. Closing an app keeps it with its project, data, chat and secrets (`POST /api/apps/:id/close`): "New tab" lists the saved apps to open again in the current workspace (`/api/library`, `POST /api/apps/:id/reopen`), as does the command bar. "Delete" in its menu deletes it for good. A new app with nothing in it yet is just removed.
- **"New tab"** is under the tabs. At the very bottom, one row: the collapse button on the left, the workspaces' icons centered, Settings on the right.

It collapses to a column of icons (the collapse button, or Ctrl+Shift+B, also from inside web pages) and is resized by dragging its edge (double-click it for the default width; dragging it far enough to the left collapses it). Its width and whether it's collapsed are remembered.

## Agent sidebar

The agent has one place: the agent sidebar, right of the tabs (`components/AgentSidebar.tsx`). It looks and works the same for every kind of tab: building or editing an app, customizing a site and using it all happen there. It shows the agent of the tab that has the focus (in a split view, the focused pane's), with the tab's name in its header; each tab keeps its own conversation, and what you typed but didn't send stays with the tab. Elements picked in a page (the crosshair) show above its composer (`lib/picks.ts`). Ctrl+I (or the agent button at the top of the sidebar) opens or closes it for the tab. Its header is the tab's name, a red shield while agents have full access, new chat, earlier chats and close. It's open by default only where it's needed: on a new app tab, to describe the app. Web pages and other tabs start with it closed and remember being opened; an app's tab follows its mode (open while it's being edited), and apps start finished when Rune Browser starts.

**Chats.** "New chat" (in its header, a tab's menu or the command bar) starts a fresh conversation and keeps the current one: the clock button lists a tab's earlier chats, newest first, to open one again (it continues where it left off, with its agent session; the current chat is kept in its place) or delete it (`/api/apps/:id/chats`).

It's resized like the tab sidebar: drag its left edge (or use the arrow keys on it), double-click for the default width, drag it far to the right to close it. The width is the same in every tab and remembered.

## Command bar

Ctrl+K opens it from anywhere, including inside web pages and app previews. It finds tabs (in every workspace), workspaces, Rune Browser's own commands (new tab, rename, move, snapshot, theme, safe mode…) and the actions apps offer. Free text is routed: a URL opens in a tab; a sentence nothing matches goes to the agent of the tab you're on, or builds a new app; anything else can be searched for on the web. Commands that need text (rename, "Add expense") ask for it after you pick them, or take it inline: `add expense lunch 12`.

Apps declare their actions in `rune.json`:

```json
"actions": [
  { "id": "report", "title": "Monthly report", "path": "/report" },
  { "id": "add-expense", "title": "Add expense", "endpoint": "/api/actions/add-expense", "input": "What and how much" }
]
```

- `path` opens the app at that page.
- `endpoint`: Rune Browser starts the app if needed and POSTs `{ "input": … }` to its own server. The JSON reply's `message` (or `error`) is shown as a notice, and the call is recorded in Activity.
- Paths and endpoints are always on the app's own server. Invalid actions are left out rather than breaking the manifest.

## Split view

Tabs of a workspace can be shown side by side or stacked, any kind together (apps, web tabs, extension pages), up to four at once.

- **Making one:** drag a tab from the sidebar onto a side of the tab on screen (or onto an end of the split on screen), choose "Show beside …" in a tab's menu, or type "split" in the command bar.
- **Using it:** clicking into a pane focuses its tab (the outlined one; shortcuts and the address bar go to it). Drag the line between panes to resize them, double-click it for equal sizes.
- **In the sidebar** a split is one block with its tabs, which takes the place of its first tab. Its handle drags the whole split, its menu stacks or unstacks it, evens out the sizes or unsplits it. Dropping a tab next to one of its tabs adds it there, dropping one of its tabs elsewhere takes it out.
- **Saved** with the workspace (`PUT /api/workspaces/:id/splits`, kept consistent by `normalizeSplits`): a deleted or moved tab leaves its split, and a split of one ends.

Tabs aren't moved in the DOM for this (a webview that moves reloads): every tab keeps its layer, and a split only places its tabs' layers in their panes (`components/SplitView.tsx`, `lib/splits.ts`).

## Tab unloading

Tabs that haven't been on screen for a while are unloaded: their page (a web page or an app's preview) closes and frees its memory (Settings → Performance, memory saver: after 30 minutes by default, or never). They're dimmed in the sidebar and come back where you left them when opened: the same page, scroll position (the window's and scrolled containers') and what you typed, put back through the fields' own setters so frameworks notice. Passwords, hidden and file inputs and card fields aren't kept, and the rest lives only in memory (`lib/pagestate.ts`).

- **Never unloaded:** tabs on screen (in a split, all of its tabs), tabs whose agent is working, pages playing sound, and pinned tabs ("Keep loaded" in a tab's menu, saved with the tab: `PUT /api/apps/:id/pinned`).
- **By hand:** "Unload" in a tab's menu, or "Unload other tabs" in the command bar.
- **Background work:** an agent's page tools wake an unloaded tab in the background (`wakePage` in `lib/webtabs.ts`) and it stays loaded until it's idle again. The chat keeps streaming, and an app's server keeps running for schedules, tools and other apps.
- **Not kept:** a page's back/forward history, and anything only in its JavaScript memory. Extensions only see loaded tabs.

## Settings

Settings has a sidebar of its own on the left, one category at a time on the right (`components/SettingsPage.tsx`, the list in `lib/settingsSections.ts`): Rune Browser's own (Appearance, Workspace, Agent, Providers, Apps, Site customizations, Network, Secrets, Permissions, Keyboard shortcuts), the browser settings in a group of their own (Autofill and passwords, Privacy and security, Site settings, Performance, Fonts and zoom, Search engine, Default browser, On startup, Languages, Downloads, Import bookmarks and settings, Reset settings, Extensions; see Browsing), Rune Browser's pages (Downloads, History, Schedules, Mods and Activity) and About. Each category is also in the command bar ("Settings: Apps"), and the pages keep their own commands ("Open History").

Tabs are put in order by dragging them up or down (or "Move up"/"Move down" in their menu). The order is saved per workspace (`PUT /api/workspaces/:id/order`); new tabs, copies and tabs moved in from another workspace go last.

Every tab can have its own icon ("Change icon…" in its menu): a Lucide icon (searchable), an emoji or an uploaded image (scaled to a 64px PNG). It's shown in the sidebar and the command bar; "Use the default" brings back the app icon or the site's favicon. An app's agent picks an icon with `set_app_info` (a Lucide name, or `icon_file`, an image from the project), but never replaces one you chose.
