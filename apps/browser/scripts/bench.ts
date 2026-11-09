// Performance benchmarks: Rune Browser against Google Chrome on the same pages, plus Rune's own UI under
// stress. Everything a user feels (loading, input to paint, smooth scrolling and animation, a page or the UI
// freezing) and everything the computer pays (CPU, memory, GPU), measured the same way in both browsers.
// See docs/benchmarks.md.
//
//   bun run bench                    everything, 5 runs each (the median counts), Rune then Chrome
//   bun run bench --quick            3 runs, fewer startups: a quick look while working on something
//   bun run bench --only <text>      only scenarios whose id contains it ("load|input": either)
//   bun run bench --skip <text>      leave those out
//   bun run bench --runs <n>         runs per scenario (after a warm-up run that isn't counted)
//   bun run bench --rune-only        no Chrome (the UI scenarios and Rune's numbers alone)
//   bun run bench --chrome <path>    which Chrome (default: $CHROME_PATH, the usual places, Playwright's)
//   bun run bench --headed           real windows on screen, GPU and all (for your own machine)
//   bun run bench --save-baseline    keep this run as the baseline later runs are compared with
//   bun run bench --baseline <file>  compare with that run instead of bench-results/baseline.json
//   bun run bench --check            exit with an error when something regressed since the baseline
//   bun run bench --list             list the scenarios
//   bun run bench compare <a.json> <b.json>   compare two saved runs (b against a)
//
// Results go to bench-results/ (latest.md, latest.json, and one JSON per run). Run `bun run build` first.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserName, findChrome, launchChrome, launchRune } from "./bench/browsers";
import { sampleTree } from "./bench/procs";
import { markdown, type Saved, summary, type Environment } from "./bench/report";
import { metric, Results } from "./bench/results";
import { type Ctx, SCENARIOS, type Scenario } from "./bench/scenarios";
import { serveSite, type Site } from "./bench/site";
import { UI_SCENARIOS } from "./bench/ui";
import { Page } from "./lib/cdp";

const here = import.meta.dir;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const outDir = option("--out") ?? join(here, "../bench-results");
const ALL = [...SCENARIOS, ...UI_SCENARIOS];

if (args[0] === "compare") {
  const [a, b] = [args[1], args[2]];
  if (!a || !b) {
    console.error("Usage: bun run bench compare <baseline.json> <run.json>");
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(a, "utf8")) as Saved;
  const now = JSON.parse(readFileSync(b, "utf8")) as Saved;
  console.log(markdown(now, before));
  process.exit(summary(now, before).regressed.length && flag("--check") ? 1 : 0);
}

if (flag("--list")) {
  for (const s of [
    { id: "startup", title: "Startup", about: "Launching the browser to a page.", runeOnly: false },
    ...ALL,
  ])
    console.log(`${s.id.padEnd(24)} ${s.runeOnly ? "(Rune) " : ""}${s.title} — ${s.about}`);
  process.exit(0);
}

if (!existsSync(join(here, "../dist/electron/main.cjs"))) {
  console.error("No build found — run `bun run build` first.");
  process.exit(1);
}
process.chdir(join(here, ".."));

const quick = flag("--quick");
const runs = Number(option("--runs") ?? (quick ? 3 : 5));
const startups = Number(option("--startups") ?? (quick ? 2 : 5));
const headed = flag("--headed");
const [vw, vh] = (option("--viewport") ?? "1280x800").split("x").map(Number);
const viewport = { width: vw || 1280, height: vh || 800 };
const matches = (id: string, list: string | undefined) => !!list && list.split("|").some((part) => id.includes(part));
const only = option("--only");
const skip = option("--skip");
const wanted = (id: string) => (!only || matches(id, only)) && !matches(id, skip);
const chromePath = flag("--rune-only") ? undefined : findChrome(option("--chrome"));
if (!flag("--rune-only") && !chromePath)
  console.warn("No Chrome found (pass --chrome <path> or set CHROME_PATH): measuring Rune alone.");
const browsers: BrowserName[] = chromePath ? ["rune", "chrome"] : ["rune"];

const results = new Results();
const env: Environment = {
  date: new Date().toISOString().slice(0, 16).replace("T", " "),
  commit: await commit(),
  os: `${platform()} ${release()}`,
  cpu: `${cpus()[0]?.model.trim() ?? "?"} (${cpus().length} threads)`,
  memoryGB: Math.round(totalmem() / 2 ** 30),
  headed,
  viewport: `${viewport.width}×${viewport.height}`,
  runs,
  browsers: {},
};

async function commit() {
  const sha = await Bun.$`git rev-parse --short HEAD`.quiet().nothrow().text();
  const dirty = (await Bun.$`git status --porcelain`.quiet().nothrow().text()).trim() ? "+changes" : "";
  return sha.trim() ? `${sha.trim()}${dirty}` : "unknown";
}

/** Browsers running now: stopped if the benchmarks are interrupted (Ctrl+C), so none is left behind. */
const running = new Set<Browser>();
async function launch(name: BrowserName, url?: string): Promise<Browser> {
  const b =
    name === "rune"
      ? await launchRune({ headed, viewport, url })
      : await launchChrome(chromePath!, { headed, viewport, url });
  const quit = b.quit;
  b.quit = () => (running.delete(b), quit());
  running.add(b);
  return b;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    console.log("\nStopping the browsers…");
    void Promise.all([...running].map((b) => b.quit().catch(() => {}))).finally(() => process.exit(130));
  });

/** The GPU the browser renders with, and whether it's hardware accelerated. */
async function gpuInfo(b: Browser) {
  const info = await b.browserCdp
    .send<{
      gpu: { devices: { vendorString?: string; deviceString?: string }[]; featureStatus?: Record<string, string> };
    }>("SystemInfo.getInfo")
    .catch(() => null);
  if (!info) return "unknown";
  const device = info.gpu.devices[0];
  const name = [device?.vendorString, device?.deviceString].filter(Boolean).join(" ") || "no device";
  const status = info.gpu.featureStatus ?? {};
  const accel = /swiftshader|llvmpipe|software/i.test(name)
    ? "GPU emulated in software"
    : status.gpu_compositing?.startsWith("enabled")
      ? "hardware accelerated"
      : "software compositing";
  return `${name} (${accel}, WebGL ${status.webgl ?? "?"})`;
}

// --- Startup ------------------------------------------------------------------------------------------

async function startup(site: Site) {
  const g = "Startup";
  const url = site.url("/nav/3");
  console.log(`\n▸ Startup (${startups}× each)`);
  for (let i = 0; i < startups; i++) {
    // Taking turns, so neither gets the warmer disk cache every time.
    for (const name of i % 2 ? [...browsers].reverse() : browsers) {
      const b = await launch(name, url);
      try {
        const port = b.port;
        const deadline = Date.now() + 30_000;
        let target: { webSocketDebuggerUrl: string } | undefined;
        while (!target) {
          const ts = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
            type: string;
            url: string;
            webSocketDebuggerUrl: string;
          }[];
          target = ts.find((t) => (t.type === "page" || t.type === "webview") && t.url === url);
          if (!target && Date.now() > deadline) throw new Error(`${name} never opened ${url}`);
          if (!target) await Bun.sleep(20);
        }
        const page = await Page.open(target.webSocketDebuggerUrl);
        const painted = await page.eval<number>(
          `new Promise((resolve) => { const check = () => { const p = performance.getEntriesByName("first-contentful-paint")[0]; p ? resolve(performance.timeOrigin + p.startTime) : setTimeout(check, 10); }; check(); })`,
          30_000,
        );
        page.close();
        results.record(
          name,
          metric(g, "startup.page", "Launch to the page painted", "ms", "lower", 2000),
          painted - b.spawnedAt,
        );
        if (b.name === "rune" && "ui" in b) {
          const rb = b as Awaited<ReturnType<typeof launchRune>>;
          const uiPaint = await rb.ui.eval<number>(
            `performance.timeOrigin + (performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? NaN)`,
          );
          results.record(
            name,
            metric(g, "startup.ui-paint", "Launch to the window painted", "ms", "lower", 1000),
            uiPaint - b.spawnedAt,
          );
          results.record(
            name,
            metric(g, "startup.ui-ready", "Launch to the window ready", "ms", "lower", 1500),
            rb.readyAt - b.spawnedAt,
          );
        }
        // Settled: what it takes to have the browser open with one page.
        await Bun.sleep(3000);
        const tree = await sampleTree(b.pid);
        results.record(name, metric(g, "startup.mem", "Memory after launching with one page", "MB"), tree.memMB);
        results.record(
          name,
          metric(g, "startup.cpu", "CPU time to launch and settle", "ms"),
          [...tree.cpuByPid.values()].reduce((a, c) => a + c, 0),
        );
        results.record(name, metric(g, "startup.processes", "Processes after launching", "count"), tree.processes);
        console.log(`  ${name}: page painted after ${Math.round(painted - b.spawnedAt)} ms`);
      } catch (err) {
        results.note(`Startup failed in ${name}: ${(err as Error).message}`);
        console.log(`  ✗ ${name}: ${(err as Error).message}`);
      } finally {
        await b.quit();
      }
    }
  }
}

// --- Scenarios ----------------------------------------------------------------------------------------

async function runScenarios(name: BrowserName, site: Site, list: Scenario[]) {
  if (!list.length) return;
  console.log(`\n▸ ${name === "rune" ? "Rune Browser" : "Chrome"}`);
  const b = await launch(name);
  env.browsers[name] = { version: b.version, gpu: await gpuInfo(b) };
  console.log(`  ${b.version} · GPU: ${env.browsers[name]!.gpu}`);
  // A tab that stays open throughout, as a user always has one: the window never runs out of tabs
  // between scenarios.
  await b.newTab(site.url("/blank"));
  try {
    for (const s of list) {
      const count = runs;
      const started = performance.now();
      let tab;
      try {
        tab = await b.newTab(site.url("/blank"));
        // One run first that isn't counted: caches, JIT and the first process of a site warmed up.
        for (let i = 0; i <= count; i++) {
          const warmup = i === 0;
          const ctx: Ctx = {
            browser: b,
            site,
            tab,
            record: (m, v) => !warmup && results.record(name, m, v),
            note: (t) => results.note(t),
          };
          await s.run(ctx);
        }
        console.log(`  ✓ ${s.title} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
      } catch (err) {
        const message = (err as Error).message.split("\n")[0];
        results.note(`${s.title} failed in ${name}: ${message}`);
        console.log(`  ✗ ${s.title}: ${message}`);
      } finally {
        await tab?.close().catch(() => {});
        await Bun.sleep(300);
      }
    }
  } finally {
    await b.quit();
  }
}

// --- Main ---------------------------------------------------------------------------------------------

const site = serveSite();
console.log(
  `Benchmarking ${browsers.join(" and ")}: ${runs} runs per scenario, ${headed ? "in windows" : "headless"}, viewport ${env.viewport}`,
);
console.log("Preparing the test sites…");
await site.warm();
const started = performance.now();
try {
  if (startups > 0 && wanted("startup")) await startup(site);
  for (const name of browsers) {
    const list = ALL.filter((s) => wanted(s.id) && (!s.runeOnly || name === "rune"));
    await runScenarios(name, site, list);
  }
} finally {
  site.stop();
}

const saved: Saved = { version: 1, env, ...results.toJSON() };
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const jsonPath = join(outDir, `run-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(saved, null, 1));
writeFileSync(join(outDir, "latest.json"), JSON.stringify(saved, null, 1));
const baselinePath = option("--baseline") ?? join(outDir, "baseline.json");
const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Saved) : undefined;
const report = markdown(saved, baseline);
writeFileSync(join(outDir, "latest.md"), report);
const { text, regressed } = summary(saved, baseline);
console.log(`\n${text}`);
if (results.notes.length) console.log(`\nNotes:\n${results.notes.map((n) => `  - ${n}`).join("\n")}`);
console.log(`\nDone in ${((performance.now() - started) / 60000).toFixed(1)} min.`);
console.log(`Report: ${join(outDir, "latest.md")}\nData:   ${jsonPath}`);
if (flag("--save-baseline")) {
  copyFileSync(jsonPath, join(outDir, "baseline.json"));
  console.log(`Saved as the baseline: ${join(outDir, "baseline.json")}`);
}
if (flag("--check") && regressed.length) {
  console.error(`\n${regressed.length} metric(s) regressed since the baseline.`);
  process.exit(1);
}
