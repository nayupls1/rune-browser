// Chrome extensions in web tabs. They're installed once (registry.ts) and run
// in every workspace's session, each its own copy with its own storage, like
// Chrome profiles. Electron runs them natively (content scripts, storage,
// declarativeNetRequest, scripting, offscreen…); what it lacks comes from the
// shim in their pages and service workers (src/extension-preload/), answered
// by apis.ts. The Rune Browser window shows their toolbar buttons and popups, and
// manages them in Settings → Extensions (import from Chrome, the Chrome Web
// Store, a folder).
import {
  app,
  dialog,
  ipcMain,
  Menu,
  webContents,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  actionOf,
  BUILTIN_EXTENSION_ID,
  extensionIdFromHash,
  extensionIdOf,
  iconPath,
  isExtensionId,
  localize,
  networkRulesToDnr,
  optionalPermissionsOf,
  permissionsOf,
  parseShortcut,
  shortcutMatches,
  webStoreId,
  type ExtensionAction,
  type ExtensionTabRequest,
  type ExtensionTabs,
  type ImportRequest,
  type InstallResult,
  type Shortcut,
} from "../../shared/extensions";
import type { NetworkRule } from "../../shared/api";
import { createApis } from "./apis";
import { builtinExtensionDir } from "./builtin";
import { detectBrowsers, importExtensions, platform, storageFolders } from "./browsers";
import { Contexts, dispatch, ExtensionState, STATE_FOLDER, stateFile, workerStatus, type ActionState } from "./host";
import { hasHostsFor } from "./native";
import {
  commandsOf as registryCommandsOf,
  describe,
  extensionsDir,
  forgetIcons,
  idForPath,
  imageDataUrl,
  readManifest,
  Registry,
  type InstalledExtension,
} from "./registry";
import { checkUpdates, downloadFromWebStore, downloadUpdate, WEB_STORE_UPDATE_URL } from "./webstore";

export interface ExtensionsOptions {
  getWindow: () => BrowserWindow | undefined;
  /** The session of a workspace's web tabs (set up on first use). */
  webSession: (workspaceId: string) => Session;
  workspaceOf: (s: Session) => string | undefined;
  /** Holds back a tab's navigation to an insecure page and hands it to the tab; true if it did. */
  holdInsecure: (contents: WebContents, url: string) => boolean;
}

const UPDATE_INTERVAL = 5 * 60 * 60 * 1000;

/** Chromium's ID for an extension folder: from its key, or else from the path. */
function idForDir(dir: string, key: unknown) {
  if (typeof key !== "string" || !key) return idForPath(dir);
  return extensionIdFromHash(createHash("sha256").update(Buffer.from(key, "base64")).digest("hex"));
}

export function setupExtensions(options: ExtensionsOptions) {
  const { getWindow } = options;
  const registry = new Registry();
  const contexts = new Contexts();
  const states = new Map<string, ExtensionState>();
  const errors = new Map<string, string>();
  const attached = new Map<Session, Promise<void>>();
  const hooked = new WeakSet<Session>();
  const startedThisRun = new Set<string>();
  const grants = new Map<string, Set<number>>();
  const loading = new Map<string, Promise<void>>();
  let tabs: ExtensionTabs = { workspaces: {}, current: null, showing: null };
  let networkRules: NetworkRule[] = [];
  const preload = join(app.getAppPath(), "dist", "electron", "extension-preload.cjs");

  const send = (channel: string, ...args: unknown[]) => getWindow()?.webContents.send(channel, ...args);
  const stateKey = (s: Session, id: string) => `${options.workspaceOf(s) ?? "?"}|${id}`;
  const state = (s: Session, id: string) => states.get(stateKey(s, id));
  const sessions = () => [...attached.keys()];
  const loaded = (s: Session, id: string) => !!s.extensions.getExtension(id);

  // --- Telling the Rune Browser window ------------------------------------------------------------------

  let changedTimer: ReturnType<typeof setTimeout> | null = null;
  const listChanged = () => {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      send("rune:extensions-changed");
    }, 50);
  };
  const actionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const actionsChanged = (s: Session) => {
    const workspaceId = options.workspaceOf(s);
    if (!workspaceId || actionTimers.has(workspaceId)) return;
    actionTimers.set(
      workspaceId,
      setTimeout(() => {
        actionTimers.delete(workspaceId);
        send("rune:extensions-actions-changed", workspaceId);
      }, 50),
    );
  };

  const pending = new Map<string, (value: any) => void>();
  function ask<T>(channel: string, request: Record<string, unknown>, fallback: T, ms: number): Promise<T> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) resolve(fallback);
      }, ms);
      pending.set(requestId, (value: T) => {
        clearTimeout(timer);
        resolve(value);
      });
      if (!getWindow()) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(fallback);
        return;
      }
      send(channel, { ...request, requestId });
    });
  }

  // --- Tabs -------------------------------------------------------------------------------------------------

  const tabsOf = (workspaceId: string) => tabs.workspaces[workspaceId]?.tabs ?? [];
  const activeOf = (workspaceId: string) => tabs.workspaces[workspaceId]?.active ?? null;
  const grantKey = (s: Session, id: string) => stateKey(s, id);
  const grantActiveTab = (s: Session, id: string, tabId: number | null) => {
    if (tabId === null) return;
    const set = grants.get(grantKey(s, id)) ?? new Set<number>();
    set.add(tabId);
    grants.set(grantKey(s, id), set);
  };

  const apis = createApis({
    contexts,
    registry,
    state,
    workspaceOf: options.workspaceOf,
    holdInsecure: options.holdInsecure,
    sessions,
    window: getWindow,
    tabs: tabsOf,
    active: activeOf,
    hasActiveTab: (s, id, tabId) =>
      !registry.get(id)?.denied?.includes("activeTab") && (grants.get(grantKey(s, id))?.has(tabId) ?? false),
    grantActiveTab,
    requestTab: (request: DistributiveOmit<ExtensionTabRequest, "requestId">) =>
      ask<number | null>("rune:extensions-tab", request, null, 15_000),
    requestPermission: (s, id, permissions, origins) => {
      let name = id;
      try {
        name = readManifest(s.extensions.getExtension(id)!.path).name;
      } catch {
        // the ID then
      }
      return ask<boolean>(
        "rune:extensions-permission",
        { extensionId: id, name, permissions, origins },
        false,
        5 * 60_000,
      );
    },
    openPopup: (s, id, url) => openPopup(s, id, url),
    actionsChanged,
    commandsOf,
    // Electron's own user agent, without Rune Browser's name.
    rules: (s) =>
      networkRulesToDnr(
        networkRules,
        options.workspaceOf(s) ?? "",
        app.userAgentFallback.replace(/ RuneBrowser\/\S+/gi, ""),
      ),
    whenLoaded: (s, id) => loading.get(stateKey(s, id)) ?? Promise.resolve(),
    reload: (s, id) => {
      const entry = registry.get(id);
      if (!entry) return;
      void unloadFrom(s, id);
      void loadInto(s, entry);
    },
  });

  type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

  ipcMain.on("rune:extensions-tabs", (event, value: ExtensionTabs) => {
    if (event.sender !== getWindow()?.webContents || !value || typeof value !== "object") return;
    const before = tabs;
    tabs = value;
    for (const s of sessions()) {
      const workspaceId = options.workspaceOf(s);
      if (!workspaceId) continue;
      const a = before.workspaces[workspaceId] ?? { tabs: [], active: null };
      const b = value.workspaces[workspaceId] ?? { tabs: [], active: null };
      if (a.tabs.join() !== b.tabs.join() || a.active !== b.active) {
        apis.tabsChanged(s, a, b);
        actionsChanged(s);
      }
    }
  });
  ipcMain.on("rune:extensions-reply", (event, requestId: unknown, value: unknown) => {
    if (event.sender !== getWindow()?.webContents || typeof requestId !== "string") return;
    const resolve = pending.get(requestId);
    pending.delete(requestId);
    resolve?.(value);
  });

  // --- Contexts: extension pages and service workers ---------------------------------------------------

  ipcMain.handle("crx:call", (event, method: unknown, args: unknown) => {
    const frame = event.senderFrame;
    const id = extensionIdOf(frame?.url);
    const s = event.sender.session;
    if (!frame || !id || !attached.has(s) || !loaded(s, id) || typeof method !== "string")
      return { error: "Not an extension" };
    const key = `f:${frame.processId}:${frame.routingId}`;
    const contents = event.sender;
    const ctx =
      (method !== "hello" && contexts.get(key)) ||
      contexts.add({
        key,
        extensionId: id,
        session: s,
        events: new Set(),
        frame,
        contents,
        worker: null,
        send: (name, a) => {
          if (!frame.isDestroyed() && !frame.detached) frame.send("crx:event", name, a);
        },
        alive: () =>
          !frame.isDestroyed() && !frame.detached && !contents.isDestroyed() && extensionIdOf(frame.url) === id,
      });
    return apis.handle(ctx, method, Array.isArray(args) ? args : []);
  });

  function hookWorkers(s: Session) {
    const hooked = new WeakSet<Electron.ServiceWorkerMain>();
    // Extension workers only.
    const byVersion = new Map<number, Electron.ServiceWorkerMain>();
    // Websites' own workers: looked at once (for their scope), then never touched again.
    const ignored = new Set<number>();
    s.serviceWorkers.on("running-status-changed", (details) => {
      // A worker that's gone by now (they come and go quickly) is no reason to take the app down.
      try {
        onStatus(details);
      } catch (err) {
        console.warn("Following an extension's service worker failed:", err);
      }
    });
    function onStatus({ versionId, runningStatus }: { versionId: number; runningStatus: string }) {
      const key = `w:${stateKey(s, "")}:${versionId}`;
      const known = byVersion.get(versionId);
      if (known) workerStatus(known, runningStatus);
      if (runningStatus === "stopped") {
        byVersion.delete(versionId);
        ignored.delete(versionId);
        return contexts.remove(key);
      }
      if (known || ignored.has(versionId)) return;
      // Getting a worker's ServiceWorkerMain while Chromium stops or replaces it can crash the whole
      // app (an access violation on Windows): a website's worker does that when the page clears its
      // caches, updates its worker and navigates. So never while a worker stops, and a website's
      // worker only once. Extension workers are hooked as they start: their preload calls crx:call
      // right away, and it has no timers to try again with.
      if (runningStatus !== "starting" && runningStatus !== "running") return;
      const worker = s.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker) return;
      if (!extensionIdOf(worker.scope)) return void ignored.add(versionId);
      byVersion.set(versionId, worker);
      workerStatus(worker, runningStatus);
      const id = extensionIdOf(worker?.scope);
      if (!worker || !id || hooked.has(worker)) return;
      hooked.add(worker);
      worker.ipc.handle("crx:call", (_event, method: unknown, args: unknown) => {
        if (!loaded(s, id) || typeof method !== "string") return { error: "Not an extension" };
        const ctx =
          (method !== "hello" && contexts.get(key)) ||
          contexts.add({
            key,
            extensionId: id,
            session: s,
            events: new Set(),
            frame: null,
            contents: null,
            worker,
            send: (name, a) => {
              if (!worker.isDestroyed()) worker.send("crx:event", name, a);
            },
            alive: () => !worker.isDestroyed(),
          });
        return apis.handle(ctx, method, Array.isArray(args) ? args : []);
      });
    }
  }

  // --- Loading ---------------------------------------------------------------------------------------

  function initialAction(entry: InstalledExtension): ActionState {
    let name = entry.id;
    let m: ReturnType<typeof readManifest>["manifest"] = {};
    let messages = null;
    try {
      const info = readManifest(entry.path);
      ({ name, messages } = info);
      m = info.manifest;
    } catch {
      // shown as broken
    }
    const a = actionOf(m);
    return {
      title: localize(a?.default_title, messages) || name,
      icon: imageDataUrl(entry.path, iconPath(a?.default_icon, 32) ?? iconPath(m.icons, 32)),
      badge: "",
      badgeColor: [0, 0, 0, 0],
      badgeTextColor: null,
      popup: a?.default_popup ? `chrome-extension://${entry.id}/${a.default_popup.replace(/^\/+/, "")}` : "",
      enabled: true,
    };
  }

  /** Puts imported chrome.storage data into a session before the extension's first start there. */
  function seed(s: Session, entry: InstalledExtension, st: ExtensionState) {
    if (!entry.seed || st.stored.seeded || !s.storagePath) return;
    for (const folder of storageFolders(entry.id)) {
      const from = join(entry.seed, folder);
      const to = join(s.storagePath, folder);
      if (!existsSync(from) || existsSync(to)) continue;
      try {
        cpSync(from, to, { recursive: true });
      } catch (err) {
        console.warn("Couldn't copy an extension's settings:", err);
      }
    }
    st.stored.seeded = true;
  }

  // Loading and unloading an extension in a session happen one after the other:
  // Electron mustn't load an extension that's still loading or being removed
  // (importing or updating while the workspace starts, toggling it quickly…).
  const queues = new Map<string, Promise<void>>();
  function queued(key: string, fn: () => Promise<void> | void) {
    const next = (queues.get(key) ?? Promise.resolve())
      .then(fn)
      .catch((err) => console.error("Loading an extension failed:", err));
    queues.set(key, next);
    void next.then(() => queues.get(key) === next && queues.delete(key));
    return next;
  }

  function loadInto(s: Session, entry: InstalledExtension) {
    return queued(stateKey(s, entry.id), () => load(s, entry));
  }

  async function load(s: Session, entry: InstalledExtension) {
    if (!entry.enabled || loaded(s, entry.id)) return;
    const key = stateKey(s, entry.id);
    let st = states.get(key);
    if (!st) {
      st = new ExtensionState(stateFile(s, entry.id), initialAction(entry));
      states.set(key, st);
    } else {
      st.action = initialAction(entry);
      st.tabActions.clear();
    }
    const firstSeed = !!entry.seed && !st.stored.seeded;
    seed(s, entry, st);
    let version = "";
    try {
      version = readManifest(entry.path).version;
    } catch {
      // the load fails below
    }
    // runtime.onInstalled / onStartup, which Electron doesn't send.
    const previous = st.stored.version;
    if (!previous)
      st.lifecycle = {
        event: "runtime.onInstalled",
        details: firstSeed ? { reason: "update", previousVersion: version } : { reason: "install" },
      };
    else if (previous !== version)
      st.lifecycle = { event: "runtime.onInstalled", details: { reason: "update", previousVersion: previous } };
    else st.lifecycle = startedThisRun.has(key) ? null : { event: "runtime.onStartup", details: null };
    st.resetRulesets = st.lifecycle?.event === "runtime.onInstalled";
    startedThisRun.add(key);
    const load = s.extensions.loadExtension(entry.path, { allowFileAccess: false });
    loading.set(
      key,
      load.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      const ext = await load;
      if (ext.id !== entry.id) {
        s.extensions.removeExtension(ext.id);
        throw new Error(`It loaded with a different ID (${ext.id})`);
      }
      st.stored.version = version;
      st.save();
      errors.delete(entry.id);
    } catch (err) {
      errors.set(entry.id, err instanceof Error ? err.message : String(err));
      st.lifecycle = null;
    }
    listChanged();
    actionsChanged(s);
  }

  async function loadBuiltin(s: Session) {
    if (loaded(s, BUILTIN_EXTENSION_ID)) return;
    try {
      await s.extensions.loadExtension(builtinExtensionDir(), { allowFileAccess: false });
    } catch (err) {
      console.error("Couldn't load Rune Browser's network rules:", err);
    }
  }

  function unloadFrom(s: Session, id: string) {
    return queued(stateKey(s, id), () => {
      if (loaded(s, id)) s.extensions.removeExtension(id);
      contexts.removeWhere((c) => c.session === s && c.extensionId === id);
      const st = state(s, id);
      if (st) st.tabActions.clear();
      actionsChanged(s);
    });
  }

  /** Runs extensions in a web tab session (once). Resolves when they're loaded. */
  function attach(s: Session) {
    const existing = attached.get(s);
    if (existing) return existing;
    if (!hooked.has(s)) {
      hooked.add(s);
      s.registerPreloadScript({ id: "rune-extensions-worker", type: "service-worker", filePath: preload });
      s.registerPreloadScript({ id: "rune-extensions-frame", type: "frame", filePath: preload });
      hookWorkers(s);
      apis.watchCookies(s);
    }
    const ready = Promise.all([loadBuiltin(s), ...registry.list().map((e) => loadInto(s, e))]).then(() => {
      pushRules(s);
    });
    attached.set(s, ready);
    return ready;
  }

  /** A deleted workspace: its extensions stop before its data is cleared. */
  async function detach(s: Session) {
    const ready = attached.get(s);
    if (!ready) return;
    attached.delete(s);
    await ready.catch(() => {});
    await Promise.all(s.extensions.getAllExtensions().map((e) => unloadFrom(s, e.id)));
    const prefix = stateKey(s, "");
    for (const key of [...states.keys()]) if (key.startsWith(prefix)) states.delete(key);
  }

  /** Waits (a little) for a workspace's extensions, so pages don't load before their content scripts. */
  async function prepare(workspaceId: string) {
    const s = options.webSession(workspaceId);
    await Promise.race([attach(s), new Promise((r) => setTimeout(r, 5000))]);
  }

  // --- Network rules -----------------------------------------------------------------------------------

  async function pushRules(s: Session, attempt = 0): Promise<void> {
    if (!loaded(s, BUILTIN_EXTENSION_ID)) return;
    const live = contexts.of(s, BUILTIN_EXTENSION_ID).filter((c) => c.worker);
    if (live.length) return live.forEach((c) => c.send("rules.changed", []));
    // A started worker reads the rules itself. Right after loading, it may not be registered yet (it then starts on its own).
    try {
      await s.serviceWorkers.startWorkerForScope(`chrome-extension://${BUILTIN_EXTENSION_ID}/`);
    } catch (err) {
      if (attempt < 3) setTimeout(() => void pushRules(s, attempt + 1), 1000);
      else console.warn("Couldn't apply the network rules:", err);
    }
  }

  function setNetworkRules(rules: NetworkRule[]) {
    const before = JSON.stringify(networkRules);
    networkRules = rules;
    if (JSON.stringify(rules) === before) return;
    for (const s of sessions()) void attached.get(s)!.then(() => pushRules(s));
  }

  // --- Toolbar buttons and popups ---------------------------------------------------------------------

  const cssColor = (c: [number, number, number, number] | null) =>
    c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(3)})` : null;

  /** What its toolbar button opens: its popup, or its side panel when it asked for that. */
  function popupOf(s: Session, id: string, a: ActionState) {
    if (a.popup) return a.popup;
    return state(s, id)?.stored.sidePanel?.openOnAction ? (apis.sidePanelUrl(s, id) ?? "") : "";
  }

  function actionsFor(workspaceId: string, tabId: number | null): ExtensionAction[] {
    const s = options.webSession(workspaceId);
    const out: ExtensionAction[] = [];
    for (const entry of registry.list()) {
      if (!entry.enabled || !loaded(s, entry.id)) continue;
      let m;
      try {
        m = readManifest(entry.path).manifest;
      } catch {
        continue;
      }
      if (!actionOf(m)) continue;
      const a = state(s, entry.id)?.actionFor(tabId) ?? initialAction(entry);
      out.push({
        extensionId: entry.id,
        title: a.title,
        icon: a.icon,
        badge: a.badge,
        badgeColor: a.badgeColor[3] === 0 ? "" : cssColor(a.badgeColor)!,
        badgeTextColor: cssColor(a.badgeTextColor),
        popup: popupOf(s, entry.id, a) || null,
        enabled: a.enabled,
      });
    }
    return out;
  }

  function openPopup(s: Session, id: string, url?: string) {
    const workspaceId = options.workspaceOf(s);
    if (!workspaceId) return false;
    const a = state(s, id)?.actionFor(activeOf(workspaceId));
    const popup = url ?? (a ? popupOf(s, id, a) : "");
    if (!popup) return false;
    send("rune:extensions-popup", { workspaceId, extensionId: id, url: popup });
    return true;
  }

  const activeTabObject = (s: Session, id: string) => {
    const workspaceId = options.workspaceOf(s);
    const tabId = workspaceId ? activeOf(workspaceId) : null;
    const contents = tabId === null ? undefined : webContents.fromId(tabId);
    return contents && !contents.isDestroyed() ? apis.tabObject(s, id, contents) : undefined;
  };

  /** The toolbar button was clicked: its popup's URL, or the click goes to the extension. */
  function clickAction(workspaceId: string, id: string): string | null {
    const s = options.webSession(workspaceId);
    if (!loaded(s, id)) return null;
    const tabId = activeOf(workspaceId);
    grantActiveTab(s, id, tabId);
    const a = state(s, id)?.actionFor(tabId);
    if (!a?.enabled) return null;
    const popup = popupOf(s, id, a);
    if (popup) return popup;
    void dispatch(contexts, state(s, id), s, id, "action.onClicked", [activeTabObject(s, id)]);
    return null;
  }

  // --- Keyboard shortcuts --------------------------------------------------------------------------------

  function commandsOf(id: string) {
    const entry = registry.get(id);
    if (!entry) return [];
    try {
      return registryCommandsOf(entry, readManifest(entry.path));
    } catch {
      return [];
    }
  }

  let bindings: { id: string; name: string; shortcut: Shortcut }[] = [];
  const rebind = () => {
    bindings = registry
      .list()
      .filter((e) => e.enabled)
      .flatMap((e) =>
        commandsOf(e.id).flatMap((c) => {
          const shortcut = c.shortcut ? parseShortcut(c.shortcut, platform) : null;
          return shortcut ? [{ id: e.id, name: c.name, shortcut }] : [];
        }),
      );
  };
  rebind();

  function runCommand(s: Session, id: string, name: string) {
    const workspaceId = options.workspaceOf(s);
    if (!workspaceId) return;
    grantActiveTab(s, id, activeOf(workspaceId));
    if (name === "_execute_action" || name === "_execute_browser_action" || name === "_execute_page_action") {
      if (!openPopup(s, id)) void dispatch(contexts, state(s, id), s, id, "action.onClicked", [activeTabObject(s, id)]);
      return;
    }
    void dispatch(contexts, state(s, id), s, id, "commands.onCommand", [name, activeTabObject(s, id)]);
  }

  /** An extension's shortcut pressed in a web tab of this session (or the Rune Browser window): runs it. */
  function handleInput(s: Session | null, input: Input) {
    if (input.type !== "keyDown" || !bindings.length) return false;
    const target = s ?? (tabs.current ? options.webSession(tabs.current) : null);
    if (!target || !attached.has(target)) return false;
    const key = { control: input.control, alt: input.alt, shift: input.shift, meta: input.meta, code: input.code };
    const hit = bindings.find((b) => shortcutMatches(b.shortcut, key) && loaded(target, b.id));
    if (!hit) return false;
    runCommand(target, hit.id, hit.name);
    return true;
  }

  // --- Web tabs -------------------------------------------------------------------------------------------

  function trackGuest(contents: WebContents) {
    apis.trackGuest(contents);
    const s = contents.session;
    // activeTab lasts until the tab goes to another page.
    contents.on("did-navigate", () => {
      for (const [key, set] of grants) if (key.startsWith(`${options.workspaceOf(s)}|`)) set.delete(contents.id);
    });
    contents.once("destroyed", () => {
      for (const set of grants.values()) set.delete(contents.id);
    });
  }

  /** A page of an extension running in this session (not Rune Browser's own). */
  const isExtensionPage = (s: Session, url: string) => {
    const id = extensionIdOf(url);
    return !!id && id !== BUILTIN_EXTENSION_ID && attached.has(s) && loaded(s, id);
  };

  /** Websites get the harmless permissions only; extension pages also what their manifest asks for. */
  function allowsPermission(s: Session, permission: string, url: string | undefined) {
    const id = extensionIdOf(url);
    if (!id || !loaded(s, id)) return false;
    const asks = (p: string) => apis.hasPermission(s, id, p);
    if (permission === "clipboard-read") return asks("clipboardRead");
    if (permission === "notifications") return asks("notifications");
    if (permission === "persistent-storage") return asks("unlimitedStorage");
    return false;
  }

  function menuItems(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
    if (!attached.has(contents.session)) return [];
    return apis.menuItems(contents.session, contents, params);
  }

  // --- Installing ----------------------------------------------------------------------------------------

  function afterInstall(entries: InstalledExtension[]) {
    rebind();
    for (const s of sessions()) {
      for (const entry of entries) {
        unloadFrom(s, entry.id);
        void loadInto(s, entry);
      }
    }
    listChanged();
  }

  async function installFromStore(input: string): Promise<InstallResult> {
    const id = webStoreId(input);
    if (!id)
      return {
        installed: [],
        failed: [{ id: input, name: input, error: "That isn't a Chrome Web Store link or extension ID" }],
      };
    try {
      const previous = registry.get(id);
      const { dir } = await downloadFromWebStore(id);
      const info = readManifest(dir);
      if (previous?.managed && previous.path !== dir) rmSync(previous.path, { recursive: true, force: true });
      const entry: InstalledExtension = {
        id,
        path: dir,
        managed: true,
        enabled: true,
        pinned: previous?.pinned ?? !!actionOf(info.manifest),
        source: previous?.source.kind === "browser" ? previous.source : { kind: "webstore" },
        installedAt: previous?.installedAt ?? Date.now(),
        ...(previous?.commands ? { commands: previous.commands } : {}),
        ...(previous?.granted ? { granted: previous.granted } : {}),
      };
      registry.put(entry);
      afterInstall([entry]);
      return { installed: [{ id, name: info.name }], failed: [] };
    } catch (err) {
      return { installed: [], failed: [{ id, name: id, error: err instanceof Error ? err.message : String(err) }] };
    }
  }

  async function loadUnpacked(): Promise<InstallResult | null> {
    const win = getWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, { title: "Load an unpacked extension", properties: ["openDirectory"] })
      : null;
    const dir = picked?.filePaths[0];
    if (!dir || picked?.canceled) return null;
    let info;
    try {
      info = readManifest(dir);
    } catch {
      return { installed: [], failed: [{ id: "", name: dir, error: "There's no manifest.json in that folder" }] };
    }
    if (info.manifest.theme || info.manifest.app)
      return { installed: [], failed: [{ id: "", name: info.name, error: "Themes and apps aren't supported" }] };
    const id = idForDir(dir, info.manifest.key);
    const previous = registry.get(id);
    const entry: InstalledExtension = {
      id,
      path: dir,
      managed: false,
      enabled: true,
      pinned: previous?.pinned ?? !!actionOf(info.manifest),
      source: { kind: "unpacked" },
      installedAt: Date.now(),
    };
    registry.put(entry);
    afterInstall([entry]);
    return { installed: [{ id, name: info.name }], failed: [] };
  }

  function importFrom(request: ImportRequest): InstallResult {
    const ids = request.ids.filter(isExtensionId);
    const { installed, failed } = importExtensions(registry, request.profileKey, ids, request.settings === true);
    afterInstall(installed.map((i) => i.entry));
    return { installed: installed.map((i) => ({ id: i.entry.id, name: i.name })), failed };
  }

  /** Every web tab session's folder, attached or not (to clear an uninstalled extension's data). */
  function sessionFolders() {
    const dirs = new Set<string>();
    for (const s of sessions()) if (s.storagePath) dirs.add(s.storagePath);
    const partitions = join(app.getPath("userData"), "Partitions");
    try {
      for (const name of readdirSync(partitions)) if (/^web(-|$)/.test(name)) dirs.add(join(partitions, name));
    } catch {
      // none yet
    }
    return [...dirs];
  }

  async function remove(id: string) {
    await Promise.all(sessions().map((s) => unloadFrom(s, id)));
    registry.remove(id);
    for (const dir of sessionFolders()) {
      for (const folder of storageFolders(id)) rmSync(join(dir, folder), { recursive: true, force: true });
      rmSync(join(dir, STATE_FOLDER, `${id}.json`), { force: true });
    }
    for (const key of [...states.keys()]) if (key.endsWith(`|${id}`)) states.delete(key);
    rmSync(join(extensionsDir(), "sync", `${id}.json`), { force: true });
    apis.forgetSync(id);
    errors.delete(id);
    rebind();
    listChanged();
  }

  /** Allows or blocks one of its permissions: optional ones are granted or taken back, required ones blocked or unblocked. */
  function setPermission(id: string, permission: string, allowed: boolean) {
    const entry = registry.get(id);
    if (!entry) return;
    let manifest;
    try {
      manifest = readManifest(entry.path).manifest;
    } catch {
      return;
    }
    const required = permissionsOf(manifest).includes(permission);
    if (!required && !optionalPermissionsOf(manifest).includes(permission)) return;
    const denied = new Set(entry.denied ?? []);
    if (allowed) denied.delete(permission);
    else denied.add(permission);
    const granted = entry.granted ?? { permissions: [], origins: [] };
    const grantedNow = required
      ? granted.permissions
      : allowed
        ? [...new Set([...granted.permissions, permission])]
        : granted.permissions.filter((p) => p !== permission);
    registry.update(id, { denied: [...denied], granted: { ...granted, permissions: grantedNow } });
    // It starts over with what it may use now (its pages and worker learn it as they start).
    for (const s of sessions()) {
      void unloadFrom(s, id);
      void loadInto(s, entry);
    }
    listChanged();
  }

  function setEnabled(id: string, enabled: boolean) {
    const entry = registry.update(id, { enabled });
    if (!entry) return;
    for (const s of sessions()) {
      if (enabled) void loadInto(s, entry);
      else unloadFrom(s, id);
    }
    rebind();
    listChanged();
  }

  // --- Updates ----------------------------------------------------------------------------------------------

  let updating: Promise<number> | null = null;
  function updateAll(): Promise<number> {
    updating ??= (async () => {
      let count = 0;
      const byServer = new Map<string, { id: string; version: string }[]>();
      for (const entry of registry.list()) {
        if (!entry.managed || !entry.enabled) continue;
        try {
          const info = readManifest(entry.path);
          const url = typeof info.manifest.update_url === "string" ? info.manifest.update_url : null;
          if (!url) continue;
          // The store's old addresses all mean the store.
          const server = /clients2\.google\.com|chrome\.google\.com/.test(url) ? WEB_STORE_UPDATE_URL : url;
          byServer.set(server, [...(byServer.get(server) ?? []), { id: entry.id, version: info.version }]);
        } catch {
          // a broken one doesn't update
        }
      }
      for (const [server, list] of byServer) {
        let updates;
        try {
          updates = await checkUpdates(server, list);
        } catch (err) {
          console.warn("Extension update check failed:", err);
          continue;
        }
        for (const update of updates) {
          try {
            const old = registry.get(update.id);
            if (!old) continue;
            const { dir } = await downloadUpdate(update);
            const entry = registry.update(update.id, { path: dir })!;
            forgetIcons(old.path);
            afterInstall([entry]);
            if (old.path !== dir) setTimeout(() => rmSync(old.path, { recursive: true, force: true }), 10_000);
            count++;
          } catch (err) {
            console.warn(`Couldn't update the extension ${update.id}:`, err);
          }
        }
      }
      return count;
    })().finally(() => {
      updating = null;
    });
    return updating;
  }

  if (process.env.RUNE_EXTENSION_UPDATES !== "0") {
    setTimeout(() => registry.autoUpdate && void updateAll(), 60_000).unref?.();
    setInterval(() => registry.autoUpdate && void updateAll(), UPDATE_INTERVAL).unref?.();
  }

  // --- IPC from the Rune Browser window ---------------------------------------------------------------------------

  const fromWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
    event.sender === getWindow()?.webContents;
  const validWorkspace = (w: unknown): w is string => typeof w === "string" && /^[\w-]+$/.test(w);
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromWindow(event)) throw new Error("Not allowed");
      return fn(...args);
    });

  handle("rune:extensions-list", () => {
    const list = registry.list().map((e) => describe(e, errors.get(e.id) ?? null, hasHostsFor(e.id)));
    return { extensions: list, autoUpdate: registry.autoUpdate };
  });
  handle("rune:extensions-prepare", (workspaceId: unknown) =>
    validWorkspace(workspaceId) ? prepare(workspaceId) : undefined,
  );
  handle("rune:extensions-actions", (workspaceId: unknown, tabId: unknown) =>
    validWorkspace(workspaceId) ? actionsFor(workspaceId, typeof tabId === "number" ? tabId : null) : [],
  );
  handle("rune:extensions-click", (workspaceId: unknown, id: unknown) =>
    validWorkspace(workspaceId) && isExtensionId(id) ? clickAction(workspaceId, id) : null,
  );
  handle("rune:extensions-detect", () => detectBrowsers(registry));
  handle("rune:extensions-import", (request: ImportRequest) => importFrom(request));
  handle("rune:extensions-install", (input: unknown) => installFromStore(String(input ?? "")));
  handle("rune:extensions-load-unpacked", () => loadUnpacked());
  handle(
    "rune:extensions-set-enabled",
    (id: unknown, enabled: unknown) => isExtensionId(id) && setEnabled(id, enabled === true),
  );
  handle("rune:extensions-set-pinned", (id: unknown, pinned: unknown) => {
    if (!isExtensionId(id) || !registry.update(id, { pinned: pinned === true })) return;
    listChanged();
    for (const s of sessions())
      void dispatch(contexts, state(s, id), s, id, "action.onUserSettingsChanged", [{ isOnToolbar: pinned === true }]);
  });
  handle("rune:extensions-remove", (id: unknown) => (isExtensionId(id) ? remove(id) : undefined));
  handle("rune:extensions-set-permission", (id: unknown, permission: unknown, allowed: unknown) => {
    if (isExtensionId(id) && typeof permission === "string") setPermission(id, permission, allowed === true);
  });
  handle("rune:extensions-set-auto-update", (value: unknown) => {
    registry.autoUpdate = value === true;
    listChanged();
  });
  handle("rune:extensions-update", () => updateAll());
  handle("rune:extensions-action-menu", (workspaceId: unknown, id: unknown) => {
    if (!validWorkspace(workspaceId) || !isExtensionId(id)) return;
    const s = options.webSession(workspaceId);
    const entry = registry.get(id);
    if (!entry) return;
    const info = describe(entry, null, false);
    const tabId = activeOf(workspaceId);
    const contents = tabId === null ? null : (webContents.fromId(tabId) ?? null);
    const own = attached.has(s) ? apis.menuItems(s, contents, { pageURL: contents?.getURL() ?? "" }, id) : [];
    const items: MenuItemConstructorOptions[] = [
      { label: info.name.replace(/&/g, "&&"), enabled: false },
      { type: "separator" },
      ...(own.length ? [...own, { type: "separator" as const }] : []),
      {
        label: entry.pinned ? "Unpin" : "Pin to toolbar",
        click: () => registry.update(id, { pinned: !entry.pinned }) && listChanged(),
      },
      ...(info.optionsUrl
        ? [
            {
              label: "Options",
              click: () =>
                void ask(
                  "rune:extensions-tab",
                  { action: "open", workspaceId, url: info.optionsUrl!, active: true },
                  null,
                  15_000,
                ),
            },
          ]
        : []),
      { label: "Manage extensions", click: () => send("rune:extensions-manage") },
    ];
    Menu.buildFromTemplate(items).popup({ window: getWindow() });
  });

  return {
    attach,
    detach,
    prepare,
    trackGuest,
    isExtensionPage,
    allowsPermission,
    menuItems,
    handleInput,
    setNetworkRules,
    /** A site in a web tab wants a username and password: what an extension (a password manager) answers. */
    authRequired: (contents: WebContents, url: string, info: Parameters<typeof apis.authRequired>[3]) =>
      attached.has(contents.session) ? apis.authRequired(contents.session, contents, url, info) : Promise.resolve(null),
  };
}
