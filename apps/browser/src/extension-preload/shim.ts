// The chrome.* APIs Electron leaves out or only stubs, for extension pages and
// service workers. This function runs in the extension's own world (injected
// by the preload with contextBridge.executeInMainWorld), so it can't use
// anything from outside itself: it gets the bridge to Rune Browser's main process as
// an argument. Calls go to main/extensions/apis.ts; events come back by name.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ShimBridge {
  call: (method: string, args: unknown[]) => Promise<{ value?: unknown; error?: string }>;
  onEvent: (fn: (name: string, args: unknown[]) => void) => void;
}

export interface ShimInfo {
  id: string;
  worker: boolean;
  /** Rune Browser's own network-rules extension. */
  builtin: boolean;
  /** Permissions that only allow something (no namespace of their own to stand in for). */
  withoutApi: string[];
}

export function shim(bridge: ShimBridge, info: ShimInfo) {
  // Runs on its own in the extension's world: only what's defined in here exists.
  const PERMISSIONS_WITHOUT_API = new Set(info.withoutApi);
  const g: any = globalThis;
  const c: any = g.chrome;
  if (!c?.runtime || g.__runeShim) return;
  g.__runeShim = true;

  const call = (method: string, ...args: unknown[]): Promise<any> =>
    bridge.call(method, args).then((r) => {
      if (r && r.error !== undefined) throw new Error(r.error);
      return r ? r.value : undefined;
    });

  /** Runs a callback with chrome.runtime.lastError set, like Chrome does when a call fails. */
  const withLastError = (message: string, fn: () => void) => {
    try {
      Object.defineProperty(c.runtime, "lastError", { value: { message }, configurable: true, enumerable: true });
    } catch {
      // keep going without it
    }
    try {
      fn();
    } finally {
      try {
        delete c.runtime.lastError;
      } catch {
        // ignore
      }
    }
  };

  /** An API function: promise style, or with a callback as the last argument. */
  const api =
    (method: string, prepare?: (args: any[]) => any[] | Promise<any[]>, after?: (value: any) => any) =>
    (...args: any[]) => {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      const p = Promise.resolve(prepare ? prepare(args) : args)
        .then((a) => call(method, ...a))
        .then((v) => (after ? after(v) : v));
      if (!cb) return p;
      p.then(
        (v) => cb(v),
        (e) => withLastError(e?.message ?? String(e), () => cb()),
      );
      return undefined;
    };

  /** An API function that just answers. */
  const resolved =
    <T>(value: T) =>
    (...args: any[]) => {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      if (!cb) return Promise.resolve(value);
      queueMicrotask(() => cb(value));
      return undefined;
    };

  // --- Events ------------------------------------------------------------------------

  const events = new Map<string, Ev>();
  const internal = new Map<string, (args: any[]) => void>();

  class Ev {
    private listeners: { fn: (...args: any[]) => any; filter?: any }[] = [];
    constructor(
      private name: string,
      private matches?: (filter: any, args: any[]) => boolean,
    ) {}
    addListener(fn: (...args: any[]) => any, filter?: any) {
      if (typeof fn !== "function") throw new TypeError("The listener has to be a function");
      if (this.listeners.some((l) => l.fn === fn)) return;
      this.listeners.push({ fn, filter });
      if (this.listeners.length === 1 && this.name) {
        // The answer can carry the event itself (runtime.onInstalled / onStartup).
        void call("listen", this.name).then(
          (r: any) => r?.fire && setTimeout(() => this.dispatch(r.fire), 0),
          () => {},
        );
      }
    }
    removeListener(fn: (...args: any[]) => any) {
      const before = this.listeners.length;
      this.listeners = this.listeners.filter((l) => l.fn !== fn);
      if (before && !this.listeners.length && this.name) void call("unlisten", this.name).catch(() => {});
    }
    hasListener(fn: (...args: any[]) => any) {
      return this.listeners.some((l) => l.fn === fn);
    }
    hasListeners() {
      return this.listeners.length > 0;
    }
    dispatch(args: any[]) {
      for (const l of this.listeners.slice()) {
        if (l.filter && this.matches && !this.matches(l.filter, args)) continue;
        try {
          l.fn(...args);
        } catch (err) {
          console.error(err);
        }
      }
    }
    // Declarative events (not used by these APIs).
    addRules(_rules: unknown, cb?: () => void) {
      cb?.();
    }
    getRules(_ids: unknown, cb?: (rules: unknown[]) => void) {
      (typeof _ids === "function" ? (_ids as any) : cb)?.([]);
    }
    removeRules(_ids: unknown, cb?: () => void) {
      (typeof _ids === "function" ? (_ids as any) : cb)?.();
    }
  }

  const ev = (name: string, matches?: (filter: any, args: any[]) => boolean) => {
    const existing = events.get(name);
    if (existing) return existing;
    const e = new Ev(name, matches);
    events.set(name, e);
    return e;
  };
  /** An event only this context dispatches (ports). */
  const localEv = () => new Ev("");

  bridge.onEvent((name, args) => {
    internal.get(name)?.(args);
    events.get(name)?.dispatch(args);
  });

  // What was changed, to do the same to the `browser` namespace (a separate object in Electron).
  const defined: [any, string, unknown][] = [];
  const define = (target: any, name: string, value: unknown) => {
    defined.push([target, name, value]);
    defineOn(target, name, value);
  };
  const defineOn = (target: any, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: true });
    } catch {
      try {
        target[name] = value;
      } catch {
        // read-only: keep Electron's
      }
    }
  };

  // A namespace of chrome.*. Chromium puts its own back on `chrome` whenever
  // the bindings are updated (another extension loading does that), so one
  // Electron has gets extended (Chromium keeps that object and hands it out
  // again), and only a missing one is added.
  const apiNames = new Map<object, string>();
  const defineApi = (name: string, value: Record<string, unknown>) => {
    let native: any;
    try {
      native = c[name];
    } catch {
      native = undefined;
    }
    if (!native || typeof native !== "object" || native === value) {
      define(c, name, value);
      return value;
    }
    apiNames.set(native, name);
    for (const key of Object.keys(value)) define(native, key, value[key]);
    return native;
  };

  // The permissions the user blocked come with the first answer (Rune Browser's
  // side refuses their calls until then too).
  let denied = new Set<string>();
  void call("hello").then(
    (r: any) => (denied = new Set(Array.isArray(r?.denied) ? r.denied : [])),
    () => {},
  );

  // --- Rune Browser's network rules extension ------------------------------------------------

  if (info.builtin) {
    const dnr = c.declarativeNetRequest;
    let applying = Promise.resolve();
    const apply = () => {
      applying = applying.then(async () => {
        try {
          const rules = (await call("rules.get")) ?? [];
          const existing: { id: number }[] = await dnr.getSessionRules();
          await dnr.updateSessionRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
          await call("rules.applied");
        } catch (err) {
          console.error("Rune Browser's network rules:", err);
        }
      });
    };
    internal.set("rules.changed", apply);
    apply();
    return;
  }

  const manifest: any = c.runtime.getManifest?.() ?? {};

  // --- declarativeNetRequest: the manifest's rulesets ---------------------------------------
  // Electron doesn't turn on the rulesets a manifest enables, so that's done
  // here when the extension is installed or updated, before the extension
  // itself looks at them.
  const dnr = c.declarativeNetRequest;
  const resources: { id: string; enabled?: boolean }[] = manifest.declarative_net_request?.rule_resources ?? [];
  if (dnr?.updateEnabledRulesets && resources.length) {
    const update = dnr.updateEnabledRulesets.bind(dnr);
    const enableDefaults = () =>
      update({
        enableRulesetIds: resources.filter((r) => r.enabled).map((r) => r.id),
        disableRulesetIds: resources.filter((r) => !r.enabled).map((r) => r.id),
      });
    const ready: Promise<unknown> = call("dnr.shouldReset")
      .then((reset) => (reset ? enableDefaults() : undefined))
      .catch((err) => console.error("Enabling the extension's rulesets:", err));
    // Never holds the extension up for long.
    const settled = Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    for (const name of [
      "getEnabledRulesets",
      "updateEnabledRulesets",
      "updateStaticRules",
      "getDisabledRuleIds",
      "getAvailableStaticRuleCount",
    ]) {
      const original = dnr[name];
      if (typeof original !== "function") continue;
      define(dnr, name, (...args: any[]) => {
        const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
        const p = settled.then(() => original.apply(dnr, args));
        if (!cb) return p;
        p.then(
          (v: unknown) => cb(v),
          (e: any) => withLastError(e?.message ?? String(e), () => cb()),
        );
        return undefined;
      });
    }
  }
  const permissions: string[] = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].filter(
    (p: unknown) => typeof p === "string",
  );
  const has = (p: string) => permissions.includes(p);
  const base = `chrome-extension://${info.id}/`;
  const here = () => {
    try {
      return String(g.location?.href ?? base);
    } catch {
      return base;
    }
  };
  const absolute = (path: string) => new URL(path, here()).href;

  // --- chrome.action (and MV2's browserAction / pageAction) ----------------------------------

  const ICON_SIZE = 32;
  const pickSize = (sizes: string[]) => {
    const n = sizes
      .map(Number)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    const best = n.find((x) => x >= ICON_SIZE) ?? n[n.length - 1];
    return best === undefined ? sizes[0] : String(best);
  };

  async function imageDataUrl(image: any): Promise<string> {
    const canvas = new g.OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d").putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(s)}`;
  }

  const isImageData = (x: any) => x && typeof x.width === "number" && typeof x.height === "number" && x.data;

  async function iconOf(details: any): Promise<string | null> {
    if (details.imageData) {
      const img = details.imageData;
      if (isImageData(img)) return imageDataUrl(img);
      const key = pickSize(Object.keys(img));
      return key === undefined ? null : imageDataUrl(img[key]);
    }
    if (details.path) {
      const p = details.path;
      if (typeof p === "string") return absolute(p);
      const key = pickSize(Object.keys(p));
      return key === undefined ? null : absolute(p[key]);
    }
    return null;
  }

  const tabOf = (d: any) => (d && typeof d.tabId === "number" ? d.tabId : null);
  const actionOnClicked = ev("action.onClicked");

  const action = {
    setTitle: api("action.set", ([d]) => [tabOf(d), "title", String(d?.title ?? "")]),
    getTitle: api("action.get", ([d]) => [tabOf(d), "title"]),
    setBadgeText: api("action.set", ([d]) => [tabOf(d), "badge", d?.text == null ? "" : String(d.text)]),
    getBadgeText: api("action.get", ([d]) => [tabOf(d), "badge"]),
    setBadgeBackgroundColor: api("action.set", ([d]) => [tabOf(d), "badgeColor", d?.color]),
    getBadgeBackgroundColor: api("action.get", ([d]) => [tabOf(d), "badgeColor"]),
    setBadgeTextColor: api("action.set", ([d]) => [tabOf(d), "badgeTextColor", d?.color]),
    getBadgeTextColor: api("action.get", ([d]) => [tabOf(d), "badgeTextColor"]),
    setPopup: api("action.set", ([d]) => [tabOf(d), "popup", d?.popup ? absolute(String(d.popup)) : ""]),
    getPopup: api("action.get", ([d]) => [tabOf(d), "popup"]),
    setIcon: api("action.set", async ([d]) => [tabOf(d), "icon", await iconOf(d ?? {})]),
    enable: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", true]),
    disable: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", false]),
    isEnabled: api("action.get", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled"]),
    show: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", true]),
    hide: api("action.set", ([tabId]) => [typeof tabId === "number" ? tabId : null, "enabled", false]),
    getUserSettings: api("action.userSettings"),
    openPopup: api("action.openPopup"),
    onClicked: actionOnClicked,
    onUserSettingsChanged: ev("action.onUserSettingsChanged"),
  };
  if (manifest.action || manifest.manifest_version === 3) defineApi("action", action);
  if (manifest.browser_action) defineApi("browserAction", action);
  if (manifest.page_action) defineApi("pageAction", action);

  // --- chrome.tabs ---------------------------------------------------------------------------

  const nativeTabs: any = c.tabs ?? {};
  const bindNative = (name: string) =>
    typeof nativeTabs[name] === "function" ? nativeTabs[name].bind(nativeTabs) : api(`tabs.${name}`);
  const tabs = {
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
    get: api("tabs.get"),
    getCurrent: api("tabs.getCurrent"),
    query: api("tabs.query", ([q]) => [q ?? {}]),
    create: api("tabs.create", ([p]) => [p ?? {}]),
    update: api("tabs.update", (args) =>
      typeof args[0] === "number" ? [args[0], args[1] ?? {}] : [null, args[0] ?? {}],
    ),
    remove: api("tabs.remove", ([ids]) => [Array.isArray(ids) ? ids : [ids]]),
    reload: api("tabs.reload", (args) =>
      typeof args[0] === "number" ? [args[0], args[1] ?? {}] : [null, args[0] ?? {}],
    ),
    duplicate: api("tabs.duplicate"),
    highlight: api("tabs.highlight", ([i]) => [i ?? {}]),
    move: api("tabs.move", ([ids, props]) => [Array.isArray(ids) ? ids : [ids], props ?? {}]),
    discard: api("tabs.discard", ([id]) => [typeof id === "number" ? id : null]),
    goBack: api("tabs.goBack", ([id]) => [typeof id === "number" ? id : null]),
    goForward: api("tabs.goForward", ([id]) => [typeof id === "number" ? id : null]),
    captureVisibleTab: api("tabs.captureVisibleTab", (args) =>
      typeof args[0] === "number" || args[0] == null ? [args[1] ?? {}] : [args[0] ?? {}],
    ),
    detectLanguage: api("tabs.detectLanguage", ([id]) => [typeof id === "number" ? id : null]),
    group: api("unsupported", () => ["tabs.group"]),
    ungroup: api("unsupported", () => ["tabs.ungroup"]),
    getSelected: api(
      "tabs.query",
      () => [{ active: true, currentWindow: true }],
      (list: any[]) => list[0],
    ),
    getAllInWindow: api("tabs.query", ([windowId]) => [
      typeof windowId === "number" ? { windowId } : { currentWindow: true },
    ]),
    sendMessage: bindNative("sendMessage"),
    connect: bindNative("connect"),
    executeScript: bindNative("executeScript"),
    insertCSS: bindNative("insertCSS"),
    removeCSS: bindNative("removeCSS"),
    setZoom: bindNative("setZoom"),
    getZoom: bindNative("getZoom"),
    setZoomSettings: bindNative("setZoomSettings"),
    getZoomSettings: bindNative("getZoomSettings"),
    onActivated: ev("tabs.onActivated"),
    onActiveChanged: ev("tabs.onActiveChanged"),
    onSelectionChanged: ev("tabs.onSelectionChanged"),
    onHighlighted: ev("tabs.onHighlighted"),
    onHighlightChanged: ev("tabs.onHighlightChanged"),
    onUpdated: ev("tabs.onUpdated"),
    onCreated: ev("tabs.onCreated"),
    onRemoved: ev("tabs.onRemoved"),
    onReplaced: ev("tabs.onReplaced"),
    onMoved: ev("tabs.onMoved"),
    onAttached: ev("tabs.onAttached"),
    onDetached: ev("tabs.onDetached"),
    onZoomChange: nativeTabs.onZoomChange ?? ev("tabs.onZoomChange"),
  };
  defineApi("tabs", tabs);

  // --- chrome.windows ---------------------------------------------------------------------------

  defineApi("windows", {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: api("windows.get", ([id, opts]) => [id, opts ?? {}]),
    getCurrent: api("windows.get", ([opts]) => [-2, opts ?? {}]),
    getLastFocused: api("windows.get", ([opts]) => [-2, opts ?? {}]),
    getAll: api("windows.getAll", ([opts]) => [opts ?? {}]),
    create: api("windows.create", ([data]) => [data ?? {}]),
    update: api("windows.get", ([id]) => [id, {}]),
    remove: resolved(undefined),
    onCreated: ev("windows.onCreated"),
    onRemoved: ev("windows.onRemoved"),
    onFocusChanged: ev("windows.onFocusChanged"),
    onBoundsChanged: ev("windows.onBoundsChanged"),
  });

  // --- chrome.commands ---------------------------------------------------------------------------

  defineApi("commands", {
    getAll: api("commands.getAll"),
    onCommand: ev("commands.onCommand"),
    onChanged: ev("commands.onChanged"),
  });

  // --- chrome.contextMenus / chrome.menus ----------------------------------------------------------

  if (has("contextMenus") || has("menus")) {
    let next = 1;
    const onclicks = new Map<string, (info: any, tab: any) => void>();
    const strip = (props: any) => {
      const { onclick, ...rest } = props ?? {};
      return { rest, onclick: typeof onclick === "function" ? onclick : null };
    };
    const onClicked = ev("contextMenus.onClicked");
    internal.set("contextMenus.onClicked", ([clickInfo, tab]) => {
      const fn = onclicks.get(String(clickInfo?.menuItemId));
      if (fn) {
        try {
          fn(clickInfo, tab);
        } catch (err) {
          console.error(err);
        }
      }
    });
    // A local onclick needs the click delivered here too.
    const watchClicks = () => {
      if (onclicks.size === 1) void call("listen", "contextMenus.onClicked").catch(() => {});
    };
    const menus = {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      create(props: any, cb?: () => void) {
        const { rest, onclick } = strip(props);
        const id = rest.id ?? next++;
        if (onclick) {
          onclicks.set(String(id), onclick);
          watchClicks();
        }
        call("menus.create", { ...rest, id }).then(
          () => cb?.(),
          (e) =>
            cb ? withLastError(e.message, () => cb()) : console.error(`Unchecked runtime.lastError: ${e.message}`),
        );
        return id;
      },
      update: api("menus.update", ([id, props]) => {
        const { rest, onclick } = strip(props);
        if (onclick) {
          onclicks.set(String(id), onclick);
          watchClicks();
        }
        return [id, rest];
      }),
      remove: api("menus.remove", ([id]) => {
        onclicks.delete(String(id));
        return [id];
      }),
      removeAll: api("menus.removeAll", () => {
        onclicks.clear();
        return [];
      }),
      refresh: resolved(undefined),
      onClicked,
      onShown: ev("contextMenus.onShown"),
      onHidden: ev("contextMenus.onHidden"),
    };
    defineApi("contextMenus", menus);
    if (has("menus")) defineApi("menus", menus);
  }

  // --- chrome.permissions ------------------------------------------------------------------------

  defineApi("permissions", {
    contains: api("permissions.contains", ([p]) => [p ?? {}]),
    getAll: api("permissions.getAll"),
    request: api("permissions.request", ([p]) => [p ?? {}]),
    remove: api("permissions.remove", ([p]) => [p ?? {}]),
    addHostAccessRequest: resolved(undefined),
    removeHostAccessRequest: resolved(undefined),
    onAdded: ev("permissions.onAdded"),
    onRemoved: ev("permissions.onRemoved"),
  });

  // --- chrome.storage.sync ---------------------------------------------------------------------------

  if (c.storage) {
    const syncChanged = ev("storage.sync.onChanged");
    const sync = {
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
      MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
      get: api("sync.get", ([keys]) => [keys === undefined ? null : keys]),
      getKeys: api("sync.keys"),
      set: api("sync.set", ([items]) => [JSON.parse(JSON.stringify(items ?? {}))]),
      remove: api("sync.remove", ([keys]) => [Array.isArray(keys) ? keys : [keys]]),
      clear: api("sync.clear"),
      getBytesInUse: api("sync.bytes", ([keys]) => [keys === undefined ? null : keys]),
      setAccessLevel: resolved(undefined),
      onChanged: syncChanged,
    };
    define(c.storage, "sync", sync);
    // storage.onChanged covers every area: Electron's (local, session) plus sync.
    const native = c.storage.onChanged;
    if (native) {
      const wrapped = new Map<(...args: any[]) => void, (changes: any) => void>();
      define(c.storage, "onChanged", {
        addListener(fn: (changes: any, area: string) => void) {
          native.addListener(fn);
          if (wrapped.has(fn)) return;
          const w = (changes: any) => fn(changes, "sync");
          wrapped.set(fn, w);
          syncChanged.addListener(w);
        },
        removeListener(fn: (changes: any, area: string) => void) {
          native.removeListener(fn);
          const w = wrapped.get(fn);
          if (w) syncChanged.removeListener(w);
          wrapped.delete(fn);
        },
        hasListener: (fn: (changes: any, area: string) => void) => native.hasListener(fn) || wrapped.has(fn),
        hasListeners: () => native.hasListeners() || wrapped.size > 0,
      });
    }
  }

  // --- chrome.runtime ----------------------------------------------------------------------------------

  define(c.runtime, "onInstalled", ev("runtime.onInstalled"));
  define(c.runtime, "onStartup", ev("runtime.onStartup"));
  if (!c.runtime.onUpdateAvailable) define(c.runtime, "onUpdateAvailable", ev("runtime.onUpdateAvailable"));
  define(c.runtime, "openOptionsPage", api("runtime.openOptionsPage"));
  define(c.runtime, "setUninstallURL", resolved(undefined));
  define(c.runtime, "requestUpdateCheck", resolved({ status: "no_update" }));
  define(c.runtime, "reload", () => void call("runtime.reload"));

  if (has("nativeMessaging")) {
    define(c.runtime, "sendNativeMessage", api("native.send"));
    const ports = new Map<string, { onMessage: Ev; onDisconnect: Ev; port: any; open: boolean }>();
    internal.set("native.message", ([id, message]) =>
      ports.get(id)?.onMessage.dispatch([message, ports.get(id)!.port]),
    );
    internal.set("native.disconnect", ([id, error]) => {
      const p = ports.get(id);
      if (!p) return;
      ports.delete(id);
      p.open = false;
      if (error) withLastError(error, () => p.onDisconnect.dispatch([p.port]));
      else p.onDisconnect.dispatch([p.port]);
    });
    define(c.runtime, "connectNative", (application: string) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const onMessage = localEv();
      const onDisconnect = localEv();
      const port = {
        name: String(application),
        onMessage,
        onDisconnect,
        postMessage(message: unknown) {
          if (!entry.open) throw new Error("Attempting to use a disconnected port object");
          void call("native.post", id, JSON.parse(JSON.stringify(message ?? null))).catch(() => {});
        },
        disconnect() {
          if (!entry.open) return;
          entry.open = false;
          ports.delete(id);
          void call("native.disconnect", id).catch(() => {});
        },
      };
      const entry = { onMessage, onDisconnect, port, open: true };
      ports.set(id, entry);
      void call("native.connect", id, String(application)).catch(() => {});
      return port;
    });
  }

  // --- chrome.webNavigation ------------------------------------------------------------------------------

  if (has("webNavigation")) {
    const urlMatches = (f: any, url: string) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return false;
      }
      const host = u.hostname;
      const path = u.pathname;
      const query = u.search.slice(1);
      const whole = url.split("#")[0]!;
      const checks: [string, string, (a: string, b: string) => boolean][] = [];
      const contains = (a: string, b: string) => a.includes(b);
      const equals = (a: string, b: string) => a === b;
      const prefix = (a: string, b: string) => a.startsWith(b);
      const suffix = (a: string, b: string) => a.endsWith(b);
      checks.push(
        ["hostContains", `.${host}`, contains],
        ["hostEquals", host, equals],
        ["hostPrefix", host, prefix],
        ["hostSuffix", host, suffix],
        ["pathContains", path, contains],
        ["pathEquals", path, equals],
        ["pathPrefix", path, prefix],
        ["pathSuffix", path, suffix],
        ["queryContains", query, contains],
        ["queryEquals", query, equals],
        ["queryPrefix", query, prefix],
        ["querySuffix", query, suffix],
        ["urlContains", whole, contains],
        ["urlEquals", whole, equals],
        ["urlPrefix", whole, prefix],
        ["urlSuffix", whole, suffix],
      );
      for (const [key, value, test] of checks) if (typeof f[key] === "string" && !test(value, f[key])) return false;
      try {
        if (typeof f.urlMatches === "string" && !new RegExp(f.urlMatches).test(whole)) return false;
        if (typeof f.originAndPathMatches === "string" && !new RegExp(f.originAndPathMatches).test(u.origin + path))
          return false;
      } catch {
        return false;
      }
      if (Array.isArray(f.schemes) && !f.schemes.includes(u.protocol.slice(0, -1))) return false;
      if (Array.isArray(f.ports)) {
        const port = Number(u.port || (u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 0));
        if (!f.ports.some((p: any) => (Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p))) return false;
      }
      return true;
    };
    const byUrl = (filter: any, args: any[]) =>
      !Array.isArray(filter?.url) || filter.url.some((f: any) => urlMatches(f, args[0]?.url ?? ""));
    const names = [
      "onBeforeNavigate",
      "onCommitted",
      "onDOMContentLoaded",
      "onCompleted",
      "onErrorOccurred",
      "onCreatedNavigationTarget",
      "onReferenceFragmentUpdated",
      "onHistoryStateUpdated",
      "onTabReplaced",
    ];
    const nav: any = { getFrame: api("nav.getFrame"), getAllFrames: api("nav.getAllFrames") };
    for (const n of names) nav[n] = ev(`webNavigation.${n}`, byUrl);
    defineApi("webNavigation", nav);
  }

  // --- webRequest.onAuthRequired: sites asking for a username and password ------------------------
  // Electron never fires it; Rune Browser's main process asks here instead (and
  // waits for the answer) before showing its own sign-in dialog.

  if (c.webRequest && (has("webRequestAuthProvider") || has("webRequestBlocking"))) {
    const matches = (pattern: string, url: string) => {
      if (pattern === "<all_urls>") return /^(https?|wss?|ftp):/i.test(url);
      const m = /^(\*|https?|wss?|ftp):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
      if (!m) return false;
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return false;
      }
      const [, scheme, host, path = "/*"] = m as unknown as [string, string, string, string?];
      if (scheme === "*" ? !/^https?:$/.test(u.protocol) : u.protocol !== `${scheme.toLowerCase()}:`) return false;
      const h = host.toLowerCase().replace(/:\d+$/, "");
      if (
        h !== "*" &&
        !(h.startsWith("*.") ? u.hostname === h.slice(2) || u.hostname.endsWith(h.slice(1)) : u.hostname === h)
      )
        return false;
      const re = new RegExp(
        `^${path
          .split("*")
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      return re.test(u.pathname + u.search);
    };
    const listeners: { fn: (...args: any[]) => any; filter: any; spec: string[] }[] = [];
    const wants = (filter: any, details: any) =>
      (!Array.isArray(filter?.urls) ||
        filter.urls.some((p: unknown) => typeof p === "string" && matches(p, details.url))) &&
      (!Array.isArray(filter?.types) || filter.types.includes(details.type)) &&
      (typeof filter?.tabId !== "number" || filter.tabId === details.tabId);
    // A listener's answer: through the callback (asyncBlocking), returned (blocking), or a promise.
    const answerOf = (l: (typeof listeners)[number], details: any) =>
      new Promise<any>((resolve) => {
        const blocking = l.spec.includes("blocking") || l.spec.includes("asyncBlocking");
        const done = (r?: unknown) => resolve(r ?? null);
        let out: any;
        try {
          out = l.fn({ ...details }, l.spec.includes("asyncBlocking") ? done : undefined);
        } catch (err) {
          console.error(err);
          return done();
        }
        if (out && typeof out.then === "function") out.then(done, () => done());
        else if (!blocking || out !== undefined || !l.spec.includes("asyncBlocking")) done(out);
      });
    internal.set("webRequest.onAuthRequired", async ([details]) => {
      let answer: any = null;
      for (const l of listeners.slice()) {
        if (!wants(l.filter, details)) continue;
        const r = await answerOf(l, details);
        if (r && (r.authCredentials || r.cancel)) {
          answer = r;
          break;
        }
      }
      void call("auth.reply", details.requestId, answer && JSON.parse(JSON.stringify(answer))).catch(() => {});
    });
    define(c.webRequest, "onAuthRequired", {
      addListener(fn: (...args: any[]) => any, filter?: any, spec?: string[]) {
        if (typeof fn !== "function") throw new TypeError("The listener has to be a function");
        if (listeners.some((l) => l.fn === fn)) return;
        listeners.push({ fn, filter, spec: Array.isArray(spec) ? spec : [] });
        if (listeners.length === 1) void call("listen", "webRequest.onAuthRequired").catch(() => {});
      },
      removeListener(fn: (...args: any[]) => any) {
        const i = listeners.findIndex((l) => l.fn === fn);
        if (i === -1) return;
        listeners.splice(i, 1);
        if (!listeners.length) void call("unlisten", "webRequest.onAuthRequired").catch(() => {});
      },
      hasListener: (fn: (...args: any[]) => any) => listeners.some((l) => l.fn === fn),
      hasListeners: () => listeners.length > 0,
    });
  }

  // --- chrome.cookies -------------------------------------------------------------------------------------

  if (has("cookies")) {
    defineApi("cookies", {
      get: api("cookies.get"),
      getAll: api("cookies.getAll", ([d]) => [d ?? {}]),
      set: api("cookies.set"),
      remove: api("cookies.remove"),
      getAllCookieStores: api("cookies.stores"),
      getPartitionKey: resolved({ partitionKey: {} }),
      onChanged: ev("cookies.onChanged"),
    });
  }

  // --- chrome.notifications ----------------------------------------------------------------------------------

  if (has("notifications")) {
    const options = (o: any) => ({
      ...o,
      iconUrl: typeof o?.iconUrl === "string" && o.iconUrl ? absolute(o.iconUrl) : undefined,
      imageUrl: undefined,
      buttons: Array.isArray(o?.buttons) ? o.buttons.map((b: any) => ({ title: String(b?.title ?? "") })) : undefined,
    });
    defineApi("notifications", {
      create: api("notifications.create", (args) =>
        typeof args[0] === "string" || args[0] == null ? [args[0] ?? "", options(args[1])] : ["", options(args[0])],
      ),
      update: api("notifications.update", ([id, o]) => [id, options(o)]),
      clear: api("notifications.clear"),
      getAll: api("notifications.getAll"),
      getPermissionLevel: resolved("granted"),
      onClicked: ev("notifications.onClicked"),
      onClosed: ev("notifications.onClosed"),
      onButtonClicked: ev("notifications.onButtonClicked"),
      onPermissionLevelChanged: ev("notifications.onPermissionLevelChanged"),
      onShowSettings: ev("notifications.onShowSettings"),
      TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
      PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
    });
  }

  // --- The rest: small ones -------------------------------------------------------------------------------------

  if (has("idle")) {
    defineApi("idle", {
      queryState: api("idle.queryState"),
      setDetectionInterval: () => {},
      getAutoLockDelay: resolved(0),
      onStateChanged: ev("idle.onStateChanged"),
    });
  }

  if (!c.management?.getSelf || !c.management?.getAll) {
    defineApi("management", {
      ...(c.management ?? {}),
      getSelf: api("management.getSelf"),
      get: api("management.get"),
      getAll: api("management.getAll"),
      getPermissionWarningsById: resolved([]),
      setEnabled: api("management.setEnabled"),
      uninstallSelf: api("management.uninstall", ([o]) => [null, o ?? {}]),
      uninstall: api("management.uninstall", ([id, o]) => [id, o ?? {}]),
      onInstalled: ev("management.onInstalled"),
      onUninstalled: ev("management.onUninstalled"),
      onEnabled: ev("management.onEnabled"),
      onDisabled: ev("management.onDisabled"),
    });
  }

  // --- The browser's data and devices --------------------------------------------------------------
  // main/extensions/browserApis.ts does the work; a namespace Electron already has is left as it is.

  const unavailable = (name: string) => api("unsupported", () => [name]);
  const quietEvents = (...names: string[]) => Object.fromEntries(names.map((n) => [n, localEv()]));
  const missing = (name: string) => {
    try {
      return has(name) && c[name] === undefined;
    } catch {
      return false;
    }
  };
  const namedEvents = (prefix: string, ...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, ev(`${prefix}.${n}`)]));

  // chrome.sidePanel: its page in the side panel beside the workspace's tabs.
  if (has("sidePanel")) {
    let behavior = { openPanelOnActionClick: false };
    let panel: any = { enabled: true, path: manifest.side_panel?.default_path };
    defineApi("sidePanel", {
      setOptions: api("sidePanel.set", ([o]) => {
        if (!o?.tabId) panel = { ...panel, ...o };
        return [{ path: o?.tabId ? undefined : o?.path }];
      }),
      getOptions: (...args: any[]) => resolved({ ...panel })(...args.slice(1)),
      setPanelBehavior: api("sidePanel.set", ([b]) => {
        behavior = { openPanelOnActionClick: !!b?.openPanelOnActionClick };
        return [{ openOnAction: behavior.openPanelOnActionClick }];
      }),
      getPanelBehavior: (...args: any[]) => resolved({ ...behavior })(...args),
      getLayout: resolved({ side: "right" }),
      open: api("sidePanel.open", () => []),
      close: api("sidePanel.close", () => []),
      ...namedEvents("sidePanel", "onOpened", "onClosed"),
    });
  }

  // Rune Browser's bookmarks (main/extensions/apis.ts asks the server).
  if (missing("bookmarks")) {
    defineApi("bookmarks", {
      MAX_WRITE_OPERATIONS_PER_HOUR: 1000000,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
      getTree: api("bookmarks.getTree"),
      getSubTree: api("bookmarks.getSubTree"),
      getChildren: api("bookmarks.getChildren"),
      getRecent: api("bookmarks.getRecent"),
      get: api("bookmarks.get"),
      search: api("bookmarks.search"),
      create: api("bookmarks.create"),
      move: api("bookmarks.move"),
      update: api("bookmarks.update"),
      remove: api("bookmarks.remove"),
      removeTree: api("bookmarks.removeTree"),
      onCreated: ev("bookmarks.onCreated"),
      onRemoved: ev("bookmarks.onRemoved"),
      onChanged: ev("bookmarks.onChanged"),
      onMoved: ev("bookmarks.onMoved"),
      onImportBegan: ev("bookmarks.onImportBegan"),
      onImportEnded: ev("bookmarks.onImportEnded"),
      // Only for sorting a whole folder at once, which Rune Browser doesn't do.
      ...quietEvents("onChildrenReordered"),
    });
  }

  // The workspace's browsing history (private windows keep none).
  if (missing("history")) {
    defineApi("history", {
      search: api("history.search", ([q]) => [q ?? {}]),
      getVisits: api("history.getVisits", ([d]) => [d ?? {}]),
      addUrl: api("history.addUrl", ([d]) => [d ?? {}]),
      deleteUrl: api("history.deleteUrl", ([d]) => [d ?? {}]),
      deleteRange: api("history.deleteRange", ([r]) => [r ?? {}]),
      deleteAll: api("history.deleteAll", () => []),
      ...namedEvents("history", "onVisited", "onVisitRemoved"),
      ...quietEvents("onTitleChanged"),
    });
  }
  // Tabs closed lately in the workspace, and values kept with tabs and windows.
  if (missing("sessions")) {
    const values = (kind: "tab" | "window") => ({
      get: api("sessions.getValue", ([target, key]) => [kind, target, key]),
      set: api("sessions.setValue", ([target, key, value]) => [kind, target, key, value]),
      remove: api("sessions.removeValue", ([target, key]) => [kind, target, key]),
    });
    const tab = values("tab");
    const win = values("window");
    defineApi("sessions", {
      MAX_SESSION_RESULTS: 25,
      getRecentlyClosed: api("sessions.getRecentlyClosed", ([f]) => [typeof f === "object" && f ? f : {}]),
      getDevices: resolved([]),
      restore: api("sessions.restore", ([id]) => [typeof id === "string" ? id : null]),
      getTabValue: tab.get,
      setTabValue: tab.set,
      removeTabValue: tab.remove,
      getWindowValue: win.get,
      setWindowValue: win.set,
      removeWindowValue: win.remove,
      onChanged: ev("sessions.onChanged"),
    });
  }
  if (missing("topSites")) defineApi("topSites", { get: api("topSites.get", () => []) });
  // Rune Browser has no tab groups (split views are something else): there are none to see or change.
  if (missing("tabGroups")) {
    defineApi("tabGroups", {
      TAB_GROUP_ID_NONE: -1,
      Color: {
        GREY: "grey",
        BLUE: "blue",
        RED: "red",
        YELLOW: "yellow",
        GREEN: "green",
        PINK: "pink",
        PURPLE: "purple",
        CYAN: "cyan",
        ORANGE: "orange",
      },
      get: unavailable("tabGroups.get"),
      query: resolved([]),
      update: unavailable("tabGroups.update"),
      move: unavailable("tabGroups.move"),
      ...quietEvents("onCreated", "onUpdated", "onMoved", "onRemoved"),
    });
  }
  // Settings → Appearance → Fonts and zoom.
  if (missing("fontSettings")) {
    const size = (which: string) => ({
      get: api("fontSettings.getSize", () => [which]),
      set: api("fontSettings.setSize", ([d]) => [which, d ?? {}]),
      clear: api("fontSettings.clearSize", () => [which]),
    });
    const def = size("default");
    const fixed = size("fixed");
    const min = size("minimum");
    defineApi("fontSettings", {
      getFontList: api("fontSettings.getFontList", () => []),
      getFont: api("fontSettings.getFont", ([d]) => [d ?? {}]),
      setFont: api("fontSettings.setFont", ([d]) => [d ?? {}]),
      clearFont: api("fontSettings.clearFont", ([d]) => [d ?? {}]),
      getDefaultFontSize: def.get,
      setDefaultFontSize: def.set,
      clearDefaultFontSize: def.clear,
      getDefaultFixedFontSize: fixed.get,
      setDefaultFixedFontSize: fixed.set,
      clearDefaultFixedFontSize: fixed.clear,
      getMinimumFontSize: min.get,
      setMinimumFontSize: min.set,
      clearMinimumFontSize: min.clear,
      ...namedEvents(
        "fontSettings",
        "onFontChanged",
        "onDefaultFontSizeChanged",
        "onDefaultFixedFontSizeChanged",
        "onMinimumFontSizeChanged",
      ),
    });
  }
  // What Rune Browser has of Chrome's privacy settings (third-party cookies, Do Not Track, WebRTC's IP policy);
  // the rest read as Rune Browser has them and can't be changed (like settings a policy controls).
  if (missing("privacy")) {
    const setting = (name: string) => ({
      get: api("privacy.get", () => [name]),
      set: api("privacy.set", ([d]) => [name, d ?? {}]),
      clear: api("privacy.clear", () => [name]),
      onChange: ev(`privacy.${name}.onChange`),
    });
    const group = (prefix: string) =>
      new Proxy({} as Record<string, unknown>, {
        get: (t, k) => (typeof k === "string" && k !== "then" ? (t[k] ??= setting(`${prefix}.${k}`)) : undefined),
      });
    defineApi("privacy", {
      network: group("network"),
      services: group("services"),
      websites: group("websites"),
      IPHandlingPolicy: {
        DEFAULT: "default",
        DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: "default_public_and_private_interfaces",
        DEFAULT_PUBLIC_INTERFACE_ONLY: "default_public_interface_only",
        DISABLE_NON_PROXIED_UDP: "disable_non_proxied_udp",
      },
    });
  }
  // Signing in on websites in a window of their own; there's no browser account for getAuthToken.
  if (missing("identity")) {
    defineApi("identity", {
      getRedirectURL: (path?: string) => `https://${info.id}.chromiumapp.org/${String(path ?? "").replace(/^\/+/, "")}`,
      launchWebAuthFlow: api("identity.launchWebAuthFlow", ([d]) => [d ?? {}]),
      getAuthToken: unavailable("identity.getAuthToken (Rune Browser has no browser account)"),
      removeCachedAuthToken: resolved(undefined),
      clearAllCachedAuthTokens: resolved(undefined),
      getProfileUserInfo: resolved({ email: "", id: "" }),
      getAccounts: resolved([]),
      ...quietEvents("onSignInChanged"),
    });
  }
  // The workspace's downloads (the downloads page's list).
  if (missing("downloads")) {
    const act = (action: string) => api("downloads.act", ([id]) => [id, action]);
    defineApi("downloads", {
      download: api("downloads.download", ([o]) => [o ?? {}]),
      search: api("downloads.search", ([q]) => [q ?? {}]),
      pause: act("pause"),
      resume: act("resume"),
      cancel: act("cancel"),
      show: (id: number) => void call("downloads.act", id, "show").catch(() => {}),
      open: api("downloads.open"),
      showDefaultFolder: () => void call("downloads.showDefaultFolder").catch(() => {}),
      erase: api("downloads.erase", ([q]) => [q ?? {}]),
      removeFile: api("downloads.removeFile"),
      acceptDanger: api("downloads.acceptDanger"),
      getFileIcon: api("downloads.getFileIcon", (args) => [args[0], typeof args[1] === "object" ? args[1] : {}]),
      setShelfEnabled: (enabled: boolean) => void call("downloads.setUi", enabled !== false).catch(() => {}),
      setUiOptions: api("downloads.setUi", ([o]) => [o?.enabled !== false]),
      ...namedEvents("downloads", "onCreated", "onErased", "onChanged"),
      // Rune Browser names downloads itself (it doesn't wait for extensions' suggestions).
      ...quietEvents("onDeterminingFilename"),
    });
  }
  if (missing("search")) defineApi("search", { query: api("search.query", ([q]) => [q ?? {}]) });
  if (["system.cpu", "system.memory", "system.display", "system.storage"].some(has)) {
    const system: any = c.system ?? defineApi("system", {});
    if (has("system.cpu") && !system.cpu) defineOn(system, "cpu", { getInfo: api("system.cpu") });
    if (has("system.memory") && !system.memory) defineOn(system, "memory", { getInfo: api("system.memory") });
    if (has("system.display") && !system.display) {
      defineOn(system, "display", {
        getInfo: api("system.display", () => []),
        getDisplayLayout: resolved([]),
        ...quietEvents("onDisplayChanged"),
      });
    }
    if (has("system.storage")) {
      // Electron has its own, but its getInfo never answers and holds up the whole app (Chromium's storage
      // monitor isn't set up there): its functions are replaced on the object Chromium hands out.
      const storage = {
        getInfo: api("system.storage", () => []),
        // Ejecting is left to the system.
        ejectDevice: resolved("failure"),
        getAvailableCapacity: api("system.storageAvailable"),
      };
      if (system.storage && typeof system.storage === "object")
        for (const [key, value] of Object.entries(storage)) define(system.storage, key, value);
      else defineOn(system, "storage", { ...storage, ...quietEvents("onAttached", "onDetached") });
    }
  }

  // tabCapture and desktopCapture: ids for getUserMedia. A tab's id is made for the page that uses it, so
  // getUserMedia here swaps it for the real one first.
  const resolveCapture = async (constraints: any) => {
    const swap = async (track: any) => {
      const id = track?.mandatory?.chromeMediaSourceId;
      if (typeof id === "string" && id.startsWith("rune-tab:")) {
        const real = await call("tabCapture.resolve", id);
        return { ...track, mandatory: { ...track.mandatory, chromeMediaSource: "tab", chromeMediaSourceId: real } };
      }
      return track;
    };
    if (!constraints || typeof constraints !== "object") return constraints;
    return { ...constraints, audio: await swap(constraints.audio), video: await swap(constraints.video) };
  };
  if ((has("tabCapture") || has("desktopCapture")) && g.navigator?.mediaDevices?.getUserMedia) {
    const md = g.navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    defineOn(md, "getUserMedia", async (constraints: any) => original(await resolveCapture(constraints)));
    if (typeof g.navigator.webkitGetUserMedia === "function") {
      defineOn(g.navigator, "webkitGetUserMedia", (constraints: any, ok: any, fail: any) =>
        resolveCapture(constraints)
          .then((c2) => original(c2))
          .then(ok, fail),
      );
    }
  }
  if (missing("tabCapture")) {
    defineApi("tabCapture", {
      capture: (options: any, cb?: (stream: any) => void) => {
        const md = g.navigator?.mediaDevices;
        void (async () => {
          try {
            if (!md) throw new Error("tabCapture.capture is only available in extension pages");
            const tabId = await call("tabCapture.activeTab");
            const streamId = await call("tabCapture.getMediaStreamId", { targetTabId: tabId });
            const track = (on: boolean) =>
              on ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } : false;
            const stream = await md.getUserMedia({ audio: track(!!options?.audio), video: track(!!options?.video) });
            cb?.(stream);
          } catch (e: any) {
            withLastError(e?.message ?? String(e), () => cb?.(null));
          }
        })();
      },
      getMediaStreamId: api("tabCapture.getMediaStreamId", ([o]) => [o ?? {}]),
      getCapturedTabs: api("tabCapture.getCapturedTabs", () => []),
      onStatusChanged: ev("tabCapture.onStatusChanged"),
    });
  }
  if (missing("desktopCapture")) {
    let requests = 0;
    defineApi("desktopCapture", {
      DesktopCaptureSourceType: { SCREEN: "screen", WINDOW: "window", TAB: "tab", AUDIO: "audio" },
      chooseDesktopMedia: (...args: any[]) => {
        const cb = args.find((a) => typeof a === "function");
        const sources = args.find((a) => Array.isArray(a)) ?? [];
        const target = args.find((a) => a && typeof a === "object" && !Array.isArray(a) && typeof a.id === "number");
        call("desktopCapture.choose", sources, target?.id).then(
          (r: any) => cb?.(r?.streamId ?? "", { canRequestAudioTrack: !!r?.canRequestAudioTrack }),
          (e: any) => withLastError(e?.message ?? String(e), () => cb?.("", { canRequestAudioTrack: false })),
        );
        return ++requests;
      },
      cancelChooseDesktopMedia: () => {},
    });
  }
  // Push messages need Google's servers (Chrome's own sender): there are none to get.
  if (missing("gcm")) {
    defineApi("gcm", {
      MAX_MESSAGE_SIZE: 4096,
      register: unavailable("gcm.register (push messages need Google's servers)"),
      unregister: resolved(undefined),
      send: unavailable("gcm.send (push messages need Google's servers)"),
      ...quietEvents("onMessage", "onMessagesDeleted", "onSendError"),
    });
  }

  // chrome.browsingData: the workspace's data (extensions keep theirs, like in Chrome).
  if (missing("browsingData")) {
    const remove = (types: string[]) =>
      api("browsingData.remove", ([options]) => [options ?? {}, Object.fromEntries(types.map((t) => [t, true]))]);
    defineApi("browsingData", {
      settings: api("browsingData.settings", () => []),
      remove: api("browsingData.remove", ([options, data]) => [options ?? {}, data ?? {}]),
      removeAppcache: remove(["appcache"]),
      removeCache: remove(["cache"]),
      removeCacheStorage: remove(["cacheStorage"]),
      removeCookies: remove(["cookies"]),
      removeDownloads: remove(["downloads"]),
      removeFileSystems: remove(["fileSystems"]),
      removeFormData: remove(["formData"]),
      removeHistory: remove(["history"]),
      removeIndexedDB: remove(["indexedDB"]),
      removeLocalStorage: remove(["localStorage"]),
      removePasswords: remove(["passwords"]),
      removePluginData: remove(["pluginData"]),
      removeServiceWorkers: remove(["serviceWorkers"]),
      removeWebSQL: remove(["webSQL"]),
    });
  }

  // chrome.contentSettings: Rune Browser's site settings.
  if (missing("contentSettings")) {
    const contentSetting = (type: string) => ({
      get: api("contentSettings.get", ([d]) => [type, d ?? {}]),
      set: api("contentSettings.set", ([d]) => [type, d ?? {}]),
      clear: api("contentSettings.clear", () => [type]),
      getResourceIdentifiers: resolved(undefined),
    });
    const types = [
      "cookies",
      "images",
      "javascript",
      "location",
      "plugins",
      "popups",
      "notifications",
      "microphone",
      "camera",
      "unsandboxedPlugins",
      "automaticDownloads",
      "autoVerify",
      "clipboard",
      "sound",
    ];
    defineApi("contentSettings", {
      ...Object.fromEntries(types.map((t) => [t, contentSetting(t)])),
      CookiesContentSetting: { ALLOW: "allow", BLOCK: "block", SESSION_ONLY: "session_only" },
      ImagesContentSetting: { ALLOW: "allow", BLOCK: "block" },
      JavascriptContentSetting: { ALLOW: "allow", BLOCK: "block" },
      LocationContentSetting: { ALLOW: "allow", BLOCK: "block", ASK: "ask" },
      NotificationsContentSetting: { ALLOW: "allow", BLOCK: "block", ASK: "ask" },
      PopupsContentSetting: { ALLOW: "allow", BLOCK: "block" },
      Scope: { REGULAR: "regular", INCOGNITO_SESSION_ONLY: "incognito_session_only" },
    });
  }

  // chrome.debugger: a tab's DevTools protocol.
  if (missing("debugger")) {
    defineApi("debugger", {
      attach: api("debugger.attach", ([target, version]) => [target ?? {}, version]),
      detach: api("debugger.detach", ([target]) => [target ?? {}]),
      sendCommand: api("debugger.sendCommand", ([target, method, params]) => [target ?? {}, method, params ?? {}]),
      getTargets: api("debugger.getTargets", () => []),
      DetachReason: { CANCELED_BY_USER: "canceled_by_user", TARGET_CLOSED: "target_closed" },
      ...namedEvents("debugger", "onEvent", "onDetach"),
    });
  }

  // chrome.declarativeContent: its toolbar button shown (or its icon set) on the pages its rules match.
  if (missing("declarativeContent")) {
    class PageStateMatcher {
      instanceType = "declarativeContent.PageStateMatcher";
      constructor(o: any) {
        Object.assign(this, o ?? {});
      }
    }
    class ShowAction {
      instanceType = "declarativeContent.ShowAction";
    }
    class ShowPageAction {
      instanceType = "declarativeContent.ShowPageAction";
    }
    class SetIcon {
      instanceType = "declarativeContent.SetIcon";
      constructor(public o: any) {}
    }
    class RequestContentScript {
      instanceType = "declarativeContent.RequestContentScript";
      constructor(public o: any) {}
    }
    /** An icon as a data: URL (ImageData is drawn on a canvas; a path is read from the extension). */
    const iconUrl = async (o: any): Promise<string | null> => {
      const data = o?.imageData;
      const image =
        data && typeof data === "object" && !("data" in data) ? data[Object.keys(data).sort().pop()!] : data;
      if (image && typeof g.OffscreenCanvas === "function") {
        const canvas = new g.OffscreenCanvas(image.width, image.height);
        canvas.getContext("2d").putImageData(image, 0, 0);
        const blob = await canvas.convertToBlob();
        return await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        });
      }
      const path = typeof o?.path === "string" ? o.path : o?.path && Object.values(o.path).pop();
      return typeof path === "string" ? absolute(path) : null;
    };
    const serialize = async (rule: any) => ({
      id: rule?.id,
      priority: rule?.priority,
      conditions: (rule?.conditions ?? []).map((c2: any) => ({
        pageUrl: c2?.pageUrl,
        css: c2?.css,
        isBookmarked: c2?.isBookmarked,
      })),
      actions: await Promise.all(
        (rule?.actions ?? []).map(async (a: any) => {
          if (a instanceof SetIcon) return { type: "icon", icon: await iconUrl(a.o) };
          if (a instanceof RequestContentScript)
            return { type: "script", js: a.o?.js ?? [], css: a.o?.css ?? [], allFrames: !!a.o?.allFrames };
          return { type: "show" };
        }),
      ),
    });
    const onPageChanged = ev("declarativeContent.onPageChanged");
    const rulesCall =
      (method: string, prepare: (args: any[]) => any[] | Promise<any[]>) =>
      (...args: any[]) => {
        const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
        Promise.resolve(prepare(args))
          .then((a) => call(method, ...a))
          .then(
            (v) => cb?.(v),
            (e) => (cb ? withLastError(e?.message ?? String(e), () => cb()) : console.error(e)),
          );
      };
    defineOn(
      onPageChanged,
      "addRules",
      rulesCall("declarativeContent.add", async ([rules]) => [await Promise.all((rules ?? []).map(serialize))]),
    );
    defineOn(
      onPageChanged,
      "removeRules",
      rulesCall("declarativeContent.remove", ([ids]) => [Array.isArray(ids) ? ids : null]),
    );
    defineOn(
      onPageChanged,
      "getRules",
      rulesCall("declarativeContent.get", ([ids]) => [Array.isArray(ids) ? ids : null]),
    );
    defineApi("declarativeContent", {
      PageStateMatcher,
      ShowAction,
      ShowPageAction,
      SetIcon,
      RequestContentScript,
      onPageChanged,
    });
  }

  // chrome.pageCapture: a tab saved as MHTML.
  if (missing("pageCapture")) {
    defineApi("pageCapture", {
      saveAsMHTML: api(
        "pageCapture.saveAsMHTML",
        ([d]) => [d ?? {}],
        (base64: string) => {
          const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
          return new Blob([bytes], { type: "multipart/related" });
        },
      ),
    });
  }

  // chrome.power: keeping the computer (or its display) awake.
  if (missing("power")) {
    defineApi("power", {
      Level: { SYSTEM: "system", DISPLAY: "display" },
      requestKeepAwake: (level: string) => void call("power.requestKeepAwake", level).catch(() => {}),
      releaseKeepAwake: () => void call("power.releaseKeepAwake").catch(() => {}),
      reportActivity: resolved(undefined),
    });
  }

  // chrome.proxy: the workspace's proxy.
  if (missing("proxy")) {
    defineApi("proxy", {
      Mode: {
        DIRECT: "direct",
        AUTO_DETECT: "auto_detect",
        PAC_SCRIPT: "pac_script",
        FIXED_SERVERS: "fixed_servers",
        SYSTEM: "system",
      },
      settings: {
        get: api("proxy.get", () => []),
        set: api("proxy.set", ([d]) => [d ?? {}]),
        clear: api("proxy.clear", () => []),
        onChange: ev("proxy.settings.onChange"),
      },
      ...quietEvents("onProxyError"),
    });
  }

  // chrome.tts: the system's voices (through the window), and other extensions' (ttsEngine).
  if (missing("tts")) {
    defineApi("tts", {
      EventType: {
        START: "start",
        END: "end",
        WORD: "word",
        SENTENCE: "sentence",
        MARKER: "marker",
        INTERRUPTED: "interrupted",
        CANCELLED: "cancelled",
        ERROR: "error",
        PAUSE: "pause",
        RESUME: "resume",
      },
      VoiceGender: { MALE: "male", FEMALE: "female" },
      speak: (...args: any[]) => {
        const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
        const [text, options] = args;
        const { onEvent, ...rest } = options ?? {};
        const fire = (e: any) => {
          try {
            if (typeof onEvent === "function") onEvent(e);
          } catch (err) {
            console.error(err);
          }
        };
        // Speaking starts now; the callback (or the promise) only says it was queued, like Chrome's.
        queueMicrotask(() => fire({ type: "start", charIndex: 0 }));
        void call("tts.speak", String(text ?? ""), rest).then(
          (result: any) => fire({ type: result?.type ?? "end", charIndex: String(text ?? "").length, ...result }),
          (e: any) => fire({ type: "error", errorMessage: e?.message ?? String(e) }),
        );
        if (!cb) return Promise.resolve();
        queueMicrotask(() => cb());
        return undefined;
      },
      stop: () => void call("tts.stop").catch(() => {}),
      pause: () => void call("tts.pause").catch(() => {}),
      resume: () => void call("tts.resume").catch(() => {}),
      isSpeaking: api("tts.isSpeaking", () => []),
      getVoices: api("tts.getVoices", () => []),
      ...quietEvents("onVoicesChanged"),
    });
  }
  // chrome.ttsEngine: its voices for chrome.tts (sendTtsEvent goes back to whoever asked to speak).
  if (missing("ttsEngine")) {
    const onSpeak = ev("ttsEngine.onSpeak");
    const dispatchSpeak = onSpeak.dispatch.bind(onSpeak);
    defineOn(onSpeak, "dispatch", ([requestId, utterance, options]: any[]) =>
      dispatchSpeak([utterance, options, (event: any) => void call("ttsEngine.event", requestId, event ?? {})]),
    );
    defineApi("ttsEngine", {
      updateVoices: (voices: any[]) => void call("ttsEngine.updateVoices", voices ?? []).catch(() => {}),
      updateLanguage: () => {},
      onSpeak,
      ...namedEvents("ttsEngine", "onStop", "onPause", "onResume"),
      ...quietEvents("onSpeakWithAudioStream", "onInstallLanguageRequest", "onUninstallLanguageRequest"),
    });
  }

  // chrome.userScripts: scripts it registers for websites, run in a world of its own (or the page's).
  if (missing("userScripts")) {
    defineApi("userScripts", {
      ExecutionWorld: { MAIN: "MAIN", USER_SCRIPT: "USER_SCRIPT" },
      register: api("userScripts.register", ([scripts]) => [scripts ?? []]),
      update: api("userScripts.update", ([scripts]) => [scripts ?? []]),
      unregister: api("userScripts.unregister", ([f]) => [typeof f === "object" && f ? f : {}]),
      getScripts: api("userScripts.getScripts", ([f]) => [typeof f === "object" && f ? f : {}]),
      configureWorld: api("userScripts.configureWorld", ([config]) => [config ?? {}]),
      getWorldConfigurations: api("userScripts.getWorldConfigurations", () => []),
      resetWorldConfiguration: api("userScripts.resetWorldConfiguration", ([id]) => [id]),
      execute: api("userScripts.execute", ([injection]) => [injection ?? {}]),
    });
  }

  // Websites' icons for its pages: chrome-extension://<id>/_favicon/?pageUrl=… (Electron doesn't serve them).
  if (has("favicon")) {
    const prefix = `${base}_favicon/`;
    const isFavicon = (url: unknown) => typeof url === "string" && url.startsWith(prefix);
    const iconFor = (url: string): Promise<string | null> => {
      const params = new URL(url).searchParams;
      return call("favicon.get", params.get("pageUrl") ?? "", Number(params.get("size")) || 16).catch(() => null);
    };
    const fetch0 = g.fetch?.bind(g);
    if (fetch0) {
      defineOn(g, "fetch", async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : input?.url;
        if (!isFavicon(url)) return fetch0(input, init);
        const icon = await iconFor(url);
        return icon ? fetch0(icon) : new Response(null, { status: 404 });
      });
    }
    const Img = g.HTMLImageElement;
    const srcProp = Img && Object.getOwnPropertyDescriptor(Img.prototype, "src");
    if (srcProp?.set && srcProp.get) {
      const set = srcProp.set;
      Object.defineProperty(Img.prototype, "src", {
        ...srcProp,
        set(this: any, value: unknown) {
          const url = String(value);
          if (!isFavicon(url)) return set.call(this, value);
          void iconFor(url).then((icon) => set.call(this, icon ?? ""));
        },
      });
      // Images in its HTML.
      const fix = (img: any) => {
        const url = img.getAttribute?.("src");
        if (isFavicon(new URL(url ?? "", here()).href)) img.src = new URL(url, here()).href;
      };
      const watch = () => {
        g.document.querySelectorAll?.("img[src*='_favicon/']").forEach(fix);
        new g.MutationObserver((records: any[]) => {
          for (const r of records)
            for (const n of r.addedNodes ?? []) {
              if (n.tagName === "IMG") fix(n);
              n.querySelectorAll?.("img[src*='_favicon/']").forEach(fix);
            }
        }).observe(g.document, { childList: true, subtree: true });
      };
      if (g.document?.readyState === "loading") g.document.addEventListener("DOMContentLoaded", watch);
      else if (g.document) watch();
    }
  }

  // Anything else it asks for that isn't there: functions fail, events never come.
  for (const name of permissions) {
    if (PERMISSIONS_WITHOUT_API.has(name) || name.includes(".") || !missing(name)) continue;
    defineApi(
      name,
      new Proxy({} as Record<string, unknown>, {
        get: (t, k) => {
          if (typeof k !== "string" || k === "then") return undefined;
          if (!(k in t))
            t[k] = /^on[A-Z]/.test(k) ? localEv() : /^[A-Z_]+$/.test(k) ? undefined : unavailable(`${name}.${k}`);
          return t[k];
        },
      }),
    );
  }

  // Turning other extensions on and off, and removing one, the user saying yes first.
  if (c.management) {
    for (const [name, fn] of [
      ["setEnabled", api("management.setEnabled")],
      ["uninstallSelf", api("management.uninstall", ([o]) => [null, o ?? {}])],
      ["uninstall", api("management.uninstall", ([id, o]) => [id, o ?? {}])],
    ] as const)
      define(c.management, name, fn);
  }

  // chrome.extension: what Chrome still has of it.
  if (c.extension) {
    const ext = c.extension;
    if (typeof ext.isAllowedIncognitoAccess !== "function") define(ext, "isAllowedIncognitoAccess", resolved(false));
    if (typeof ext.isAllowedFileSchemeAccess !== "function") define(ext, "isAllowedFileSchemeAccess", resolved(false));
    if (typeof ext.setUpdateUrlData !== "function") define(ext, "setUpdateUrlData", () => {});
    if (typeof ext.getViews !== "function") define(ext, "getViews", () => []);
  }

  // storage.managed: what an administrator set (policies): nothing.
  if (c.storage) {
    defineOn(c.storage, "managed", {
      get: resolved({}),
      getKeys: resolved([]),
      getBytesInUse: resolved(0),
      set: unavailable("storage.managed.set"),
      remove: unavailable("storage.managed.remove"),
      clear: unavailable("storage.managed.clear"),
      onChanged: localEv(),
    });
  }

  // --- Blocked permissions ---------------------------------------------------------------------------
  // What the user blocked in its details: those namespaces' calls fail and
  // their events don't come. Rune Browser's own side checks too (tabs' URLs,
  // native messaging…).

  const blockedMessage = (permission: string) =>
    `The '${permission}' permission is blocked for this extension in Rune Browser.`;
  const blockedOf = (perms: string[]) => (perms.every((p) => denied.has(p)) ? perms[0]! : null);
  const gated = new WeakSet<object>();
  const listenerWrappers = new WeakMap<(...args: any[]) => any, (...args: any[]) => any>();

  const gateFunction = (fn: (...args: any[]) => any, self: any, perms: string[]) =>
    function (this: any, ...args: any[]) {
      const blocked = blockedOf(perms);
      if (!blocked) return fn.apply(this ?? self, args);
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
      if (cb) return void queueMicrotask(() => withLastError(blockedMessage(blocked), () => cb()));
      return Promise.reject(new Error(blockedMessage(blocked)));
    };

  const gateEvent = (event: any, perms: string[]) => {
    if (gated.has(event)) return;
    gated.add(event);
    const add = event.addListener?.bind(event);
    const remove = event.removeListener?.bind(event);
    const hasOne = event.hasListener?.bind(event);
    if (!add) return;
    const wrap = (fn: (...args: any[]) => any) => {
      if (typeof fn !== "function") return fn;
      let w = listenerWrappers.get(fn);
      if (!w) {
        w = function (this: any, ...a: any[]) {
          return blockedOf(perms) ? undefined : fn.apply(this, a);
        };
        listenerWrappers.set(fn, w);
      }
      return w;
    };
    defineOn(event, "addListener", (fn: (...args: any[]) => any, ...rest: any[]) => add(wrap(fn), ...rest));
    if (remove)
      defineOn(event, "removeListener", (fn: (...args: any[]) => any) => remove(listenerWrappers.get(fn) ?? fn));
    if (hasOne) defineOn(event, "hasListener", (fn: (...args: any[]) => any) => hasOne(listenerWrappers.get(fn) ?? fn));
  };

  const gate = (target: any, perms: string[]) => {
    if (!target || typeof target !== "object" || gated.has(target)) return;
    gated.add(target);
    const keys = new Set<string>();
    for (let o = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
      for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
    for (const key of keys) {
      if (key === "constructor" || /^[A-Z]/.test(key)) continue;
      let value: any;
      try {
        value = target[key];
      } catch {
        continue;
      }
      if (typeof value === "function") defineOn(target, key, gateFunction(value, target, perms));
      else if (value && typeof value === "object" && typeof value.addListener === "function") gateEvent(value, perms);
      else if (value && typeof value === "object") gate(value, perms);
    }
  };

  // Namespaces and the permissions that give them (any one of them will do).
  const GATED: [string, string[]][] = [
    ["storage", ["storage"]],
    ["alarms", ["alarms"]],
    ["scripting", ["scripting"]],
    ["offscreen", ["offscreen"]],
    ["declarativeNetRequest", ["declarativeNetRequest", "declarativeNetRequestWithHostAccess"]],
    ["webRequest", ["webRequest"]],
    ["webNavigation", ["webNavigation"]],
    ["cookies", ["cookies"]],
    ["notifications", ["notifications"]],
    ["idle", ["idle"]],
    ["contextMenus", ["contextMenus", "menus"]],
    ["menus", ["menus", "contextMenus"]],
    ["sidePanel", ["sidePanel"]],
    ["bookmarks", ["bookmarks"]],
    ["history", ["history"]],
    ["sessions", ["sessions"]],
    ["topSites", ["topSites"]],
    ["tabGroups", ["tabGroups"]],
    ["fontSettings", ["fontSettings"]],
    ["privacy", ["privacy"]],
    ["identity", ["identity"]],
    ["downloads", ["downloads"]],
    ["search", ["search"]],
    ["tabCapture", ["tabCapture"]],
    ["desktopCapture", ["desktopCapture"]],
    ["gcm", ["gcm"]],
    ["browsingData", ["browsingData"]],
    ["contentSettings", ["contentSettings"]],
    ["debugger", ["debugger"]],
    ["declarativeContent", ["declarativeContent"]],
    ["pageCapture", ["pageCapture"]],
    ["power", ["power"]],
    ["proxy", ["proxy"]],
    ["tts", ["tts"]],
    ["ttsEngine", ["ttsEngine"]],
    ["userScripts", ["userScripts"]],
  ];
  const b: any = g.browser;
  for (const [name, perms] of GATED) {
    const asked = perms.filter(has);
    if (!asked.length) continue;
    for (const root of b && b !== c ? [c, b] : [c]) {
      try {
        gate(root[name], asked);
      } catch {
        // leave it as it is
      }
    }
  }

  if (b && b !== c) {
    for (const [target, name, value] of defined) {
      const key =
        target === c
          ? null
          : (apiNames.get(target) ??
            ["runtime", "storage", "declarativeNetRequest", "extension", "webRequest"].find((k) => c[k] === target));
      const other = key === null ? b : key ? b[key] : undefined;
      if (other && other !== target) defineOn(other, name, value);
    }
  }
}
