// Web push (the Push API) for websites, through ntfy (https://ntfy.sh, or your own ntfy server): Electron has no
// push service, so Rune Browser is one. Sites call pushManager.subscribe() from their pages or service workers as
// in Chrome (extension-preload/push.ts stands in for the API and calls here); each subscription gets its own key
// pair, auth secret and ntfy topic, whose address is the endpoint the site's server sends to. One connection to
// the ntfy server follows every topic. A message that decrypts (aes128gcm, pushCrypto.ts) wakes the site's
// service worker with a `push` event; what it shows with showNotification() is a notification of Rune Browser's,
// and a click on it is a `notificationclick` in the worker, which may open or focus a tab.
//
// Kept here, never in a renderer, a page or an agent: the keys (sealed with the key from the OS keychain,
// sealKey.ts) and the subscriptions, in push.json in the profile. Scoped by workspace, like logins; private
// windows get none (subscribe() is refused, like Chrome's incognito). A subscription goes when the site
// unsubscribes, its notifications permission isn't "allow" anymore, its data is cleared, its workspace is
// deleted, or push is turned off (or moved to another server).
//
// Rune Browser has to run to receive (it keeps running without windows by default, main/background.ts): what's
// sent meanwhile waits on the ntfy server (12 hours on ntfy.sh) and arrives at the next start (`since`).
import {
  app,
  ipcMain,
  nativeImage,
  Notification,
  session,
  webContents,
  type IpcMainInvokeEvent,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_WORKSPACE } from "../shared/api";
import { coversHost, siteOf, type BrowserSettings, type SiteDefault } from "../shared/browser";
import {
  decodeBase64,
  encodeBase64Url,
  endpointFor,
  isTopic,
  newTopic,
  notificationFrom,
  parseNtfyLine,
  PUSH_ERRORS,
  pushServerOf,
  type PushError,
  type PushNotificationInfo,
  type PushSubscriptionInfo,
  type PushSubscriptionSummary,
} from "../shared/push";
import { decryptPushMessage, newSubscriptionKeys, seal, unseal } from "./pushCrypto";
import { loadSealKey } from "./sealKey";
import type { AppWindows } from "./windows";

/** For the e2e checks only: no messages through ntfy.sh, only through a server on this computer. */
const localOnly = !app.isPackaged && process.env.RUNE_PUSH_LOCAL_ONLY === "1";
const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
/** Offscreen (the e2e checks), notifications are kept for the checks to read and click instead of shown. */
const offscreen = process.env.RUNE_OFFSCREEN === "1";

/** No data from the server for this long: the connection is gone (ntfy sends a keepalive every 45 s). */
const STALE_MS = 120_000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
/** How long a worker may take over an event (Chrome gives service worker events minutes; sites need seconds). */
const EVENT_TIMEOUT_MS = 60_000;
/** After a click on a notification, its worker may open or focus a window for this long (like Chrome's). */
const ACTIVATION_MS = 10_000;
const MAX_SUBSCRIPTIONS = 500;
/** Waits before each try to start a site's service worker for an event. */
const START_RETRIES_MS = [0, 500, 1500, 4000];
const MAX_NOTIFICATIONS = 100;
/** Message ids remembered, so what the server sends again after a reconnect isn't delivered twice. */
const SEEN = 300;

interface StoredSubscription {
  id: string;
  workspaceId: string;
  /** The site's origin (scheme, host, port). */
  origin: string;
  /** Its service worker registration's scope. */
  scope: string;
  topic: string;
  endpoint: string;
  /** The ntfy server it's on. */
  server: string;
  /** The site's applicationServerKey (base64url). */
  key: string;
  /** The subscription's public key (base64url). */
  p256dh: string;
  /** The private key and the auth secret, sealed. */
  sealed: string;
  createdAt: number;
}

interface Secrets {
  privateKey: string;
  auth: string;
}

interface Stored {
  version: 1;
  /** The server's time of the newest message or keepalive seen: on a reconnect, what came since is asked for. */
  since: number | null;
  seen: string[];
  subscriptions: StoredSubscription[];
}

interface ShownNotification {
  info: PushNotificationInfo;
  workspaceId: string;
  scope: string;
  origin: string;
  native?: Notification;
  clicked?: boolean;
}

type Caller =
  | { kind: "frame"; session: Session; workspaceId: string; origin: string; contents: WebContents }
  | { kind: "worker"; session: Session; workspaceId: string; origin: string; scope: string };

type Reply = { value: unknown } | { error: PushError; silent?: boolean } | { prompt: true };

export interface PushOptions {
  windows: AppWindows;
  webSession: (workspaceId: string) => Session;
  /** The workspace of a web tab session (undefined: not one). */
  workspaceOf: (s: Session) => string | undefined;
  /** The browser settings in effect, and whether the renderer sent them yet (until then, nothing is pruned). */
  settings: () => BrowserSettings;
  settingsReady: () => boolean;
  /** The notifications setting of a site in normal windows (its settings, or a prompt just answered). */
  notificationSetting: (site: string) => SiteDefault;
  /** Pages that get nothing (headless tabs). */
  excluded: (contents: WebContents) => boolean;
}

const fail = (error: PushError): Reply => ({ error });
const originOf = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
};
const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
};

export function setupPush(options: PushOptions) {
  const { windows } = options;
  const file = join(app.getPath("userData"), "push.json");

  // --- Storage --------------------------------------------------------------------------------------

  let stored: Stored = load();
  function load(): Stored {
    try {
      if (existsSync(file)) {
        const v = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
        if (v.version === 1 && Array.isArray(v.subscriptions))
          return {
            version: 1,
            since: typeof v.since === "number" ? v.since : null,
            seen: Array.isArray(v.seen) ? v.seen.filter((s) => typeof s === "string").slice(-SEEN) : [],
            subscriptions: v.subscriptions.filter((s) => s && isTopic(s.topic) && typeof s.sealed === "string"),
          };
      }
    } catch (err) {
      console.warn("Couldn't read the push subscriptions:", err);
    }
    return { version: 1, since: null, seen: [], subscriptions: [] };
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function save(now = false) {
    clearTimeout(saveTimer);
    const write = () => {
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify(stored), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
      } catch (err) {
        console.warn("Couldn't save the push subscriptions:", err);
      }
    };
    if (now) write();
    else saveTimer = setTimeout(write, 500);
  }
  app.on("will-quit", () => {
    if (saveTimer || sinceDirty) save(true);
  });

  let sealKey: Buffer | null | undefined;
  const sealingKey = () => {
    if (sealKey === undefined) {
      const k = loadSealKey();
      sealKey = k ? createHash("sha256").update(`rune-push-seal-v1:${k.key}`).digest() : null;
    }
    return sealKey;
  };
  const secretsOf = (sub: StoredSubscription) => {
    const k = sealingKey();
    return k ? unseal<Secrets>(k, sub.sealed) : null;
  };

  const infoOf = (sub: StoredSubscription): PushSubscriptionInfo | null => {
    const secrets = secretsOf(sub);
    return secrets ? { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: secrets.auth, key: sub.key } : null;
  };
  const find = (workspaceId: string, scope: string) =>
    stored.subscriptions.find((s) => s.workspaceId === workspaceId && s.scope === scope);

  function remove(which: (s: StoredSubscription) => boolean) {
    const before = stored.subscriptions.length;
    stored.subscriptions = stored.subscriptions.filter((s) => !which(s));
    if (stored.subscriptions.length === before) return;
    save(true);
    stream.update();
  }

  // --- Which server ---------------------------------------------------------------------------------

  /** The server in effect: null while push is off or your own server's address isn't valid. */
  const server = () => {
    const s = pushServerOf(options.settings());
    return s && (!localOnly || isLoopback(s)) ? s : null;
  };

  // --- The connection to ntfy -----------------------------------------------------------------------

  const stream = (() => {
    let controller: AbortController | null = null;
    let current = "";
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    let opened: (() => void)[] = [];
    /** Its own session: no cookies or cache, and nothing of the user's goes along. */
    let netSession: Session | undefined;
    const net = () => (netSession ??= session.fromPartition("rune-push", { cache: false }));

    const wanted = () => {
      const base = server();
      if (!base || !options.settingsReady()) return "";
      const topics = stored.subscriptions.filter((s) => s.server === base).map((s) => s.topic);
      return topics.length ? `${base}/${[...new Set(topics)].sort().join(",")}/json` : "";
    };

    function stop() {
      controller?.abort();
      controller = null;
      clearTimeout(retry);
      clearTimeout(stale);
    }

    /** Connects to what's wanted now, if that changed. */
    function update() {
      const url = wanted();
      if (url === current && (controller || retry)) return;
      stop();
      current = url;
      attempt = 0;
      if (url) void connect(url);
      else for (const fn of opened.splice(0)) fn();
    }

    function scheduleRetry(url: string) {
      if (current !== url) return;
      const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!;
      retry = setTimeout(() => {
        retry = undefined;
        if (current === url) void connect(url);
      }, wait);
    }

    async function connect(url: string) {
      const ctrl = new AbortController();
      controller = ctrl;
      const since = stored.since !== null ? `?since=${Math.max(0, stored.since - 5)}` : "";
      const watchdog = () => {
        clearTimeout(stale);
        stale = setTimeout(() => ctrl.abort(), STALE_MS);
      };
      watchdog();
      try {
        const res = await net().fetch(url + since, {
          signal: ctrl.signal,
          cache: "no-store",
          credentials: "omit",
          headers: { Accept: "application/x-ndjson" },
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          watchdog();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 1_000_000) throw new Error("line too long");
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const event = parseNtfyLine(line);
            if (!event) continue;
            if (event.kind === "open") {
              attempt = 0;
              for (const fn of opened.splice(0)) fn();
            }
            received(event);
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted || controller === ctrl)
          console.warn("The push connection failed:", err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(stale);
        if (controller === ctrl) {
          controller = null;
          scheduleRetry(url);
        }
      }
    }

    return {
      update,
      /** Resolves once the connection with what's wanted now is open (or after `ms`). */
      whenOpen(ms: number) {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          opened.push(() => {
            clearTimeout(timer);
            resolve();
          });
          update();
        });
      },
      stop,
    };
  })();

  /** When `since` was last written for a keepalive (they come every 45 s: written every few minutes). */
  let sinceSaved = 0;
  let sinceDirty = false;
  function received(event: ReturnType<typeof parseNtfyLine> & {}) {
    if (stored.since === null || event.time > stored.since) {
      stored.since = event.time;
      sinceDirty = true;
      if (Date.now() - sinceSaved > 5 * 60_000) {
        sinceSaved = Date.now();
        sinceDirty = false;
        save();
      }
    }
    if (event.kind !== "message") return;
    if (stored.seen.includes(event.id)) return;
    stored.seen = [...stored.seen, event.id].slice(-SEEN);
    save();
    const sub = stored.subscriptions.find((s) => s.topic === event.topic);
    if (sub) void deliver(sub, event.body);
  }

  // --- Delivering messages --------------------------------------------------------------------------

  async function deliver(sub: StoredSubscription, body: Uint8Array) {
    const secrets = secretsOf(sub);
    // Sealed with a key that's gone (the keychain was reset): the subscription can't be used anymore.
    if (!secrets) return remove((s) => s.id === sub.id);
    const plain = decryptPushMessage(body, {
      privateKey: Buffer.from(decodeBase64(secrets.privateKey) ?? []),
      auth: Buffer.from(decodeBase64(secrets.auth) ?? []),
    });
    // Not from someone who knows the subscription's keys (ntfy doesn't check who sends): dropped.
    if (!plain) return;
    if (options.notificationSetting(siteOf(hostOf(sub.origin))) !== "allow") return;
    const done = await dispatch(sub.workspaceId, sub.scope, { type: "push", data: encodeBase64Url(plain) });
    // The site's service worker is gone (unregistered, or its data cleared): so is the subscription, like in Chrome.
    if (done === "no-worker") remove((s) => s.id === sub.id);
  }

  /** Workers hooked to answer the page API's calls (once each). */
  const hooked = new WeakSet<ServiceWorkerMain>();
  /** Events a worker is handling, until it says it's done (only that worker may). */
  const pendingEvents = new Map<number, { workspaceId: string; scope: string; done: () => void }>();
  let eventIds = 0;
  /** Scopes whose notification was just clicked (workspace and scope), with when. */
  const activations = new Map<string, number>();

  /** Wakes a site's service worker for an event, keeps it alive while it handles it. */
  async function dispatch(workspaceId: string, scope: string, event: Record<string, unknown>) {
    let worker: ServiceWorkerMain | undefined;
    // Right after Rune Browser starts, a session's workers may not be ready to start yet: a few tries.
    for (const wait of START_RETRIES_MS) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        worker = await options.webSession(workspaceId).serviceWorkers.startWorkerForScope(scope);
        if (!worker.isDestroyed()) break;
      } catch (err) {
        worker = undefined;
        if (wait === START_RETRIES_MS.at(-1))
          console.warn(`Couldn't start the service worker of ${scope}:`, err instanceof Error ? err.message : err);
      }
    }
    if (!worker || worker.isDestroyed()) return "no-worker" as const;
    hookWorker(options.webSession(workspaceId), worker);
    const task = worker.startTask();
    const id = ++eventIds;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EVENT_TIMEOUT_MS);
        pendingEvents.set(id, {
          workspaceId,
          scope: worker.scope,
          done: () => {
            clearTimeout(timer);
            resolve();
          },
        });
        worker.send("push:event", { ...event, id });
      });
      return "done" as const;
    } catch (err) {
      console.warn("A site's service worker didn't take a push event:", err);
      return "failed" as const;
    } finally {
      pendingEvents.delete(id);
      try {
        task.end();
      } catch {
        // gone already
      }
    }
  }

  // --- Notifications --------------------------------------------------------------------------------

  const shown = new Map<string, ShownNotification>();

  async function iconFor(s: Session, url: string) {
    try {
      if (url.startsWith("data:image/")) return nativeImage.createFromDataURL(url);
      if (!/^https?:/i.test(url)) return undefined;
      const res = await s.fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      const data = Buffer.from(await res.arrayBuffer());
      return data.length <= 1_000_000 ? nativeImage.createFromBuffer(data) : undefined;
    } catch {
      return undefined;
    }
  }

  function closeShown(id: string) {
    const n = shown.get(id);
    if (!n) return;
    shown.delete(id);
    try {
      n.native?.close();
    } catch {
      // gone already
    }
  }

  async function showNotification(caller: Caller, scope: string, title: unknown, raw: unknown) {
    const info = notificationFrom(randomUUID(), title, raw, Date.now());
    // The same tag replaces the notification before it (without a close event), like in Chrome.
    for (const [id, n] of shown)
      if (n.workspaceId === caller.workspaceId && n.scope === scope && info.tag && n.info.tag === info.tag)
        closeShown(id);
    const entry: ShownNotification = { info, workspaceId: caller.workspaceId, scope, origin: caller.origin };
    shown.set(info.id, entry);
    // The oldest go when there are too many.
    for (const id of [...shown.keys()].slice(0, Math.max(0, shown.size - MAX_NOTIFICATIONS))) closeShown(id);
    if (offscreen || !Notification.isSupported()) return;
    const icon = info.icon ? await iconFor(caller.session, info.icon) : undefined;
    if (shown.get(info.id) !== entry) return;
    const host = hostOf(caller.origin);
    const native = new Notification({
      title: info.title,
      // Like Chrome, the site it's from is part of it (macOS shows it as the subtitle).
      ...(process.platform === "darwin" ? { subtitle: host } : {}),
      body: process.platform === "darwin" ? info.body : [info.body, host].filter(Boolean).join("\n"),
      ...(icon && !icon.isEmpty() ? { icon } : {}),
      silent: info.silent === true,
      ...(info.requireInteraction ? { timeoutType: "never" as const } : {}),
    });
    native.on("click", () => void clicked(info.id));
    native.on("close", () => closedByUser(info.id));
    entry.native = native;
    native.show();
  }

  async function clicked(id: string) {
    const n = shown.get(id);
    if (!n || n.clicked) return;
    n.clicked = true;
    activations.set(`${n.workspaceId} ${n.scope}`, Date.now());
    await dispatch(n.workspaceId, n.scope, { type: "notificationclick", notification: n.info, action: "" });
  }

  function closedByUser(id: string) {
    const n = shown.get(id);
    if (!n) return;
    shown.delete(id);
    // The system closes a notification that was clicked: that's not the user dismissing it.
    if (!n.clicked) void dispatch(n.workspaceId, n.scope, { type: "notificationclose", notification: n.info });
  }

  const activated = (caller: Caller) =>
    caller.kind === "worker" &&
    Date.now() - (activations.get(`${caller.workspaceId} ${caller.scope}`) ?? 0) < ACTIVATION_MS;

  // --- Windows from a notification's click ----------------------------------------------------------

  function openWindow(caller: Caller, url: string) {
    const win = windows.current("normal");
    if (!win) {
      // None open (running in the background, main/background.ts): the window closed last comes back with it.
      void windows.openLink(url, { private: false, workspaceId: caller.workspaceId, restore: true });
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("rune:push-open-tab", { url, workspaceId: caller.workspaceId });
  }

  function focusClient(caller: Caller, url: string) {
    const target = webContents
      .getAllWebContents()
      .find(
        (c) =>
          !c.isDestroyed() &&
          c.getType() === "webview" &&
          c.session === caller.session &&
          c.getURL() === url &&
          windows.of(c) &&
          !windows.isPrivate(windows.of(c)),
      );
    const win = target && windows.of(target);
    if (!target || !win) return false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("rune:push-focus-tab", target.id);
    return true;
  }

  // --- The page API's calls -------------------------------------------------------------------------

  const settingOf = (caller: Caller): SiteDefault =>
    caller.workspaceId === PRIVATE_WORKSPACE ? "block" : options.notificationSetting(siteOf(hostOf(caller.origin)));

  /** The scope a caller names, if it's theirs to name: their own origin's (a worker: its own). */
  function scopeFor(caller: Caller, value: unknown): string | null {
    if (typeof value !== "string" || value.length > 2000) return null;
    if (caller.kind === "worker") return value === caller.scope ? value : null;
    return originOf(value) === caller.origin ? value : null;
  }

  async function handle(caller: Caller, method: string, raw: unknown): Promise<Reply> {
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    switch (method) {
      case "hello":
        return { value: true };
      case "permissionState": {
        if (args.userVisibleOnly !== true) return fail(PUSH_ERRORS.silentState);
        const setting = settingOf(caller);
        return { value: setting === "allow" ? "granted" : setting === "block" ? "denied" : "prompt" };
      }
      case "subscribe":
        return subscribe(caller, args);
      case "getSubscription": {
        const scope = scopeFor(caller, args.scope);
        const sub = scope && caller.workspaceId !== PRIVATE_WORKSPACE ? find(caller.workspaceId, scope) : undefined;
        return { value: sub && sub.server === server() ? infoOf(sub) : null };
      }
      case "unsubscribe": {
        const scope = scopeFor(caller, args.scope);
        const sub = scope ? find(caller.workspaceId, scope) : undefined;
        if (!sub || (typeof args.endpoint === "string" && args.endpoint !== sub.endpoint)) return { value: false };
        remove((s) => s.id === sub.id);
        return { value: true };
      }
      case "showNotification": {
        const scope = scopeFor(caller, args.scope);
        if (!scope || settingOf(caller) !== "allow") return fail(PUSH_ERRORS.noNotificationPermission);
        await showNotification(caller, scope, args.title, args.options);
        return { value: true };
      }
      case "getNotifications": {
        const scope = scopeFor(caller, args.scope);
        const tag = typeof args.tag === "string" ? args.tag : "";
        return {
          value: [...shown.values()]
            .filter((n) => n.workspaceId === caller.workspaceId && n.scope === scope && (!tag || n.info.tag === tag))
            .map((n) => n.info),
        };
      }
      case "closeNotification": {
        const n = typeof args.id === "string" ? shown.get(args.id) : undefined;
        if (n && n.workspaceId === caller.workspaceId && n.origin === caller.origin) closeShown(n.info.id);
        return { value: true };
      }
      case "openWindow": {
        if (!activated(caller)) return fail(PUSH_ERRORS.openWindow);
        const url = typeof args.url === "string" && /^https?:\/\//i.test(args.url) ? args.url.slice(0, 8000) : null;
        if (!url) return { value: null };
        openWindow(caller, url);
        return { value: url };
      }
      case "focus": {
        if (!activated(caller)) return fail(PUSH_ERRORS.focus);
        const url = typeof args.url === "string" ? args.url : "";
        return { value: originOf(url) === caller.origin && focusClient(caller, url) };
      }
      case "done": {
        const event = typeof args.id === "number" ? pendingEvents.get(args.id) : undefined;
        if (
          event &&
          caller.kind === "worker" &&
          caller.workspaceId === event.workspaceId &&
          caller.scope === event.scope
        )
          event.done();
        return { value: true };
      }
    }
    return fail(PUSH_ERRORS.noService);
  }

  async function subscribe(caller: Caller, args: Record<string, unknown>): Promise<Reply> {
    const scope = scopeFor(caller, args.scope);
    if (!scope) return fail(PUSH_ERRORS.noWorker);
    const base = options.settingsReady() ? server() : null;
    if (!base) return fail(PUSH_ERRORS.noService);
    // Private windows keep nothing: refused like Chrome's incognito (which can't tell it from a "no").
    if (caller.workspaceId === PRIVATE_WORKSPACE) return fail(PUSH_ERRORS.permissionDenied);
    let existing = find(caller.workspaceId, scope);
    // One on another server (push moved there since) doesn't count anymore.
    if (existing && existing.server !== base) {
      const old = existing;
      remove((s) => s.id === old.id);
      existing = undefined;
    }
    const key = typeof args.key === "string" ? args.key : "";
    if (!key && !existing) return fail(PUSH_ERRORS.noKey);
    if (key && existing && existing.key !== key) return fail(PUSH_ERRORS.keyMismatch);
    const setting = settingOf(caller);
    if (setting === "block") return fail(PUSH_ERRORS.permissionDenied);
    // Asking is the page's to do (Notification.requestPermission(), the site permission prompt); workers can't.
    if (setting === "ask")
      return caller.kind === "frame" && args.asked !== true ? { prompt: true } : fail(PUSH_ERRORS.permissionDenied);
    if (args.userVisibleOnly !== true) return { error: PUSH_ERRORS.permissionDenied, silent: true };
    if (existing) {
      const info = infoOf(existing);
      if (info) return { value: info };
      const old = existing;
      remove((s) => s.id === old.id);
    }
    const k = key ? decodeBase64(key) : null;
    if (!k || k.length !== 65 || k[0] !== 4) return fail(PUSH_ERRORS.invalidKey);
    const sealWith = sealingKey();
    if (!sealWith || stored.subscriptions.length >= MAX_SUBSCRIPTIONS) return fail(PUSH_ERRORS.storage);
    const keys = newSubscriptionKeys();
    const topic = newTopic((n) => randomBytes(n));
    const sub: StoredSubscription = {
      id: randomUUID(),
      workspaceId: caller.workspaceId,
      origin: caller.origin,
      scope,
      topic,
      endpoint: endpointFor(base, topic),
      server: base,
      key,
      p256dh: encodeBase64Url(keys.publicKey),
      sealed: seal(sealWith, {
        privateKey: encodeBase64Url(keys.privateKey),
        auth: encodeBase64Url(keys.auth),
      } satisfies Secrets),
      createdAt: Date.now(),
    };
    stored.subscriptions = [...stored.subscriptions, sub];
    save(true);
    // ntfy.sh takes messages for a topic only once someone listens to it: listening first, so the site's
    // server can send right away (bounded: a server that's down doesn't keep the page waiting).
    await stream.whenOpen(5000);
    return { value: infoOf(sub) };
  }

  // --- IPC: pages (frames) and service workers -------------------------------------------------------

  function frameCaller(event: IpcMainInvokeEvent): Caller | null {
    const frame: WebFrameMain | null = event.senderFrame;
    const contents = event.sender;
    const workspaceId = options.workspaceOf(contents.session);
    if (!frame || frame.isDestroyed() || workspaceId === undefined || options.excluded(contents)) return null;
    const origin = originOf(frame.url);
    // Only the page itself, or frames of its own origin (the permission is the top page's).
    if (!origin || originOf(frame.top?.url ?? "") !== origin) return null;
    return { kind: "frame", session: contents.session, workspaceId, origin, contents };
  }

  ipcMain.handle("push:call", async (event, method: unknown, args: unknown) => {
    const caller = frameCaller(event);
    if (!caller || typeof method !== "string") return fail(PUSH_ERRORS.permissionDenied);
    return handle(caller, method, args);
  });

  /** Lets a site's service worker call (its preload's push:call); once per worker. */
  function hookWorker(s: Session, worker: ServiceWorkerMain) {
    if (hooked.has(worker)) return;
    hooked.add(worker);
    const workspaceId = options.workspaceOf(s);
    const origin = originOf(worker.scope);
    if (workspaceId === undefined || !origin) return;
    try {
      worker.ipc.handle("push:call", (_event, method: unknown, args: unknown) => {
        if (typeof method !== "string" || worker.isDestroyed()) return fail(PUSH_ERRORS.permissionDenied);
        return handle({ kind: "worker", session: s, workspaceId, origin, scope: worker.scope }, method, args);
      });
    } catch {
      // hooked already
    }
  }

  // --- Settings' list, and the e2e checks' view of notifications --------------------------------------

  ipcMain.handle("rune:push-list", (event): PushSubscriptionSummary[] => {
    if (!windows.isUi(event.sender)) return [];
    return stored.subscriptions.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      origin: s.origin,
      scope: s.scope,
      createdAt: s.createdAt,
    }));
  });
  ipcMain.handle("rune:push-remove", (event, id: unknown) => {
    if (!windows.isUi(event.sender) || typeof id !== "string") return false;
    remove((s) => s.id === id);
    return true;
  });
  if (offscreen)
    ipcMain.handle("rune:test-notifications", async (event, action: unknown) => {
      if (!windows.isUi(event.sender)) return null;
      const a = (action ?? {}) as { click?: unknown; close?: unknown };
      if (typeof a.click === "string") await clicked(a.click);
      if (typeof a.close === "string") closedByUser(a.close);
      return [...shown.values()].map((n) => ({
        id: n.info.id,
        title: n.info.title,
        body: n.info.body,
        tag: n.info.tag,
        origin: n.origin,
        workspaceId: n.workspaceId,
      }));
    });

  // --- What changes subscriptions -------------------------------------------------------------------

  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  let applied = false;
  /** The browser settings changed (or arrived): push turned off or moved, permissions taken back. */
  function settingsChanged() {
    if (!options.settingsReady()) return;
    // Permissions: at once.
    prune();
    // The service: once the address stops changing (typed into Settings), except the first time.
    clearTimeout(applyTimer);
    if (!applied) return void ((applied = true), applyService());
    applyTimer = setTimeout(applyService, 1000);
  }

  function prune() {
    remove((s) => options.notificationSetting(siteOf(hostOf(s.origin))) !== "allow");
  }

  function applyService() {
    const { service } = options.settings().push;
    const base = server();
    // Off, or moved to another server: the subscriptions on the old one go (sites subscribe again).
    if (service === "off") remove(() => true);
    else if (base) remove((s) => s.server !== base);
    stream.update();
  }

  return {
    hookWorker,
    settingsChanged,
    /** A site's data (`sites`, with their subdomains), or all of it (null), was cleared in these workspaces. */
    siteDataCleared(workspaceIds: readonly string[], sites: readonly string[] | null) {
      remove(
        (s) =>
          workspaceIds.includes(s.workspaceId) &&
          (sites === null || sites.some((site) => coversHost(site, hostOf(s.origin)))),
      );
    },
    workspaceDeleted(workspaceId: string) {
      remove((s) => s.workspaceId === workspaceId);
      for (const [id, n] of shown) if (n.workspaceId === workspaceId) closeShown(id);
    },
  };
}

export type PushControl = ReturnType<typeof setupPush>;
