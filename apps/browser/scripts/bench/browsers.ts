// The two browsers the benchmarks compare, behind one interface: Rune Browser (the built app, a web tab in
// its window) and Google Chrome (a tab of its own). Both run on a throwaway profile, with the same flags
// where they share them, headless by default (Chromium's headless display backend: the same compositor and
// rendering as a window, nothing on screen) or in real windows with --headed.
//
// Input goes the way a user's does: in Rune, into the window at the web tab's position, so it travels
// through the browser's own UI to the page, as a real click or key press does.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchElectron } from "../electron";
import { Page } from "../lib/cdp";
import { PROBE } from "./probe";

export type BrowserName = "rune" | "chrome";

export interface LaunchOptions {
  headed: boolean;
  /** The page's viewport. Rune's window is sized so its web tab gets about this; Chrome's to match Rune's. */
  viewport: { width: number; height: number };
  /** Opened at startup (to measure launching straight to a page). */
  url?: string;
}

/** Where input goes: a DevTools connection, and where the page's top-left corner is in it. */
export interface InputTarget {
  cdp: Page;
  offset: () => Promise<{ x: number; y: number }>;
}

export interface Tab {
  /** The page's own DevTools connection (its target: Rune's webview guest, Chrome's tab). */
  cdp: Page;
  input: InputTarget;
  /** Navigates and waits until the page loaded (and said it's ready, if it does); resolves to the ms taken. */
  navigate(url: string, opts?: { timeoutMs?: number }): Promise<number>;
  eval<T>(expression: string, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface Browser {
  name: BrowserName;
  /** "Chrome/142.0…", and Electron's version for Rune. */
  version: string;
  pid: number;
  /** When the process was spawned (epoch ms, sub-millisecond: performance.timeOrigin + performance.now()). */
  spawnedAt: number;
  viewport: { width: number; height: number };
  newTab(url: string): Promise<Tab>;
  /** The browser-wide DevTools connection. */
  browserCdp: Page;
  port: number;
  quit(): Promise<void>;
}

const epochNow = () => performance.timeOrigin + performance.now();

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Flags both browsers get: nothing slows down a page because a headless window counts as hidden. */
const SHARED_FLAGS = [
  "--password-store=basic",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];
/**
 * Headless, both draw with SwiftShader (the GPU in software): Chrome picks it there on its own, while
 * Electron's GPU process otherwise fails to start (ANGLE looks for an X display) and falls back further.
 * With --headed each uses the real GPU.
 */
const headlessFlags = (headed: boolean, size: { width: number; height: number }) =>
  headed
    ? []
    : [
        "--ozone-platform=headless",
        `--ozone-override-screen-size=${size.width + 600},${size.height + 400}`,
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ];

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
const targets = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as TargetInfo[];

async function waitForTarget(port: number, pick: (t: TargetInfo) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await targets(port)
      .then((ts) => ts.find(pick))
      .catch(() => undefined);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for a DevTools target");
    await Bun.sleep(50);
  }
}

async function connectBrowser(port: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
        webSocketDebuggerUrl: string;
      };
      return await Page.open(info.webSocketDebuggerUrl);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await Bun.sleep(50);
    }
  }
}

/** Sets up a page's connection: the probe for every document from now on, and the events navigate() waits for. */
async function preparePage(cdp: Page) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  cdp.acceptDialogs();
}

async function navigateAndWait(cdp: Page, url: string, timeoutMs = 60_000) {
  const started = performance.now();
  const loaded = cdp.next("Page.loadEventFired", timeoutMs);
  const res = await cdp.send<{ errorText?: string }>("Page.navigate", { url });
  if (res.errorText) throw new Error(`${url}: ${res.errorText}`);
  await loaded;
  // Pages that build themselves after load say when they're done (window.__benchReady).
  const deadline = Date.now() + timeoutMs;
  while ((await cdp.eval<boolean>(`window.__benchReady !== false`).catch(() => false)) !== true) {
    if (Date.now() > deadline) throw new Error(`${url} never got ready`);
    await Bun.sleep(20);
  }
  const took = performance.now() - started;
  // Until it's on screen: two frames painted (input sent earlier than anyone could click can miss the page).
  await cdp.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))`);
  return took;
}

const makeTab = (cdp: Page, input: InputTarget, close: () => Promise<void>): Tab => ({
  cdp,
  input,
  navigate: (url, opts) => navigateAndWait(cdp, url, opts?.timeoutMs),
  eval: (expression, timeoutMs) => cdp.eval(expression, timeoutMs),
  close,
});

// --- Rune ---------------------------------------------------------------------------------------------

export interface RuneBrowser extends Browser {
  name: "rune";
  /** The window's UI (the renderer). */
  ui: Page;
  /** When the window was ready to use: its tabs' "New tab" button there (epoch ms). */
  readyAt: number;
  /** The window's id: new tabs are created in it (without one, a tab made right after launch has no window yet). */
  windowId: string;
  profile: string;
  /** An authenticated request to Rune's server, made from the UI. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  /** The tab a Tab belongs to (its id in Rune). */
  tabIdOf(tab: Tab): string;
}

export async function launchRune(opts: LaunchOptions & { seedProfile?: (profile: string) => void }) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "rune-bench-"));
  const downloads = mkdtempSync(join(tmpdir(), "rune-bench-downloads-"));
  // Rune's chrome (tab strip, address bar, window border) around the page: the window is that much larger.
  const window = { width: opts.viewport.width + 16, height: opts.viewport.height + 54 };
  await Bun.write(
    join(profile, "windows.json"),
    JSON.stringify({ version: 1, open: [{ id: "w-bench00000", bounds: window, maximized: false }], closed: [] }),
  );
  opts.seedProfile?.(profile);
  const spawnedAt = epochNow();
  const proc = await launchElectron(
    {
      RUNE_USER_DATA_DIR: profile,
      RUNE_EXTENSION_UPDATES: "0",
      RUNE_BROWSER_DIRS: "",
      RUNE_DOWNLOADS_DIR: downloads,
    },
    [
      ...headlessFlags(opts.headed, window),
      ...SHARED_FLAGS,
      `--remote-debugging-port=${port}`,
      ...(opts.url ? [opts.url] : []),
    ],
  );
  const cleanup = () => {
    rmSync(profile, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  };
  try {
    const browserCdp = await connectBrowser(port, 60_000);
    const uiTarget = await waitForTarget(port, (t) => t.type === "page" && t.url.startsWith("app://"), 60_000);
    const ui = await Page.open(uiTarget.webSocketDebuggerUrl);
    await ui.send("Runtime.enable");
    await ui.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // Polled often: launching is measured by it.
    const deadline = Date.now() + 60_000;
    while (
      !(await ui.eval<boolean>(`!!window.rune && !!document.querySelector("[data-new-tab]")`).catch(() => false))
    ) {
      if (Date.now() > deadline) throw new Error("Rune's window never showed its tabs");
      await Bun.sleep(10);
    }
    const readyAt = epochNow();
    const version = await browserCdp.send<{ product: string }>("Browser.getVersion");
    const electron = await ui.eval<string>(`window.rune.versions.electron`);
    const windowId = await ui.eval<string>(`window.rune.window.id`);
    const api = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
      ui.eval<T>(`window.rune.serverReady().then(() => fetch(window.rune.serverUrl + ${JSON.stringify(path)}, {
        method: ${JSON.stringify(init.method ?? "GET")},
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.rune.token },
        ${init.body !== undefined ? `body: ${JSON.stringify(JSON.stringify(init.body))},` : ""}
      }).then(async (r) => { if (!r.ok) throw new Error(r.status + " " + (await r.text())); return r.status === 204 ? null : r.json(); }))`);
    const tabIds = new WeakMap<Tab, string>();

    const browser: RuneBrowser = {
      name: "rune",
      version: `${version.product} (Electron ${electron})`,
      pid: proc.pid,
      spawnedAt,
      readyAt,
      windowId,
      viewport: opts.viewport,
      port,
      browserCdp,
      ui,
      profile,
      api,
      tabIdOf: (tab) => tabIds.get(tab)!,
      async newTab(url) {
        const before = new Set((await targets(port)).filter((t) => t.type === "webview").map((t) => t.id));
        const app = await api<{ id: string }>("/api/apps", { method: "POST", body: { url, windowId } });
        const view = `[data-web-tab="${app.id}"] webview`;
        // A new tab from elsewhere isn't selected: click it, as the user would.
        await ui.waitFor(`!!document.querySelector('[data-app-id="${app.id}"]')`, { label: "the new tab" });
        await ui.eval(`document.querySelector('[data-app-id="${app.id}"]').click(), true`);
        await ui.waitFor(`!!document.querySelector('${view}')`, { label: "the web tab's page", timeoutMs: 30_000 });
        const target = await waitForTarget(port, (t) => t.type === "webview" && !before.has(t.id));
        const cdp = await Page.open(target.webSocketDebuggerUrl);
        await preparePage(cdp);
        // Wait for its first page, so what's measured next starts from a loaded tab.
        await ui.waitFor(`document.querySelector('${view}')?.getURL?.() === ${JSON.stringify(url)}`, {
          label: "the first page",
          timeoutMs: 30_000,
        });
        const input: InputTarget = {
          cdp: ui,
          offset: () =>
            ui.eval(
              `(() => { const r = document.querySelector('${view}').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
            ),
        };
        const tab = makeTab(cdp, input, async () => {
          cdp.close();
          await api(`/api/apps/${app.id}`, { method: "DELETE" }).catch(() => {});
        });
        tabIds.set(tab, app.id);
        return tab;
      },
      async quit() {
        ui.close();
        browserCdp.close();
        proc.kill();
        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
        if (!exited) proc.kill(9);
        await proc.exited;
        cleanup();
      },
    };
    return browser;
  } catch (err) {
    proc.kill(9);
    await proc.exited;
    cleanup();
    throw err;
  }
}

// --- Chrome -------------------------------------------------------------------------------------------

/** Chrome on this computer: --chrome, $CHROME_PATH, the usual install locations, or Playwright's Chromium. */
export function findChrome(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
            .filter(Boolean)
            .map((dir) => join(dir!, "Google", "Chrome", "Application", "chrome.exe"))
        : [
            ...["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"].map((n) => Bun.which(n) ?? ""),
            ...(existsSync("/opt/pw-browsers")
              ? readdirSync("/opt/pw-browsers")
                  .filter((d) => d.startsWith("chromium-"))
                  .map((d) => `/opt/pw-browsers/${d}/chrome-linux64/chrome`)
              : []),
          ];
  return candidates.find((c) => c && existsSync(c));
}

export async function launchChrome(binary: string, opts: LaunchOptions) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "chrome-bench-"));
  mkdirSync(profile, { recursive: true });
  const rootArgs = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const spawnedAt = epochNow();
  const proc = Bun.spawn(
    [
      binary,
      ...rootArgs,
      ...(opts.headed ? [] : ["--headless=new"]),
      ...headlessFlags(opts.headed, opts.viewport),
      ...SHARED_FLAGS,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--window-size=${opts.viewport.width},${opts.viewport.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      // Chrome's own background work (component and safe browsing updates, metrics, sync), which Rune
      // doesn't do either (and its extension updates are off for the benchmarks).
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-pings",
      "--use-mock-keychain",
      opts.url ?? "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const cleanup = () => rmSync(profile, { recursive: true, force: true });
  try {
    const browserCdp = await connectBrowser(port, 60_000);
    const version = await browserCdp.send<{ product: string }>("Browser.getVersion");
    let initial: string | undefined = (await waitForTarget(port, (t) => t.type === "page")).id;
    const browser: Browser = {
      name: "chrome",
      version: version.product,
      pid: proc.pid,
      spawnedAt,
      viewport: opts.viewport,
      port,
      browserCdp,
      async newTab(url) {
        const { targetId } = await browserCdp.send<{ targetId: string }>("Target.createTarget", { url });
        // The tab Chrome started with (about:blank) goes once there's another: like closing the new tab page.
        if (initial) {
          await browserCdp.send("Target.closeTarget", { targetId: initial }).catch(() => {});
          initial = undefined;
        }
        const target = await waitForTarget(port, (t) => t.id === targetId);
        const cdp = await Page.open(target.webSocketDebuggerUrl);
        await preparePage(cdp);
        await browserCdp.send("Target.activateTarget", { targetId });
        // Wait for its first page.
        const deadline = Date.now() + 30_000;
        while ((await cdp.eval<string>(`location.href + " " + document.readyState`)) !== `${url} complete`) {
          if (Date.now() > deadline) throw new Error(`${url} didn't load in Chrome`);
          await Bun.sleep(30);
        }
        return makeTab(cdp, { cdp, offset: async () => ({ x: 0, y: 0 }) }, async () => {
          cdp.close();
          await browserCdp.send("Target.closeTarget", { targetId }).catch(() => {});
        });
      },
      async quit() {
        await browserCdp.send("Browser.close").catch(() => {});
        browserCdp.close();
        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
        if (!exited) proc.kill(9);
        await proc.exited;
        cleanup();
      },
    };
    return browser;
  } catch (err) {
    proc.kill(9);
    await proc.exited;
    cleanup();
    throw err;
  }
}

// --- Input --------------------------------------------------------------------------------------------

/** Real input (as from the mouse and keyboard), at page coordinates. */
export const input = {
  async click(t: InputTarget, x: number, y: number) {
    const o = await t.offset();
    const at = { x: o.x + x, y: o.y + y, button: "left", clickCount: 1 };
    await t.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await t.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await t.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
  },
  async wheel(t: InputTarget, x: number, y: number, deltaY: number) {
    const o = await t.offset();
    await t.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: o.x + x, y: o.y + y, deltaX: 0, deltaY });
  },
  /** One key press: a printable character, or a named key ("Enter", "Backspace"…). */
  async key(t: InputTarget, key: string, modifiers = 0) {
    const named: Record<string, { code: string; keyCode: number; text?: string }> = {
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Backspace: { code: "Backspace", keyCode: 8 },
      Escape: { code: "Escape", keyCode: 27 },
      Tab: { code: "Tab", keyCode: 9 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
    };
    const info = named[key] ?? {
      code: /^[a-z]$/i.test(key)
        ? `Key${key.toUpperCase()}`
        : /^\d$/.test(key)
          ? `Digit${key}`
          : (PUNCTUATION[key]?.[1] ?? ""),
      // Windows virtual key codes: letters and digits are their own, punctuation has codes of its own
      // (a "." sent as its character code, 46, would be the Delete key).
      keyCode: /^[a-z\d ]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : (PUNCTUATION[key]?.[0] ?? 0),
      text: modifiers & ~8 ? undefined : key,
    };
    const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers };
    await t.cdp.send("Input.dispatchKeyEvent", {
      type: info.text ? "keyDown" : "rawKeyDown",
      ...base,
      text: info.text,
    });
    await t.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  },
};

/** Punctuation keys (US layout): their virtual key code and their code. */
const PUNCTUATION: Record<string, [number, string]> = {
  ".": [190, "Period"],
  ",": [188, "Comma"],
  "/": [191, "Slash"],
  "?": [191, "Slash"],
  ":": [186, "Semicolon"],
  ";": [186, "Semicolon"],
  "-": [189, "Minus"],
  _: [189, "Minus"],
  "=": [187, "Equal"],
  "+": [187, "Equal"],
  "'": [222, "Quote"],
  "[": [219, "BracketLeft"],
  "]": [221, "BracketRight"],
  "\\": [220, "Backslash"],
  "`": [192, "Backquote"],
  "&": [55, "Digit7"],
  "#": [51, "Digit3"],
  "%": [53, "Digit5"],
};

/** Modifier bits for input.key. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8, primary: process.platform === "darwin" ? 4 : 2 };
