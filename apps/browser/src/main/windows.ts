// Rune Browser's windows (shared/windows.ts): opening them (Ctrl+N, Ctrl+Shift+N, a tab
// dragged out), keeping where they are in windows.json so they come back after a
// restart, and the closed ones to reopen with their tabs. The server keeps which
// window each tab is in; it's told whenever the windows change (POST /api/windows).
// Private windows are never saved: their tabs are deleted when they close, and
// their session is wiped once the last one is gone (and at every start).
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { join } from "node:path";
import { PRIVATE_PARTITION } from "../shared/api";
import {
  DEFAULT_BOUNDS,
  isPrivateWindow,
  newWindowId,
  parseWindowsFile,
  startupPlan,
  trimClosed,
  WINDOW_ID_PATTERN,
  type OnStartup,
  type SavedWindow,
  type WindowIntent,
  type WindowBounds,
} from "../shared/windows";
import { readJson, writeJson } from "./extensions/registry";
import type { ServerHandle } from "./server";

/** What the other parts of the main process need to know about the windows. */
export interface AppWindows {
  /** Every open window. */
  all(): BrowserWindow[];
  /** The window a page is in: a window's own page, or a web tab or app preview (a webview) in it. */
  of(contents: WebContents | null | undefined): BrowserWindow | undefined;
  /** The focused window, else the one focused last (only private ones, or only normal ones, if asked). */
  current(kind?: "private" | "normal"): BrowserWindow | undefined;
  /** Whether a message comes from one of the windows' own pages (Rune Browser's UI). */
  isUi(sender: WebContents): boolean;
  /** Sends to every window. */
  broadcast(channel: string, ...args: unknown[]): void;
  /** Whether a window is private. */
  isPrivate(win: BrowserWindow | undefined): boolean;
  /** Calls `fn` when a window gets the focus. */
  onFocus(fn: () => void): void;
}

interface Live {
  id: string;
  win: BrowserWindow;
  private: boolean;
  /** What it was opened for, until its page asks (rune:window-intent). */
  intent: WindowIntent;
  /** Closed because its last tab moved to another window: nothing to reopen. */
  discarded?: boolean;
}

export interface WindowManagerOptions {
  /** The URL of Rune Browser's page; the window's id goes in its query (the e2e checks find windows by it). */
  rendererUrl: string;
  preload: string;
  icon: string;
  safeMode: boolean;
  offscreen: boolean;
  /** Everything else a new window needs (crash handling, links, keys), from index.ts. */
  onCreated: (win: BrowserWindow) => void;
}

export function createWindowManager(options: WindowManagerOptions) {
  const file = join(app.getPath("userData"), "windows.json");
  const live = new Map<number, Live>();
  /** Window ids, the focused last. */
  let focusOrder: string[] = [];
  let closed: SavedWindow[] = [];
  /** The last normal window, closed with no other one left: it opens again at the next start (or on macOS's activate). */
  let lastSession: SavedWindow | null = null;
  let quitting = false;
  let server: ServerHandle | undefined;
  /** Windows being opened (their tabs move first): the server must not take those tabs away meanwhile. */
  const opening = new Set<string>();
  const focusListeners = new Set<() => void>();

  const byId = (id: string) => [...live.values()].find((w) => w.id === id);
  const entryOf = (win: BrowserWindow | undefined) => (win ? live.get(win.id) : undefined);
  const savedOf = (w: Live): SavedWindow => {
    const maximized = !w.win.isDestroyed() && w.win.isMaximized();
    const b = w.win.isDestroyed() ? DEFAULT_BOUNDS : maximized ? w.win.getNormalBounds() : w.win.getBounds();
    // Wayland doesn't say where a window is: only its size is kept there.
    const bounds: WindowBounds =
      process.platform === "linux" && process.env.WAYLAND_DISPLAY && !process.env.RUNE_OFFSCREEN
        ? { width: b.width, height: b.height }
        : { x: b.x, y: b.y, width: b.width, height: b.height };
    return { id: w.id, bounds, maximized };
  };

  // --- Saving ---------------------------------------------------------------------------------

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const open = [...live.values()].filter((w) => !w.private).map(savedOf);
    writeJson(file, { version: 1, open: open.length ? open : lastSession ? [lastSession] : [], closed });
  }
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  };

  /** Tells the server which windows there are, one call after another. */
  let syncing: Promise<unknown> = Promise.resolve();
  function sync(forget: string[] = [], open?: () => string[]) {
    // What's open is read when the request goes out: a window opened meanwhile is in it.
    const body = () => ({
      open: [...new Set([...(open?.() ?? [...live.values()].map((w) => w.id)), ...opening])],
      closed: [...closed.map((w) => w.id), ...(lastSession ? [lastSession.id] : [])],
      forget,
    });
    syncing = syncing.then(() =>
      api("/api/windows", { method: "POST", body: body() }).catch((err) => console.warn(err)),
    );
    return syncing;
  }

  async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!server) throw new Error("The server isn't running");
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // --- Opening ---------------------------------------------------------------------------------

  function open(saved: SavedWindow, intent: Live["intent"], at?: { x: number; y: number }) {
    if (!server) throw new Error("The server isn't running");
    const isPrivate = isPrivateWindow(saved.id);
    const position = at
      ? { x: Math.round(at.x - 120), y: Math.round(at.y - 20) }
      : saved.bounds.x !== undefined && saved.bounds.y !== undefined
        ? { x: saved.bounds.x, y: saved.bounds.y }
        : {};
    const win = new BrowserWindow({
      width: saved.bounds.width,
      height: saved.bounds.height,
      ...position,
      minWidth: 400,
      minHeight: 300,
      show: false,
      autoHideMenuBar: true,
      icon: options.icon,
      // No title bar (like Chrome). macOS keeps its traffic lights (top left); elsewhere the
      // window is frameless and the renderer draws its close button. Its top bars are where
      // the window is dragged (lib/windowChrome.ts).
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 16 } }
        : { frame: false }),
      webPreferences: {
        preload: options.preload,
        additionalArguments: [
          `--rune-server-url=${server.url}`,
          `--rune-token=${server.token}`,
          `--rune-window=${saved.id}`,
          ...(isPrivate ? ["--rune-private=1"] : []),
          ...(options.safeMode ? ["--rune-safe-mode=1"] : []),
          ...(options.offscreen ? ["--rune-offscreen=1"] : []),
        ],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Web tabs are <webview> guests (locked down in web.ts).
        webviewTag: true,
        // Agent runs stream into the window while it's in the background.
        backgroundThrottling: false,
        // Tests render without a visible window (always painted, nothing pops up).
        offscreen: options.offscreen,
      },
    });
    const entry: Live = { id: saved.id, win, private: isPrivate, intent };
    // Kept: a destroyed window can't say its id anymore.
    const key = win.id;
    live.set(key, entry);
    focusOrder = [...focusOrder.filter((id) => id !== saved.id), saved.id];

    win.once("ready-to-show", () => {
      if (saved.maximized) win.maximize();
      if (!options.offscreen) win.show();
    });
    const sendMaximized = () => win.webContents.send("rune:maximized", win.isMaximized());
    win.on("maximize", sendMaximized);
    win.on("unmaximize", sendMaximized);
    win.on("focus", () => {
      focusOrder = [...focusOrder.filter((id) => id !== entry.id), entry.id];
      for (const fn of focusListeners) fn();
    });
    const moved = () => !entry.private && saveSoon();
    win.on("resize", moved);
    win.on("move", moved);
    win.on("maximize", moved);
    win.on("unmaximize", moved);
    win.on("close", () => {
      if (entry.private || entry.discarded || quitting) return;
      // Closed with other windows still open: it can be reopened. The last one is the session to come back.
      const others = [...live.values()].some((w) => w !== entry && !w.private);
      if (others) closed = [{ ...savedOf(entry), closedAt: Date.now() }, ...closed];
      else lastSession = { ...savedOf(entry), closedAt: Date.now() };
    });
    win.on("closed", () => {
      live.delete(key);
      focusOrder = focusOrder.filter((id) => id !== entry.id);
      if (quitting) return;
      const plan = trimClosed({ closed, forget: [] });
      closed = plan.closed;
      if (!entry.private) save();
      void sync(plan.forget);
      // A private session keeps nothing once the last private window is gone.
      if (entry.private && ![...live.values()].some((w) => w.private)) void clearPrivate();
    });

    options.onCreated(win);
    const url = new URL(options.rendererUrl);
    url.searchParams.set("window", saved.id);
    void win.loadURL(url.toString());
    return win;
  }

  async function clearPrivate() {
    const s = session.fromPartition(PRIVATE_PARTITION);
    await s.clearStorageData().catch(() => {});
    await s.clearCache().catch(() => {});
    await s.clearAuthCache().catch(() => {});
    s.clearHostResolverCache?.();
  }

  /** A new window: empty (it opens a new tab, unless it's for links), or with these tabs moved into it. */
  async function openNew(isPrivate: boolean, tabIds: string[] = [], at?: { x: number; y: number }, newTab = true) {
    // Rune Browser is quitting: nothing new opens (it would outlive the cleanup).
    if (quitting) return null;
    const id = newWindowId(isPrivate);
    let moved = 0;
    opening.add(id);
    try {
      for (const tabId of tabIds.slice(0, 50)) {
        await api(`/api/apps/${encodeURIComponent(tabId)}/window`, { method: "POST", body: { windowId: id } }).then(
          () => moved++,
          (err) => console.warn("Moving a tab to the new window failed:", err),
        );
      }
    } finally {
      opening.delete(id);
    }
    if (tabIds.length && !moved) return null;
    if (!isPrivate && lastSession) {
      // The window kept for the next start is just a closed window now.
      closed = [lastSession, ...closed];
      lastSession = null;
    }
    const current = entryOf(BrowserWindow.getFocusedWindow() ?? undefined);
    const bounds = current
      ? { width: savedOf(current).bounds.width, height: savedOf(current).bounds.height }
      : DEFAULT_BOUNDS;
    open({ id, bounds, maximized: false }, moved || !newTab ? null : "new-tab", at);
    if (!isPrivate) save();
    await sync();
    return id;
  }

  /** Opens a closed window again, with its tabs (the one closed last, if none is named). */
  async function reopen(id?: string) {
    if (quitting) return false;
    const target = id ? closed.find((w) => w.id === id) : closed[0];
    const fromSession = !target && lastSession && (!id || lastSession.id === id) ? lastSession : null;
    const saved = target ?? fromSession;
    if (!saved) return false;
    closed = closed.filter((w) => w !== saved);
    if (fromSession) lastSession = null;
    open(saved, null);
    save();
    await sync();
    return true;
  }

  // --- IPC ---------------------------------------------------------------------------------------

  const windows: AppWindows = {
    all: () => [...live.values()].map((w) => w.win).filter((w) => !w.isDestroyed()),
    of(contents) {
      if (!contents || contents.isDestroyed()) return undefined;
      const host = contents.getType() === "webview" ? contents.hostWebContents : contents;
      const win = host ? BrowserWindow.fromWebContents(host) : null;
      return win && live.has(win.id) ? win : undefined;
    },
    current(kind) {
      const focused = entryOf(BrowserWindow.getFocusedWindow() ?? undefined);
      const fits = (w: Live | undefined) =>
        !!w && !w.win.isDestroyed() && (!kind || (kind === "private") === w.private);
      if (fits(focused)) return focused!.win;
      for (const id of [...focusOrder].reverse()) {
        const w = byId(id);
        if (fits(w)) return w!.win;
      }
      return undefined;
    },
    isUi: (sender) => [...live.values()].some((w) => !w.win.isDestroyed() && w.win.webContents === sender),
    broadcast(channel, ...args) {
      for (const w of live.values()) if (!w.win.isDestroyed()) w.win.webContents.send(channel, ...args);
    },
    isPrivate: (win) => !!entryOf(win)?.private,
    onFocus: (fn) => void focusListeners.add(fn),
  };

  const senderOf = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    windows.isUi(event.sender) ? entryOf(BrowserWindow.fromWebContents(event.sender) ?? undefined) : undefined;

  ipcMain.handle("rune:window-intent", (event) => {
    const w = senderOf(event);
    if (!w) return null;
    const intent = w.intent;
    w.intent = null;
    return intent;
  });
  ipcMain.handle("rune:window-open", async (event, value: unknown) => {
    const w = senderOf(event);
    if (!w) return null;
    const v = (value ?? {}) as { private?: unknown; tabIds?: unknown; at?: { x?: unknown; y?: unknown } };
    const tabIds = Array.isArray(v.tabIds) ? v.tabIds.filter((t): t is string => typeof t === "string") : [];
    // Tabs keep to their kind of window: a private window's tabs only go to private windows.
    const isPrivate = tabIds.length ? w.private : v.private === true;
    const at =
      typeof v.at?.x === "number" && typeof v.at?.y === "number" && Number.isFinite(v.at.x) && Number.isFinite(v.at.y)
        ? { x: v.at.x, y: v.at.y }
        : undefined;
    return openNew(isPrivate, tabIds, at);
  });
  ipcMain.handle("rune:window-others", (event) => {
    const w = senderOf(event);
    if (!w) return [];
    return [...live.values()]
      .filter((o) => o !== w && o.private === w.private && !o.win.isDestroyed())
      .map((o) => ({ id: o.id, title: o.win.getTitle() }));
  });
  ipcMain.on("rune:window-focus", (event, windowId: unknown) => {
    if (!senderOf(event) || typeof windowId !== "string") return;
    const target = byId(windowId);
    if (!target) return;
    if (target.win.isMinimized()) target.win.restore();
    target.win.focus();
  });
  ipcMain.handle("rune:window-closed", async (event) => {
    if (!senderOf(event)) return [];
    const list = lastSession ? [...closed, lastSession] : closed;
    const tabs = await api<{ windowId: string | null }[]>("/api/apps").catch(() => []);
    return list.map((c) => ({
      id: c.id,
      closedAt: c.closedAt ?? 0,
      tabs: tabs.filter((t) => t.windowId === c.id).length,
    }));
  });
  ipcMain.handle("rune:window-reopen", (event, windowId: unknown) => {
    if (!senderOf(event)) return false;
    return reopen(typeof windowId === "string" && WINDOW_ID_PATTERN.test(windowId) ? windowId : undefined);
  });

  // The window's own buttons (drawn by the renderer when there's no frame) and double-clicking a top bar.
  ipcMain.on("rune:window", (event, action: unknown) => {
    const win = senderOf(event)?.win;
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "close") win.close();
    else if (action === "discard") {
      senderOf(event)!.discarded = true;
      win.close();
    } else if (action === "toggle-fullscreen") win.setFullScreen(!win.isFullScreen());
    else if (action === "quit") app.quit();
    else if (action === "toggle-maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  /** Quitting waits for this: private windows' cleanup (their windows closing could ask to quit again). */
  let cleaning = false;
  app.on("before-quit", (event) => {
    if (cleaning) return event.preventDefault();
    if (quitting) return;
    // Every window open now comes back at the next start.
    save();
    quitting = true;
    if (![...live.values()].some((w) => w.private)) return;
    // Private windows' tabs and session go now, not at the next start (a few seconds at most).
    event.preventDefault();
    cleaning = true;
    const normal = [...live.values()].filter((w) => !w.private).map((w) => w.id);
    // Their pages stop before the session is wiped, so nothing is written to it afterwards.
    for (const w of live.values()) if (w.private && !w.win.isDestroyed()) w.win.destroy();
    const done = Promise.all([sync([], () => normal), clearPrivate()]);
    void Promise.race([done, new Promise((r) => setTimeout(r, 3000))]).finally(() => {
      cleaning = false;
      app.quit();
    });
  });

  return {
    windows,
    /** Opens the windows the startup setting says (after telling the server, so tabs are where they belong). */
    async start(handle: ServerHandle) {
      server = handle;
      const onStartup = await api<{ browser?: { startup?: { mode?: OnStartup } } }>("/api/settings")
        .then((s) => s.browser?.startup?.mode ?? "continue")
        .catch(() => "continue" as const);
      // Whatever a private window left (Rune Browser quit or crashed with one open) goes first.
      await clearPrivate();
      const plan = startupPlan(parseWindowsFile(readJson(file)), onStartup);
      closed = plan.closed;
      await sync(plan.forget, () => plan.open.map((w) => w.id));
      // The first window does what the startup setting says (a new tab, the startup pages).
      plan.open.forEach((saved, i) => open(saved, i === 0 ? "startup" : null));
      save();
    },
    /** macOS's dock icon with no window open: the last one comes back, or a new one. */
    activate() {
      if (live.size) return;
      if (lastSession) void reopen(lastSession.id);
      else void openNew(false);
    },
    /** A normal window for links from other apps when none is open: the last one comes back, or an empty one. */
    showNormal() {
      if ([...live.values()].some((w) => !w.private)) return;
      if (lastSession) void reopen(lastSession.id);
      else void openNew(false, [], undefined, false);
    },
    reopen,
  };
}
