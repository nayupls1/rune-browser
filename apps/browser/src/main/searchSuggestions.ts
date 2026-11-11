// The search engine's suggestions for the address bar, fetched here rather
// than in the renderer or a page: only Rune Browser's own UI may ask, the
// engine comes from the settings in effect (not from the asker), and requests
// go out through a session of their own, in memory, without the user's
// cookies or logins (no cookies sent or kept, no cache). What's typed is
// checked again (shared/searchSuggestions.ts) before it leaves; a newer
// request from the same window cancels the one before it, every request has a
// short timeout, and the answer, untrusted, is read up to a size and parsed
// defensively. Private windows get them too, like Chrome's: the session has
// nothing that ties them to the user.
import { app, ipcMain, session, type Session, type WebContents } from "electron";
import type { BrowserSettings } from "../shared/browser";
import { suggestUrlOf } from "../shared/browser";
import { MAX_SUGGEST_QUERY, maySuggestFor, parseSuggestions, suggestRequestUrl } from "../shared/searchSuggestions";
import { chromeUserAgent } from "./userAgent";
import type { AppWindows } from "./windows";

/** In memory (no `persist:`): nothing it gets is written to disk. */
const PARTITION = "rune-search-suggestions";
const TIMEOUT_MS = 1500;
/** Answers bigger than this are cut off (and then aren't JSON: no suggestions). */
const MAX_BODY = 64 * 1024;

/**
 * For the e2e checks only: suggestions come only from a local fake engine, so a run never sends what the
 * checks type to a real search engine.
 */
const localOnly = !app.isPackaged && process.env.RUNE_SEARCH_SUGGESTIONS_LOCAL_ONLY === "1";
const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url);

export interface SearchSuggestionsOptions {
  windows: AppWindows;
  /** The browser settings in effect: the search engine, and whether suggestions are on. */
  settings: () => BrowserSettings;
}

export function setupSearchSuggestions(options: SearchSuggestionsOptions) {
  let suggestSession: Session | undefined;
  /** Its own session: no logins, cookies neither sent nor kept, no cache, a plain Chrome user agent. */
  const sessionFor = () => {
    if (suggestSession) return suggestSession;
    const s = session.fromPartition(PARTITION, { cache: false });
    s.setUserAgent(chromeUserAgent);
    s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    s.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) if (/^(cookie|authorization)$/i.test(name)) delete headers[name];
      callback({ requestHeaders: headers });
    });
    s.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const name of Object.keys(headers)) if (/^set-cookie2?$/i.test(name)) delete headers[name];
      callback({ responseHeaders: headers });
    });
    suggestSession = s;
    return s;
  };

  /** The request in flight for each window's UI: a newer one cancels it. */
  const inFlight = new Map<number, AbortController>();
  /** The windows' UIs that asked: a closed one's request is cancelled. */
  const watched = new Set<number>();

  async function readCapped(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        void reader.cancel().catch(() => {});
        return "";
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }

  async function suggest(sender: WebContents, query: string): Promise<string[]> {
    inFlight.get(sender.id)?.abort();
    inFlight.delete(sender.id);
    const template = suggestUrlOf(options.settings());
    if (!template || !maySuggestFor(query)) return [];
    const url = suggestRequestUrl(template, query);
    if (!/^https?:\/\//i.test(url) || (localOnly && !isLoopback(url))) return [];
    const controller = new AbortController();
    inFlight.set(sender.id, controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await sessionFor().fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json, text/javascript, */*;q=0.1" },
      });
      if (!response.ok) return [];
      const body = await readCapped(response);
      return controller.signal.aborted ? [] : parseSuggestions(body, query);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      if (inFlight.get(sender.id) === controller) inFlight.delete(sender.id);
    }
  }

  ipcMain.handle("rune:search-suggestions", (event, query: unknown) => {
    if (!options.windows.isUi(event.sender)) return [];
    if (typeof query !== "string" || query.length > MAX_SUGGEST_QUERY) return [];
    const sender = event.sender;
    if (!watched.has(sender.id)) {
      const id = sender.id;
      watched.add(id);
      sender.once("destroyed", () => {
        watched.delete(id);
        inFlight.get(id)?.abort();
        inFlight.delete(id);
      });
    }
    return suggest(sender, query);
  });
}
