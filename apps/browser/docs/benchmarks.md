# Benchmarks

[README](../../../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Benchmarks](benchmarks.md) · [Releasing](releasing.md)

`bun run bench` measures Rune Browser against Google Chrome on the same pages,
and Rune's own UI under stress. It measures what people feel (pages loading,
how fast a click or key shows, smooth scrolling and animation, the page or the
browser freezing) and what the computer pays for it (CPU, memory, GPU). Both
browsers are measured the same way, so the numbers can be compared, and each
run is compared with a baseline, so you can tell whether a change made things
better or worse.

```sh
bun run build                 # the benchmarks run the built app
bun run bench                 # everything: about 30–40 minutes
bun run bench --quick         # 3 runs instead of 5, 2 launches instead of 5
bun run bench --only "input|ui.tab-switch"   # just what you're working on
bun run bench --list          # every scenario, with what it does
```

The report is written to `apps/browser/bench-results/latest.md` and the data
to a JSON file per run next to it (the folder is ignored by git).

## Tracking a change

1. On `master`, save a baseline: `bun run bench --save-baseline` (or with
   `--only …` for the area you're working on).
2. Make the change and `bun run build`.
3. Run the same benchmarks again: `bun run bench --only …`. The report's
   **Since the baseline** section lists what got worse (🔴) or better (🟢), and
   the terminal prints the same. `--check` exits with an error when something
   regressed, for scripts.

Only differences beyond the noise count as changes. A metric counts as
changed when its median moved by more than 5%, by more than a rounding-sized
amount (2 ms, 2 MB…), and by more than twice the variation between runs
(medians and median absolute deviations, which ignore the occasional outlier).
That needs at least 3 runs on each side. Compare runs from the same machine,
with nothing else heavy running. Two saved runs can also be compared later:
`bun run bench compare before.json after.json`.

A `Benchmarks` workflow runs the whole suite on GitHub's Linux runners when
started by hand (Actions → Benchmarks → Run workflow, for any branch). Its report is
the run's summary and its data an artifact. The runners are noisy, so it's for a
broad picture; small changes need your own machine.

## How it's measured

- **The same pages, offline.** The test sites are generated
  (`scripts/bench/site.ts`), served locally, and identical on every run, so a
  change in a number comes from the browser, not the internet.
  `127.0.0.1` and `localhost` are two sites, for cross-site frames and
  resources.
- **The same way in both browsers.** Rune's page is a web tab in its window
  (the webview's own DevTools target); Chrome's is a tab. A probe
  (`scripts/bench/probe.ts`) is installed in every page before its own
  scripts. It records paints, long tasks, long animation frames, Event Timing,
  frame intervals and input to paint.
- **Real input, the user's way.** Clicks, keys and the mouse wheel go
  through Rune's window at the web tab's position, so they cross Rune's UI
  and main process the way a user's input does. In Chrome they go straight to
  the tab. Overhead Rune adds on that path shows up as latency.
- **Input to paint** is the time from the input event to the next frame painted
  after its handlers ran, measured in the page. The "click, no work" button
  measures only the browser's own overhead.
- **Fair settings.** Same viewport (Chrome's window is sized to Rune's web
  tab), throwaway profiles, the same flags where both have them. Each
  browser's background work is off: Chrome's component updates, sync and
  metrics, and Rune's extension updates. Every scenario starts with one run
  that isn't counted (caches, JIT, the site's first process), then 5 counted
  runs; the report shows medians. Page loads start with the cache emptied.
  Startup alternates which browser goes first.
- **Headless by default.** Both run on Chromium's headless display backend:
  the real compositor, nothing on screen. Both draw with SwiftShader (the GPU
  emulated in software), so headless GPU numbers compare the two browsers,
  not your graphics card. `--headed` runs both in real windows on the real
  GPU, which is closer to what you see, but only on your own machine. CI and
  agents never use it.
- **Sequential.** Rune runs every scenario, then Chrome does, never both at
  once.

### What it costs the computer

Every scenario records, for the browser's whole process tree (for Rune:
Electron's processes, its server and the apps it runs):

- **CPU time** of all processes, and of the GPU process alone. Without a GPU,
  drawing shows up there. Idle and the busy-page scenario split CPU by process:
  the browser (main) process, Rune's UI, the pages' renderers, the GPU
  process, utilities and the server.
- **Memory**, peak and at the end: PSS on Linux, so pages shared between
  Chromium's processes aren't counted twice, and the resident set on macOS and
  Windows.
- **GPU** engine time and GPU memory, where the OS reports them per process
  without admin rights: Linux's DRM fdinfo (Intel, AMD and other DRM drivers),
  `nvidia-smi` for NVIDIA's driver, and Windows' GPU performance counters.
  macOS has no such source (`powermetrics` needs sudo), and a machine without a
  GPU has nothing to report. The report's header says which GPU each browser
  used and whether it was hardware accelerated.

### "Noticeable at"

Metrics where people notice past a point have that point next to them, and
the report lists where Rune's median goes past it:

| What                                 | Noticeable at | Why                                                  |
| ------------------------------------ | ------------- | ---------------------------------------------------- |
| A response (click, menu, tab switch) | 100 ms        | RAIL: within 100 ms feels immediate                  |
| A key press showing                  | 50 ms         | Typing feels laggy beyond a few frames               |
| A long task                          | 50 ms         | Input that arrives meanwhile waits                   |
| A frame / the UI freezing            | 33 / 100 ms   | Two missed frames stutter; 100 ms is a visible hitch |
| Frames missed while moving           | 5%            | Scrolling or animation looks uneven                  |
| First / largest contentful paint     | 1.8 / 2.5 s   | Core Web Vitals                                      |
| Total blocking time                  | 200 ms        | Lighthouse                                           |
| Layout shift                         | 0.1           | Core Web Vitals                                      |
| CPU at idle                          | 1%            | Battery and fans                                     |

## The scenarios

`bun run bench --list` prints them all. In both browsers:

- **Startup:** launching to a page painted (with the URL on the command line),
  memory, CPU time and the number of processes after launching. For Rune also
  the window painted and ready.
- **Page loading** (cold cache): an article with photos, a 5,000-row table, a
  JavaScript app (a 680 KB bundle, then a dashboard built on the client), a
  page of 140 files, 16 frames (half cross-site), an API-driven feed, and a
  cached reload. For each: first byte, FCP, LCP, DOMContentLoaded, load, total
  blocking time, the longest task, layout shift and the JavaScript heap.
- **Navigation:** link click to the next page painted, back to the previous
  page, and how often back is served from the back/forward cache.
- **Input latency:** clicks on handlers costing 0, 40 and 120 ms, typing into
  a filtering search box, sorting the big table, filtering and searching the
  dashboard. Input to paint (median and p95) and the slowest interaction.
- **Scrolling** (mouse wheel) the article, the infinite feed, the table and a
  page that's expensive to paint, and **animation** (CSS transforms,
  JavaScript layout every frame, canvas particles): frames per second, frames
  missed, p95 and longest frame, main-thread blocking.
- **Engine:** JavaScript (JSON, regexes, sorting, objects and GC, strings,
  typed arrays, classes, array chains, WebAssembly), DOM and layout (Speedometer-like
  work, including a to-do app), canvas and WebGL, storage (localStorage,
  IndexedDB, the Cache API), and network requests (bursts, POSTs, a 20 MB
  download).
- **Memory and idle:** eight different sites open, then the memory per tab,
  CPU while they sit there, and what's given back after closing them. One tab
  idle for 8 s, with CPU and memory per kind of process.

Rune's UI alone (Chrome's UI isn't a web page; these are tracked against
Rune's own baseline):

- **At rest:** main process round trip (an IPC call from the UI), server API
  latency, UI frames.
- **New tab** (Ctrl+T), the **address bar** (typing with 1,500 pages of
  history, then Enter to the page painted), **switching tabs** (clicking, and
  Ctrl+Tab), the **⋯ menu and the command bar**.
- **60 tabs** opened at once, scrolled through and closed, in the tab strip
  and in the vertical sidebar: time until shown, UI frames and blocking, the
  UI's heap and DOM nodes, memory.
- **A page that hangs** for 4 s: do the UI's frames, menus, the main process
  and switching to another tab still work?
- **A busy page** that changes its title, URL and favicon, logs and calls its
  API 100 times a second: what it costs Rune's UI, main process and server
  (frames, round trips, CPU per process).
- **A long agent chat** (500 messages) opened and scrolled in the agent
  sidebar.

## Adding a scenario

Scenarios are objects with a `run(ctx)` that does one run and records metrics
with `ctx.record(metric(group, id, label, unit, better, budget), value)`:
`scripts/bench/scenarios.ts` for both browsers, `scripts/bench/ui.ts` for Rune's
UI (`runeOnly: true`). Wrap the measured part in `measured(ctx, id, title, fn)`
to record its CPU, memory and GPU too. A new page goes in `scripts/bench/site.ts`.
It must be the same on every run (use the seeded `rng`), set
`window.__benchReady = false` until it has built itself if it does that after
loading, and expose `window.__run()` for work measured inside the page. Keep
metric ids stable: baselines are matched by them.
