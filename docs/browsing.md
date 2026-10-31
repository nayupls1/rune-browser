# Browsing

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

## Web tabs

Web tabs are `<webview>`s in their workspace's session, separate from Rune Browser's own. The website agent works on the
open page and saves changes that apply on every visit. It gets only the page tools, no files or shell.

**Page changes** (`db/PageChanges.ts`, applied by `shared/web.ts`) are single changes, each with a title:

- **What:** hide elements, restyle them (CSS declarations), replace their text, set an attribute, insert HTML next to or inside them, add a button with a click handler, or a stylesheet or script.
- **Where:** a site (host; what the agent uses by default, so a change stays when you move around the site), a pattern (`*.example.com/*`, `example.com/docs/*`; `*.` also covers the bare domain), or one page (host and path, ignoring query and hash) when you ask for just that page. A change's scope can be changed from its row (click where it applies).
- **Lasting:** they're applied on every load and in single-page apps on in-page navigation. A MutationObserver applies them to content the page adds later. CSS goes in through `insertCSS`, so pages' content security policies don't block it, and button handlers are compiled with the injected script rather than `eval`ed.
- **Visible:** the paintbrush in the address bar lists every change on the page (and the site's CSS/JS override) with a switch and a remove button, and Settings → Web tabs lists all of them. Turning one off undoes it in place; only scripts need a reload, since what they did can't be taken back.
- **Tools:** the website agent uses `add_page_change`, `update_page_change`, `remove_page_change` and `list_page_changes`, and asks per site or pattern first (`agent.site`). The API is `/api/page-changes`.
- **History:** changes are part of the site customizations' snapshots (`@changes/<id>.json`). The agent improves an existing change rather than adding another, and has `list_snapshots`, `view_snapshot` and `restore_snapshot` (only the site it's on; the app builder has the same for its app). Agents can't delete snapshots.

**Using pages for you.** The website agent can also do things on the web: open pages, click, type, fill in forms, press keys, scroll and wait for content (`agent/browseTools.ts`), with real input events in the tab you're looking at, so it works with your logins there.

- **Every action names its element first** (by selector, visible text or a point on a screenshot; `lib/browse.ts` finds it in the page), so Rune Browser can check it before anything happens.
- **Your OK per site:** acting on a site with your session asks once per site (`agent.browse`, rememberable in Settings → Permissions).
- **Confirmation every time** for what has consequences: clicking or submitting something that buys, pays, books, sends, posts, subscribes or deletes, submitting a form that takes card details, and typing card details (`agent.confirm`, never remembered). The agent asks for anything else with consequences itself (`confirm_action`). Passwords are never typed: you sign in yourself.
- **Visible:** a marker shows where it clicks or types, and a banner says the agent is using the page, with **Take over**, which stops it.
- **App actions:** what it finds can go into your apps with `use_app_tool` (after your OK for that app's tool).
- **Limits:** the checks read the element's text, name and form, so a site that labels "Buy" as an icon only can slip past the confirmation (the agent is told to use `confirm_action` then). `run_js` can still change a page directly; it's meant for exploring.

**Opening files.** Dragging a file into Rune Browser opens it, like in Chrome (`lib/drops.ts`):

- **Where:** dropped on the tab list or the window, it opens in a new tab; on a web tab in the list, in that tab (the tab gets a highlight, the list a slot where the new tab will be, the window an overlay). Several files open in several tabs.
- **What:** what a browser shows (PDFs, images, video, audio, text, pages, SVG) opens as a `file://` page; anything else is downloaded. Paths typed in the address bar open too.
- **Pages keep theirs:** a file dropped on a page's upload area is uploaded; dropped elsewhere on a page, it opens in that tab. Links and text dropped on the tab list open or are searched for.
- **Not for pages or agents:** a page (or an agent's script in it) can't navigate to a local file, only the user can open one; the website agent's `navigate` only opens websites.

The older **site override** (one stylesheet and script per hostname, `set_site_override`) still exists for larger reworks.

Web tab logins are cookies, which are encrypted with a key from the same keychain, like Chrome's. The `EnableCookieEncryption` fuse is set in `electron-builder.yml` for the packaged app, and by `scripts/electron.ts` in `node_modules` for runs from source. As in Chrome, a site's local storage, IndexedDB and cache aren't encrypted. They sit in the 0700 profile folder.

Web tabs say they're plain Chrome, because some sites turn away other browsers. Google's sign-in can tell that Rune Browser isn't Chrome, though, and refuses a browser that claims to be ("This browser or app may not be secure"). It accepts Electron when the user agent names it. So requests to `accounts.google.com` get Electron's own user agent, through the built-in extension that applies the network rules (`signInRule` in `src/shared/extensions.ts`).

## Network

Every web tab's traffic is recorded in Electron's main process over the DevTools protocol (`src/main/network.ts`). "Network requests" in the command bar opens the Network panel: requests with their headers and the data they returned, filterable, data (fetch/XHR, JSON, XML, forms) by default.

- **Bounded memory:** the last 500 requests per tab. Response bodies are kept for structured data only, at most 256 kB each, 3 MB per tab and 24 MB in all; the oldest go first. Settings → Network turns recording off.
- **Credentials stay hidden:** cookies, `Authorization` and other credential headers, token-like URL parameters and JSON or form fields (`password`, `accessToken`…), JWTs and bearer tokens show as `[redacted]`. In the panel you can show them; the website agent only ever gets them redacted.
- **Send again:** a captured request is sent again with the workspace's session (its cookies, plus the original credential headers), optionally changed.
- **Save for later:** a saved request is stored per workspace with its credentials sealed (AES-GCM, with a key only the main process uses; the server stores the blob but never returns it). It can be sent from the panel's Saved tab or by the website agent without opening the site.
- **Rules** block requests or set and remove request or response headers, for every workspace or one (Settings → Network, or "Block like this" in the panel). Patterns use `*` over the whole URL, or match text anywhere in it. A small built-in extension applies them as `declarativeNetRequest` session rules (`src/main/extensions/builtin.ts`), so they work alongside extensions like uBlock Origin Lite: Electron turns off every extension's blocking in a session that has `webRequest` hooks. Requests sent again from the panel check the rules themselves.

The website agent has `network_requests`, `network_request`, `replay_request`, `save_request`, `saved_requests` and `send_saved_request`. Sending anything with the user's session asks first, once per site (permission `agent.network`), and every call is in the activity log.

### Response overrides

The website agent can change what a site's API requests return in your tabs, so a page shows any state it needs to
see or test (empty, failing, slow, still loading) without touching its backend (`shared/overrides.ts`, applied by
`main/overrides.ts`). Making them is the agent's job; you see them and remove them.

- **What:** an override answers requests matching a pattern (as in rules: `*` over the whole URL, or text it contains) and
  optionally one method. It can **respond** (status, headers, body; whatever isn't set comes from the site, and with both
  status and body set the request never goes out), **fail** like the network does (offline, timed out, refused…) or
  **hang** (never answer: the loading state). A delay makes any of them slow.
- **How:** the main process pauses a tab's fetch, XHR and EventSource requests with the DevTools protocol's `Fetch`
  domain, only while an override could apply to that tab. Answers made up for another origin carry CORS headers (and
  their preflights are answered too), a replaced body drops the old one's length and encoding, and a hanging request
  goes on to the site once its override is removed. Pages and other resources aren't touched.
- **Where and how long:** one tab (the default; it goes away with the tab), the pages of one site (the page's host,
  wherever its requests go), or every tab of the workspace. They expire after an hour unless the agent asks for another
  time or none.
- **Tools:** `override_response`, `response_overrides` and `remove_response_override` (e.g. to go through every state of
  a page and take a screenshot of each). The tabs have the new list before a tool returns, so a reload right after sees it.
- **Your OK, visible, removable:** overriding a site asks first, per site (`agent.override`, rememberable). The flask in
  the address bar counts the overrides on the page and lists them with remove buttons; Settings → Network lists all of
  them. Requests they answered have the flask in the Network panel. Every tool call and every removal
  (`network.override.delete`) is in the activity log. The API only lists and removes them (`/api/response-overrides`).

### API map

While the user browses, web tabs' API calls (fetch, XHR, structured responses) build a map of each site's API: every
endpoint, grouped by host, with its parameters, request body and responses (`shared/endpoints.ts`).

- **Shapes, never values:** the main process turns a finished request into an observation before it leaves
  `main/network.ts`. Paths become templates (`/users/123` → `/users/{id}`; uuids, emails, dates, hashes and long ids
  too). Query and form parameters, JSON fields and the site's own request headers keep their name and kind of value
  (integer, string, `date`, `email`, `url`…). Credentials (by name, as in redaction) keep only their name, objects keyed
  by data (ids, emails) become maps, and GraphQL keeps the operation name and the variables' shape, not the query.
- **Grows over time:** the server merges observations into `api_endpoints` (`db/Endpoints.ts`). Fields seen in only
  some requests become optional, different kinds become alternatives, responses are kept per status, and paths that
  differ in one segment (4 or more values, e.g. `/users/ada`, `/users/bob`…) become one template. Each host keeps at most
  300 endpoints (the least used make room), each workspace 5000.
- **Browse:** Settings → API map lists the workspace's hosts, their endpoints and each one's shapes.
- **Agents and apps:** both agents have `api_map` (hosts, a host's endpoints, or a search). Apps' servers call
  `GET $RUNE_API_URL/endpoints?search=` after the user allows it (`app.endpoints`, audited).
- **Privacy controls:** a switch turns the map off (it also needs traffic recording). A site can be left out (it covers
  its subdomains, and deletes what was mapped for it), a host's map can be deleted, and a deleted workspace takes its map
  with it.

## Extensions

Web tabs run Chrome extensions (Manifest V3 and V2) with Electron's extension support. Each workspace's session loads its own copy, so an extension only sees the tabs of its workspace and keeps separate data there (`chrome.storage.sync` is the exception: one copy per extension, shared). Settings → Extensions lists them. You can add one from the Chrome Web Store (link or ID), load an unpacked folder, or import from a browser. Store extensions update every 5 hours.

**Import from your browser** (Settings → Extensions, or the puzzle menu in a web tab) reads the profiles of Chrome, Chromium, Brave, Edge and Vivaldi (including Flatpak and Snap installs). It offers what's turned on there. Store extensions are copied and keep their IDs. Unpacked ones are used from their folder. They come along with:

- which ones are pinned (at the top of the extensions menu);
- the keyboard shortcuts changed there;
- with "Bring their settings too", what they saved: `chrome.storage.local`, their dynamic blocking rules and IndexedDB (sign-ins, preferences).

An imported extension gets `runtime.onInstalled` with `reason: "update"`, so it doesn't open its welcome pages again.

**APIs.** What Electron lacks is added by a shim that the extension preload (`src/extension-preload/`) injects into extension pages and service workers; the main process does the work (`src/main/extensions/apis.ts`):

- toolbar buttons (`action`, `browserAction`, `pageAction`: badges, popups, per-tab state);
- `tabs`/`windows` (tabs open, select and close through Rune Browser's tab list);
- `commands`, `contextMenus`, `permissions` (optional ones ask first);
- `storage.sync`, `webNavigation`, `cookies`, `notifications`, `idle`, `management`, `downloads.download`, `search`, `system.cpu`/`memory`/`display`;
- `runtime.onInstalled`/`onStartup`/`openOptionsPage`;
- native messaging.

**Site sign-ins** (HTTP Basic/Digest, proxies): Electron cancels them and never asks extensions. Rune Browser handles them itself (`login` in `src/main/web.ts`): extensions that listen to `webRequest.onAuthRequired` (with `webRequestAuthProvider` or `webRequestBlocking`, and access to the site) are asked first, like in Chrome, so password managers fill them in. A retry keeps its request ID, and after two refused answers the extensions aren't asked again. Then Rune Browser's own sign-in dialog asks you (`components/AuthDialog.tsx`). App previews keep Electron's behavior.

Chromium puts its own namespaces back on `chrome` whenever bindings update (another extension loading does that), so the shim extends the namespaces Electron has instead of replacing them.

Stopped service workers are started again for the events they listened to. Electron doesn't enable static `declarativeNetRequest` rulesets by itself, so the shim enables the manifest's defaults on install and update.

**Native messaging** uses the browser's own host manifests (`NativeMessagingHosts` in the browser's profile folder, `/etc/opt/chrome`, `/etc/chromium`), or Rune Browser's own (`<userData>/NativeMessagingHosts`). A host only runs for the extensions in its `allowed_origins`, and doesn't get Rune Browser's environment variables.

**Caveats:**

- **Limited permissions** (`shared/extensions.ts`, `permissionAbout`): what Rune Browser doesn't have gets a stand-in, so the extension keeps working: `history`, `bookmarks`, `sessions`, `tabGroups`, `topSites` are empty, `privacy` and `fontSettings` read as defaults and change nothing, `identity`, `tabCapture`, `gcm` and anything unknown fail with `lastError`, `desktopCapture` acts cancelled. A side panel (`sidePanel`) shows as the popup of its toolbar button, or in a tab. `userScripts` stays missing, like in Chrome with "Allow user scripts" off. Import and the extension's details say what's different for each.
- **Allowing and blocking permissions:** an extension's details list every permission it asks for with a switch. Blocking one restarts the extension; its calls then fail (in the shim and in the main process) and its events don't come. Optional permissions are granted or taken back there too.
- `chrome.storage.sync` data isn't imported (Chrome keeps it in a LevelDB that Rune Browser doesn't parse).
- Settings are imported into each workspace once, when the extension first loads there; later changes stay per workspace.

## Keyboard shortcuts

Rune Browser has Chromium's keyboard shortcuts on every platform (Cmd instead of Ctrl on macOS), plus its own. All of
them are listed and can be changed in Settings → Keyboard shortcuts. The command bar and tooltips show each action's keys.

- **Registry:** `shared/shortcuts.ts` lists every action with its default keys per platform and who gets the key first. It
  also matches pressed keys: letters go by what the layout types (Dvorak's Ctrl+T is where its T is), or by position
  when the layout types no Latin letter; digits always go by position.
- **Pages first, like Chromium:** in a page, the main process (`main/shortcuts.ts`) handles the keys Chromium reserves
  right away: new, close, reopen and switch tabs, close the window, quit, and Rune Browser's workspaces. Other keys go
  to the page first, as a keydown on whatever has the focus (with the legacy `keyCode`). The shortcut only runs if the
  page doesn't `preventDefault` it, so a site's own Ctrl+K or Ctrl+S keeps working. Esc reaches the page and also
  stops a load.
- **Conditional handler:** `lib/shortcuts.ts` has each action's code and when it applies (a tab to close, a page to
  zoom, something loading to stop). A key whose action doesn't apply is left alone. Keys pressed in Rune Browser's own
  UI that a component used itself (the agent picker's Ctrl+Tab) aren't taken.
- **No native menu shortcuts:** Linux and Windows have no application menu, and macOS has only its app, Edit and Window
  menus. Electron's default menu used to close the window on Ctrl+W, and reload or zoom Rune Browser itself.
- **Closing tabs:** Ctrl+W never closes the window. Closing the last tab opens a new one, and in Settings or Rune
  Browser's pages it goes back to the tabs.

### Chromium parity

| Chromium                                                                                           | Rune Browser                                                                 |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| New tab, close tab (Ctrl+W, Ctrl+F4), reopen closed tab                                            | Same                                                                         |
| Next and previous tab (Ctrl+Tab, Ctrl+PageDown/Up, macOS Cmd+Option+arrows and Cmd+Shift+[ ])      | Same, in the sidebar's order                                                 |
| Tab 1–8 and last tab (Ctrl+1–9; Alt+1–9 on Linux)                                                  | Same                                                                         |
| Move tab (Ctrl+Shift+PageUp/Down)                                                                  | Moves it up or down the sidebar                                              |
| Back, forward (Alt+arrows, macOS Cmd+[ ] and Cmd+arrows, browser keys, mouse back/forward buttons) | Same                                                                         |
| Reload, hard reload (Ctrl+R, F5, Ctrl+Shift+R, Shift+F5, Ctrl+F5), stop (Esc)                      | Same                                                                         |
| Focus the address bar (Ctrl+L, Alt+D, F6), search (Ctrl+E)                                         | Same                                                                         |
| Find, find next and previous (Ctrl+F, Ctrl+G, F3, Shift+F3, Ctrl+Shift+G)                          | Same, with a find bar                                                        |
| Zoom in, out, reset (Ctrl+Plus/=, Ctrl+Minus, Ctrl+0, Ctrl+scroll)                                 | Same, per site and workspace, shown in the address bar                       |
| Print (Ctrl+P), save page (Ctrl+S)                                                                 | Same (.html with its files, or .htm alone)                                   |
| DevTools, console, inspect (F12, Ctrl+Shift+I/J/C, macOS Cmd+Option+I/J/C)                         | Same                                                                         |
| Full screen (F11, macOS Cmd+Ctrl+F), close window (Ctrl+Shift+W, Alt+F4), quit (Ctrl+Shift+Q)      | Same (macOS quits with Cmd+Q)                                                |
| History (Ctrl+H, macOS Cmd+Y)                                                                      | Same                                                                         |
| Ctrl+click or middle click on a link; Ctrl+Shift+click, Shift+click                                | Same: a background tab; a tab that's shown (one window, so no new window)    |
| Address bar: Ctrl+Enter (www. and .com), Alt+Enter or Shift+Enter (macOS Cmd+Enter: new tab)       | Same                                                                         |
| Search tabs (Ctrl+Shift+A)                                                                         | Same, in the command bar                                                     |
| View source (Ctrl+U, macOS Cmd+Option+U)                                                           | Different: DevTools' Sources panel (Electron can't show view-source: pages)  |
| Bookmark page (Ctrl+D)                                                                             | Different: pins or unpins the tab (no bookmarks)                             |
| Downloads (Ctrl+J)                                                                                 | Different: shows or hides the agent (Rune Browser has no downloads page yet) |
| Bookmarks bar (Ctrl+Shift+B)                                                                       | Different: shows or hides the sidebar (no bookmarks)                         |
| Search in the address bar (Ctrl+K)                                                                 | Different: the command bar, which also searches                              |
| Bookmark manager (Ctrl+Shift+O)                                                                    | Not yet: no bookmarks                                                        |
| New window (Ctrl+N), private window (Ctrl+Shift+N)                                                 | Not yet: one window                                                          |
| Open file (Ctrl+O)                                                                                 | Not yet                                                                      |
| Clear browsing data (Ctrl+Shift+Delete), task manager (Shift+Esc), caret browsing (F7)             | Not yet                                                                      |
| Home (Alt+Home), menu (Alt+F, F10), focus toolbar (Alt+Shift+T)                                    | Not applicable: no home page or menu                                         |

Rune Browser's own: the command bar (Ctrl+K), the agent (Ctrl+J), the sidebar (Ctrl+Shift+B), workspaces 1–9
(Ctrl+Alt+1–9), Settings (Ctrl+,) and this list (Ctrl+/). Duplicating and new apps have no keys by default; you can
give them some. The mouse's back and forward buttons can be given to any action too (Settings records them like keys):
webviews don't act on them by themselves, so the main process takes them from the page's input events.
