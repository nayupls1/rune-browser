// Headless tabs (docs/browsing.md: Headless tabs): pages the website agent loads
// in the background only to read their data. They're never shown and are kept
// cheap: no images, WebGL, sound, popups, downloads, dialogs or permissions.
//
// - Without logins (the default) a page loads in a session of its own (one per
//   workspace) that lives in memory and is cleared when its last tab closes: no
//   cookies, no logins, nothing kept.
// - With logins it uses the workspace's web tab session, for the hosts the user
//   allowed (agent.headless, asked by the server); the page can't go to other
//   hosts there (a redirect or a link to one is stopped and reported).
// - This computer and the local network are out of reach, by name (like
//   shared/insecure.ts decides what's local) and by the addresses a name
//   resolves to, and only websites load.
//
// They close when the agent closes them, when its turn ends (the server closes
// all of its tab's, also one still loading), after
// IDLE_MS unused or MAX_LIFETIME_MS in all, when the window that opened them
// closes or reloads, and when Rune Browser quits. The renderer relays the
// server's requests (renderer: lib/headless.ts) and lists them in the agent's tab.
import { app, ipcMain, session, WebContentsView, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { HeadlessInfo, HeadlessOpenRequest, HeadlessPage } from "../shared/api";
import { isLocalHost } from "../shared/insecure";
import { headlessUrlProblem } from "../shared/web";
import { acquire, send } from "./cdp";
import type { AppWindows } from "./windows";

/** At most this many at once, in all (the server allows fewer per agent). */
export const MAX_HEADLESS = 8;
/** Closed after this long without being used. */
const IDLE_MS = 3 * 60_000;
/** Closed after this long in any case. */
const MAX_LIFETIME_MS = 15 * 60_000;
/** Loading gives up waiting after this long (the page keeps what it has). */
const LOAD_TIMEOUT_MS = 30_000;
/** A script in the page gives up after this long. */
const EVAL_TIMEOUT_MS = 30_000;
/** In memory only (no "persist:"): nothing is written to disk. One per workspace. */
const PARTITION = "rune-headless";
/** The size pages lay out at (a laptop's window). */
const VIEWPORT = { width: 1280, height: 900 };
/**
 * For the e2e checks only: names that may resolve to a local address (their test site
 * under a name that isn't local, mapped with --host-resolver-rules). The names
 * themselves are still checked.
 */
const testHosts = new Set(
  (!app.isPackaged ? (process.env.RUNE_HEADLESS_TEST_HOSTS ?? "") : "").split(",").filter(Boolean),
);
/** What a name resolved to is remembered this long (a page asks for many things from the same hosts). */
const RESOLVED_MS = 10_000;

/**
 * Runs in each frame of a page with logins, once per document: a password a password manager fills in
 * is cleared right away (also in open shadow roots), so the agent's scripts never see one. It knows the
 * shadow roots from watching what the page adds, so clearing only looks at password fields. It runs in
 * an isolated world, out of the page's scripts' reach, before them (CDP); frames in another process get
 * it in their own world once they're ready.
 */
const NO_PASSWORDS = `(() => {
  if (window.__runeNoPasswords) return;
  window.__runeNoPasswords = true;
  const start = () => {
    const roots = new Set([document]);
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) find(node);
    });
    const add = (root) => {
      if (roots.has(root)) return;
      roots.add(root);
      observer.observe(root, { childList: true, subtree: true });
      find(root);
    };
    const find = (node) => {
      if (node.shadowRoot) add(node.shadowRoot);
      for (const el of node.querySelectorAll("*")) if (el.shadowRoot) add(el.shadowRoot);
    };
    observer.observe(document, { childList: true, subtree: true });
    find(document);
    const clear = () => {
      for (const root of roots)
        for (const input of root.querySelectorAll("input[type=password]")) if (input.value) input.value = "";
    };
    clear();
    document.addEventListener("input", clear, true);
    document.addEventListener("change", clear, true);
    setInterval(clear, 50);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})()`;

interface Entry {
  info: HeadlessInfo;
  session: Session;
  contents: WebContents;
  view: WebContentsView;
  /** The Rune Browser window that opened it. */
  owner: WebContents;
  /** With logins: the hosts it may load (main frame). */
  hosts: Set<string> | null;
  /** The last navigation that was stopped. */
  blocked?: HeadlessPage["blocked"];
  lastUsed: number;
  /** Sets up the page before it first loads (CDP), once. */
  prepare: (() => Promise<unknown>) | null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** The promise's value, or after `ms` the fallback's (which may throw). */
const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: () => T) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(fallback());
      } catch (err) {
        reject(err);
      }
    }, ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

/** An address of this computer or the local network ("::1" too). */
const isLocalAddress = (address: string) => isLocalHost(address.includes(":") ? `[${address}]` : address);

export function setupHeadless(options: {
  windows: AppWindows;
  /** The session of a workspace's web tabs (with the user's logins). */
  webSession: (workspaceId: string) => Session;
  userAgent: string;
}) {
  const entries = new Map<string, Entry>();
  const byContents = new Map<number, Entry>();

  /** Whether a name resolves to this computer or the local network (a name like 127.0.0.1.nip.io, DNS rebinding). */
  const resolved = new WeakMap<Session, Map<string, { local: Promise<boolean>; at: number }>>();
  function resolvesLocal(s: Session, host: string): Promise<boolean> {
    if (!host || testHosts.has(host) || /^[\d.]+$|^\[/.test(host)) return Promise.resolve(false);
    let hosts = resolved.get(s);
    if (!hosts) resolved.set(s, (hosts = new Map()));
    const known = hosts.get(host);
    if (known && Date.now() - known.at < RESOLVED_MS) return known.local;
    const local = s.resolveHost(host).then(
      (r) => r.endpoints.some((e) => isLocalAddress(e.address)),
      () => false, // Not found: loading it fails anyway.
    );
    if (hosts.size > 500) hosts.clear();
    hosts.set(host, { local, at: Date.now() });
    return local;
  }

  const own = new Map<string, Session>();
  /** Sessions being cleared after their last tab closed: a new tab waits for it. */
  const clearing = new Map<Session, Promise<unknown>>();
  /** A workspace's session for tabs without logins, set up on first use. */
  function ownSession(workspaceId: string) {
    const known = own.get(workspaceId);
    if (known) return known;
    const s = session.fromPartition(`${PARTITION}-${workspaceId}`);
    s.setUserAgent(options.userAgent);
    s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    // The page's own requests can't reach this computer or the local network either.
    s.webRequest.onBeforeRequest((details, callback) => {
      const host = hostOf(details.url);
      if (!host || !/^(https?|wss?):/i.test(details.url)) return callback({});
      if (isLocalHost(host)) return callback({ cancel: true });
      void resolvesLocal(s, host).then((local) => callback({ cancel: local }));
    });
    own.set(workspaceId, s);
    return s;
  }

  const listFor = (owner: WebContents) =>
    [...entries.values()].filter((e) => e.owner === owner).map((e) => ({ ...e.info }));
  const changed = (owner: WebContents) => {
    if (!owner.isDestroyed()) owner.send("rune:headless-changed", listFor(owner));
  };

  /** Stops a main-frame navigation the tab may not make; true if it did. */
  function stopped(entry: Entry, url: string) {
    const reason = headlessUrlProblem(url)
      ? "not-a-website"
      : entry.hosts && !entry.hosts.has(hostOf(url))
        ? "not-allowed"
        : null;
    if (!reason) return false;
    entry.blocked = { url, reason };
    return true;
  }

  function create(request: HeadlessOpenRequest, owner: WebContents): Entry {
    const s = request.logins ? options.webSession(request.workspaceId) : ownSession(request.workspaceId);
    const view = new WebContentsView({
      webPreferences: {
        session: s,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // Only the data: no images, WebGL or spell checking, and timers run at full speed although
        // nothing is shown.
        images: false,
        webgl: false,
        spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: "document-user-activation-required",
      },
    });
    // Never shown, but laid out like a window: responsive pages show their usual layout.
    view.setBounds({ x: 0, y: 0, ...VIEWPORT });
    const contents = view.webContents;
    const entry: Entry = {
      info: {
        id: randomUUID(),
        tabId: request.tabId,
        url: request.url,
        title: "",
        logins: request.logins,
        openedAt: Date.now(),
      },
      session: s,
      contents,
      view,
      owner,
      hosts: request.logins ? new Set((request.hosts ?? []).map((h) => h.toLowerCase())) : null,
      lastUsed: Date.now(),
      prepare: null,
    };
    entries.set(entry.info.id, entry);
    byContents.set(contents.id, entry);
    contents.setAudioMuted(true);
    // No popups, no leaving the page's rules behind by navigating, no beforeunload prompts.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => {
      if (stopped(entry, event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame && stopped(entry, event.url)) event.preventDefault();
    });
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.on("page-title-updated", (_event, title) => {
      entry.info.title = title;
      changed(owner);
    });
    const moved = (url: string) => {
      entry.info.url = url;
      changed(owner);
    };
    contents.on("did-navigate", (_event, url) => moved(url));
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => isMainFrame && moved(url));
    contents.on("render-process-gone", () => close(entry.info.id));
    // alert(), confirm() and prompt() are answered right away (nobody would see them).
    const cdp = acquire(contents, "headless");
    if (cdp) {
      contents.debugger.on("message", (_event, method) => {
        if (method === "Page.javascriptDialogOpening")
          void send(contents, "Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
      });
      void send(contents, "Page.enable").catch(() => {});
      // DevTools only answers once the page has a renderer: after a first (blank) page.
      if (request.logins)
        entry.prepare = async () => {
          await contents.loadURL("about:blank").catch(() => {});
          if (contents.isDestroyed()) return;
          await withTimeout(
            send(contents, "Page.addScriptToEvaluateOnNewDocument", {
              source: NO_PASSWORDS,
              worldName: "rune-no-passwords",
              runImmediately: true,
            }).catch(() => {}),
            5_000,
            () => undefined,
          );
        };
    }
    if (request.logins && !cdp)
      contents.on(
        "dom-ready",
        () => void contents.executeJavaScriptInIsolatedWorld(1029, [{ code: NO_PASSWORDS }]).catch(() => {}),
      );
    if (request.logins) {
      // Frames in another process (other sites) are out of the script's reach: they get it once ready.
      contents.on("frame-created", (_event, { frame }) => {
        frame?.on("dom-ready", () => {
          if (frame.isDestroyed() || (cdp && frame.processId === contents.mainFrame.processId)) return;
          void frame.executeJavaScript(NO_PASSWORDS).catch(() => {});
        });
      });
    }
    watchOwner(owner);
    changed(owner);
    return entry;
  }

  async function load(entry: Entry, url: string): Promise<HeadlessPage> {
    entry.lastUsed = Date.now();
    entry.blocked = undefined;
    if (await resolvesLocal(entry.session, hostOf(url))) {
      entry.blocked = { url, reason: "not-a-website" };
      return page(entry);
    }
    const prepare = entry.prepare;
    entry.prepare = null;
    if (prepare) await prepare();
    // Closed meanwhile (its turn ended, the user closed it, unused for too long).
    if (entry.contents.isDestroyed()) throw new Error("This headless tab is closed");
    let error: string | undefined;
    await withTimeout(
      entry.contents.loadURL(url).then(
        () => undefined,
        (err: unknown) => {
          // Stopped by us (blocked) or by the page moving on: not an error of its own.
          const message = err instanceof Error ? err.message : String(err);
          if (!/ERR_ABORTED/.test(message)) error = message.replace(/^.*?(ERR_[A-Z_]+).*$/s, "$1");
        },
      ),
      LOAD_TIMEOUT_MS,
      () => undefined,
    );
    entry.lastUsed = Date.now();
    return page(entry, error);
  }

  const page = (entry: Entry, error?: string): HeadlessPage => ({
    id: entry.info.id,
    url: entry.contents.isDestroyed() ? entry.info.url : entry.contents.getURL() || entry.info.url,
    title: entry.contents.isDestroyed() ? entry.info.title : entry.contents.getTitle(),
    ...(entry.blocked ? { blocked: entry.blocked } : {}),
    ...(error ? { error } : {}),
  });

  function close(id: string) {
    const entry = entries.get(id);
    if (!entry) return false;
    entries.delete(id);
    byContents.delete(entry.contents.id);
    try {
      if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false });
    } catch (err) {
      console.warn("Closing a headless tab failed:", err);
    }
    changed(entry.owner);
    // The last one in a session without logins: what its pages left behind (cookies, storage, cache) goes too.
    const s = entry.session;
    if (!entry.hosts && ![...entries.values()].some((e) => e.session === s)) {
      const done = Promise.allSettled([s.clearStorageData(), s.clearCache()]).finally(() => {
        if (clearing.get(s) === done) clearing.delete(s);
      });
      clearing.set(s, done);
    }
    return true;
  }

  /** Closes the headless tabs a tab's agent opened (its turn ended); how many. */
  /** Opens of a tab waiting for their session: when the tab's headless tabs are all closed, they give up. */
  const waiting = new Map<string, Set<{ cancelled: boolean }>>();
  const closeOf = (tabId: string) => {
    for (const open of waiting.get(tabId) ?? []) open.cancelled = true;
    return [...entries.values()].filter((e) => e.info.tabId === tabId).filter((e) => close(e.info.id)).length;
  };

  const watched = new WeakSet<WebContents>();
  /** A window that closes or reloads takes its headless tabs with it (its agents are gone with it). */
  function watchOwner(owner: WebContents) {
    if (watched.has(owner)) return;
    watched.add(owner);
    const closeAll = () => {
      for (const entry of [...entries.values()]) if (entry.owner === owner) close(entry.info.id);
    };
    owner.once("destroyed", closeAll);
    owner.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) closeAll();
    });
  }

  // Unused or open for too long: closed, whatever the agent does.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const entry of [...entries.values()])
      if (now - entry.lastUsed > IDLE_MS || now - entry.info.openedAt > MAX_LIFETIME_MS) close(entry.info.id);
  }, 15_000);
  sweep.unref?.();
  app.on("will-quit", () => {
    clearInterval(sweep);
    for (const id of [...entries.keys()]) close(id);
  });

  const entryFor = (event: Electron.IpcMainInvokeEvent, id: unknown) => {
    if (!options.windows.isUi(event.sender) || typeof id !== "string") throw new Error("Unknown headless tab");
    const entry = entries.get(id);
    if (!entry || entry.contents.isDestroyed()) throw new Error("This headless tab is closed");
    return entry;
  };
  const hostList = (hosts: unknown) =>
    Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string" && /^[\w.-]+$/.test(h)) : [];

  ipcMain.handle("rune:headless-open", async (event, value: unknown) => {
    if (!options.windows.isUi(event.sender)) throw new Error("Not allowed");
    const v = (value ?? {}) as Partial<Record<keyof HeadlessOpenRequest, unknown>>;
    if (typeof v.url !== "string" || typeof v.tabId !== "string" || typeof v.workspaceId !== "string")
      throw new Error("Missing url, tabId or workspaceId");
    if (!/^[\w-]+$/.test(v.workspaceId)) throw new Error("Unknown workspace");
    const problem = headlessUrlProblem(v.url);
    if (problem) throw new Error(problem);
    const request: HeadlessOpenRequest = {
      tabId: v.tabId,
      workspaceId: v.workspaceId,
      url: v.url,
      logins: v.logins === true,
      hosts: hostList(v.hosts),
    };
    if (request.logins && !request.hosts!.includes(hostOf(request.url)))
      throw new Error("With logins, the page's host has to be allowed first");
    const wait = { cancelled: false };
    const others = waiting.get(request.tabId) ?? new Set();
    waiting.set(request.tabId, others.add(wait));
    try {
      if (!request.logins) await clearing.get(ownSession(request.workspaceId));
    } finally {
      others.delete(wait);
      if (!others.size) waiting.delete(request.tabId);
    }
    // Its agent's turn ended while it waited.
    if (wait.cancelled) throw new Error("The agent's turn ended");
    if (entries.size >= MAX_HEADLESS) throw new Error(`At most ${MAX_HEADLESS} headless tabs can be open at once`);
    const entry = create(request, event.sender);
    const opened = await load(entry, request.url);
    // Refused before anything loaded (a name of the local network): no tab is left behind.
    if (opened.blocked?.reason === "not-a-website" && !entry.contents.isDestroyed() && !entry.contents.getURL()) {
      close(entry.info.id);
      throw new Error("Headless tabs don't open this computer or the local network, only websites.");
    }
    return opened;
  });

  ipcMain.handle("rune:headless-navigate", async (event, id: unknown, url: unknown, hosts: unknown) => {
    const entry = entryFor(event, id);
    if (typeof url !== "string") throw new Error("Missing url");
    const problem = headlessUrlProblem(url);
    if (problem) throw new Error(problem);
    if (entry.hosts) {
      for (const host of hostList(hosts)) entry.hosts.add(host.toLowerCase());
      if (!entry.hosts.has(hostOf(url))) throw new Error("With logins, the page's host has to be allowed first");
    }
    return load(entry, url);
  });

  ipcMain.handle("rune:headless-eval", async (event, id: unknown, code: unknown) => {
    const entry = entryFor(event, id);
    if (typeof code !== "string") throw new Error("Missing code");
    entry.lastUsed = Date.now();
    try {
      return await withTimeout(entry.contents.executeJavaScript(code), EVAL_TIMEOUT_MS, () => {
        throw new Error(`The script didn't finish within ${EVAL_TIMEOUT_MS / 1000}s`);
      });
    } finally {
      entry.lastUsed = Date.now();
    }
  });

  ipcMain.handle("rune:headless-close", (event, id: unknown) => {
    if (!options.windows.isUi(event.sender) || typeof id !== "string") return false;
    return close(id);
  });

  ipcMain.handle("rune:headless-close-tab", (event, tabId: unknown) =>
    options.windows.isUi(event.sender) && typeof tabId === "string" ? closeOf(tabId) : 0,
  );

  ipcMain.handle("rune:headless-list", (event) => (options.windows.isUi(event.sender) ? listFor(event.sender) : []));

  return {
    /** A headless tab's page (no downloads, no sign-in prompts, no permissions). */
    isHeadless: (contents: WebContents) => byContents.has(contents.id),
  };
}
