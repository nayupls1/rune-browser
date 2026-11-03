# Chromium parity

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

Rune Browser aims to work like Chromium wherever it's a browser, with Chromium's source as the reference: its
settings, shortcuts, internal pages and everyday behavior. This is the checklist, so the gaps are visible. Each item is:

- **Matched:** works like Chromium.
- **Different:** on purpose, or because Electron can't; the note says what Rune Browser does instead.
- **Not yet:** missing for now (often being worked on).
- **Not applicable:** a Chromium feature that has no place in Rune Browser (Google account sync, enterprise policies).

Rune Browser's own settings (agents, apps, secrets…) stay apart from the browser's.

## Internal pages

Rune Browser's pages have rune:// addresses, and chrome:// addresses open the one that matches (chrome://settings is
rune://settings, chrome://extensions rune://extensions; `about:version` works too). rune://rune-urls lists them, with
Chromium's pages and how each fares here. They're defined in `shared/internalPages.ts` and shown in Settings (the
address bar shows their rune:// address); Chromium's settings pages map to Settings' categories
(chrome://settings/search is Settings → Browser → Search engine).

| Chromium                                                                                          | Rune Browser   | Note                                                                                       |
| ------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| chrome://settings (and its pages, chrome://help)                                                  | Matched        | rune://settings, rune://settings/&lt;category&gt;; Rune Browser's own settings beside them |
| chrome://extensions                                                                               | Matched        | rune://extensions                                                                          |
| chrome://version                                                                                  | Matched        | rune://version: versions (Rune Browser, Chromium, Electron, V8, Node.js, Bun), OS, paths   |
| chrome://gpu                                                                                      | Matched        | rune://gpu: graphics feature status and the GPU's details, with "Copy report"              |
| chrome://flags                                                                                    | Matched        | rune://flags: a chosen set of Chromium's flags, applied at the next start                  |
| chrome://chrome-urls, chrome://about                                                              | Matched        | rune://rune-urls                                                                           |
| chrome://newtab                                                                                   | Matched        | rune://newtab opens a new web tab                                                          |
| chrome://history                                                                                  | Not yet        | Browsing history is on its way                                                             |
| chrome://downloads                                                                                | Not yet        | Downloads and a downloads page are on their way                                            |
| chrome://bookmarks                                                                                | Not yet        | Bookmarks are on their way                                                                 |
| chrome://password-manager                                                                         | Not yet        | No password manager yet: password manager extensions (Bitwarden, 1Password) work           |
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
(the Ozone platform on Linux) can't be offered.

## Settings

Chromium's settings, by its own sections. Browser settings get their own part of Settings, apart from Rune Browser's.

| Chromium                       | Rune Browser   | Note                                                                                              |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------- |
| Autofill and passwords         | Different      | Settings → Browser: no password store of its own; password manager extensions work                |
| Privacy and security           | Matched        | Clear browsing data (all time only), the insecure-site warning, third-party cookies, Do Not Track |
| Site settings                  | Matched        | Location, camera, microphone, notifications, MIDI, clipboard, JavaScript, images, sound; per site |
| Performance (Memory Saver)     | Matched        | Settings → Browser → Performance (tab unloading)                                                  |
| Appearance                     | Different      | Fonts and page zoom in Settings → Browser → Fonts and zoom; themes are Rune Browser's Appearance  |
| Search engine                  | Matched        | Settings → Browser → Search engine, or your own URL                                               |
| Default browser                | Matched        | Settings → Browser → Default browser; links and web files from other apps open as tabs            |
| On startup                     | Matched        | Continue, a new tab, or specific pages (your tabs stay in the sidebar)                            |
| Languages, spell check         | Matched        | Preferred languages for websites, spell check and its dictionaries (macOS: the system's)          |
| Downloads                      | Matched        | Settings → Browser → Downloads: the folder, or ask every time                                     |
| Import bookmarks and settings  | Different      | Settings from Chromium-based browsers; no bookmarks or passwords (see Browsing)                   |
| Reset settings                 | Matched        | Settings → Browser → Reset settings                                                               |
| Extensions                     | Matched        | Settings → Browser → Extensions (rune://extensions)                                               |
| About Chrome                   | Matched        | Settings → About: version, updates, release channel                                               |
| Accessibility, System          | Not yet        | Hardware acceleration switches are in rune://flags                                                |
| You and Google (sync, sign-in) | Not applicable | No Google account                                                                                 |

## Keyboard shortcuts

All of Chromium's shortcuts, on Windows, macOS and Linux: see the table in
[Browsing → Keyboard shortcuts](browsing.md#chromium-parity). Every shortcut is listed and can be changed in Settings →
Keyboard shortcuts (rune://shortcuts).

## Everyday behavior

| Chromium                                                          | Rune Browser             | Note                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find in page                                                      | Matched                  | Find bar, Ctrl+F, Ctrl+G, F3                                                                                                                                            |
| Zoom                                                              | Matched                  | Per site and workspace, shown in the address bar, Ctrl+scroll                                                                                                           |
| Certificate warnings                                              | Matched                  | "Your connection is not private", Advanced, "Proceed to … (unsafe)"; remembered for the site in the workspace until Rune Browser quits                                  |
| Error pages                                                       | Matched                  | "This site can't be reached", "No internet"… with Chromium's words and codes                                                                                            |
| Context menus                                                     | Matched                  | Links, images, video and audio, fields (spelling suggestions, Add to dictionary, Paste as plain text, Emoji), selections ("Search … for", "Go to …"), the page, Inspect |
| HTTP sign-in prompts                                              | Matched                  | Extensions first (password managers), then Rune Browser's dialog                                                                                                        |
| Opening files (drag and drop, typed paths)                        | Matched                  | See [Browsing → Opening files](browsing.md#web-tabs)                                                                                                                    |
| Full screen                                                       | Matched                  | F11, and pages' own full screen                                                                                                                                         |
| Save page, view source                                            | Matched                  | Save page as .html with its files or .htm; view source opens DevTools' Sources panel (Electron can't show view-source: pages)                                           |
| Printing                                                          | Different                | The system's print dialog (Electron has no print preview)                                                                                                               |
| New tab                                                           | Different                | A blank tab with the address bar focused (no tiles of top sites)                                                                                                        |
| Pop-ups                                                           | Different                | Open as tabs (Ctrl+click and middle click in the background)                                                                                                            |
| Context menu: new window, incognito, Translate, Cast, Google Lens | Not yet / not applicable | New and private windows are on their way; no Google services                                                                                                            |
| Context menu: Loop, Show controls on video                        | Not yet                  | Electron has no API for them                                                                                                                                            |
| HTTP warnings ("Not secure")                                      | Matched                  | HTTPS first, a warning before plain HTTP pages, "Not secure" in the address bar: see [Browsing](browsing.md#web-tabs)                                                   |
| Downloads, bookmarks, history                                     | Not yet                  | Being worked on                                                                                                                                                         |
| Site permission prompts                                           | Not yet                  | Being worked on; pages get only harmless permissions (full screen, clipboard writes, pointer lock)                                                                      |
| Password and autofill prompts                                     | Not yet                  | Password manager extensions work                                                                                                                                        |
| New windows, private windows                                      | Not yet                  | Being worked on                                                                                                                                                         |
| Safe Browsing                                                     | Not applicable           | Google's service; extensions can block sites                                                                                                                            |
