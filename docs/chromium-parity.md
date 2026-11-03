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
(chrome://settings/search is Settings → Web tabs).

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
| chrome://settings/content                                                                         | Not yet        | Site permissions are on their way                                                          |
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

| Chromium                            | Rune Browser   | Note                                                                                |
| ----------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Search engine                       | Matched        | Settings → Web tabs                                                                 |
| Extensions                          | Matched        | Settings → Extensions (rune://extensions)                                           |
| About Chrome                        | Matched        | Settings → About: version, updates, release channel                                 |
| Appearance                          | Different      | Rune Browser's themes (Settings → Appearance); page zoom is per site and workspace  |
| Performance (Memory Saver)          | Different      | Tab unloading (Settings → Web tabs → Tabs)                                          |
| On startup                          | Different      | Tabs come back as they were, per workspace; a choice is on its way                  |
| Privacy and security, site settings | Not yet        | Being worked on; today pages get only harmless permissions                          |
| Autofill and passwords              | Not yet        | Password manager extensions work                                                    |
| Downloads                           | Not yet        | Being worked on; today each download asks where to save it                          |
| Default browser                     | Matched        | Settings → Web tabs: Make default; links and web files from other apps open as tabs |
| Languages, spell check              | Not yet        | Spell check follows the system's language                                           |
| Accessibility, System, Reset        | Not yet        | Hardware acceleration switches are in rune://flags                                  |
| You and Google (sync, sign-in)      | Not applicable | No Google account                                                                   |

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
