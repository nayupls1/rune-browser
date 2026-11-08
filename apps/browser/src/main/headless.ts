// Headless tabs (docs/browsing.md: Headless tabs): pages the website agent loads
// in the background only to read their data. They're never shown and are kept
// cheap: no images, WebGL, sound, popups, downloads, dialogs or permissions.
//
// - Without logins (the default) a page loads in a session of its own that
//   lives in memory and is cleared when the last such tab closes: no cookies,
//   no logins, nothing kept.
// - With logins it uses the workspace's web tab session, for the hosts the user
//   allowed (agent.headless, asked by the server); the page can't go to other
//   hosts there (a redirect or a link to one is stopped and reported).
// - This computer and the local network are out of reach (by address, like
//   shared/insecure.ts decides what's local), and only websites load.
//
// They close when the agent closes them, when its turn ends (the server), after
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
/** In memory only (no "persist:"): nothing is written to disk. */
const PARTITION = "rune-headless";

interface Entry {
  info: HeadlessInfo;
  contents: WebContents;
  view: WebContentsView;
  /** The Rune Browser window that opened it. */
  owner: WebContents;
  /** With logins: the hosts it may load (main frame). */
  hosts: Set<string> | null;
  /** The last navigation that was stopped. */
  blocked?: HeadlessPage["blocked"];
  lastUsed: number;
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

export function setupHeadless(options: {
  windows: AppWindows;
  /** The session of a workspace's web tabs (with the user's logins). */
  webSession: (workspaceId: string) => Session;
  userAgent: string;
}) {
  const entries = new Map<string, Entry>();
  const byContents = new Map<number, Entry>();

  let own: Session | undefined;
  /** The session for tabs without logins, set up on first use. */
  function ownSession() {
    if (own) return own;
    const s = session.fromPartition(PARTITION);
    s.setUserAgent(options.userAgent);
    s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    // The page's own requests can't reach this computer or the local network either.
    s.webRequest.onBeforeRequest((details, callback) => {
      const host = hostOf(details.url);
      callback({ cancel: !!host && /^(https?|wss?):/i.test(details.url) && isLocalHost(host) });
    });
    own = s;
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
    const s = request.logins ? options.webSession(request.workspaceId) : ownSession();
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
      contents,
      view,
      owner,
      hosts: request.logins ? new Set((request.hosts ?? []).map((h) => h.toLowerCase())) : null,
      lastUsed: Date.now(),
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
    contents.on("did-navigate", (_event, url) => {
      entry.info.url = url;
      changed(owner);
    });
    contents.on("render-process-gone", () => close(entry.info.id));
    // alert(), confirm() and prompt() are answered right away (nobody would see them).
    if (acquire(contents, "headless")) {
      contents.debugger.on("message", (_event, method) => {
        if (method === "Page.javascriptDialogOpening")
          void send(contents, "Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
      });
      void send(contents, "Page.enable").catch(() => {});
    }
    watchOwner(owner);
    changed(owner);
    return entry;
  }

  async function load(entry: Entry, url: string): Promise<HeadlessPage> {
    entry.lastUsed = Date.now();
    entry.blocked = undefined;
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
    // The last one without logins: what its pages left behind (cookies, storage, cache) goes too.
    if (own && !entry.hosts && ![...entries.values()].some((e) => !e.hosts)) {
      void own.clearStorageData().catch(() => {});
      void own.clearCache().catch(() => {});
    }
    return true;
  }

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
    if (entries.size >= MAX_HEADLESS) throw new Error(`At most ${MAX_HEADLESS} headless tabs can be open at once`);
    return load(create(request, event.sender), request.url);
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

  ipcMain.handle("rune:headless-list", (event) => (options.windows.isUi(event.sender) ? listFor(event.sender) : []));

  return {
    /** A headless tab's page (no downloads, no sign-in prompts, no permission prompts). */
    isHeadless: (contents: WebContents) => byContents.has(contents.id),
  };
}
