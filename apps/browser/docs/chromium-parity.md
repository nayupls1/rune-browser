# Chromium parity

[README](../../../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Benchmarks](benchmarks.md) · [Releasing](releasing.md)

Rune Browser aims to work like Chromium wherever it's a browser, with Chromium's source as the reference: its
settings, shortcuts, internal pages and everyday behavior. This is the checklist, so the gaps are visible. Each item is:

- **Matched:** works like Chromium.
- **Different:** on purpose, or because Electron can't; the note says what Rune Browser does instead.
- **Not yet:** missing for now (often being worked on).
- **Not applicable:** a Chromium feature that has no place in Rune Browser (Google account sync, enterprise policies).

Rune Browser's own settings (agents, workspaces, permissions…) stay apart from the browser's.

## Internal pages

Rune Browser's pages have rune:// addresses, and chrome:// addresses open the one that matches (chrome://settings is
rune://settings, chrome://extensions rune://extensions; `about:version` works too). rune://rune-urls lists them, with
Chromium's pages and how each fares here. They're defined in `shared/internalPages.ts` and shown in Settings (the
address bar shows their rune:// address); Chromium's settings pages map to Settings' categories
(chrome://settings/search is Settings → General → Search engine).

| Chromium                                                                                          | Rune Browser   | Note                                                                                       |
| ------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| chrome://settings (and its pages, chrome://help)                                                  | Matched        | rune://settings, rune://settings/&lt;category&gt;; Rune Browser's own settings beside them |
| chrome://extensions                                                                               | Matched        | rune://extensions                                                                          |
| chrome://version                                                                                  | Matched        | rune://version: versions (Rune Browser, Chromium, Electron, V8, Node.js, Bun), OS, paths   |
| chrome://gpu                                                                                      | Matched        | rune://gpu: graphics feature status and the GPU's details, with "Copy report"              |
| chrome://flags                                                                                    | Matched        | rune://flags: a chosen set of Chromium's flags, applied at the next start                  |
| chrome://chrome-urls, chrome://about                                                              | Matched        | rune://rune-urls                                                                           |
| chrome://newtab                                                                                   | Matched        | rune://newtab opens a new web tab                                                          |
| chrome://history                                                                                  | Matched        | rune://history: visited pages by day (see [Browsing](browsing.md#browsing-history))        |
| chrome://downloads                                                                                | Matched        | rune://downloads: every download by day (see [Browsing](browsing.md#downloads))            |
| chrome://bookmarks                                                                                | Matched        | rune://bookmarks: your bookmarks in folders (see [Browsing](browsing.md#bookmarks))        |
| chrome://password-manager                                                                         | Different      | No password store of its own: password manager extensions (Bitwarden, 1Password) do it     |
| chrome://settings/content                                                                         | Matched        | rune://settings/browser-sites: site settings                                               |
| chrome://inspect                                                                                  | Different      | DevTools open from the page (F12)                                                          |
| chrome://crashes                                                                                  | Different      | Rune Browser tells you when it crashed, with a report to send                              |
| chrome://accessibility                                                                            | Not applicable | A Chromium developer page                                                                  |
| chrome://components                                                                               | Not applicable | Rune Browser updates as a whole                                                            |
| chrome://policy, chrome://management                                                              | Not applicable | No enterprise policies or management                                                       |
| chrome://sync-internals, chrome://signin-internals                                                | Not applicable | No Google account                                                                          |
| chrome://net-internals, chrome://net-export                                                       | Not applicable | The Network panel shows a tab's traffic                                                    |
| chrome://serviceworker-internals, chrome://indexeddb-internals                                    | Not applicable | DevTools' Application panel                                                                |
| chrome://tracing                                                                                  | Not applicable | DevTools' Performance panel                                                                |
| chrome://media-internals, chrome://webrtc-internals, chrome://process-internals, chrome://sandbox | Not applicable | Chromium developer pages                                                                   |
| chrome://dino                                                                                     | Not applicable | No offline game                                                                            |

**rune://flags** (`shared/flags.ts`) has Chromium's names and descriptions: Override software rendering list, GPU
rasterization, Zero-copy rasterizer, Hardware-accelerated video decode, Smooth Scrolling and Overlay Scrollbars (Linux
and Windows), Auto Dark Mode for Web Contents, Parallel downloading, Experimental QUIC protocol and Experimental Web
Platform features. What's set is kept in `<userData>/flags.json` and applied as command line switches before the app
starts (`main/flags.ts`), so a change asks for a relaunch. Switches given on the command line win, and safe mode leaves
the flags out, in case one keeps Rune Browser from starting. Flags that Electron reads before Rune Browser's code runs
(the Ozone platform on Linux) can't be offered. Rune Browser turns off one Chromium feature on its own: RenderDocument (a new frame for every
page a tab goes to), which delays every page a `<webview>` shows (`applyDefaultFeatures` in `main/flags.ts`);
`--enable-features=RenderDocument` turns it back on.

## Settings

Chromium's settings, by its own sections. Browser settings get their own part of Settings, apart from Rune Browser's.

| Chromium                       | Rune Browser   | Note                                                                                                                                           |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Autofill and passwords         | Different      | Settings → Passwords and autofill: no password store of its own; password manager extensions work                                              |
| Privacy and security           | Matched        | Clear browsing data, the insecure-site warning, third-party cookies, Do Not Track                                                              |
| Clear browsing data            | Different      | History, downloads, cookies and cache by time range; cookies and cache for the sites visited in the range                                      |
| Site settings                  | Matched        | Location, camera, microphone, notifications, MIDI, clipboard, JavaScript, images, sound; per site                                              |
| Performance (Memory Saver)     | Matched        | Settings → General → Performance (tab unloading; tab cleanup closes tabs unused for long)                                                      |
| Appearance                     | Different      | Fonts and page zoom in Settings → Appearance → Fonts and zoom; themes are Rune Browser's Appearance                                            |
| Search engine                  | Matched        | Settings → General → Search engine, or your own URL                                                                                            |
| Default browser                | Matched        | Settings → General → Default browser; links and web files from other apps open as tabs                                                         |
| On startup                     | Matched        | Continue, a new tab, or specific pages (your tabs stay in the sidebar)                                                                         |
| Languages, spell check         | Matched        | Preferred languages for websites, spell check and its dictionaries (macOS: the system's)                                                       |
| Downloads                      | Matched        | Settings → General → Downloads: the folder, or ask every time                                                                                  |
| Import bookmarks and settings  | Different      | Bookmarks from Chrome, Firefox or HTML; settings from Chromium-based browsers; no passwords (see Browsing)                                     |
| Reset settings                 | Matched        | Settings → General → Reset settings                                                                                                            |
| Extensions                     | Matched        | Settings → Extensions (rune://extensions)                                                                                                      |
| About Chrome                   | Matched        | Settings → About: version, updates, release channel                                                                                            |
| Accessibility                  | Different      | Follows the system's (screen readers, contrast, reduced motion); text size in Fonts and zoom; no Live Caption or image descriptions (Google's) |
| System                         | Different      | Settings → General → System: keeps running in the background (tray icon), open at login; GPU switches in rune://flags; system proxy            |
| You and Google (sync, sign-in) | Not applicable | No Google account                                                                                                                              |

## Extension APIs

Chrome's extension APIs, by the permission that gives them (see [Browsing → Extensions](browsing.md#extensions)).

| Chromium                                                                                        | Rune Browser   | Note                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| action, tabs, windows, commands, contextMenus, permissions, storage, scripting, alarms          | Matched        | Electron's, completed by the shim                                                  |
| declarativeNetRequest, webRequest, webNavigation, cookies, offscreen, i18n, idle, notifications | Matched        |                                                                                    |
| bookmarks, history, topSites, sessions, downloads                                               | Matched        | Rune Browser's own, per workspace; no other devices in sessions                    |
| browsingData, contentSettings, privacy, fontSettings, proxy                                     | Matched        | Change Rune Browser's settings; settings it doesn't have read as Chrome's defaults |
| debugger, declarativeContent, pageCapture, power, geolocation, favicon, search, management      | Matched        |                                                                                    |
| desktopCapture, tabCapture                                                                      | Matched        | Rune Browser's screen picker (screens and windows); tabs by their id               |
| sidePanel                                                                                       | Matched        | A panel on the right of the window                                                 |
| tts, userScripts, nativeMessaging, system.cpu/memory/display                                    | Matched        | User scripts need the permission allowed in its details                            |
| identity                                                                                        | Different      | Signing in on websites works; no browser account for getAuthToken                  |
| ttsEngine                                                                                       | Different      | Its voices are for extensions, not web pages                                       |
| system.storage                                                                                  | Different      | Devices are listed; ejecting isn't available                                       |
| tabGroups                                                                                       | Not applicable | Rune Browser has no tab groups                                                     |
| gcm                                                                                             | Not applicable | Google's push messaging for Chrome                                                 |

## Keyboard shortcuts

All of Chromium's shortcuts, on Windows, macOS and Linux: see the table in
[Browsing → Keyboard shortcuts](browsing.md#chromium-parity). Every shortcut is listed and can be changed in Settings →
Keyboard shortcuts (rune://shortcuts).

## Everyday behavior

| Chromium                                                  | Rune Browser   | Note                                                                                                                                                                    |
| --------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find in page                                              | Matched        | Find bar, Ctrl+F, Ctrl+G, F3                                                                                                                                            |
| Zoom                                                      | Matched        | Per site and workspace, shown in the address bar, Ctrl+scroll                                                                                                           |
| Certificate warnings                                      | Matched        | "Your connection is not private", Advanced, "Proceed to … (unsafe)"; remembered for the site in the workspace until Rune Browser quits                                  |
| Error pages                                               | Matched        | "This site can't be reached", "No internet"… with Chromium's words and codes                                                                                            |
| Crashed tabs ("Aw, Snap!")                                | Matched        | The sad tab with Chromium's words, error code (SIGKILL, Out of Memory…) and Reload; one that crashed in the background reloads when shown                               |
| Back/forward history after a restart                      | Matched        | Tabs come back with their last 50 pages, also unloaded tabs and Ctrl+Shift+T; private windows keep none: see [Browsing](browsing.md#web-tabs)                           |
| Context menus                                             | Matched        | Links, images, video and audio, fields (spelling suggestions, Add to dictionary, Paste as plain text, Emoji), selections ("Search … for", "Go to …"), the page, Inspect |
| HTTP sign-in prompts                                      | Matched        | Extensions first (password managers), then Rune Browser's dialog                                                                                                        |
| Opening files (drag and drop, typed paths)                | Matched        | See [Browsing → Opening files](browsing.md#web-tabs)                                                                                                                    |
| Full screen                                               | Matched        | F11, and pages' own full screen                                                                                                                                         |
| Save page, view source                                    | Matched        | Save page as .html with its files or .htm; view source opens DevTools' Sources panel (Electron can't show view-source: pages)                                           |
| Printing                                                  | Different      | The system's print dialog (Electron has no print preview)                                                                                                               |
| New tab                                                   | Different      | A blank tab with the address bar focused (no tiles of top sites)                                                                                                        |
| Pop-ups                                                   | Different      | Open as tabs (Ctrl+click and middle click in the background)                                                                                                            |
| Context menu: open link in new window or incognito window | Matched        | "Open link in new window" (private from a private window, in the page's workspace otherwise) and "Open link in private window" (grayed out in one)                      |
| Context menu: Translate, Cast, Google Lens                | Not applicable | No Google services                                                                                                                                                      |
| Context menu: Loop, Show controls on video                | Matched        | Checked as the element is, with Picture in picture and Copy video frame; audio has Loop and Show controls too                                                           |
| HTTP warnings ("Not secure")                              | Matched        | HTTPS first, a warning before plain HTTP pages, "Not secure" in the address bar: see [Browsing](browsing.md#web-tabs)                                                   |
| Downloads                                                 | Matched        | Saved without fuss, progress, a warning before risky files are kept, the Downloads page (Ctrl+J): see [Browsing](browsing.md#downloads)                                 |
| Bookmarks                                                 | Matched        | Star and Ctrl+D, a bookmarks bar and menu, the Bookmarks page (Ctrl+Shift+O), import from Chrome, Firefox or HTML, export: see [Browsing](browsing.md#bookmarks)        |
| Search suggestions in the address bar                     | Matched        | The search engine's suggestions as you type, after tabs, bookmarks and history; a switch in Privacy and security: see [Browsing](browsing.md#search-suggestions)        |
| History                                                   | Matched        | The pages you visited by day, searched and deleted, suggested by the address bar (Ctrl+H): see [Browsing](browsing.md#browsing-history)                                 |
| Site permission prompts                                   | Matched        | Prompts in the tab, remembered in site settings, in use shown with Stop: see [Browsing](browsing.md#site-permission-prompts)                                            |
| Push API (notifications from sites' service workers)      | Matched        | Through ntfy (ntfy.sh, or your own server), not Google's push service; same API and errors: see [Browsing](browsing.md#push-notifications)                              |
| Notifications from closed tabs                            | Different      | While Rune Browser runs (it stays in the background once its windows close, like Chrome); what's sent after it quits arrives at the next start                          |
| Password and autofill prompts                             | Different      | No password store of its own: password manager extensions fill and save passwords, addresses and cards                                                                  |
| Task manager                                              | Matched        | Shift+Esc: rune://task-manager, a page rather than a window; memory, CPU and process ID, sortable, End process for tabs                                                 |
| New windows, private windows                              | Matched        | Ctrl+N, Ctrl+Shift+N, moving tabs between windows: see [Interface](interface.md#windows)                                                                                |
| Passkeys and security keys (WebAuthn)                     | Different      | USB security keys, with Rune Browser's prompts (touch, account, why it failed); Windows' dialog there: see [Browsing](browsing.md#passkeys-and-security-keys)           |
| Security key PIN entry                                    | Not yet        | Electron can't ask for a PIN: such a key is refused and the prompt says why (Windows' own dialog asks for it)                                                           |
| Passkeys on this device (Touch ID, Windows Hello)         | Different      | Windows Hello on Windows; none on Linux, and macOS needs Apple entitlements Rune lacks (refused at once, with what to use)                                              |
| Passkeys on a phone (QR code, hybrid)                     | Not yet        | Only through Windows 11's dialog; Chrome's QR code and tunnel aren't in Electron                                                                                        |
| Google Password Manager passkeys                          | Not applicable | No Google account; password manager extensions' passkeys work                                                                                                           |
| Safe Browsing                                             | Not applicable | Google's service; extensions can block sites                                                                                                                            |
