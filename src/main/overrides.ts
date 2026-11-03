// Response overrides (shared/overrides.ts) in web tabs: the DevTools protocol's
// Fetch domain pauses a tab's API requests (fetch, XHR, EventSource) while an
// override could apply to it, and answers the ones that match instead of the
// site, changes the site's answer, fails them, delays them or leaves them
// hanging. Tabs without overrides aren't intercepted at all.
//
// The Rune Browser window sends the list (lib/webtabs.ts), with tab-scoped
// overrides resolved to their tab's webContents.
import { ipcMain, type Session, type WebContents } from "electron";
import type { AppWindows } from "./windows";
import type { ResponseOverride } from "../shared/api";
import {
  answerHeaders,
  answersAlone,
  isLive,
  preflightHeaders,
  requestMatches,
  scopeCovers,
  type HeaderList,
} from "../shared/overrides";
import * as cdp from "./cdp";

type Active = ResponseOverride & { webContentsId: number | null };

interface Tab {
  contents: WebContents;
  intercepting: boolean;
  /** Paused at the request: answers that never come, until their override goes. */
  hung: Map<string, string>;
  /** Let through to the site: the override that changes its answer, by Fetch request id. */
  answering: Map<string, Active>;
  /** Waiting out a delay. */
  timers: Set<ReturnType<typeof setTimeout>>;
  onMessage: (event: unknown, method: string, params: any) => void;
}

const API_TYPES = ["XHR", "Fetch", "EventSource"];

export interface OverridesOptions {
  windows: AppWindows;
  /** The workspace a web tab session belongs to; app previews have none and aren't intercepted. */
  workspaceOf: (session: Session) => string | undefined;
  /** A request of a tab was answered by an override (DevTools' Network request id), for its log. */
  onOverridden: (webContentsId: number, requestId: string, title: string) => void;
}

export function setupOverrides(options: OverridesOptions) {
  let list: Active[] = [];
  const tabs = new Map<number, Tab>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  /** The live overrides that could apply to a tab (its page's URL decides site scopes later). */
  const candidates = (contents: WebContents) => {
    if (contents.isDestroyed()) return [];
    const workspaceId = options.workspaceOf(contents.session);
    const now = Date.now();
    return list.filter(
      (o) =>
        isLive(o, now) && (o.scope.type === "tab" ? o.webContentsId === contents.id : o.workspaceId === workspaceId),
    );
  };

  /** Starts watching a web tab. */
  function track(contents: WebContents) {
    if (tabs.has(contents.id) || options.workspaceOf(contents.session) === undefined) return;
    const tab: Tab = {
      contents,
      intercepting: false,
      hung: new Map(),
      answering: new Map(),
      timers: new Set(),
      onMessage: (_event, method, params) => {
        if (method === "Fetch.requestPaused") void paused(tab, params).catch(() => {});
      },
    };
    tabs.set(contents.id, tab);
    contents.once("destroyed", () => {
      for (const timer of tab.timers) clearTimeout(timer);
      tabs.delete(contents.id);
    });
    contents.debugger.on("detach", () => {
      tab.intercepting = false;
      tab.hung.clear();
      tab.answering.clear();
      contents.debugger.removeListener("message", tab.onMessage);
    });
    // A new page: what was hanging was cancelled with the old one.
    contents.on("did-start-navigation", (_e, _url, inPage, isMainFrame) => {
      if (isMainFrame && !inPage) tab.hung.clear();
    });
    update(tab);
  }

  function update(tab: Tab) {
    const { contents } = tab;
    if (contents.isDestroyed()) return;
    const active = candidates(contents);
    if (active.length && !tab.intercepting) void start(tab);
    else if (!active.length && tab.intercepting) stop(tab);
    // Hanging requests whose override is gone go on to the site.
    const live = new Set(active.map((o) => o.id));
    for (const [requestId, overrideId] of [...tab.hung]) {
      if (live.has(overrideId)) continue;
      tab.hung.delete(requestId);
      void cdp.send(contents, "Fetch.continueRequest", { requestId }).catch(() => {});
    }
  }

  async function start(tab: Tab) {
    const { contents } = tab;
    if (!cdp.acquire(contents, "overrides")) return;
    tab.intercepting = true;
    contents.debugger.on("message", tab.onMessage);
    const patterns = (types: string[]) => types.map((resourceType) => ({ urlPattern: "*", resourceType }));
    try {
      // CORS preflights too, so an answer made up for another origin isn't refused before it's asked for.
      await cdp.send(contents, "Fetch.enable", { patterns: patterns([...API_TYPES, "Preflight"]) });
    } catch {
      await cdp
        .send(contents, "Fetch.enable", { patterns: patterns(API_TYPES) })
        .catch((err) => console.warn("Can't override the responses of a web tab:", err));
    }
  }

  function stop(tab: Tab) {
    const { contents } = tab;
    tab.intercepting = false;
    contents.debugger.removeListener("message", tab.onMessage);
    for (const timer of tab.timers) clearTimeout(timer);
    tab.timers.clear();
    // Paused requests go on as they are.
    const waiting = [...tab.hung.keys(), ...tab.answering.keys()];
    tab.hung.clear();
    tab.answering.clear();
    void Promise.all(
      waiting.map((requestId) => cdp.send(contents, "Fetch.continueRequest", { requestId }).catch(() => {})),
    )
      .then(() => cdp.send(contents, "Fetch.disable"))
      .catch(() => {})
      .finally(() => cdp.release(contents, "overrides"));
  }

  const later = (tab: Tab, ms: number, fn: () => Promise<unknown>) => {
    if (ms <= 0) return void fn().catch(() => {});
    const timer = setTimeout(() => {
      tab.timers.delete(timer);
      void fn().catch(() => {});
    }, ms);
    tab.timers.add(timer);
  };

  const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

  async function paused(tab: Tab, p: any) {
    const { contents } = tab;
    const send = (method: string, params: object) => cdp.send(contents, method, params);
    const requestId: string = p.requestId;
    const go = () => send("Fetch.continueRequest", { requestId });

    // The site answered a request whose answer an override changes.
    if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) {
      const o = tab.answering.get(requestId);
      tab.answering.delete(requestId);
      if (!o || p.responseErrorReason !== undefined) return go();
      const site: HeaderList = p.responseHeaders ?? [];
      const responseCode = o.status ?? p.responseStatusCode;
      const responseHeaders = answerHeaders(o, site, { url: p.request.url, origin: null });
      if (o.body !== null)
        return send("Fetch.fulfillRequest", { requestId, responseCode, responseHeaders, body: base64(o.body) });
      try {
        return await send("Fetch.continueResponse", { requestId, responseCode, responseHeaders });
      } catch {
        const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId });
        return send("Fetch.fulfillRequest", {
          requestId,
          responseCode,
          responseHeaders,
          body: base64Encoded ? body : base64(body),
        });
      }
    }

    const request = p.request as { url: string; method: string; headers: Record<string, string> };
    const header = (name: string) =>
      Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
    const preflightFor = request.method === "OPTIONS" ? header("access-control-request-method") : null;
    const pageUrl = contents.isDestroyed() ? "" : contents.getURL();
    const o = candidates(contents).find(
      (o) =>
        scopeCovers(o.scope, pageUrl, () => o.webContentsId === contents.id) &&
        requestMatches(o, preflightFor ?? request.method, request.url),
    );
    if (!o) return go();

    if (preflightFor !== null) {
      // The real request is answered without the site: so is its preflight.
      const origin = header("origin");
      if (!origin || !answersAlone(o) || o.kind !== "respond") return go();
      return send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 204,
        responseHeaders: preflightHeaders(origin, preflightFor, header("access-control-request-headers") ?? ""),
      });
    }

    if (p.networkId) options.onOverridden(contents.id, p.networkId, o.title);
    if (o.kind === "hang") {
      tab.hung.set(requestId, o.id);
      return;
    }
    if (o.kind === "fail")
      return later(tab, o.delayMs, () => send("Fetch.failRequest", { requestId, errorReason: o.failure }));
    if (answersAlone(o)) {
      return later(tab, o.delayMs, () =>
        send("Fetch.fulfillRequest", {
          requestId,
          responseCode: o.status,
          responseHeaders: answerHeaders(o, null, { url: request.url, origin: header("origin") }),
          body: base64(o.body ?? ""),
        }),
      );
    }
    // Only a delay: the site's answer, later.
    if (o.status === null && o.body === null && !Object.keys(o.headers).length) return later(tab, o.delayMs, go);
    tab.answering.set(requestId, o);
    return later(tab, o.delayMs, () => send("Fetch.continueRequest", { requestId, interceptResponse: true }));
  }

  function set(next: Active[]) {
    list = next;
    for (const tab of tabs.values()) update(tab);
    // Expired ones stop by themselves (the server deletes them when they're next listed).
    clearTimeout(expiryTimer);
    const now = Date.now();
    const next_ = Math.min(
      ...list.map((o) => (o.expiresAt ? Date.parse(o.expiresAt) : Infinity)).filter((t) => t > now),
    );
    if (Number.isFinite(next_)) expiryTimer = setTimeout(() => set(list), Math.min(next_ - now + 50, 2 ** 31 - 1));
  }

  ipcMain.on("rune:network-overrides", (event, value: unknown) => {
    if (!options.windows.isUi(event.sender) || !Array.isArray(value)) return;
    set(value as Active[]);
  });

  return { track };
}
