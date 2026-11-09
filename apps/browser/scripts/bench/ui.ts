// Rune Browser's own UI under stress: what a user feels in the browser around the pages. Chrome's UI isn't a
// web page, so there's nothing to compare it with; these are tracked against Rune's own earlier runs.
//
// The UI's renderer gets the same probe as the pages (long tasks, frames, input to paint). The main process
// is measured by how long a round trip to it takes from the UI (an IPC call), the server by how long its API
// takes to answer. When either of them stalls, every click and key waits.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { input, MOD, type RuneBrowser } from "./browsers";
import { cpuBetween, monitor, sampleTree } from "./procs";
import { PROBE, type ProbeData, READ_PROBE, totalBlockingTime } from "./probe";
import { BUDGET, metric } from "./results";
import { type Ctx, epochNow, measured, recordUsage, type Scenario } from "./scenarios";
import { frameStats, max, median, percentile } from "./stats";

const G = "Rune UI";

const rune = (ctx: Ctx) => ctx.browser as RuneBrowser;

/** Waits in the UI for `condition`, resolving with the time the frame showing it was painted. */
const WAITER = `window.__benchWait = (condition, timeoutMs = 15000) => new Promise((resolve) => {
  const until = performance.now() + timeoutMs;
  const check = () => {
    let ok = false;
    try { ok = !!condition(); } catch {}
    if (ok) {
      // Called from a frame's requestAnimationFrame: a task posted now runs once that frame is painted.
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve(performance.timeOrigin + performance.now());
      ch.port2.postMessage(0);
    } else if (performance.now() > until) resolve(NaN);
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
})`;

/** Installs the probe and the waiter in Rune's UI (once). */
async function prepareUi(ctx: Ctx) {
  const { ui } = rune(ctx);
  await ui.eval(`${PROBE}, ${WAITER}, true`);
}

/** How long from `action` until the UI painted a frame where `condition` (UI JavaScript) holds. */
async function uiLatency(ctx: Ctx, condition: string, action: () => Promise<unknown>) {
  const { ui } = rune(ctx);
  await ui.eval(`window.__benchPending = window.__benchWait(() => (${condition})), true`);
  const started = epochNow();
  await action();
  const at = await ui.eval<number | null>(`window.__benchPending`, 20_000);
  return at ? at - started : NaN;
}

/** Real input into the UI itself (no offset: the window's coordinates). */
const uiTarget = (ctx: Ctx) => ({ cdp: rune(ctx).ui, offset: async () => ({ x: 0, y: 0 }) });
/** A real click on an element of the UI, scrolled into view first (a tab beyond the strip's edge) as a user would. */
const uiClick = async (ctx: Ctx, selector: string) => {
  const ui = rune(ctx).ui;
  const deadline = Date.now() + 3000;
  for (let first = true; ; first = false) {
    // Where it is now, if that's really it under the pointer (scrolling into view may animate).
    const at = await ui.eval<{ x: number; y: number } | null | false>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length);
      if (!el) return null;
      if (${first}) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && el.contains(hit) ? { x, y } : false;
    })()`);
    if (at === null) throw new Error(`nothing to click: ${selector}`);
    if (at) return input.click(uiTarget(ctx), at.x, at.y);
    if (Date.now() > deadline) throw new Error(`${selector} is covered by something else`);
    await Bun.sleep(30);
  }
};
const uiKey = (ctx: Ctx, key: string, modifiers = 0) => input.key(uiTarget(ctx), key, modifiers);

/** Long tasks and frames of the UI while `fn` runs. */
async function uiFrames<T>(ctx: Ctx, fn: () => Promise<T>) {
  const { ui } = rune(ctx);
  await ui.eval(`window.__bench.reset(), window.__bench.startFrames(), true`);
  const result = await fn();
  const intervals = await ui.eval<number[]>(`window.__bench.stopFrames()`);
  const data = await ui.eval<ProbeData>(READ_PROBE);
  return { result, intervals, data };
}

function recordUiFrames(ctx: Ctx, id: string, title: string, intervals: number[], data: ProbeData) {
  const f = frameStats(intervals);
  ctx.record(
    metric(G, `${id}.ui-dropped`, `${title}: UI frames missed`, "%", "lower", BUDGET.droppedFrames),
    f.droppedPct,
  );
  ctx.record(metric(G, `${id}.ui-hitch`, `${title}: longest UI freeze`, "ms", "lower", BUDGET.hitch), f.max);
  ctx.record(
    metric(G, `${id}.ui-blocking`, `${title}: UI main thread blocked`, "ms", "lower", BUDGET.tbt),
    totalBlockingTime(data, 0),
  );
}

function recordLatencies(ctx: Ctx, id: string, title: string, values: number[], budget: number) {
  const ok = values.filter(Number.isFinite);
  if (ok.length < values.length) ctx.note(`${title}: ${values.length - ok.length} of ${values.length} never showed.`);
  if (!ok.length) return;
  ctx.record(metric(G, `${id}.p50`, `${title} (median)`, "ms", "lower", budget), median(ok));
  ctx.record(metric(G, `${id}.p95`, `${title} (p95)`, "ms", "lower", budget), percentile(ok, 95));
}

/** Samples round trips to the main process (from the UI) and to the server (from here) while `fn` runs. */
async function roundTrips<T>(ctx: Ctx, fn: () => Promise<T>, everyMs = 25) {
  const r = rune(ctx);
  await r.ui.eval(`(() => {
    const out = (window.__benchIpc = []);
    window.__benchIpcRun = true;
    (async () => {
      while (window.__benchIpcRun) {
        const s = performance.now();
        await window.rune.internals.version();
        out.push(performance.now() - s);
        await new Promise((r) => setTimeout(r, ${everyMs}));
      }
    })();
    return true;
  })()`);
  const { serverUrl, token } = await r.ui.eval<{ serverUrl: string; token: string }>(
    `({ serverUrl: window.rune.serverUrl, token: window.rune.token })`,
  );
  const server: number[] = [];
  let running = true;
  const serverLoop = (async () => {
    while (running) {
      const s = performance.now();
      await fetch(`${serverUrl}/api/apps`, { headers: { Authorization: `Bearer ${token}` } }).then((res) =>
        res.arrayBuffer(),
      );
      server.push(performance.now() - s);
      await Bun.sleep(everyMs);
    }
  })();
  const result = await fn();
  running = false;
  await serverLoop;
  const ipc = await r.ui.eval<number[]>(`(window.__benchIpcRun = false, window.__benchIpc)`);
  return { result, ipc, server };
}

function recordRoundTrips(ctx: Ctx, id: string, title: string, ipc: number[], server: number[]) {
  if (ipc.length) {
    ctx.record(
      metric(G, `${id}.ipc-p50`, `${title}: main process round trip (median)`, "ms", "lower", BUDGET.frame),
      median(ipc),
    );
    ctx.record(
      metric(G, `${id}.ipc-max`, `${title}: main process round trip (slowest)`, "ms", "lower", BUDGET.hitch),
      max(ipc),
    );
  }
  if (server.length) {
    ctx.record(
      metric(G, `${id}.server-p50`, `${title}: server API (median)`, "ms", "lower", BUDGET.frame),
      median(server),
    );
    ctx.record(
      metric(G, `${id}.server-p95`, `${title}: server API (p95)`, "ms", "lower", BUDGET.response),
      percentile(server, 95),
    );
  }
}

const visible = (tabId: string) =>
  `(() => { const l = document.querySelector('[data-tab-layer="${tabId}"]'); return !!l && getComputedStyle(l).visibility === "visible"; })()`;
const tabCount = `document.querySelectorAll("[data-app-id]").length`;

/** The tabs open now (to close what a scenario opened, and only that). */
const openTabs = async (ctx: Ctx) => new Set((await rune(ctx).api<{ id: string }[]>("/api/apps")).map((a) => a.id));

/** Closes the tabs opened since `keep` was taken. */
async function closeAllBut(ctx: Ctx, keep: Set<string>) {
  const r = rune(ctx);
  for (const app of await r.api<{ id: string }[]>("/api/apps"))
    if (!keep.has(app.id)) await r.api(`/api/apps/${app.id}`, { method: "DELETE" }).catch(() => {});
  await r.ui.waitFor(`${tabCount} === ${keep.size}`, { label: "the other tabs closed", timeoutMs: 30_000 });
}

/** Back on the scenario's tab, with the focus in the UI rather than the page. */
async function home(ctx: Ctx) {
  const id = rune(ctx).tabIdOf(ctx.tab);
  await uiKey(ctx, "Escape");
  await rune(ctx).ui.eval(`document.querySelector('[data-app-id="${id}"]').click(), true`);
  await rune(ctx).ui.waitFor(visible(id), { label: "the scenario's tab" });
  await rune(ctx).ui.eval(`document.activeElement?.blur(), true`);
}

// --- Scenarios ----------------------------------------------------------------------------------------

const baseline: Scenario = {
  id: "ui.baseline",
  title: "UI: at rest",
  about:
    "One web tab, nothing happening: how fast the main process and the server answer, and whether the UI keeps its frames.",
  runeOnly: true,
  async run(ctx) {
    await prepareUi(ctx);
    await ctx.tab.navigate(ctx.site.url("/nav/1"));
    await Bun.sleep(500);
    const { result, intervals, data } = await uiFrames(ctx, () => roundTrips(ctx, () => Bun.sleep(3000)));
    recordRoundTrips(ctx, "ui.baseline", "At rest", result.ipc, result.server);
    recordUiFrames(ctx, "ui.baseline", "At rest", intervals, data);
  },
};

const newTab: Scenario = {
  id: "ui.new-tab",
  title: "UI: new tab",
  about: "Ctrl+T (⌘T) until the new tab is on screen with its address bar focused, ten times.",
  runeOnly: true,
  async run(ctx) {
    await prepareUi(ctx);
    const keep = await openTabs(ctx);
    const times: number[] = [];
    await measured(ctx, "ui.new-tab", "New tab", async () => {
      for (let i = 0; i < 10; i++) {
        await home(ctx);
        const count = await rune(ctx).ui.eval<number>(tabCount);
        times.push(
          await uiLatency(ctx, `${tabCount} > ${count} && document.activeElement?.matches("[data-address]")`, () =>
            uiKey(ctx, "t", MOD.primary),
          ),
        );
      }
    });
    await closeAllBut(ctx, keep);
    recordLatencies(ctx, "ui.new-tab", "New tab on screen", times, BUDGET.response);
  },
};

const addressBar: Scenario = {
  id: "ui.address",
  title: "UI: address bar",
  about:
    "Typing into the address bar with 1,500 pages in the history (suggestions on every key), then Enter to the page painted: Rune's own path from the address bar to a page.",
  runeOnly: true,
  async run(ctx) {
    const r = rune(ctx);
    await prepareUi(ctx);
    // History to suggest from (once per profile).
    if (!(await r.ui.eval<boolean>(`!!window.__benchSeeded`))) {
      const [space] = await r.api<{ id: string }[]>("/api/workspaces");
      for (let i = 0; i < 1500; i += 50)
        await Promise.all(
          Array.from({ length: 50 }, (_, k) =>
            r.api(`/api/visits/add?workspace=${space!.id}`, {
              method: "POST",
              body: { url: `https://example${(i + k) % 97}.com/docs/page-${i + k}`, title: `Docs page ${i + k}` },
            }),
          ),
        );
      await r.ui.eval(`window.__benchSeeded = true`);
    }
    await home(ctx);
    const target = ctx.site.url("/nav/7");
    let keys: number[] = [];
    let enter = NaN;
    await measured(ctx, "ui.address", "Address bar", async () => {
      await uiKey(ctx, "l", MOD.primary);
      await r.ui.waitFor(`document.activeElement?.matches("[data-address]")`, { label: "the address bar focused" });
      await r.ui.eval(`window.__bench.reset(), true`);
      for (const ch of target) {
        await uiKey(ctx, ch);
        await Bun.sleep(60);
      }
      await Bun.sleep(200);
      keys = (await r.ui.eval<ProbeData>(READ_PROBE)).inputs.filter((e) => e.type === "keydown").map((e) => e.latency);
      const loaded = ctx.tab.cdp.next("Page.loadEventFired", 30_000);
      const started = epochNow();
      await uiKey(ctx, "Enter");
      await loaded;
      const painted = await ctx.tab.eval<number>(
        `new Promise((resolve) => { const check = () => window.__bench?.fcp ? resolve(performance.timeOrigin + window.__bench.fcp) : setTimeout(check, 10); check(); })`,
      );
      enter = painted - started;
    });
    recordLatencies(ctx, "ui.address.typing", "Address bar: key to paint", keys, BUDGET.keystroke);
    ctx.record(
      metric(G, "ui.address.enter", "Address bar: Enter to page painted", "ms", "lower", BUDGET.response * 3),
      enter,
    );
  },
};

const tabSwitch: Scenario = {
  id: "ui.tab-switch",
  title: "UI: switching tabs",
  about: "Ten loaded tabs; clicking between them and Ctrl+Tab through them until the chosen page is on screen.",
  runeOnly: true,
  async run(ctx) {
    const r = rune(ctx);
    await prepareUi(ctx);
    const keep = await openTabs(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const app = await r.api<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: ctx.site.url(`/nav/${i}`), windowId: r.windowId },
      });
      ids.push(app.id);
      // Viewed once, so it's loaded (as tabs a user opened and looked at are).
      await r.ui.waitFor(`!!document.querySelector('[data-app-id="${app.id}"]')`, { label: "the new tab" });
      await r.ui.eval(`document.querySelector('[data-app-id="${app.id}"]').click(), true`);
      await r.ui.waitFor(`!!document.querySelector('[data-web-tab="${app.id}"] webview')`, { label: "its page" });
      await Bun.sleep(150);
    }
    const clicks: number[] = [];
    const keys: number[] = [];
    const { intervals, data } = await uiFrames(ctx, () =>
      measured(ctx, "ui.tab-switch", "Switching tabs", async () => {
        for (let i = 0; i < 20; i++) {
          const id = ids[(i * 7) % ids.length]!;
          if (await r.ui.eval<boolean>(visible(id))) continue;
          clicks.push(await uiLatency(ctx, visible(id), () => uiClick(ctx, `[data-app-id="${id}"]`)));
          await Bun.sleep(100);
        }
        await r.ui.eval(`document.activeElement?.blur(), true`);
        for (let i = 0; i < 10; i++) {
          const current = await r.ui.eval<string>(
            `[...document.querySelectorAll("[data-tab-layer]")].find((l) => getComputedStyle(l).visibility === "visible")?.dataset.tabLayer ?? ""`,
          );
          keys.push(await uiLatency(ctx, `!${visible(current)}`, () => uiKey(ctx, "Tab", MOD.ctrl)));
          await Bun.sleep(100);
        }
      }),
    );
    await closeAllBut(ctx, keep);
    recordLatencies(ctx, "ui.tab-switch.click", "Click a tab to its page on screen", clicks, BUDGET.response);
    recordLatencies(ctx, "ui.tab-switch.key", "Ctrl+Tab to the next page on screen", keys, BUDGET.response);
    recordUiFrames(ctx, "ui.tab-switch", "Switching tabs", intervals, data);
  },
};

function manyTabs(layout: "horizontal" | "vertical"): Scenario {
  const id = `ui.many-tabs.${layout}`;
  const title = `60 tabs (${layout === "horizontal" ? "tab strip" : "sidebar"})`;
  return {
    id,
    title: `UI: ${title}`,
    about: `60 tabs opened at once and closed again with ${layout === "horizontal" ? "tabs along the top" : "the vertical tab sidebar"}: how the UI copes with many tabs (frames, blocking, memory), and scrolling through them.`,
    runeOnly: true,
    maxRuns: 3,
    async run(ctx) {
      const r = rune(ctx);
      await prepareUi(ctx);
      const keep = await openTabs(ctx);
      // Switched as the user does, from a tab's menu (the window doesn't pick up settings saved elsewhere).
      const isVertical = `!!document.querySelector("nav[data-sidebar] li[data-app-id]")`;
      const setLayout = async (to: "horizontal" | "vertical") => {
        if ((await r.ui.eval<boolean>(isVertical)) === (to === "vertical")) return;
        await r.ui.eval(
          `(() => { const li = document.querySelector("[data-app-id]"); const r = li.getBoundingClientRect(); li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true; })()`,
        );
        await r.ui.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="tab-layout"]')`, {
          label: "the layout in the tab's menu",
        });
        await r.ui.eval(`document.querySelector('[data-context-menu] [data-menu-item="tab-layout"]').click(), true`);
        await r.ui.waitFor(to === "vertical" ? isVertical : `!${isVertical}`, { label: `the ${to} layout` });
        await Bun.sleep(500);
      };
      await setLayout(layout);
      const before = await sampleTree(r.pid);
      let shown = NaN;
      const opening = await uiFrames(ctx, async () => {
        const started = epochNow();
        const pending = r.ui.eval<number>(`window.__benchWait(() => ${tabCount} >= ${keep.size + 60}, 60000)`, 70_000);
        for (let i = 0; i < 60; i += 10)
          await Promise.all(
            Array.from({ length: 10 }, (_, k) =>
              r.api("/api/apps", {
                method: "POST",
                body: { kind: "web", url: ctx.site.url(`/nav/${i + k}`), windowId: r.windowId },
              }),
            ),
          );
        shown = (await pending) - started;
        await Bun.sleep(500);
      });
      const { metrics } = await r.ui.send<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics");
      const after = await sampleTree(r.pid);
      // Scrolling the tabs: the strip sideways, the sidebar down.
      const list = layout === "horizontal" ? "[data-tab-strip] [data-app-id]" : "nav[data-sidebar] li[data-app-id]";
      const at = await r.ui.eval<{ x: number; y: number }>(
        `(() => { const r = document.querySelector('${list}').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`,
      );
      const scrolling = await uiFrames(ctx, async () => {
        for (let i = 0; i < 40; i++) {
          await rune(ctx).ui.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: at.x,
            y: at.y,
            deltaX: 0,
            deltaY: i < 20 ? 120 : -120,
            ...(layout === "horizontal" ? { modifiers: MOD.shift } : {}),
          });
          await Bun.sleep(16);
        }
        await Bun.sleep(200);
      });
      let closedIn = NaN;
      const closing = await uiFrames(ctx, async () => {
        const started = epochNow();
        const pending = r.ui.eval<number>(`window.__benchWait(() => ${tabCount} === ${keep.size}, 60000)`, 70_000);
        const apps = await r.api<{ id: string }[]>("/api/apps");
        await Promise.all(
          apps.filter((a) => !keep.has(a.id)).map((a) => r.api(`/api/apps/${a.id}`, { method: "DELETE" })),
        );
        closedIn = (await pending) - started;
        await Bun.sleep(300);
      });
      await setLayout("horizontal");
      ctx.record(metric(G, `${id}.shown`, `${title}: until all are shown`, "ms"), shown);
      recordUiFrames(ctx, `${id}.open`, `${title}: opening`, opening.intervals, opening.data);
      recordUiFrames(ctx, `${id}.scroll`, `${title}: scrolling them`, scrolling.intervals, scrolling.data);
      ctx.record(metric(G, `${id}.closed`, `${title}: until all are closed`, "ms"), closedIn);
      recordUiFrames(ctx, `${id}.close`, `${title}: closing`, closing.intervals, closing.data);
      const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? NaN;
      ctx.record(metric(G, `${id}.ui-heap`, `${title}: UI JavaScript heap`, "MB"), get("JSHeapUsedSize") / 2 ** 20);
      ctx.record(metric(G, `${id}.ui-nodes`, `${title}: UI DOM nodes`, "count"), get("Nodes"));
      ctx.record(metric(G, `${id}.mem`, `${title}: memory they add (not loaded)`, "MB"), after.memMB - before.memMB);
    },
  };
}

const menus: Scenario = {
  id: "ui.menus",
  title: "UI: menus and the command bar",
  about: "Opening the ⋯ menu and the command bar (Ctrl+K) and closing them again, eight times each.",
  runeOnly: true,
  async run(ctx) {
    await prepareUi(ctx);
    const menu: number[] = [];
    const bar: number[] = [];
    await measured(ctx, "ui.menus", "Menus", async () => {
      for (let i = 0; i < 8; i++) {
        await home(ctx);
        menu.push(
          await uiLatency(ctx, `!!document.querySelector("[data-context-menu]")`, () =>
            uiClick(ctx, "[data-more-menu]"),
          ),
        );
        await uiKey(ctx, "Escape");
        await rune(ctx).ui.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "the menu closed" });
        bar.push(
          await uiLatency(ctx, `!!document.querySelector("[data-command-bar]")`, () => uiKey(ctx, "k", MOD.primary)),
        );
        await uiKey(ctx, "Escape");
        await rune(ctx).ui.waitFor(`!document.querySelector("[data-command-bar]")`, {
          label: "the command bar closed",
        });
      }
    });
    recordLatencies(ctx, "ui.menus.more", "⋯ menu open", menu, BUDGET.response);
    recordLatencies(ctx, "ui.menus.command", "Command bar open", bar, BUDGET.response);
  },
};

const hungPage: Scenario = {
  id: "ui.hung-page",
  title: "UI: a page that hangs",
  about:
    "A page stops its main thread for 4 s. Meanwhile: does Rune's UI keep its frames, do its menus open, does the main process answer, can you switch to another tab?",
  runeOnly: true,
  async run(ctx) {
    const r = rune(ctx);
    await prepareUi(ctx);
    const keep = await openTabs(ctx);
    const other = await r.api<{ id: string }>("/api/apps", {
      method: "POST",
      body: { kind: "web", url: ctx.site.url("/nav/2"), windowId: r.windowId },
    });
    await r.ui.waitFor(`!!document.querySelector('[data-app-id="${other.id}"]')`, { label: "the other tab" });
    await ctx.tab.navigate(ctx.site.url("/hang?ms=4000"));
    await home(ctx);
    const menu: number[] = [];
    let away = NaN;
    const { result, intervals, data } = await uiFrames(ctx, () =>
      roundTrips(ctx, () =>
        measured(ctx, "ui.hung-page", "Hung page", async () => {
          void ctx.tab.cdp
            .send("Runtime.evaluate", { expression: "window.__hang()" }, undefined, 20_000)
            .catch(() => {});
          await Bun.sleep(200);
          for (let i = 0; i < 4; i++) {
            menu.push(
              await uiLatency(ctx, `!!document.querySelector("[data-context-menu]")`, () =>
                uiClick(ctx, "[data-more-menu]"),
              ),
            );
            await uiKey(ctx, "Escape");
            await r.ui.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "the menu closed" });
          }
          away = await uiLatency(ctx, visible(other.id), () => uiClick(ctx, `[data-app-id="${other.id}"]`));
          // Until the page is back.
          await ctx.tab.eval(`true`, 20_000);
        }),
      ),
    );
    await closeAllBut(ctx, keep);
    recordLatencies(ctx, "ui.hung-page.menu", "While a page hangs: ⋯ menu open", menu, BUDGET.response);
    ctx.record(
      metric(G, "ui.hung-page.switch", "While a page hangs: switch to another tab", "ms", "lower", BUDGET.response),
      away,
    );
    recordUiFrames(ctx, "ui.hung-page", "While a page hangs", intervals, data);
    recordRoundTrips(ctx, "ui.hung-page", "While a page hangs", result.ipc, result.server);
  },
};

const flood: Scenario = {
  id: "ui.flood",
  title: "UI: a busy page",
  about:
    "A page that changes its title, URL and favicon, logs to the console and calls its API 100 times a second, for 4 s: everything Rune listens to in a page, at once. What it costs Rune's UI, main process and server.",
  runeOnly: true,
  async run(ctx) {
    const r = rune(ctx);
    await prepareUi(ctx);
    await ctx.tab.navigate(ctx.site.url("/flood"));
    await home(ctx);
    const before = await sampleTree(r.pid);
    const mon = monitor(r.pid);
    const { result, intervals, data } = await uiFrames(ctx, () =>
      roundTrips(ctx, () => ctx.tab.eval(`window.__flood(4000)`, 30_000)),
    );
    const usage = await mon.stop();
    recordUsage(ctx, "ui.flood", "Busy page", usage);
    const after = await sampleTree(r.pid);
    const cpu = cpuBetween(before, after);
    recordUiFrames(ctx, "ui.flood", "Busy page", intervals, data);
    recordRoundTrips(ctx, "ui.flood", "Busy page", result.ipc, result.server);
    for (const kind of ["browser", "ui", "renderer", "gpu", "server"] as const)
      ctx.record(metric(G, `ui.flood.cpu.${kind}`, `Busy page: CPU of the ${kind} process(es)`, "%"), cpu.byKind[kind]);
  },
};

/** Chat messages as an agent run writes them: prose, code, tool calls. */
function chatMessages(n: number) {
  const out: [string, string][] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 5;
    if (kind === 0) out.push(["user", `Step ${i}: make the list sortable by date and keep the filter when reloading.`]);
    else if (kind === 1)
      out.push([
        "assistant",
        `Looking at **step ${i}**. The list is rendered in \`src/list.ts\`; I'll:\n\n1. add a \`sortBy\` field\n2. keep it in \`localStorage\`\n3. update the header\n\n\`\`\`ts\nexport function sortBy<T>(items: T[], key: keyof T) {\n  return [...items].sort((a, b) => String(a[key]).localeCompare(String(b[key])));\n}\n\`\`\``,
      ]);
    else if (kind === 2) out.push(["tool", JSON.stringify({ kind: "read", title: `Read \`src/file${i}.ts\`` })]);
    else if (kind === 3)
      out.push([
        "tool",
        JSON.stringify({
          kind: "edit",
          title: `Edited \`src/file${i}.ts\``,
          detail: "- old line\n+ new line\n".repeat(8),
        }),
      ]);
    else
      out.push([
        "assistant",
        `Done with step ${i}. ${"The change keeps the existing behaviour and adds the option. ".repeat(4)}`,
      ]);
  }
  return out;
}

const longChat: Scenario = {
  id: "ui.chat",
  title: "UI: a long agent chat",
  about:
    "Opening an earlier chat of 500 messages (markdown, code, tool calls) in the agent sidebar, then scrolling it.",
  runeOnly: true,
  maxRuns: 3,
  async run(ctx) {
    const r = rune(ctx);
    await prepareUi(ctx);
    const tabId = r.tabIdOf(ctx.tab);
    const panel = `[data-agent-for="${tabId}"]`;
    const db = new Database(join(r.profile, "data", "rune.sqlite"));
    db.run("PRAGMA busy_timeout = 5000");
    const at = (s: number) => new Date(Date.parse("2026-01-05T10:00:00Z") + s * 1000).toISOString();
    const chatId = Number(
      db
        .query("INSERT INTO chats (app_id, title, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id")
        .get(tabId, `Long chat ${Date.now()}`, at(0), at(0))!["id" as never],
    );
    const messages = chatMessages(500);
    const insert = db.prepare(
      "INSERT INTO messages (app_id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => messages.forEach(([role, content], i) => insert.run(tabId, chatId, role, content, at(i))))();
    db.close();
    await home(ctx);
    if (!(await r.ui.eval<boolean>(`!!document.querySelector('${panel}')`))) await uiKey(ctx, "i", MOD.primary);
    await r.ui.waitFor(`!!document.querySelector('${panel} [data-chat-history-button]')`, {
      label: "the agent sidebar",
    });
    await uiClick(ctx, `${panel} [data-chat-history-button]`);
    await r.ui.waitFor(`!!document.querySelector('[data-chat="${chatId}"] [data-open-chat]')`, {
      label: "the chat in the list",
    });
    let opened = NaN;
    const open = await uiFrames(ctx, async () => {
      opened = await uiLatency(
        ctx,
        `document.querySelector('${panel}')?.innerText.includes("Done with step 499")`,
        () => uiClick(ctx, `[data-chat="${chatId}"] [data-open-chat]`),
      );
    });
    await Bun.sleep(500);
    const box = await r.ui.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('${panel}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    const scroll = await uiFrames(ctx, () =>
      measured(ctx, "ui.chat", "Long chat", async () => {
        for (let i = 0; i < 60; i++) {
          await r.ui.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: box.x,
            y: box.y,
            deltaX: 0,
            deltaY: -150,
          });
          await Bun.sleep(16);
        }
        await Bun.sleep(300);
      }),
    );
    await uiKey(ctx, "i", MOD.primary);
    ctx.record(metric(G, "ui.chat.open", "Long chat: open to shown", "ms", "lower", BUDGET.response * 5), opened);
    recordUiFrames(ctx, "ui.chat.open", "Long chat: opening", open.intervals, open.data);
    recordUiFrames(ctx, "ui.chat.scroll", "Long chat: scrolling", scroll.intervals, scroll.data);
  },
};

export const UI_SCENARIOS: Scenario[] = [
  baseline,
  newTab,
  addressBar,
  tabSwitch,
  manyTabs("horizontal"),
  manyTabs("vertical"),
  menus,
  hungPage,
  flood,
  longChat,
];
