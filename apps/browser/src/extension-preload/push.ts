// The Push API for websites, in their pages and service workers, as Chrome has it: PushManager (subscribe,
// getSubscription, permissionState, supportedContentEncodings), PushSubscription (endpoint, getKey, toJSON,
// unsubscribe…), and in workers the `push` event with its PushMessageData, notifications shown with
// registration.showNotification() (Rune Browser's own: Electron's don't reach the worker when clicked) and their
// `notificationclick`/`notificationclose` events, clients.openWindow() and WindowClient.focus() after a click.
//
// This function runs in the site's own world (injected by the preload with contextBridge.executeInMainWorld), so
// it can't use anything from outside itself: it gets the bridge to the main process (main/push.ts) as an
// argument. The main process checks every call against the page's or worker's own origin: a site only ever
// reaches its own subscriptions. Keys never come here, except the subscription's public key and auth secret,
// which are the site's to give its server.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PushBridge {
  call: (method: string, args: Record<string, unknown>) => Promise<any>;
  onEvent: (fn: (event: any) => void) => void;
}

export interface PushShimInfo {
  worker: boolean;
  encodings: readonly string[];
  /** Chrome's errors (shared/push.ts' PUSH_ERRORS). */
  errors: Record<string, { name: string; message: string }>;
  silentMessage: string;
}

export function pushShim(bridge: PushBridge, info: PushShimInfo) {
  // Runs on its own in the site's world: only what's defined in here exists.
  const g: any = globalThis;
  const PM = g.PushManager;
  const SWR = g.ServiceWorkerRegistration;
  const PS = g.PushSubscription;
  if (!PM || !SWR || !PS || !g.isSecureContext) return;
  const marker = Symbol.for("rune.push");
  if (SWR.prototype[marker]) return;
  Object.defineProperty(SWR.prototype, marker, { value: true });

  const E = info.errors;
  const errorOf = (e: { name: string; message: string }) =>
    e.name === "TypeError" ? new TypeError(e.message) : new DOMException(e.message, e.name);
  const call = async (method: string, args: Record<string, unknown>) => {
    const r = await bridge.call(method, args);
    if (r && r.error) {
      if (r.silent) console.error(info.silentMessage);
      throw errorOf(r.error);
    }
    return r ?? {};
  };

  const toB64 = (bytes: Uint8Array) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromB64 = (text: string): Uint8Array | null => {
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
    const s = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (s.length % 4 === 1) return null;
    try {
      return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  };
  const define = (target: any, name: string, value: any) =>
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: true });
  const getter = (target: any, name: string, get: () => any) =>
    Object.defineProperty(target, name, { get, configurable: true, enumerable: true });
  const illegal = () => new TypeError("Illegal invocation");

  // --- Which registration a PushManager belongs to --------------------------------------------------

  const registrationOf = new WeakMap<object, any>();
  const pmDescriptor = Object.getOwnPropertyDescriptor(SWR.prototype, "pushManager");
  if (!pmDescriptor?.get) return;
  const nativePushManager = pmDescriptor.get;
  getter(SWR.prototype, "pushManager", function (this: any) {
    const pm = nativePushManager.call(this);
    if (pm) registrationOf.set(pm, this);
    return pm;
  });
  const reg = (pm: any) => {
    const r = registrationOf.get(pm);
    if (!r) throw illegal();
    return r;
  };

  // --- PushSubscription -----------------------------------------------------------------------------

  interface Sub {
    endpoint: string;
    p256dh: string;
    auth: string;
    key: string;
    scope: string;
    options: any;
  }
  const subs = new WeakMap<object, Sub>();
  const sub = (s: any) => {
    const v = subs.get(s);
    if (!v) throw illegal();
    return v;
  };
  const optionsState = new WeakMap<object, ArrayBuffer>();
  const PSO = g.PushSubscriptionOptions;
  if (PSO) {
    getter(PSO.prototype, "applicationServerKey", function (this: any) {
      const key = optionsState.get(this);
      if (!key) throw illegal();
      return key;
    });
    getter(PSO.prototype, "userVisibleOnly", function (this: any) {
      if (!optionsState.has(this)) throw illegal();
      return true;
    });
  }
  const bufferOf = (b64: string) => {
    const bytes = fromB64(b64) ?? new Uint8Array();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };
  function makeSubscription(v: { endpoint: string; p256dh: string; auth: string; key: string }, scope: string) {
    const options = Object.create(PSO ? PSO.prototype : Object.prototype);
    optionsState.set(options, bufferOf(v.key));
    const s = Object.create(PS.prototype);
    subs.set(s, { ...v, scope, options });
    return s;
  }
  getter(PS.prototype, "endpoint", function (this: any) {
    return sub(this).endpoint;
  });
  getter(PS.prototype, "expirationTime", function (this: any) {
    sub(this);
    return null;
  });
  getter(PS.prototype, "options", function (this: any) {
    return sub(this).options;
  });
  const psMethods = {
    getKey(this: any, name: unknown) {
      const s = sub(this);
      if (name === "p256dh") return bufferOf(s.p256dh);
      if (name === "auth") return bufferOf(s.auth);
      throw new TypeError(
        `Failed to execute 'getKey' on 'PushSubscription': The provided value '${String(name)}' is not a valid enum value of type PushEncryptionKeyName.`,
      );
    },
    toJSON(this: any) {
      const s = sub(this);
      return { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } };
    },
    async unsubscribe(this: any) {
      const s = sub(this);
      const r = await call("unsubscribe", { scope: s.scope, endpoint: s.endpoint });
      return r.value === true;
    },
  };
  for (const [name, fn] of Object.entries(psMethods)) define(PS.prototype, name, fn);

  // --- PushManager ----------------------------------------------------------------------------------

  const NotificationApi = g.Notification;
  const requestPermission =
    !info.worker && typeof NotificationApi?.requestPermission === "function"
      ? NotificationApi.requestPermission.bind(NotificationApi)
      : null;

  /** The applicationServerKey as base64url, checked like blink does; null without one. */
  function keyOf(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    let bytes: Uint8Array | null;
    if (typeof value === "string") {
      bytes = fromB64(value);
      if (!bytes) throw errorOf(E.keyEncoding!);
    } else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
    else if (ArrayBuffer.isView(value))
      bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    else
      throw new TypeError(
        "Failed to execute 'subscribe' on 'PushManager': The provided value is not of type '(ArrayBuffer or ArrayBufferView or DOMString)'.",
      );
    if (bytes.length !== 65 || bytes[0] !== 4) throw errorOf(E.invalidKey!);
    return toB64(bytes);
  }

  const pmMethods = {
    async subscribe(this: any, options?: any) {
      const r = reg(this);
      const o = options ?? {};
      const key = keyOf(o.applicationServerKey);
      const userVisibleOnly = !!o.userVisibleOnly;
      if (!r.active) throw errorOf(E.noWorker!);
      const ask = (asked: boolean) =>
        bridge.call("subscribe", { scope: r.scope, key: key ?? "", userVisibleOnly, asked });
      let reply = await ask(false);
      // The notifications permission isn't decided: asked like Chrome does (the site permission prompt).
      if (reply?.prompt && requestPermission) {
        await requestPermission().catch(() => "default");
        reply = await ask(true);
      }
      if (!reply || reply.prompt) throw errorOf(E.permissionDenied!);
      if (reply.error) {
        if (reply.silent) console.error(info.silentMessage);
        throw errorOf(reply.error);
      }
      return makeSubscription(reply.value, r.scope);
    },
    async getSubscription(this: any) {
      const r = reg(this);
      const reply = await call("getSubscription", { scope: r.scope });
      return reply.value ? makeSubscription(reply.value, r.scope) : null;
    },
    async permissionState(this: any, options?: any) {
      reg(this);
      const reply = await call("permissionState", { userVisibleOnly: !!options?.userVisibleOnly });
      return reply.value;
    },
  };
  for (const [name, fn] of Object.entries(pmMethods)) define(PM.prototype, name, fn);
  const encodings = Object.freeze([...info.encodings]);
  Object.defineProperty(PM, "supportedContentEncodings", {
    get: () => encodings,
    configurable: true,
    enumerable: true,
  });

  // --- Notifications of a registration --------------------------------------------------------------

  const base = () => String(g.location?.href ?? "");
  const absolute = (url: unknown) => {
    if (typeof url !== "string" || !url) return "";
    try {
      return new URL(url, base()).href;
    } catch {
      return "";
    }
  };
  function makeNotification(n: any) {
    const proto = NotificationApi?.prototype ?? Object.prototype;
    const out = Object.create(proto);
    let data: unknown = null;
    try {
      data = JSON.parse(n.data);
    } catch {
      // stays null
    }
    const value = (v: unknown) => ({ value: v, enumerable: true });
    Object.defineProperties(out, {
      title: value(n.title),
      body: value(n.body),
      tag: value(n.tag),
      data: value(data),
      icon: value(n.icon),
      badge: value(n.badge),
      image: value(n.image),
      lang: value(n.lang),
      dir: value(n.dir),
      timestamp: value(n.timestamp),
      renotify: value(n.renotify),
      silent: value(n.silent),
      requireInteraction: value(n.requireInteraction),
      actions: value(Object.freeze(n.actions.map((a: any) => Object.freeze({ ...a })))),
      vibrate: value(Object.freeze([])),
      close: {
        value: () => {
          void bridge.call("closeNotification", { id: n.id }).catch(() => {});
        },
      },
    });
    return out;
  }
  const regMethods = {
    async showNotification(this: any, title?: unknown, options?: any) {
      if (arguments.length < 1)
        throw new TypeError(
          "Failed to execute 'showNotification' on 'ServiceWorkerRegistration': 1 argument required, but only 0 present.",
        );
      if (!this.active) throw new TypeError("No active registration available on the ServiceWorkerRegistration.");
      const o = options ?? {};
      let data = "null";
      try {
        data = JSON.stringify(o.data ?? null) ?? "null";
      } catch {
        throw new DOMException("The notification's data could not be serialized.", "DataCloneError");
      }
      const actions = Array.isArray(o.actions)
        ? o.actions.map((a: any) => ({
            action: String(a?.action ?? ""),
            title: String(a?.title ?? ""),
            icon: absolute(a?.icon),
          }))
        : [];
      await call("showNotification", {
        scope: this.scope,
        title: String(title),
        options: {
          body: o.body === undefined ? "" : String(o.body),
          tag: o.tag === undefined ? "" : String(o.tag),
          data,
          icon: absolute(o.icon),
          badge: absolute(o.badge),
          image: absolute(o.image),
          lang: o.lang === undefined ? "" : String(o.lang),
          dir: o.dir,
          timestamp: typeof o.timestamp === "number" ? o.timestamp : undefined,
          renotify: !!o.renotify,
          silent: o.silent === undefined || o.silent === null ? null : !!o.silent,
          requireInteraction: !!o.requireInteraction,
          actions,
        },
      });
      return undefined;
    },
    async getNotifications(this: any, filter?: any) {
      const reply = await call("getNotifications", { scope: this.scope, tag: filter?.tag ? String(filter.tag) : "" });
      return (reply.value as any[]).map(makeNotification);
    },
  };
  for (const [name, fn] of Object.entries(regMethods)) define(SWR.prototype, name, fn);

  if (!info.worker) return;

  // --- A service worker: its events, and windows after a click --------------------------------------

  const clients = g.clients;
  const Clients = g.Clients;
  if (Clients?.prototype) {
    define(Clients.prototype, "openWindow", async function openWindow(this: any, url: unknown) {
      const target = absolute(String(url));
      const reply = await call("openWindow", { url: target });
      if (!reply.value) return null;
      // The new tab's page as a client of this worker's (none if it's another site's, like in Chrome).
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
        const found = all.find((c: any) => c.url === reply.value);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    });
  }
  const WindowClient = g.WindowClient;
  if (WindowClient?.prototype) {
    define(WindowClient.prototype, "focus", async function focus(this: any) {
      const reply = await call("focus", { url: this.url });
      if (!reply.value) throw new TypeError("Failed to focus window.");
      return this;
    });
  }

  function pushData(bytes: Uint8Array) {
    const copy = () => bytes.slice();
    const text = () => new TextDecoder().decode(bytes);
    return {
      arrayBuffer: () => copy().buffer,
      bytes: copy,
      blob: () => new Blob([copy()]),
      text,
      json: () => JSON.parse(text()),
    };
  }

  function eventFor(e: any): any {
    if (e.type === "push") {
      const bytes = e.data ? fromB64(e.data) : null;
      const init = bytes && bytes.length ? { data: bytes.slice().buffer } : {};
      try {
        return new g.PushEvent("push", init);
      } catch {
        const event = new g.ExtendableEvent("push");
        Object.defineProperty(event, "data", {
          value: bytes && bytes.length ? pushData(bytes) : null,
          enumerable: true,
        });
        return event;
      }
    }
    const event = new g.ExtendableEvent(e.type);
    Object.defineProperties(event, {
      notification: { value: makeNotification(e.notification), enumerable: true },
      action: { value: e.action ?? "", enumerable: true },
      reply: { value: null, enumerable: true },
    });
    return event;
  }

  bridge.onEvent((e: any) => {
    if (!e || typeof e.id !== "number") return;
    setTimeout(async () => {
      const waiting: Promise<unknown>[] = [];
      try {
        const event = eventFor(e);
        // waitUntil() as on a real event: the worker stays up until what it was given settles.
        define(event, "waitUntil", (p: unknown) => {
          waiting.push(Promise.resolve(p));
        });
        g.dispatchEvent(event);
        // Promises can add more while they run: until none are left.
        for (let done = 0; done < waiting.length;) {
          const batch = waiting.slice(done);
          done = waiting.length;
          await Promise.allSettled(batch);
        }
      } catch (err) {
        console.error(err);
      }
      void bridge.call("done", { id: e.id }).catch(() => {});
    }, 0);
  });
}
