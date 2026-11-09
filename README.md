<p align="center">
  <img src="apps/browser/build/icon.svg" width="112" alt="Rune Browser">
</p>

<h1 align="center">Rune Browser</h1>

<p align="center">
  A desktop browser where coding agents build your own small apps,<br>
  and customize the websites you use, on your own Claude, Codex or OpenCode login.
</p>

<p align="center">
  <a href="https://github.com/nayupls1/rune-browser/releases/latest">Download</a> ·
  <a href="apps/browser/docs/concepts.md">Docs</a> ·
  <a href="https://github.com/nayupls1/rune-browser/issues">Issues</a>
</p>

---

Every tab in Rune Browser is a web page or an **app**. Describe an app and the
agent builds it: a real project with its own server and SQLite database,
running in a sandbox and shown in a live preview next to the chat. Keep
editing it by talking to the agent, or close the chat and use it. On web pages
the same agent can hide, restyle or add things, and those changes stay.

![A new app: describe it, pick an idea or a template](apps/browser/docs/screenshots/new-app.png)

## What it does

- **Apps from a sentence.** "A habit tracker with daily check-ins": the agent
  writes a real project (React, vanilla or API-only, or whatever you ask for),
  runs it, and fixes what it sees in the preview. Apps can store data, use AI,
  run on a schedule, offer tools to agents, and read each other's data when you
  allow it.
- **Your own agents and logins.** Claude Code, Codex and OpenCode, the CLIs you
  already use, signed in with your own subscription. No API keys, no accounts
  here.
- **Websites your way.** Ask the agent about a page or point at an element:
  it hides, restyles or adds things, per page, site or pattern, each with its
  own switch. Bundle changes, a theme and extensions into a **mod** to share.
- **A real browser.** Workspaces with their own logins, split view, a command
  bar (Ctrl+K), Chrome extensions (imported from your browser), and password
  managers that fill in sign-ins.
- **Safe by default.** Apps run in a sandbox (bubblewrap on Linux) and ask
  before reaching anything beyond it; secrets never reach agents; web pages
  never reach an agent that has tools. Everything agents and apps do is in
  Activity.
- **Nothing is lost.** Every change is saved as a snapshot, with its diff,
  to undo or restore, including the app's data.

|                                                                                         |                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ![An app with its agent and its snapshots](apps/browser/docs/screenshots/snapshots.png) | ![Page changes on a website](apps/browser/docs/screenshots/page-changes.png) |
| ![The mods gallery](apps/browser/docs/screenshots/mods-gallery.png)                     |                                                                              |

## Install

Get the latest release from the
[releases page](https://github.com/nayupls1/rune-browser/releases/latest).
Rune Browser updates itself from there (Settings → About; a Daily channel gets
builds of the latest changes).

| OS                        | Download                                                                                                                 | Notes                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linux** (x64)           | `.AppImage` (any distribution), `.deb` (Debian, Ubuntu), `.rpm` (Fedora, openSUSE) or `.pacman` (Arch: `sudo pacman -U`) | Install [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) so apps run sandboxed (the deb recommends it, the pacman package depends on it). |
| **Windows** (x64)         | `-setup-x64.exe`                                                                                                         | Not signed yet: on the SmartScreen warning, choose "More info" → "Run anyway".                                                                            |
| **macOS** (Apple Silicon) | `.dmg`                                                                                                                   | Supported but untested, and not signed yet: right-click → Open the first time. Updates are downloaded by hand.                                            |

Then install and sign in to at least one agent:

- [Claude Code](https://claude.com/claude-code): `npm install -g @anthropic-ai/claude-code`, then `claude` → `/login`
- [Codex](https://github.com/openai/codex): `npm install -g @openai/codex`, then `codex login`
- [OpenCode](https://opencode.ai): `curl -fsSL https://opencode.ai/install | bash`

Rune Browser finds them on your `PATH` (or set their paths in Settings →
Providers).

## Build from source

With [Bun](https://bun.sh) installed:

```sh
bun install
bun run dev       # run it with hot reload
bun run check     # typecheck, tests, build, e2e
bun run package   # installers for this OS, in apps/browser/release/
```

More in [Development](apps/browser/docs/development.md).

### Repository layout

A Bun workspace, with tasks run by [Turborepo](https://turborepo.dev):

| Path                           | What it is                                                            |
| ------------------------------ | --------------------------------------------------------------------- |
| [`apps/browser`](apps/browser) | Rune Browser itself: the Electron app, its Bun server, tests and docs |
| [`apps/landing`](apps/landing) | The website: static pages built with Astro and StyleX, no JavaScript  |

`bun run dev`, `start`, `package`, `server`, `e2e` and `release` at the root
run the browser's; `bun run dev:landing` runs the website.

## Docs

- [Concepts](apps/browser/docs/concepts.md): workspaces, apps and their data, agents, AI in
  apps, tools, schedules, secrets, permissions, history and mods
- [Interface](apps/browser/docs/interface.md): the window, sidebars, command bar, split view, settings
- [Browsing](apps/browser/docs/browsing.md): web tabs, page changes, network, the API map, extensions, keyboard shortcuts
- [Chromium parity](apps/browser/docs/chromium-parity.md): rune:// pages, and how Chromium's settings, shortcuts and behavior fare
- [Architecture](apps/browser/docs/architecture.md): processes, the server's services, where data lives
- [Design system](apps/browser/docs/design-system.md): the palette from the icon, light and dark, and how themes build on it
- [Benchmarks](apps/browser/docs/benchmarks.md): Rune against Chrome, and its UI under stress (speed, CPU, memory, GPU)
- [Development](apps/browser/docs/development.md) and [Releasing](apps/browser/docs/releasing.md)

Built with Electron and SolidJS (StyleX), and a local Bun server written with
Effect v4.

## Contributing

Issues are welcome: [bug reports](https://github.com/nayupls1/rune-browser/issues/new?template=bug_report.yml)
and [ideas](https://github.com/nayupls1/rune-browser/issues/new?template=feature_request.yml).
Pull requests aren't accepted yet, see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues go through [private reporting](SECURITY.md).

## License

[MIT](LICENSE)
