# Browsing

[README](../../../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Releasing](releasing.md)

## Web tabs

Web tabs are `<webview>`s in their workspace's session, separate from Rune Browser's own. The website agent works on the
open page and saves changes that apply on every visit. It gets only the page tools, no files or shell.

**Page changes** (`db/PageChanges.ts`, applied by `shared/web.ts`) are single changes, each with a title:

- **What:** hide elements, restyle them (CSS declarations), replace their text, set an attribute, insert HTML next to or inside them, add a button with a click handler, or a stylesheet or script.
- **Where:** a site (host; what the agent uses by default, so a change stays when you move around the site), a pattern (`*.example.com/*`, `example.com/docs/*`; `*.` also covers the bare domain), or one page (host and path, ignoring query and hash) when you ask for just that page. A change's scope can be changed from its row (click where it applies).
- **Lasting:** they're applied on every load and in single-page apps on in-page navigation. A MutationObserver applies them to content the page adds later. CSS goes in through `insertCSS`, so pages' content security policies don't block it, and button handlers are compiled with the injected script rather than `eval`ed.
- **Visible:** the paintbrush in the address bar lists every change on the page (and the site's CSS/JS override) with a switch and a remove button, and Settings → Site customizations lists all of them. Turning one off undoes it in place; only scripts need a reload, since what they did can't be taken back.
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

**Insecure sites.** Pages over plain HTTP are opened over HTTPS when they can be, and Rune Browser warns before
showing one that can't, like other browsers (`shared/insecure.ts`).

- **HTTPS first:** an `http://` address (typed, a link, a redirect, a new tab, the agent's `navigate`) is tried as
  `https://` first. If that fails, takes more than 6 seconds to answer, or sends the tab back to HTTP, the tab shows a
  warning instead of the page (`components/InsecureWarning.tsx`). An address with a port of its own is warned about
  without trying.
- **The warning:** **Go back** returns to the page before; **Continue to site** opens it over HTTP until Rune Browser
  restarts, or for good with "Don't warn me about this site again". Settings → Browser → Privacy and security lists those sites (with a
  remove button) and has a switch that turns the whole thing off. "Until Rune Browser restarts" is per window, and a
  private window doesn't offer "for good" (it remembers nothing).
- **Not for local addresses:** this computer and the private network (`localhost`, `*.localhost`, private, link-local
  and VPN ranges, IPv6 local addresses, names without a dot, `.local`, `.lan`, `.home`, `.home.arpa`, `.internal`) are never
  upgraded or warned about. App previews aren't web tabs, so they aren't affected either.
- **Not secure:** the address bar says "Not secure" on a page shown over HTTP (and under the warning).
- **Same rules for everything:** what a web tab's page navigates to itself, its redirects and extensions'
  `tabs.update` are held back in the main process (`main/web.ts`) and handed to the tab, so tabs in the background and
  the website agent go through the same checks. Only the user can continue: the agent is told the page is behind the
  warning. Going back or forward to a page already allowed isn't checked again.

**Default browser.** Rune Browser can be the system's default browser (`main/defaultBrowser.ts`), so links and web files from other apps open in it:

- **Registered as a browser:** the installers declare http and https links and `.html`, `.htm`, `.xhtml`, `.shtml`, `.pdf`, `.svg` and `.webp` files (`shared/defaultBrowser.ts`): on Windows in the registry, so it's in Default apps and "Open with" (`build/installer.nsh`, removed again when uninstalled); on macOS in its Info.plist; on Linux in the `.desktop` file. It never takes files over by itself.
- **One copy:** launching it again (which is what opening a link does) hands the links and files to the running Rune Browser, where each opens in a new tab of the normal window used last (never a private one; with none open, the last one comes back or an empty one opens), and quits. macOS sends them as events instead. Links it's started with open once the window is ready. Anything that isn't a web link or an existing web file is ignored, and on Windows links come after `--`, so they can't pass switches to Chromium.
- **Settings → Browser → Default browser** shows whether it's the default. **Make default** sets it on Linux (`xdg-mime`, for links and web pages; an AppImage first writes its own `.desktop` file to `~/.local/share/applications`), asks macOS, which confirms with the user, and on Windows opens Settings at Rune Browser's default apps, since only the user can choose there. Runs from source can't be the default.

**Error pages** are Chromium's (`shared/loadErrors.ts`, `components/LoadError.tsx`): "This site can't be reached" and
the like, with Chromium's error code and Reload. A site whose certificate isn't valid gets "Your connection is not
private" first, with Back to safety, and under Advanced what's wrong with the certificate and "Proceed to … (unsafe)".
Going on is remembered for the site and that certificate in the workspace's session until Rune Browser quits
(`certificate-error` in `main/web.ts`), and the address bar warns while it's open. Only the user can go on, from Rune
Browser's window: pages and agents can't.

**The page's menu** (right click, `main/contextMenu.ts`) has Chromium's items for what was clicked: a link (open in a new
tab, save, copy its address or text), an image, video or audio (open, save, copy it or its address), a field (spelling
suggestions and Add to dictionary, undo, redo, cut, copy, paste, paste as plain text, emoji where the system has a
picker), selected text (copy, search for it with the search engine from Settings, or go to it when it's an address,
print) or else the page (back, forward, reload, save, print, view source). Extensions' items come after, and Inspect
last.

**Internal pages** have rune:// addresses (chrome:// ones open them): see [Chromium parity](chromium-parity.md).

The older **site override** (one stylesheet and script per hostname, `set_site_override`) still exists for larger reworks.

Web tab logins are cookies, which are encrypted with a key from the same keychain, like Chrome's. The `EnableCookieEncryption` fuse is set in `electron-builder.yml` for the packaged app, and by `scripts/electron.ts` in `node_modules` for runs from source. As in Chrome, a site's local storage, IndexedDB and cache aren't encrypted. They sit in the 0700 profile folder.

Web tabs say they're plain Chrome, because some sites turn away other browsers. Google's sign-in can tell that Rune Browser isn't Chrome, though, and refuses a browser that claims to be ("This browser or app may not be secure"). It accepts Electron when the user agent names it. So requests to `accounts.google.com` get Electron's own user agent, through the built-in extension that applies the network rules (`signInRule` in `src/shared/extensions.ts`).

## Browser settings

Settings → Browser has what a browser like Chrome lets you set, named and ordered like Chrome's and apart from Rune
Browser's own settings (`components/BrowserSettings.tsx`, `shared/browser.ts`). They're global, like the rest of the
settings; cookies and site data stay per workspace. The renderer sends them to the main process whenever they change
(`main/browser.ts`), which puts them into effect in web tabs:

- **Privacy and security:** clear browsing history (of a time range), cookies and other site data and/or the cache, of
  this workspace or all of them (extensions keep their data, like in Chrome); the warning before insecure sites; block
  third-party cookies; send Do Not Track.
- **Site settings:** location, camera, microphone, notifications, MIDI devices, clipboard, screen sharing, your device
  use (idle detection), window management, fonts, file editing, embedded content (storage access) and local network
  access (permissions: sites can ask, or not; see [Site permission prompts](#site-permission-prompts)), JavaScript, images and sound (content: allowed or not), each with a default and per site. A site is a
  host without `www.` and covers its subdomains; the most specific one wins. "All sites" lists the sites with their own
  settings, zoom or cookies, and each site's page has its settings, zoom and a button that deletes its cookies and data.
  The sliders button in a web tab's address bar has the same for the site on screen.
- **Search engine:** DuckDuckGo, Google, Bing, Brave Search, Kagi, Ecosia, Startpage, or your own URL with `%s`.
- **Default browser:** see above.
- **On startup:** continue where you left off, a new tab, or specific pages (a tab already showing one is reused).
- **Fonts and zoom:** font size, the four font families, the minimum size; the default page zoom (what Ctrl+0 goes
  back to) and the zoom levels sites keep (zooming a page remembers it for its site).
- **Languages:** the preferred languages websites see (`Accept-Language`), spell check and its dictionaries (with
  suggestions and "Add to dictionary" in the context menu).
- **Downloads:** the folder (files get a free name there, like Chrome's "file (1).pdf") or asking every time; see [Downloads](#downloads).
- **Performance:** memory saver (unloading idle tabs, see Interface).
- **Autofill and passwords:** Rune Browser has no password store of its own; a password manager extension does that.
- **Import bookmarks and settings:** bookmarks through the bookmarks page's import (see [Bookmarks](#bookmarks)); settings
  from the Chromium-based browsers extension import finds, their Preferences: search
  engine, startup, site settings and defaults, third-party cookies and Do Not Track, zoom, fonts, languages and spell
  check, downloads (`browserSettingsFromChrome`). Site settings and zoom levels are merged into yours; an exception
  Chrome kept for one origin covers that host's subdomains here, like every site setting.
- **Reset settings:** the browser settings go back to their defaults (cookies, logins and Rune Browser's settings stay).

How they apply:

- **Permissions** go through the web sessions' permission handlers (`main/sitePermissions.ts`): what a site's settings
  or the default allow or block is answered right away, and a site that may ask is asked (see below).
- **JavaScript, images, third-party cookies and Do Not Track** are declarativeNetRequest rules of the built-in
  extension, after the network rules (`browserRulesToDnr`): no-script `Content-Security-Policy` on blocked sites' pages and the frames they embed directly (frames those frames load aren't covered),
  blocked image requests from blocked sites, `Cookie`/`Set-Cookie` removed from third-party requests, a `DNT: 1`
  header. They take effect on the next load. Blocking third-party cookies this way stops them on the network; a
  third-party frame's `document.cookie` still works.
- **Sound** mutes a site's tabs when they navigate there.
- **Fonts** are the webview's preferences when a tab's page is created; the font size also changes in open pages (over
  the DevTools protocol, which only lets a page's font families be set once, so new families and minimum sizes apply
  to new pages).
- **Languages** set the sessions' `Accept-Language` and spell checker (macOS uses its own spell checker and languages).

### Site permission prompts

Sites can ask for the permissions above, and you decide, like in Chrome (`shared/sitePermissions.ts`, asked by
`main/sitePermissions.ts`, shown by `components/SitePermissions.tsx`).

- **Prompts:** a site asking for something its settings don't decide gets a prompt over the top left of its tab, in
  that tab's window: which site, what it wants, and **Allow while visiting the site**, **Allow this time** (not for
  notifications, which arrive after the page is gone, or screen sharing) or **Never allow**. Closing it decides
  nothing; the site can ask again. A page asking again while its prompt is open joins it, and prompts go away with the
  page.
- **Remembered** in the site's settings: allowing or blocking sets the site's own Allow or Block, which the sliders
  button and Settings → Browser → Site settings show and change. "This time" lasts while the tab stays on the site.
- **Private windows** ask too, but keep their answers in the main process only, until the last private window closes.
  Like Chrome's incognito, they get what normal windows blocked, not what they allowed. Their settings are shown, not
  changed, in the sliders button.
- **Visible while in use:** while a page uses the camera, microphone, location or screen sharing, the sliders button
  shows their icons, and its popover has **Stop** for each (the page's tracks end, as if the device went away; location
  watches are cleared). Blocking something in use stops it too. A page refused something shows it crossed out there.
- **Screen sharing** always asks with a picker: entire screens, windows, and the workspace's tabs (with their sound;
  the system's sound only on Windows). On Wayland the system's own picker chooses. It can be blocked, never allowed for
  good, as in Chromium. Pages can't name a screen or window themselves (`getUserMedia` with Chrome's
  `chromeMediaSource`, which Electron would otherwise share as asked); Chrome refuses that to web pages too.
- **System permissions:** when macOS or Windows hasn't given Rune Browser the camera or microphone (or macOS the
  screen), the tab says so and opens the place in System Settings or Settings where it's allowed. macOS asks the first
  time a site is allowed one.
- **Same as Chromium:** the permissions and their defaults follow Chromium: those above ask; motion sensors, protected
  content, background sync and payment handlers are allowed; full screen, pointer and keyboard lock, writing to the
  clipboard and keeping the screen on need nothing. Permissions belong to the site in the address bar, also when a
  frame in it asks.
- **What pages see:** Electron's permission checks only answer yes or no, so a page would read "denied" for everything
  it hasn't been allowed yet. A small script in every page (over the DevTools protocol's Page domain; the Runtime
  domain stays off, since sites can tell) makes what isn't blocked read as "prompt", and keeps the tracks and location
  watches the page has, which the address bar reads while something might be in use.
- **Limits:** device pickers (USB, HID, serial, Bluetooth) aren't supported, and those requests are refused. Uses in
  frames of other sites, which the script can't reach, show as in use until the page goes away; stopping one reloads
  the page. App previews keep only the harmless permissions (full screen, pointer lock, writing to the clipboard).

## Browsing history

Web tabs keep a history of the pages they visited, like other browsers (`db/Visits.ts`, `shared/visits.ts`). Each workspace has its own, like a browser profile.

- **What's recorded:** websites and local files a web tab goes to, with the page's title, icon and the time. Blank, extension and `data:` pages aren't, a change of only the `#hash` isn't another visit, and a page that moves on before it has a title, within a moment, was a redirect: only where it went is recorded. The server records a visit when a tab reports a new address (`PATCH /api/apps/:id/page`, or opening a tab at an address). Visits stay when their tab is closed, go with their workspace, and are kept for 90 days.
- **The History page** (Ctrl+H, macOS Cmd+Y; the command bar's "Open History"; Settings → History; macOS: History → Show All History): visits grouped by day, newest first, searchable by title and address, for the current workspace or all of them. A click opens the page in a new tab (Ctrl+click or a middle click: in the background).
- **Deleting:** a visit's ×, or [clear browsing data](#browser-settings) (the History page's "Clear browsing data" opens it): browsing history of the last hour, 24 hours, 7 days, 4 weeks, or all time, in this workspace or every workspace, along with cookies and the cache if you like. Clearing history is in Activity (`history.clear`), without the pages.
- **The address bar** suggests pages from the workspace's history as you type (`GET /api/visits/suggest`): the site you're typing first, then pages whose title matches, then the rest, the often and recently visited ones higher.
- **Private windows** record no history, the address bar there suggests none, and their History page shows none.
- **Agents** don't see browsing history, and extensions' `chrome.history` stays empty.

## Bookmarks

Bookmarks work like Chrome's: a bookmarks bar and other bookmarks, with folders in them, the same in every workspace (`bookmarks/Bookmarks.ts`, the tree in `shared/bookmarks.ts`).

- **Bookmarking:** the star in a web tab's address bar, or Ctrl+D, bookmarks the page in the folder used last (the bookmarks bar at first), and a popover shows it to rename or move right away; on a page that's bookmarked already, the star is filled and opens the popover to change it or remove it. Ctrl+Shift+D puts every web tab of the workspace in a new folder.
- **Finding them:** the bookmark button in the sidebar's top row lists them (folders open inside the menu), the bookmarks bar above the page shows the bar's (turned on in that menu or the command bar), the address bar suggests bookmarks by name or address while you type, and the command bar finds them too. Clicking one opens it in the web tab on screen; Ctrl+click or the middle button in a background tab, Shift+click in a new one.
- **The bookmarks page** (Ctrl+Shift+O, rune://bookmarks, or Bookmarks in Settings): folders on the left, a folder's bookmarks on the right, or what a search finds in all of them. Rename in place (the pencil or F2), drag to put them in order or into a folder (or Move to…, Move up and down in their menu), Delete to delete one; a folder with things in it asks first.
- **Import** (the bookmarks page's Import, also in Settings → Browser → Import bookmarks and settings): from Chrome, Chromium, Brave, Edge, Vivaldi and other Chromium browsers (their `Bookmarks` file), Firefox, Zen, LibreWolf, Floorp and Waterfox (a copy of `places.sqlite`, since Firefox keeps it locked), or an HTML file, which Safari and the others export. The other browser's bar goes on the bookmarks bar and the rest into other bookmarks; where there are bookmarks already, they come in an "Imported from …" folder. Scripts (`javascript:`) and browser-only pages are left out, and the count says so.
- **Export:** an HTML file every browser imports, the bar marked as the toolbar.
- **Extensions** with the `bookmarks` permission read and change the same bookmarks through `chrome.bookmarks`, and get its events, whoever made the change. The main process asks the server (`main/extensions/apis.ts`); the renderer passes on the server's changes from the hub.
- **API:** `/api/bookmarks` (the tree, create, `PATCH` to rename or move with Chrome's indexes, `DELETE` with `?recursive=1` for a folder), `/api/bookmarks/sources`, `/api/bookmarks/import`, `/api/bookmarks/export`.

## Network

Every web tab's traffic is recorded in Electron's main process over the DevTools protocol (`src/main/network.ts`). "Network requests" in the command bar opens the Network panel: requests with their headers and the data they returned, filterable, data (fetch/XHR, JSON, XML, forms) by default.

- **Bounded memory:** the last 500 requests per tab; the oldest ordinary requests go first, while requests that change things (POST, PUT, PATCH, DELETE) outlast them (the last 100), and up to 100 requests the website agent has looked at or replayed stay until its chat ends, so a reload's traffic doesn't push out a request it's using. When the agent asks for one that's gone, it's told why. Response bodies are kept for structured data only, at most 256 kB each, 3 MB per tab and 24 MB in all; the oldest go first. Settings → Network turns recording off.
- **Credentials stay hidden:** cookies, `Authorization` and other credential headers, token-like URL parameters and JSON or form fields (`password`, `accessToken`…), JWTs and bearer tokens show as `[redacted]`. In the panel you can show them; the website agent only ever gets them redacted.
- **Send again:** a captured request is sent again with the workspace's session (its cookies, plus the original credential headers), optionally changed.
- **Save for later:** a saved request is stored per workspace with its credentials sealed (AES-GCM, with a key only the main process uses; the server stores the blob but never returns it). It can be sent from the panel's Saved tab or by the website agent without opening the site.
- **Rules** block requests or set and remove request or response headers, for every workspace or one (Settings → Network, or "Block like this" in the panel). Patterns use `*` over the whole URL, or match text anywhere in it. A small built-in extension applies them as `declarativeNetRequest` session rules (`src/main/extensions/builtin.ts`), so they work alongside extensions like uBlock Origin Lite: Electron turns off every extension's blocking in a session that has `webRequest` hooks. Requests sent again from the panel check the rules themselves.

The website agent has `network_requests`, `network_request`, `replay_request`, `save_request`, `saved_requests`, `send_saved_request`, `cancel_requests` (stops the page's pending requests without reloading it) and `batch_requests` (`agent/batchTools.ts`): a captured or saved request sent once for each item in a list, a few at a time (3 by default, at most 10), through the same approval, session and redaction as `replay_request`. A batch that changes things (POST, PUT, DELETE…) is confirmed first, showing how many requests go where. Results go into a file in the chat's folder, one per item with its status and body or its error. `batch_requests` waits for the batch to finish (up to `wait_seconds`), `wait_for_batch` waits for the rest and `cancel_batch` stops it; batches belong to the agent's turn, so stopping the agent stops them. Sending anything with the user's session asks first, once per site (permission `agent.network`), and every call is in the activity log.

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

Web tabs run Chrome extensions (Manifest V3 and V2) with Electron's extension support. Each workspace's session loads its own copy, so an extension only sees the tabs of its workspace and keeps separate data there (`chrome.storage.sync` is the exception: one copy per extension, shared). Private windows' session loads only the extensions allowed there ("Allow in private windows" in their details), and sees the private windows' tabs. An extension sees the tabs of its workspace in every window; the focused window's say which tab is active, and tabs it opens go to the window you used last. Settings → Extensions lists them. You can add one from the Chrome Web Store (link or ID), load an unpacked folder, or import from a browser. Store extensions update every 5 hours.

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
- `bookmarks` (Rune Browser's own, see Bookmarks);
- `runtime.onInstalled`/`onStartup`/`openOptionsPage`;
- native messaging.

**Site sign-ins** (HTTP Basic/Digest, proxies): Electron cancels them and never asks extensions. Rune Browser handles them itself (`login` in `src/main/web.ts`): extensions that listen to `webRequest.onAuthRequired` (with `webRequestAuthProvider` or `webRequestBlocking`, and access to the site) are asked first, like in Chrome, so password managers fill them in. A retry keeps its request ID, and after two refused answers the extensions aren't asked again. Then Rune Browser's own sign-in dialog asks you (`components/AuthDialog.tsx`). App previews keep Electron's behavior.

Chromium puts its own namespaces back on `chrome` whenever bindings update (another extension loading does that), so the shim extends the namespaces Electron has instead of replacing them.

Stopped service workers are started again for the events they listened to. Electron doesn't enable static `declarativeNetRequest` rulesets by itself, so the shim enables the manifest's defaults on install and update.

**Native messaging** uses the browser's own host manifests (`NativeMessagingHosts` in the browser's profile folder, `/etc/opt/chrome`, `/etc/chromium`), or Rune Browser's own (`<userData>/NativeMessagingHosts`). A host only runs for the extensions in its `allowed_origins`, and doesn't get Rune Browser's environment variables.

**Caveats:**

- **Limited permissions** (`shared/extensions.ts`, `permissionAbout`): what Rune Browser doesn't have gets a stand-in, so the extension keeps working: `history`, `sessions`, `tabGroups`, `topSites` are empty, `privacy` and `fontSettings` read as defaults and change nothing, `identity`, `tabCapture`, `gcm` and anything unknown fail with `lastError`, `desktopCapture` acts cancelled. A side panel (`sidePanel`) shows as the popup of its toolbar button, or in a tab. `userScripts` stays missing, like in Chrome with "Allow user scripts" off. Import and the extension's details say what's different for each.
- **Allowing and blocking permissions:** an extension's details list every permission it asks for with a switch. Blocking one restarts the extension; its calls then fail (in the shim and in the main process) and its events don't come. Optional permissions are granted or taken back there too.
- `chrome.storage.sync` data isn't imported (Chrome keeps it in a LevelDB that Rune Browser doesn't parse).
- Settings are imported into each workspace once, when the extension first loads there; later changes stay per workspace.

## Downloads

Downloads work like Chromium's (`main/downloads.ts`, shown by `components/Downloads.tsx`), for every session: web
tabs, app previews and Rune Browser's own window.

- **Saving:** files go to the downloads folder (Settings → Browser → Downloads: the system's, or one you pick), under a
  name that doesn't overwrite anything (`report (1).pdf`), or wherever you pick when "Ask where to save each file" is on
  there. "Save link as…" and "Save image as…"
  in a page's context menu always ask, and so do app previews (a sandboxed app only gets a file out where you say).
- **Progress:** a button appears in the sidebar's top row once something was downloaded, with a ring while files
  download (the taskbar or dock icon shows it too). Its panel lists this run's downloads with their speed, size and
  time left, and pauses, resumes or cancels them.
- **Finished and failed** downloads get a notice (with "Show in folder" or "Retry") and a dot on the button until
  they're looked at.
- **Risky files:** programs, installers and scripts (`.exe`, `.msi`, `.dmg`, `.pkg`, `.deb`, `.AppImage`, `.sh`,
  `.jar`, `.apk`…), and anything from a site without HTTPS (not this computer: apps on localhost are fine), are saved
  as `Unconfirmed 123456.download` until you choose: the panel opens by itself with **Discard** and **Keep anyway**.
  Keeping gives the file its name (asking where, if that's on); discarding deletes it. There's no Safe Browsing check:
  the warning goes by file type and site.
- **Downloads page** (rune://downloads; Ctrl+J, macOS Cmd+Shift+J, the command bar or Settings' pages): every download by day with its
  name, site and size, searchable. Open a file (its name), show it in its folder, retry a failed or cancelled one,
  remove one from the list or clear the list (the files stay). The list is kept in the profile (`downloads.json`, the
  newest 1000).
- **Private windows** see only their own downloads, like Chrome's incognito ones. They're never written to
  `downloads.json`, and they leave the list when the last private window closes (the files stay; what's still
  downloading stops).

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

The rest of Chromium (settings, internal pages, everyday behavior) is in [Chromium parity](chromium-parity.md).

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
| Reopen closed tab (Ctrl+Shift+T) after closing a window                                            | Same: reopens the window with its tabs                                       |
| History (Ctrl+H, macOS Cmd+Y)                                                                      | Same: browsing history, per workspace                                        |
| Downloads (Ctrl+J, macOS Cmd+Shift+J)                                                              | Same: the Downloads page, a downloads button and warnings before risky files |
| Ctrl+click or middle click on a link; Ctrl+Shift+click, Shift+click                                | Same: a background tab; a tab that's shown (Shift+click: not a new window)   |
| Address bar: Ctrl+Enter (www. and .com), Alt+Enter or Shift+Enter (macOS Cmd+Enter: new tab)       | Same                                                                         |
| Search tabs (Ctrl+Shift+A)                                                                         | Same, in the command bar                                                     |
| View source (Ctrl+U, macOS Cmd+Option+U)                                                           | Different: DevTools' Sources panel (Electron can't show view-source: pages)  |
| Bookmark page (Ctrl+D), bookmark all tabs (Ctrl+Shift+D)                                           | Same (pinning a tab has no keys; give it some in Settings)                   |
| Bookmarks bar (Ctrl+Shift+B)                                                                       | Different: shows or hides the sidebar; the bar is in the bookmarks menu      |
| Search in the address bar (Ctrl+K)                                                                 | Different: the command bar, which also searches                              |
| Bookmark manager (Ctrl+Shift+O, macOS Cmd+Option+B)                                                | Same: the Bookmarks page                                                     |
| New window (Ctrl+N), private window (Ctrl+Shift+N)                                                 | Same (see [Windows](interface.md#windows))                                   |
| Open file (Ctrl+O)                                                                                 | Not yet                                                                      |
| Clear browsing data (Ctrl+Shift+Delete), task manager (Shift+Esc), caret browsing (F7)             | Not yet                                                                      |
| Home (Alt+Home), menu (Alt+F, F10), focus toolbar (Alt+Shift+T)                                    | Not applicable: no home page or menu                                         |

Rune Browser's own: the command bar (Ctrl+K), the agent (Ctrl+I; Ctrl+J is Chromium's downloads), the sidebar (Ctrl+Shift+B), workspaces 1–9
(Ctrl+Alt+1–9), Settings (Ctrl+,) and this list (Ctrl+/). Duplicating, pinning, new apps and the bookmarks bar have
no keys by default; you can give them some. The mouse's back and forward buttons can be given to any action too (Settings records them like keys):
webviews don't act on them by themselves, so the main process takes them from the page's input events.
