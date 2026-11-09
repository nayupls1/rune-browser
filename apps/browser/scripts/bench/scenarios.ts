// The scenarios run in both browsers: the same pages, the same input, the same measurements. Every run also
// records what it cost the computer (CPU time of the whole browser and of its GPU process, peak memory,
// GPU busy time and memory where the OS tells), so a faster page that burns more CPU shows as such.
import { type Browser, input, type Tab } from "./browsers";
import { cpuBetween, KINDS, monitor, sampleTree, type Usage } from "./procs";
import { type ProbeData, READ_PROBE, totalBlockingTime } from "./probe";
import { BUDGET, metric, type Metric } from "./results";
import type { Site } from "./site";
import { frameStats, max, median, percentile } from "./stats";

export interface Ctx {
  browser: Browser;
  site: Site;
  /** A tab of its own for the scenario (on a blank page at first). */
  tab: Tab;
  record(m: Metric, value: number): void;
  note(text: string): void;
}

export interface Scenario {
  id: string;
  title: string;
  /** What it stands for, for the report. */
  about: string;
  /** Only Rune has it (its own UI). */
  runeOnly?: boolean;
  /** At most this many runs (the slow ones). */
  maxRuns?: number;
  run(ctx: Ctx): Promise<void>;
}

/** Wall-clock time in ms with sub-millisecond precision, on the same clock as a page's timeOrigin + now(). */
export const epochNow = () => performance.timeOrigin + performance.now();

// --- What every scenario records about resources -------------------------------------------------------

const res = (id: string, title: string) => ({
  cpu: metric("Resources", `res.${id}.cpu`, `${title}: CPU time (all processes)`, "ms"),
  gpuProc: metric("Resources", `res.${id}.cpu-gpu`, `${title}: CPU time of the GPU process`, "ms"),
  mem: metric("Resources", `res.${id}.mem`, `${title}: peak memory`, "MB"),
  gpu: metric("Resources", `res.${id}.gpu`, `${title}: GPU busy`, "%"),
  gpuMem: metric("Resources", `res.${id}.gpu-mem`, `${title}: GPU memory`, "MB"),
});

/** Runs `fn` while sampling the browser's processes, and records what it cost. */
export async function measured<T>(ctx: Ctx, id: string, title: string, fn: () => Promise<T>): Promise<T> {
  const mon = monitor(ctx.browser.pid);
  let result: T;
  let usage: Usage;
  try {
    result = await fn();
  } finally {
    usage = await mon.stop();
  }
  recordUsage(ctx, id, title, usage);
  return result;
}

export function recordUsage(ctx: Ctx, id: string, title: string, usage: Usage) {
  const m = res(id, title);
  ctx.record(m.cpu, (usage.cpuPct * usage.durationMs) / 100);
  ctx.record(m.gpuProc, (usage.cpuPctByKind.gpu * usage.durationMs) / 100);
  ctx.record(m.mem, usage.memPeakMB);
  if (usage.gpu.busyPct !== null) ctx.record(m.gpu, usage.gpu.busyPct);
  if (usage.gpu.memPeakMB !== null) ctx.record(m.gpuMem, usage.gpu.memPeakMB);
  if (usage.gpu.source) ctx.note(`GPU use measured with ${usage.gpu.source}.`);
}

// --- Helpers ------------------------------------------------------------------------------------------

const probe = (tab: Tab) => tab.eval<ProbeData>(READ_PROBE);
const center = (tab: Tab, selector: string) =>
  tab.eval<{ x: number; y: number }>(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
const heapMB = async (tab: Tab) => {
  const { metrics } = await tab.cdp.send<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics");
  return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? NaN) / 2 ** 20;
};

/**
 * Clicks a text field until it has the focus (up to three times). A click that didn't get there is noted:
 * the report then says input went missing.
 */
async function focusField(ctx: Ctx, selector: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const at = await center(ctx.tab, selector);
    await input.click(ctx.tab.input, at.x, at.y);
    await Bun.sleep(100);
    if (await ctx.tab.eval<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`))
      return;
    ctx.note(`A click on a text field (${selector}) didn't focus it in ${ctx.browser.name}; clicked again.`);
  }
  throw new Error(`${selector} never got the focus`);
}

/** Leaves the page and empties the cache, so the next load is a first visit. */
async function fresh(ctx: Ctx) {
  await ctx.tab.navigate(ctx.site.url("/blank"));
  await ctx.tab.cdp.send("Network.clearBrowserCache").catch(() => {});
}

/** Wheel scrolling, like a mouse wheel: `steps` notches of 100 px, one per frame. Returns frame intervals. */
async function wheelScroll(tab: Tab, steps: number, deltaY = 100) {
  const { width, height } = await tab.eval<{ width: number; height: number }>(
    `({ width: innerWidth, height: innerHeight })`,
  );
  await tab.eval(`window.__bench.reset(), window.__bench.startFrames(), true`);
  for (let i = 0; i < steps; i++) {
    const started = performance.now();
    await input.wheel(tab.input, width / 2, height / 2, deltaY);
    const left = 16 - (performance.now() - started);
    if (left > 0) await Bun.sleep(left);
  }
  await Bun.sleep(300);
  return tab.eval<number[]>(`window.__bench.stopFrames()`);
}

function recordFrames(ctx: Ctx, group: string, id: string, title: string, intervals: number[], data: ProbeData) {
  const f = frameStats(intervals);
  ctx.record(metric(group, `${id}.fps`, `${title}: frames per second`, "fps", "higher"), f.fps);
  ctx.record(
    metric(group, `${id}.dropped`, `${title}: frames missed`, "%", "lower", BUDGET.droppedFrames),
    f.droppedPct,
  );
  ctx.record(metric(group, `${id}.p95`, `${title}: slowest frames (p95)`, "ms", "lower", BUDGET.frame * 2), f.p95);
  ctx.record(metric(group, `${id}.max`, `${title}: longest frame`, "ms", "lower", BUDGET.hitch), f.max);
  ctx.record(
    metric(group, `${id}.blocking`, `${title}: main thread blocked`, "ms", "lower", BUDGET.tbt),
    totalBlockingTime(data, 0),
  );
}

function recordInputs(ctx: Ctx, group: string, id: string, title: string, values: number[], budget: number) {
  if (!values.length) {
    ctx.note(`${title}: no input reached the page in ${ctx.browser.name}.`);
    return;
  }
  ctx.record(metric(group, `${id}.p50`, `${title}: input to paint (median)`, "ms", "lower", budget), median(values));
  ctx.record(
    metric(group, `${id}.p95`, `${title}: input to paint (p95)`, "ms", "lower", budget),
    percentile(values, 95),
  );
}

// --- Loading ------------------------------------------------------------------------------------------

function loadScenario(id: string, path: string, title: string, about: string): Scenario {
  return {
    id: `load.${id}`,
    title: `Load: ${title}`,
    about,
    async run(ctx) {
      await fresh(ctx);
      const data = await measured(ctx, `load.${id}`, `Load ${title}`, async () => {
        await ctx.tab.navigate(ctx.site.url(path));
        // Paints and tasks right after load (LCP settles, late scripts run).
        await Bun.sleep(700);
        return probe(ctx.tab);
      });
      const g = "Page loading";
      const t = title;
      if (!data.nav) throw new Error(`${path} has no navigation timing`);
      ctx.record(metric(g, `load.${id}.ttfb`, `${t}: first byte`, "ms"), data.nav.ttfb);
      ctx.record(metric(g, `load.${id}.fcp`, `${t}: first contentful paint`, "ms", "lower", BUDGET.fcp), data.fcp);
      ctx.record(metric(g, `load.${id}.lcp`, `${t}: largest contentful paint`, "ms", "lower", BUDGET.lcp), data.lcp);
      ctx.record(metric(g, `load.${id}.dcl`, `${t}: DOMContentLoaded`, "ms"), data.nav.dcl);
      ctx.record(metric(g, `load.${id}.load`, `${t}: load event`, "ms"), data.nav.load);
      ctx.record(
        metric(g, `load.${id}.tbt`, `${t}: total blocking time`, "ms", "lower", BUDGET.tbt),
        totalBlockingTime(data),
      );
      ctx.record(
        metric(g, `load.${id}.longest`, `${t}: longest task`, "ms", "lower", BUDGET.longTask),
        max(data.longTasks.map((l) => l.duration)) || 0,
      );
      ctx.record(metric(g, `load.${id}.cls`, `${t}: layout shift`, "score", "lower", BUDGET.cls), data.cls);
      ctx.record(metric(g, `load.${id}.heap`, `${t}: JavaScript heap`, "MB"), await heapMB(ctx.tab));
    },
  };
}

const loads: Scenario[] = [
  loadScenario(
    "article",
    "/article",
    "article",
    "A long article with 24 photos, a sticky header and a scroll listener.",
  ),
  loadScenario(
    "table",
    "/table",
    "huge table",
    "5,000 server-rendered rows (≈50k elements): parsing, style and layout.",
  ),
  loadScenario(
    "spa",
    "/spa",
    "JavaScript app",
    "A 680 KB bundle of functions and classes, then a dashboard built on the client.",
  ),
  loadScenario(
    "resources",
    "/resources",
    "many files",
    "120 files (CSS, scripts, images) and 20 from another site: per-request cost.",
  ),
  loadScenario("iframes", "/iframes", "frames", "16 frames, half of them from another site (each in its own process)."),
  loadScenario("feed", "/feed", "feed", "A social feed that fetches its posts from an API after loading."),
  {
    id: "load.reload",
    title: "Load: reload (cached)",
    about: "Reloading the article with everything cached, as on a second visit.",
    async run(ctx) {
      await ctx.tab.navigate(ctx.site.url("/article"));
      await Bun.sleep(300);
      const data = await measured(ctx, "load.reload", "Reload", async () => {
        const loaded = ctx.tab.cdp.next("Page.loadEventFired", 30_000);
        // As the page itself would (DevTools' Page.reload replaces an Electron webview's page instead).
        void ctx.tab.cdp.send("Runtime.evaluate", { expression: "location.reload()" }).catch(() => {});
        await loaded;
        await Bun.sleep(500);
        return probe(ctx.tab);
      });
      ctx.record(
        metric("Page loading", "load.reload.fcp", "Reload: first contentful paint", "ms", "lower", BUDGET.fcp),
        data.fcp,
      );
      ctx.record(metric("Page loading", "load.reload.load", "Reload: load event", "ms"), data.nav?.load ?? NaN);
    },
  },
];

// --- Navigating ---------------------------------------------------------------------------------------

const navigation: Scenario = {
  id: "nav",
  title: "Navigation: links, back and forward",
  about:
    "Clicking from page to page on a docs site, then going back: link to paint, and whether back is instant (back/forward cache).",
  async run(ctx) {
    const { tab } = ctx;
    await tab.navigate(ctx.site.url("/nav/0"));
    const clicks: number[] = [];
    const backs: number[] = [];
    let restored = 0;
    await measured(ctx, "nav", "Navigation", async () => {
      for (let n = 1; n <= 5; n++) {
        const at = await center(tab, "#next");
        const loaded = tab.cdp.next("Page.loadEventFired", 30_000);
        const started = epochNow();
        await input.click(tab.input, at.x, at.y);
        await loaded;
        const painted = await tab.cdp.eval<number>(
          `new Promise((resolve) => { const check = () => window.__bench.fcp ? resolve(performance.timeOrigin + window.__bench.fcp) : setTimeout(check, 10); check(); })`,
        );
        clicks.push(painted - started);
        await Bun.sleep(200);
      }
      for (let n = 0; n < 4; n++) {
        const path = `/nav/${4 - n}`;
        const started = epochNow();
        void tab.cdp.send("Runtime.evaluate", { expression: "history.back()" }).catch(() => {});
        // The page shown again: from the cache (the same document, a pageshow with persisted) or loaded anew.
        const shown = await tab.cdp
          .eval<{ persisted: boolean; at: number }>(
            `new Promise((resolve) => { const check = () => { const s = location.pathname === ${JSON.stringify(path)} && window.__bench?.shows.at(-1); if (s && s.at > ${started}) resolve(s); else setTimeout(check, 5); }; check(); })`,
            30_000,
          )
          .catch(async () => {
            // A new document: wait for it to load, then ask it.
            await Bun.sleep(500);
            return tab.cdp.eval<{ persisted: boolean; at: number }>(`window.__bench.shows.at(-1)`);
          });
        backs.push(shown.at - started);
        if (shown.persisted) restored++;
        await Bun.sleep(200);
      }
    });
    const g = "Navigation";
    ctx.record(
      metric(g, "nav.click.p50", "Link click to next page painted (median)", "ms", "lower", BUDGET.response * 3),
      median(clicks),
    );
    ctx.record(
      metric(g, "nav.click.max", "Link click to next page painted (slowest)", "ms", "lower", BUDGET.response * 3),
      max(clicks),
    );
    ctx.record(
      metric(g, "nav.back.p50", "Back to the previous page shown (median)", "ms", "lower", BUDGET.response),
      median(backs),
    );
    ctx.record(
      metric(g, "nav.bfcache", "Back served from the back/forward cache", "%", "higher"),
      (100 * restored) / 4,
    );
  },
};

// --- Responding to input ------------------------------------------------------------------------------

const inputLatency: Scenario = {
  id: "input",
  title: "Input: clicks and typing",
  about:
    "Real clicks and key presses (through Rune's window, as a user's) on buttons whose handlers cost 0, 40 and 120 ms, and typing into a search box that filters a list. The 0 ms button is the browser's own overhead.",
  async run(ctx) {
    const { tab } = ctx;
    await tab.navigate(ctx.site.url("/input"));
    await Bun.sleep(200);
    const g = "Input latency";
    const byButton: Record<string, number[]> = {};
    let typing: number[] = [];
    let inp = 0;
    await measured(ctx, "input", "Input", async () => {
      for (const [id, times] of [
        ["fast", 15],
        ["medium", 6],
        ["slow", 4],
      ] as const) {
        const at = await center(tab, `#${id}`);
        await tab.eval(`window.__bench.reset(), true`);
        for (let i = 0; i < times; i++) {
          await input.click(tab.input, at.x, at.y);
          await Bun.sleep(id === "slow" ? 250 : 120);
        }
        const data = await probe(tab);
        byButton[id] = data.inputs.filter((e) => e.type === "click").map((e) => e.latency);
        inp = Math.max(inp, ...data.events.map((e) => e.duration));
      }
      await focusField(ctx, "#search");
      await tab.eval(`window.__bench.reset(), true`);
      for (const ch of "result 12 a7") {
        await input.key(tab.input, ch);
        await Bun.sleep(80);
      }
      const data = await probe(tab);
      typing = data.inputs.filter((e) => e.type === "keydown").map((e) => e.latency);
      inp = Math.max(inp, ...data.events.map((e) => e.duration));
    });
    recordInputs(ctx, g, "input.click0", "Click, no work (browser overhead)", byButton.fast ?? [], BUDGET.keystroke);
    recordInputs(ctx, g, "input.click40", "Click, 40 ms handler", byButton.medium ?? [], BUDGET.response);
    recordInputs(ctx, g, "input.click120", "Click, 120 ms handler", byButton.slow ?? [], BUDGET.response * 2);
    recordInputs(ctx, g, "input.typing", "Typing into a filtering search box", typing, BUDGET.keystroke);
    ctx.record(metric(g, "input.inp", "Slowest interaction (Event Timing, like INP)", "ms", "lower", 200), inp);
  },
};

const appInteraction: Scenario = {
  id: "interact",
  title: "Input: heavy pages",
  about: "Sorting the 5,000-row table by clicking a header, and filtering and searching the JavaScript dashboard.",
  async run(ctx) {
    const { tab } = ctx;
    const g = "Input latency";
    await tab.navigate(ctx.site.url("/table"));
    await Bun.sleep(300);
    let sorts: number[] = [];
    let filters: number[] = [];
    let search: number[] = [];
    await measured(ctx, "interact", "Heavy page input", async () => {
      const header = await center(tab, 'th[data-col="3"]');
      await tab.eval(`window.__bench.reset(), true`);
      for (let i = 0; i < 3; i++) {
        await input.click(tab.input, header.x, header.y);
        await Bun.sleep(700);
      }
      sorts = (await probe(tab)).inputs.filter((e) => e.type === "click").map((e) => e.latency);
      await tab.navigate(ctx.site.url("/spa"));
      await Bun.sleep(300);
      await tab.eval(`window.__bench.reset(), true`);
      for (let i = 0; i < 6; i++) {
        const b = await center(tab, `#groups button:nth-child(${(i % 6) + 1})`);
        await input.click(tab.input, b.x, b.y);
        await Bun.sleep(250);
      }
      filters = (await probe(tab)).inputs.filter((e) => e.type === "click").map((e) => e.latency);
      await focusField(ctx, "#q");
      await tab.eval(`window.__bench.reset(), true`);
      for (const ch of "alpha 1") {
        await input.key(tab.input, ch);
        await Bun.sleep(120);
      }
      search = (await probe(tab)).inputs.filter((e) => e.type === "keydown").map((e) => e.latency);
    });
    recordInputs(ctx, g, "interact.sort", "Sorting a 5,000-row table", sorts, BUDGET.response * 3);
    recordInputs(ctx, g, "interact.filter", "Filtering a dashboard", filters, BUDGET.response);
    recordInputs(ctx, g, "interact.search", "Searching a dashboard (per key)", search, BUDGET.response);
  },
};

// --- Scrolling and animation --------------------------------------------------------------------------

function scrollScenario(id: string, path: string, title: string, about: string, steps: number): Scenario {
  return {
    id: `scroll.${id}`,
    title: `Scroll: ${title}`,
    about,
    async run(ctx) {
      await ctx.tab.navigate(ctx.site.url(path));
      await Bun.sleep(500);
      const intervals = await measured(ctx, `scroll.${id}`, `Scroll ${title}`, () => wheelScroll(ctx.tab, steps));
      recordFrames(ctx, "Scrolling", `scroll.${id}`, title, intervals, await probe(ctx.tab));
    },
  };
}

function animationScenario(mode: string, title: string, about: string): Scenario {
  return {
    id: `anim.${mode}`,
    title: `Animation: ${title}`,
    about,
    async run(ctx) {
      await ctx.tab.navigate(ctx.site.url(`/animation/${mode}`));
      await Bun.sleep(500);
      const intervals = await measured(ctx, `anim.${mode}`, `Animation ${title}`, async () => {
        await ctx.tab.eval(`window.__bench.reset(), window.__bench.startFrames(), true`);
        await Bun.sleep(3000);
        return ctx.tab.eval<number[]>(`window.__bench.stopFrames()`);
      });
      recordFrames(ctx, "Animation", `anim.${mode}`, title, intervals, await probe(ctx.tab));
    },
  };
}

const motion: Scenario[] = [
  scrollScenario(
    "article",
    "/article",
    "article",
    "Scrolling the article with the mouse wheel (photos decode as they come in).",
    60,
  ),
  scrollScenario(
    "feed",
    "/feed",
    "infinite feed",
    "Scrolling a feed that keeps loading posts and photos as it goes.",
    120,
  ),
  scrollScenario("table", "/table", "huge table", "Scrolling the 5,000-row table.", 60),
  scrollScenario(
    "paint",
    "/paint",
    "heavy paint",
    "Scrolling cards with blur, shadows and gradients over a fixed background.",
    60,
  ),
  animationScenario("css", "CSS transforms", "400 elements animated with CSS transforms (the compositor's work)."),
  animationScenario(
    "js",
    "JavaScript layout",
    "300 elements moved by JavaScript with properties that need layout every frame.",
  ),
  animationScenario("canvas", "canvas particles", "4,000 particles drawn on a 2D canvas every frame."),
];

// --- The engine ---------------------------------------------------------------------------------------

function suiteScenario(id: string, path: string, title: string, about: string): Scenario {
  return {
    id: `engine.${id}`,
    title: `Engine: ${title}`,
    about,
    async run(ctx) {
      await ctx.tab.navigate(ctx.site.url(path));
      await Bun.sleep(200);
      const out = await measured(ctx, `engine.${id}`, title, () =>
        ctx.tab.eval<Record<string, number> | null>(`window.__run()`, 180_000),
      );
      if (!out) return;
      const g = `Engine: ${title}`;
      for (const [name, ms] of Object.entries(out))
        ctx.record(metric(g, `engine.${id}.${name}`, `${title}: ${name}`, "ms"), ms);
      ctx.record(
        metric(g, `engine.${id}.total`, `${title}: total`, "ms"),
        Object.values(out).reduce((a, b) => a + b, 0),
      );
      if (id === "canvas" && !("webgl" in out)) ctx.note(`WebGL 2 isn't available in ${ctx.browser.name} here.`);
    },
  };
}

const engine: Scenario[] = [
  suiteScenario(
    "js",
    "/js",
    "JavaScript",
    "JSON, regular expressions, sorting, objects and GC, strings, typed arrays, classes, array chains, WebAssembly.",
  ),
  suiteScenario(
    "dom",
    "/dom",
    "DOM and layout",
    "Creating elements, innerHTML, selectors, forced layouts, style recalculation, a to-do app, text layout, SVG.",
  ),
  suiteScenario(
    "canvas",
    "/canvas",
    "Canvas and WebGL",
    "2D rectangles, paths, text and pixel reads; WebGL draw calls.",
  ),
  suiteScenario("storage", "/storage", "Storage", "localStorage, IndexedDB writes and reads, the Cache API."),
  suiteScenario(
    "fetch",
    "/fetch",
    "Network requests",
    "300 API calls six at a time, 300 at once, 100 POSTs, a 20 MB download: the browser's network path per request.",
  ),
];

// --- Memory with many tabs, and idle --------------------------------------------------------------------

const TAB_MIX = ["/article", "/spa", "/table", "/feed", "/iframes", "/nav/1", "/paint", "/input"];

const manyTabs: Scenario = {
  id: "tabs",
  title: "Memory: eight tabs",
  about:
    "Opening eight tabs of different sites one after another (each viewed, as when clicking through them), then idling with them, then closing them: memory per tab, CPU with tabs in the background, and what's given back.",
  maxRuns: 2,
  async run(ctx) {
    const { browser, site } = ctx;
    await Bun.sleep(1000);
    const before = await sampleTree(browser.pid);
    const tabs: Tab[] = [];
    const usage = monitor(browser.pid);
    for (const path of TAB_MIX) {
      const tab = await browser.newTab(site.url("/blank"));
      await tab.navigate(site.url(path));
      await Bun.sleep(400);
      tabs.push(tab);
    }
    recordUsage(ctx, "tabs", "Opening eight tabs", await usage.stop());
    await Bun.sleep(2000);
    const open = await sampleTree(browser.pid);
    const idleStart = await sampleTree(browser.pid);
    await Bun.sleep(5000);
    const idleEnd = await sampleTree(browser.pid);
    for (const tab of tabs) await tab.close();
    await Bun.sleep(3000);
    const closed = await sampleTree(browser.pid);
    const g = "Memory and idle";
    ctx.record(metric(g, "tabs.mem", "Memory with eight tabs open", "MB"), open.memMB);
    // What closing them gives back: what they took (measured from before opening them, a browser still
    // freeing the previous scenario's memory would make them look smaller than they are).
    ctx.record(
      metric(g, "tabs.mem-per-tab", "Memory per tab (given back when closed)", "MB"),
      (open.memMB - closed.memMB) / TAB_MIX.length,
    );
    ctx.record(metric(g, "tabs.mem-renderers", "Memory of the renderers (pages)", "MB"), open.byKind.renderer.memMB);
    ctx.record(metric(g, "tabs.processes", "Processes with eight tabs open", "count"), open.processes);
    ctx.record(
      metric(g, "tabs.idle-cpu", "CPU with eight tabs open, doing nothing", "%", "lower", BUDGET.idleCpu * 2),
      cpuBetween(idleStart, idleEnd).total,
    );
    ctx.record(
      metric(g, "tabs.retained", "Memory kept after closing them", "MB"),
      Math.max(0, closed.memMB - before.memMB),
    );
  },
};

const idle: Scenario = {
  id: "idle",
  title: "Idle",
  about:
    "One tab with the article open and nothing happening for 8 s: what the browser costs sitting there (battery, fans).",
  maxRuns: 3,
  async run(ctx) {
    await ctx.tab.navigate(ctx.site.url("/article"));
    await Bun.sleep(2000);
    const mon = monitor(ctx.browser.pid, 500);
    await Bun.sleep(8000);
    const usage = await mon.stop();
    const g = "Memory and idle";
    ctx.record(metric(g, "idle.cpu", "CPU at idle (one tab)", "%", "lower", BUDGET.idleCpu), usage.cpuPct);
    for (const kind of KINDS)
      if (usage.cpuPctByKind[kind] > 0 || kind === "gpu")
        ctx.record(metric(g, `idle.cpu.${kind}`, `CPU at idle: ${kind} process(es)`, "%"), usage.cpuPctByKind[kind]);
    ctx.record(metric(g, "idle.mem", "Memory at idle (one tab)", "MB"), usage.memEndMB);
    for (const kind of KINDS)
      if (usage.memEndByKind[kind] > 0)
        ctx.record(
          metric(g, `idle.mem.${kind}`, `Memory at idle: ${kind} process(es)`, "MB"),
          usage.memEndByKind[kind],
        );
    if (usage.gpu.busyPct !== null) ctx.record(metric(g, "idle.gpu", "GPU busy at idle", "%"), usage.gpu.busyPct);
  },
};

export const SCENARIOS: Scenario[] = [
  ...loads,
  navigation,
  inputLatency,
  appInteraction,
  ...motion,
  ...engine,
  manyTabs,
  idle,
];
