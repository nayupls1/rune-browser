# Interface

[README](../../../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Benchmarks](benchmarks.md) · [Releasing](releasing.md)

## Windows

Rune Browser opens as many windows as you like, each with its own tabs (`main/windows.ts`, `shared/windows.ts`). Workspaces are shared: every window shows one of them, with that window's tabs in it.

- **New window:** Ctrl+N, "New window" in the sidebar's New tab menu, the command bar, or File → New Window on macOS. It opens with a new tab.
- **Moving tabs:** drag a tab out of the sidebar and let go outside the window: it opens in a window of its own (where you let go, on platforms that say). Drop it on another window's tabs to move it there. A tab's menu has "Move to new window" and "Move to window …" too. A window whose last tab leaves closes. A tab that moves leaves its split view; agents keep working in it (their page requests go to whichever window has the tab, `Hub.ts`).
- **Closing and reopening:** a closed window (with other windows still open) can be reopened with its tabs: Ctrl+Shift+T reopens whatever was closed last, a tab or a window, and the command bar has "Reopen closed window". The last 10 are kept; older ones are forgotten, and their tabs closed.
- **After a restart:** Settings → General → On startup. "Continue where you left off" brings every window back where it was (size, place where the platform says, maximized), with its tabs, its workspace and the tab you were on. With "Open the New Tab page" or "Open a specific page or set of pages", only the first window comes back and does that (`lib/browser.ts`, only there: new windows don't); the others become closed windows to reopen. Closing the last window keeps it for the next start.
- **The server** keeps which window each tab is in (`apps.window_id`). The main process tells it which windows are open, closed and forgotten (`POST /api/windows`), so tabs of a window that's gone go where they belong.

### Private windows

Ctrl+Shift+N (or "New private window") opens a private window, like Chrome's incognito:

- **Marked:** a "Private" badge in the sidebar's top row, a tinted sidebar, "(Private)" in the window's title, and its new tab page says what's kept.
- **Nothing kept:** its web tabs share one session of their own (`persist:private-web`), wiped when the last private window closes and whenever Rune Browser starts (Electron runs no extensions in a session kept only in memory). Its tabs are deleted when it closes, it's never saved for a restart or reopened, and it doesn't remember closed tabs. Pages there feed no API map, sites' zoom isn't remembered, and their site settings can only be looked at, not changed (both are saved with the settings). Downloaded files stay where they were saved.
- **No agents:** there's no agent sidebar and no workspaces. Agents can't see its tabs: they're left out of `list_tabs` and can't be shared, a chat can't start there, permission prompts and schedule notices show in normal windows only, and page requests never go to a private window.
- **Extensions** run there only if you allow it in their details (Settings → Extensions → "Allow in private windows"). Tabs don't move between private and normal windows.

## Window

Each window has no title bar, like Zen Browser. On Linux and Windows it's frameless and Rune Browser draws its three buttons as macOS-style lights first in the sidebar's top row: close, minimize and maximize (gray while the window isn't focused, their glyphs on hover; `components/WindowControls.tsx`). macOS keeps its own traffic lights, top left (hidden with the sidebar). That row, the agent sidebar's header and, while the sidebar is hidden, the gutter above the page are where the window is dragged; double-clicking one maximizes it (`lib/windowChrome.ts`).

## Tab layout

The tabs are either in a bar along the top of the window, or in the vertical sidebar described below. New profiles start with horizontal tabs; profiles from before there was a choice keep the sidebar (`db/Db.ts` writes it into their settings once). Switch in Settings → Appearance → Tabs, in the tab area's menu ("Use vertical tabs"/"Use horizontal tabs") or the command bar.

**The tab area's menu:** a right-click on the tab area's empty space (off the tabs and buttons: below New tab in the sidebar, the free room in the tab bar) has the options for all the tabs: New tab and the layout. A tab's own menu only has what's for that tab (`tabAreaMenuItems` in `components/Sidebar.tsx`).

**The tab card:** resting the pointer on a tab (pinned ones too) shows a card with its name, address and whether it's loaded, the same in both layouts: under the tab in the tab bar, beside the sidebar there, so it never covers the list (`components/TabHoverCard.tsx`). Tabs have no tooltips of their own. It changes at once: the pages stay where they are, nothing reloads (`settings.tabs.layout`, cached in `localStorage` so a start doesn't flash the other layout).

### Horizontal tabs

`components/TabStrip.tsx`, built from the sidebar's own pieces (`components/Sidebar.tsx`):

- **One bar**, minimal like Helium's: the window's buttons (macOS: its traffic lights), back, forward and reload, a compact address (it pops out the same way to type), then the tabs right next to it (pinned ones as icons: as many whole tiles as fit in a third of the bar, the rest behind a "+n" tile at their end, which lists them with their names) and a + (a new tab; right-click for new windows), and at the end the workspaces' icons, the agent and the ⋯ menu (opening downwards). A private window has Settings in place of the workspaces and the agent. The bar drags the window where it's free (double-click maximizes); a right-click there has its own menu.
- **Tabs** shrink as more open, down to a width that still shows part of their names (the × of a tab that isn't on screen shows over the end of its name, on hover); past that they scroll (the wheel scrolls them sideways), always keeping the tab on screen in view. While there are tabs past an end, the list fades out there and an arrow beside it shows the next ones (dragging a tab near an end scrolls too). They work as in the sidebar: the same menu, × and middle-click to close, dragging to reorder, onto a side of the page for a split view or out of the window for a new one, drops from other windows, files and links dropped on them. A split view is one group with its tabs. Resting the pointer on a tab shows a card with its name, address and whether it's loaded.
- The agent sidebar and split view work as with vertical tabs; the agent sidebar sits under the bar. There's no sidebar to hide: Ctrl+Shift+B does nothing.

**Sound:** a tab whose page plays sound shows a speaker (in both layouts); clicking it, or "Mute site" in its menu, mutes the page (`lib/webtabs.ts`, from the page's `audio-state-changed` in `main/web.ts`).

## Sidebar

The sidebar is the browser's chrome, like Zen Browser's: pages get the whole content area, without a toolbar (`components/TopBar.tsx`, each tab's part in `lib/tabChrome.ts`). The page sits inset from the window and the sidebars, with rounded corners; each pane of a split view is its own card. Fullscreen video still fills the screen.

- **Top row:** the window's buttons, then hiding the sidebar, back, forward and reload. It drags the window. The bookmarks bar, when it's on, runs along the top of the page (see [Browsing](browsing.md#bookmarks)).
- **The ⋯ menu** (bottom left; one button instead of a row of them, like Chrome's ⋮ and Zen's menu): new tab, new window and new private window; Bookmarks (the bookmarks menu: bookmark this tab, the bar, every bookmark), History, Downloads and Extensions; find, zoom and print for a page; the tab's own tools; Settings. Each shows its shortcut.
- **Address:** the tab on screen's address, compact: without its scheme (a page that isn't secure keeps its `http://`), the site in full strength and the rest of the address quieter. Its buttons are all one size (24px, 14px icons, `components/addressButton.ts`), badges with a number (zoom, the agent's response changes) as high. Its icon, at the start, opens the site's settings (the lock or globe; the camera, microphone, location or screen while the page uses them). At the end: the star (Ctrl+D) once the page is bookmarked, or while the pointer is over the address (until then it takes no room from the address); a web tab's page changes behind the paintbrush; a web tab's extensions once there are any (the puzzle: one menu under the address, pinned ones first, with their badges and popups; the puzzle again, Escape or a click elsewhere, the page included, closes it) and downloads (once something was downloaded; see [Browsing](browsing.md#downloads)). Focusing it (a click, Ctrl+L, a new web tab with Ctrl+T) pops it out over the page, like Zen's: big and centered near the top of the window, with the full address selected and, before anything's typed, the pages visited most often and lately. Typing suggests the open tabs that match (every workspace; "Switch to tab", which closes the empty new tab it was picked from, like Chrome), bookmarks, pages from the workspace's history (none already shown above them) (the site you're typing first: "git" → github.com; none in private windows), the address and a web search. Enter does what the highlighted row says: a tab or bookmark leads only when its name or site starts with what's typed, otherwise the search does. A click outside or Escape puts it back.
- **The tab's tools** are in the ⋯ menu and the tab's menu. The Network panel is in the command bar ("Network requests"); picking elements is in the agent's composer.
- **Pinned tabs** are tiles above the list (and stay loaded): "Pin" in a tab's menu or the command bar. Many of them scroll in a few rows of their own.
- **Only the tab list scrolls**, with its own scrollbar: the top row, the address, pinned tabs, New tab and the bottom row stay where they are. The tab on screen is always scrolled into view, and dragging a tab near an end of the list scrolls it.
- **Tabs** have an × (or middle-click, Ctrl+W). Closing a tab removes it with its chats; Ctrl+Shift+T opens the last one again (at its address).
- **"New tab"** is under the tabs. At the very bottom, one row: the ⋯ menu on the left, the workspaces' icons centered, the agent (Ctrl+I; a dot while it works) on the right. A private window has Settings there instead.

It hides completely, like Zen's compact mode (the button in the top row, or Ctrl+Shift+B, also from inside web pages): the page gets the whole window, and moving the pointer to the window's left edge brings the sidebar in over the page until the pointer leaves it. Any movement in the edge strip does it, not only entering it, and so does leaving the page through the window's left edge (Linux and Windows resize a window that isn't maximized from the 5px inside its edges, which the page never gets). It floats under every menu, popover and dialog (z-index 900, they're 1000 and up), its own included, and stays while one of its menus is open. Ctrl+L and Ctrl+K work while it's hidden. It's resized by dragging its edge (double-click it for the default width; dragging it far enough to the left hides it). Its width and whether it's hidden are remembered.

## Agent sidebar

The agent has one place: the agent sidebar, right of the tabs (`components/AgentSidebar.tsx`). Asking about a page, customizing a site and using it all happen there. It shows the agent of the tab that has the focus (in a split view, the focused pane's), with the tab's name in its header; each tab keeps its own conversation, and what you typed but didn't send stays with the tab. Ctrl+I (or the agent button at the top of the sidebar) opens or closes it for the tab. Its header is the tab's icon and name, new chat, earlier chats and close; a hairline appears under it once the conversation scrolls.

- **The conversation:** your messages in a quiet card on the right, the agent's replies as plain text (Markdown with code blocks and tables), its tool calls as compact rows (a run of them summed up, "Read the page, took 2 screenshots"; the one in progress spins), and each finished turn folded into "Worked for 42s", which opens to its steps. While it works, "Working…" shimmers with the time it's taken. A fresh chat says what the agent can do there and offers a few things to start with, which go into the composer.
- **The composer:** one card. Elements picked in a page (the crosshair) and attached files show at its top (`lib/picks.ts`, `lib/attachments.ts`); typing @ shares another tab, and /schedule (in a chat with one request and one reply) turns the request into a scheduled task, on the Schedules page with its editor open (see concepts.md: Schedules). Its row of controls: + (attach files or images, add a folder of code), the crosshair, then the model, the reasoning effort (signal bars, only for models that have levels) and send, which turns into stop while the agent works.
- **Background jobs:** above the composer, the agent's running background jobs (a batch of requests, a page script), each with how far it got and Stop (see concepts.md: Agents).
- **Under the composer:** the agents' permissions for every tab, "Ask first" or, in red, "Full access" (its menu switches them; full access asks first, `lib/access.ts`), and the folders of code attached to the tab (`components/Sources.tsx`).

Tabs start with it closed and remember being opened.

**Chats.** "New chat" (in its header, a tab's menu or the command bar) starts a fresh conversation and keeps the current one: the history button lists a tab's earlier chats by day (Today, Yesterday, Previous 7 days…), with a search once there are more than a few, to open one again (it continues where it left off, with its agent session; the current chat is kept in its place) or delete it (`/api/apps/:id/chats`).

It's resized like the tab sidebar: drag its left edge (or use the arrow keys on it), double-click for the default width, drag it far to the right to close it. The width is the same in every tab and remembered.

## Command bar

Ctrl+K opens it from anywhere, including inside web pages. It finds tabs (in every workspace; picking one from an empty new tab closes the empty tab, like the address bar's "Switch to tab"), workspaces and Rune Browser's own commands (new tab, rename, move, snapshot, theme, safe mode…). Free text is routed: a URL opens in a tab; a sentence nothing matches goes to the agent of the tab you're on; anything else can be searched for on the web. Commands that need text (rename) ask for it after you pick them, or take it inline.

## Split view

Tabs of a workspace can be shown side by side or stacked, any kind together (web pages, extension pages, local files), up to four at once.

- **Making one:** drag a tab from the sidebar onto a side of the tab on screen (or onto an end of the split on screen), choose "Show beside …" in a tab's menu, or type "split" in the command bar.
- **Using it:** clicking into a pane focuses its tab (the outlined one; shortcuts and the address bar go to it). Drag the line between panes to resize them, double-click it for equal sizes.
- **In the sidebar** a split is one block with its tabs, which takes the place of its first tab. Its handle drags the whole split, its menu stacks or unstacks it, evens out the sizes or unsplits it. Dropping a tab next to one of its tabs adds it there, dropping one of its tabs elsewhere takes it out.
- **Saved** with the workspace (`PUT /api/workspaces/:id/splits`, kept consistent by `normalizeSplits`): a deleted or moved tab leaves its split, and a split of one ends.

Tabs aren't moved in the DOM for this (a webview that moves reloads): every tab keeps its layer, and a split only places its tabs' layers in their panes (`components/SplitView.tsx`, `lib/splits.ts`).

## Tab unloading

Tabs that haven't been on screen for a while are unloaded: their page closes and frees its memory (Settings → General → Performance, memory saver: after 30 minutes by default, or never). They're dimmed in the sidebar and come back where you left them when opened: the same page, scroll position (the window's and scrolled containers') and what you typed, put back through the fields' own setters so frameworks notice. Passwords, hidden and file inputs and card fields aren't kept, and the rest lives only in memory (`lib/pagestate.ts`).

- **Never unloaded:** tabs on screen (in a split, all of its tabs), tabs whose agent is working or runs a background job, pages playing sound, and pinned tabs ("Keep loaded" in a tab's menu, saved with the tab: `PUT /api/apps/:id/pinned`).
- **By hand:** "Unload" in a tab's menu, or "Unload other tabs" in the command bar.
- **Background work:** an agent's page tools wake an unloaded tab in the background (`wakePage` in `lib/webtabs.ts`) and it stays loaded until it's idle again. The chat keeps streaming.
- **Not kept:** a page's back/forward history, and anything only in its JavaScript memory. Extensions only see loaded tabs.

## Tab cleanup

Tabs nobody has used for a long time close by themselves, so the tab list doesn't grow forever (Settings → General → Performance, "Close unused tabs": off by default, or after 12 hours, a day, 3 days or a week). A workspace can have its own setting (Settings → Workspace), or follow the global one. Tabs sleep first (Tab unloading) and close later. A closed tab is like one closed by hand: Ctrl+Shift+T opens it again and its pages are in History. Every one is in Activity (`tab.cleanup`, by "Tab cleanup").

- **Last used:** when the tab was last on screen. The window tells the server while a tab is on screen and when it leaves it (`POST /api/apps/used`), so it's kept across restarts; tabs from before this count as used when Rune Browser first starts with it.
- **Never closed:** pinned tabs, the tabs on screen in a window, tabs playing sound, tabs with something typed (in the page, kept from a sleeping page, or unsent in the agent's composer), tabs whose agent is working or runs a background job, and tabs a scheduled task runs in.
- **Private windows:** never. Nothing of a private tab is kept once it's closed (no History, no Ctrl+Shift+T), so closing one would lose it for good, and private windows are short-lived anyway: their tabs go when the window closes.
- **How:** every 5 minutes each window asks the server which tabs are idle long enough (`GET /api/apps/idle`: the server knows when they were last used, their agents, jobs and schedules), leaves out what only it knows (on screen, sound, typed input) and closes the rest (`POST /api/apps/:id/clean-up`, which checks again). Tabs of a window that isn't open stay until it is (`lib/cleanup.ts`, `Tabs.idle` in `server/Tabs.ts`).

## Settings

Settings has a sidebar of its own on the left, one category at a time on the right (`components/SettingsPage.tsx`, the list in `lib/settingsSections.ts`). The browser's settings come first (General: on startup, default browser, search engine, downloads, languages, performance, import and reset; Appearance, with fonts and zoom; Privacy and security; Site settings; Passwords and autofill; Extensions; Keyboard shortcuts; see Browsing), then Rune Browser's own (Agents, with the coding agents; Workspace; Agent permissions; Web tools: site customizations and network rules), then its pages (Bookmarks, Downloads, History, Snapshots, Schedules, Mods, API map and Activity), with About at the bottom. A category can have parts shown on its page (General's Search engine): opening one ("Settings: Search engine" in the command bar, `rune://settings/browser-search`) opens its page there. The search above the sidebar looks through every category at once: only the matching settings are shown, the words highlighted, the sidebar narrowed to the categories that have them; Enter opens the first, Escape clears it. Each category and part is also in the command bar ("Settings: Agents"), and the pages keep their own commands ("Open History").

Tabs are put in order by dragging them up or down (or "Move up"/"Move down" in their menu). The order is saved per workspace (`PUT /api/workspaces/:id/order`); new tabs, copies and tabs moved in from another workspace go last.

Every tab can have its own icon ("Change icon…" in its menu): a Lucide icon (searchable), an emoji or an uploaded image (scaled to a 64px PNG). It's shown in the sidebar and the command bar; "Use the default" brings back the site's favicon.
