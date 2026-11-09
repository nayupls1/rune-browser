// The chrome.* APIs that reach into the browser's own data and devices, for extensions: history, top sites,
// recently closed tabs, downloads, clearing browsing data, site settings, privacy and font settings, proxy,
// the debugger, declarativeContent, screen and tab capture, signing in on websites (identity), saving pages as
// MHTML, keeping the computer awake, storage devices, text to speech and its engines, user scripts, websites'
// icons, and the side panel. The shim (src/extension-preload/shim.ts) calls these; apis.ts routes the calls
// here and checks the permissions first. An extension only sees and changes what belongs to its workspace (each
// workspace's session runs its own copy of it), and private windows keep no history to read.
import {
  app,
  BrowserWindow,
  powerSaveBlocker,
  webContents,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PRIVATE_WORKSPACE } from "../../shared/api";
import { siteSetting, siteSettings, type BrowserSettings, type SiteSettingKey } from "../../shared/browser";
import type { DownloadInfo } from "../../shared/downloads";
import {
  browsingDataPlan,
  CONTENT_SETTINGS,
  contentPatternSite,
  downloadItem,
  engineVoices,
  historyItems,
  pageActions,
  pageSelectors,
  parsePageRule,
  parseUserScript,
  proxyConfigToElectron,
  searchDownloads,
  userScriptMatches,
  visitItems,
  type DownloadItem,
  type PageRule,
  type TtsVoice,
  type UserScript,
} from "../../shared/extensionApis";
import {
  extensionIdOf,
  type BrowserSettingsChange,
  type ClosedTab,
  type ExtensionTabRequest,
  type Manifest,
  type SystemVoice,
  type TtsResult,
} from "../../shared/extensions";
import type { Visit, VisitSuggestion } from "../../shared/visits";
import * as cdp from "../cdp";
import type { DownloadsControl } from "../downloads";
import { dispatch, type Context, type ExtensionState } from "./host";
import { extensionFile, readManifest } from "./registry";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type WindowRequest = DistributiveOmit<ExtensionTabRequest, "requestId">;

/** What these APIs need from the rest of Rune Browser (main/extensions/index.ts and apis.ts). */
export interface BrowserApiEnv {
  workspaceOf: (s: Session) => string | undefined;
  state: (s: Session, id: string) => ExtensionState | undefined;
  contexts: Parameters<typeof dispatch>[0];
  sessions: () => Session[];
  window: () => BrowserWindow | undefined;
  /** Asks the Rune Browser window (the one used last, or the tab's) and waits for its answer. */
  ask: <T>(request: WindowRequest, fallback: T, ms: number) => Promise<T>;
  /** Rune Browser's server (history lives there), once it's started. */
  serverApi: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  downloads: () => DownloadsControl | undefined;
  /** The browser settings in effect (site settings, privacy, fonts). */
  browserSettings: () => BrowserSettings | undefined;
  /** The screen picker, for chrome.desktopCapture (main/sitePermissions.ts). */
  pickDesktop: (
    s: Session,
    contents: WebContents,
    name: string,
    types: readonly string[],
    audio: boolean,
  ) => Promise<{ id: string; type: string; audio: boolean } | null>;
  setEnabled: (id: string, enabled: boolean) => void;
  remove: (id: string) => Promise<void>;
  /** Its toolbar buttons changed (declarativeContent shows or hides one). */
  actionsChanged: (s: Session) => void;
  hasPermission: (s: Session, id: string, permission: string) => boolean;
  hostAccess: (s: Session, id: string, url: string) => boolean;
  canSee: (s: Session, id: string, contents: WebContents) => boolean;
  tabContents: (s: Session, tabId: unknown) => WebContents;
  activeContents: (s: Session) => WebContents | null;
  tabsIn: (s: Session) => WebContents[];
  tabObject: (s: Session, id: string, contents: WebContents) => Record<string, unknown>;
  /** Waits for a tab's page to exist (a tab just opened). */
  waitForContents: (tabId: number | null) => Promise<WebContents | null>;
  emit: (s: Session, event: string, args: (id: string) => unknown[] | null) => void;
  manifestOf: (s: Session, id: string) => Manifest;
  /** The page of its side panel (the one it set, or the manifest's), or null. */
  sidePanelUrl: (s: Session, id: string) => string | null;
  windowId: () => number;
}

type Handler = (ctx: Context, ...args: any[]) => unknown;

const err = (message: string) => new Error(message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const DAY = 86_400_000;

export function createBrowserApis(env: BrowserApiEnv) {
  const nameOf = (s: Session, id: string) => {
    const ext = s.extensions.getExtension(id);
    try {
      return ext ? readManifest(ext.path).name : id;
    } catch {
      return ext?.name ?? id;
    }
  };
  const workspace = (s: Session) => {
    const id = env.workspaceOf(s);
    if (!id) throw err("No window");
    return id;
  };
  const isPrivate = (s: Session) => env.workspaceOf(s) === PRIVATE_WORKSPACE;
  /** The extension's own pages in its session (an offscreen document, its popup…), newest first. */
  const pagesOf = (s: Session, id: string) =>
    webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.session === s && extensionIdOf(c.getURL()) === id)
      .reverse();

  // --- chrome.history -------------------------------------------------------------------------------------

  const visits = (s: Session, params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams({ workspace: workspace(s) });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return env.serverApi<Visit[]>(`/api/visits?${q}`);
  };
  const timeParam = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : undefined;
  const historyRemoved = (s: Session, details: { allHistory: boolean; urls: string[] }) =>
    env.emit(s, "history.onVisitRemoved", (id) => (env.hasPermission(s, id, "history") ? [details] : null));
  /** A page the extension may see in the history (its URL given). */
  const urlOf = (details: unknown) => {
    const url = isObject(details) && typeof details.url === "string" ? details.url : "";
    if (!url) throw err("A url is needed.");
    return url;
  };

  /** A tab went to a page: history.onVisited, once the server has recorded it. */
  function visited(s: Session, url: string) {
    if (isPrivate(s) || !/^(https?|file):/i.test(url)) return;
    setTimeout(() => {
      const listening = [...listenersFor(s, "history.onVisited")].filter((id) => env.hasPermission(s, id, "history"));
      if (!listening.length) return;
      void visits(s, { url, limit: 1000 })
        .then((list) => historyItems(list, 1)[0])
        .then((item) => {
          if (item)
            for (const id of listening)
              void dispatch(env.contexts, env.state(s, id), s, id, "history.onVisited", [item]);
        })
        .catch(() => {});
    }, 1000);
  }

  // --- chrome.sessions: tabs closed lately, and values kept with tabs and windows -------------------------

  const sessionValues = new Map<string, Record<string, unknown>>();
  const valueKey = (s: Session, id: string, kind: "tab" | "window", target: unknown) =>
    `${env.workspaceOf(s)}|${id}|${kind}:${String(target)}`;
  const closedSession = (s: Session, id: string, closed: ClosedTab) => {
    const see = env.hasPermission(s, id, "tabs") || env.hostAccess(s, id, closed.url);
    return {
      lastModified: Math.floor(closed.at / 1000),
      tab: {
        sessionId: String(closed.at),
        index: -1,
        windowId: env.windowId(),
        highlighted: false,
        active: false,
        pinned: false,
        audible: false,
        discarded: false,
        autoDiscardable: true,
        incognito: false,
        selected: false,
        groupId: -1,
        ...(see ? { url: closed.url, title: closed.title } : {}),
      },
    };
  };

  // --- chrome.downloads ------------------------------------------------------------------------------------

  const downloadNumbers = new Map<string, number>();
  const downloadIds = new Map<number, string>();
  let nextDownload = 1;
  const numberOf = (id: string) => {
    let n = downloadNumbers.get(id);
    if (n === undefined) {
      n = nextDownload++;
      downloadNumbers.set(id, n);
      downloadIds.set(n, id);
    }
    return n;
  };
  const downloadsOrFail = () => {
    const d = env.downloads();
    if (!d) throw err("Downloads aren't available yet.");
    return d;
  };
  /** A download of the extension's workspace, by its number. */
  const downloadOf = (s: Session, n: unknown) => {
    const id = typeof n === "number" ? downloadIds.get(n) : undefined;
    const d = id ? downloadsOrFail().get(id) : undefined;
    if (!d || d.workspaceId !== env.workspaceOf(s)) throw err(`Invalid download id ${String(n)}`);
    return d;
  };
  const itemsOf = (s: Session) =>
    downloadsOrFail()
      .list(workspace(s))
      .map((d) => downloadItem(d, numberOf(d.id)));
  /** What each download looked like last, for onChanged's deltas. */
  const lastSeen = new Map<string, DownloadItem>();
  let watching = false;
  function watchDownloads() {
    const control = env.downloads();
    if (watching || !control) return;
    watching = true;
    control.watch((kind, d: DownloadInfo) => {
      const n = numberOf(d.id);
      const item = downloadItem(d, n);
      const before = lastSeen.get(d.id);
      if (kind === "erased") lastSeen.delete(d.id);
      else lastSeen.set(d.id, item);
      for (const s of env.sessions()) {
        if (!d.workspaceId || env.workspaceOf(s) !== d.workspaceId) continue;
        const allowed = (id: string) => env.hasPermission(s, id, "downloads");
        if (kind === "created") env.emit(s, "downloads.onCreated", (id) => (allowed(id) ? [item] : null));
        else if (kind === "erased") env.emit(s, "downloads.onErased", (id) => (allowed(id) ? [n] : null));
        else if (before) {
          const delta: Record<string, unknown> = { id: n };
          for (const key of Object.keys(item) as (keyof DownloadItem)[]) {
            if (key === "id" || before[key] === item[key]) continue;
            delta[key] = { previous: before[key], current: item[key] };
          }
          if (Object.keys(delta).length > 1) env.emit(s, "downloads.onChanged", (id) => (allowed(id) ? [delta] : null));
        }
      }
    });
  }

  // --- chrome.contentSettings ------------------------------------------------------------------------------

  /** What each extension set, so `clear` takes back only that (like Chrome's). */
  const contentSet = new Map<string, { key: SiteSettingKey; site: string | null }[]>();
  const changeSettings = async (change: BrowserSettingsChange) => {
    const done = await env.ask<boolean | string>({ action: "settings", change }, "No window to change it in", 10_000);
    if (done !== true) throw err(typeof done === "string" ? done : "The setting couldn't be changed.");
  };
  const settingsNow = () => {
    const settings = env.browserSettings();
    if (!settings) throw err("The browser settings aren't loaded yet.");
    return settings;
  };
  /** Chrome's fixed answer for the content settings Rune Browser has no setting for. */
  const FIXED_CONTENT: Record<string, string> = {
    cookies: "allow",
    plugins: "block",
    popups: "allow",
    unsandboxedPlugins: "block",
    automaticDownloads: "allow",
    autoVerify: "allow",
  };

  // --- chrome.privacy ---------------------------------------------------------------------------------------

  type PrivacyName = string;
  /** What Rune Browser has of Chrome's privacy settings: read from its settings, changed there. */
  const privacyValue = (name: PrivacyName): { value: unknown; controllable: boolean } => {
    const settings = env.browserSettings();
    switch (name) {
      case "websites.thirdPartyCookiesAllowed":
        return { value: settings?.privacy.thirdPartyCookies !== "block", controllable: true };
      case "websites.doNotTrackEnabled":
        return { value: settings?.privacy.doNotTrack === true, controllable: true };
      case "network.webRTCIPHandlingPolicy":
        return { value: webrtcPolicy ?? "default", controllable: true };
      case "websites.hyperlinkAuditingEnabled":
      case "websites.referrersEnabled":
      case "websites.protectedContentEnabled":
      case "network.networkPredictionEnabled":
        return { value: true, controllable: false };
      default:
        // Google's services (Safe Browsing, autofill, translation…) and the Privacy Sandbox: Rune Browser has none.
        return { value: false, controllable: false };
    }
  };
  let webrtcPolicy: string | null = null;
  let webrtcBy: string | null = null;
  const privacyBy = new Map<PrivacyName, string>();
  const applyWebrtc = (contents: WebContents) => {
    if (!webrtcPolicy || contents.isDestroyed()) return;
    try {
      contents.setWebRTCIPHandlingPolicy(webrtcPolicy as Parameters<WebContents["setWebRTCIPHandlingPolicy"]>[0]);
    } catch {
      // not a page
    }
  };
  const privacyChanged = (name: PrivacyName) => {
    for (const s of env.sessions())
      env.emit(s, `privacy.${name}.onChange`, (id) =>
        env.hasPermission(s, id, "privacy") ? [privacyDetails(name, id)] : null,
      );
  };
  const privacyDetails = (name: PrivacyName, id: string) => {
    const { value, controllable } = privacyValue(name);
    const by = name === "network.webRTCIPHandlingPolicy" ? webrtcBy : privacyBy.get(name);
    return {
      value,
      levelOfControl: !controllable
        ? "not_controllable"
        : by === id
          ? "controlled_by_this_extension"
          : by
            ? "controlled_by_other_extensions"
            : "controllable_by_this_extension",
    };
  };

  // --- chrome.debugger ---------------------------------------------------------------------------------------

  /** Tabs being debugged, by tab: the extension, and how to stop following its events. */
  const debugged = new Map<number, { s: Session; id: string; stop: () => void }>();
  function detachDebugger(tabId: number, reason: string) {
    const d = debugged.get(tabId);
    if (!d) return;
    debugged.delete(tabId);
    d.stop();
    void dispatch(env.contexts, env.state(d.s, d.id), d.s, d.id, "debugger.onDetach", [{ tabId }, reason]);
  }

  // --- chrome.declarativeContent ----------------------------------------------------------------------------

  const rulesOf = (s: Session, id: string): PageRule[] =>
    ((env.state(s, id)?.stored.pageRules ?? []) as unknown[]).flatMap((r, i) => {
      const rule = parsePageRule(r, `_${i}`);
      return rule ? [rule] : [];
    });
  /** The selectors that match in a page (looked for in a world of its own, so the page can't interfere). */
  async function matchingSelectors(contents: WebContents, selectors: string[]) {
    if (!selectors.length || contents.isDestroyed()) return new Set<string>();
    try {
      const found = (await contents.executeJavaScriptInIsolatedWorld(DECLARATIVE_WORLD, [
        {
          code: `(${JSON.stringify(selectors)}).filter((s) => { try { return !!document.querySelector(s); } catch { return false; } })`,
        },
      ])) as unknown;
      return new Set(Array.isArray(found) ? found.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set<string>();
    }
  }
  const bookmarked = async (url: string) => {
    try {
      const tree = await env.serverApi<{ url?: string; children?: unknown[] }>("/api/bookmarks");
      const walk = (n: { url?: string; children?: unknown[] }): boolean =>
        n.url === url || (n.children ?? []).some((c) => walk(c as typeof n));
      return walk(tree);
    } catch {
      return false;
    }
  };
  /** Works out what declarativeContent does to each extension's button on a tab's page. */
  async function evaluatePage(contents: WebContents) {
    if (contents.isDestroyed()) return;
    const s = contents.session;
    const url = contents.getURL();
    let changed = false;
    for (const ext of s.extensions.getAllExtensions()) {
      const state = env.state(s, ext.id);
      if (!state) continue;
      const rules = rulesOf(s, ext.id);
      const before = JSON.stringify(state.pageActions.get(contents.id) ?? null);
      if (!rules.length || !env.hasPermission(s, ext.id, "declarativeContent")) {
        if (state.pageActions.delete(contents.id)) changed = true;
        continue;
      }
      const css = await matchingSelectors(contents, pageSelectors(rules));
      const needsBookmark = rules.some((r) => r.conditions.some((c) => typeof c.isBookmarked === "boolean"));
      const actions = pageActions(rules, { url, css, bookmarked: needsBookmark ? await bookmarked(url) : false });
      const page: Record<string, unknown> = {};
      if (actions.some((a) => a.type === "show")) page.enabled = true;
      const icon = actions.find((a) => a.type === "icon");
      if (icon?.type === "icon") page.icon = icon.icon;
      if (Object.keys(page).length) state.pageActions.set(contents.id, page);
      else state.pageActions.delete(contents.id);
      if (JSON.stringify(state.pageActions.get(contents.id) ?? null) !== before) changed = true;
    }
    if (changed) env.actionsChanged(s);
  }
  const evaluateAll = (s: Session) => {
    for (const contents of env.tabsIn(s)) void evaluatePage(contents);
  };

  // --- chrome.userScripts --------------------------------------------------------------------------------------

  const scriptsOf = (s: Session, id: string): UserScript[] =>
    ((env.state(s, id)?.stored.userScripts ?? []) as unknown[]).flatMap((v) => {
      try {
        return [parseUserScript(v)];
      } catch {
        return [];
      }
    });
  const worldIds = new Map<string, number>();
  const worldOf = (id: string, worldId: string) => {
    const key = `${id}|${worldId}`;
    let n = worldIds.get(key);
    if (n === undefined) {
      n = USER_SCRIPT_WORLDS + worldIds.size;
      worldIds.set(key, n);
    }
    return n;
  };
  const scriptCode = (s: Session, id: string, js: UserScript["js"]) => {
    const dir = s.extensions.getExtension(id)?.path;
    return js
      .map((part) => {
        if ("code" in part) return part.code;
        const file = dir ? extensionFile(dir, part.file) : null;
        return file && existsSync(file) ? readFileSync(file, "utf8") : "";
      })
      .filter(Boolean);
  };
  /** Runs code in a frame: in the extension's user script world (the page's own frame only), or the page's. */
  async function runIn(
    contents: WebContents,
    frame: WebFrameMain,
    code: string,
    world: "USER_SCRIPT" | "MAIN",
    worldNumber: number,
  ) {
    if (world === "USER_SCRIPT" && frame === contents.mainFrame)
      return contents.executeJavaScriptInIsolatedWorld(worldNumber, [{ code }], false);
    return frame.executeJavaScript(code, false);
  }
  /** The user scripts that run on a frame's page at this point of its loading. */
  function injectUserScripts(contents: WebContents, frame: WebFrameMain, when: "start" | "idle") {
    const s = contents.session;
    const url = frame.url;
    if (!/^(https?|file):/i.test(url)) return;
    for (const ext of s.extensions.getAllExtensions()) {
      if (!env.hasPermission(s, ext.id, "userScripts") || !env.hostAccess(s, ext.id, url)) continue;
      for (const script of scriptsOf(s, ext.id)) {
        if (frame !== contents.mainFrame && !script.allFrames) continue;
        const early = script.runAt !== "document_idle";
        if ((when === "start") !== early) continue;
        if (!userScriptMatches(script, url)) continue;
        const world = worldOf(ext.id, script.worldId);
        for (const code of scriptCode(s, ext.id, script.js))
          void runIn(contents, frame, `${code}\n//# sourceURL=userscript:${script.id}`, script.world, world).catch(
            (e) => console.warn(`A user script of ${ext.id} failed:`, e),
          );
      }
    }
  }

  // --- chrome.tts --------------------------------------------------------------------------------------------

  const engineRequests = new Map<string, (result: TtsResult) => void>();
  /** Every extension's text-to-speech voices (their manifests' tts_engine, or what they set with updateVoices). */
  const engineVoiceOverrides = new Map<string, TtsVoice[]>();
  function allEngineVoices(s: Session) {
    return s.extensions.getAllExtensions().flatMap((ext) => {
      if (!env.hasPermission(s, ext.id, "ttsEngine")) return [];
      return engineVoiceOverrides.get(ext.id) ?? engineVoices(ext.id, ext.manifest as Manifest);
    });
  }
  let speakingEngine: { s: Session; id: string; requestId: string } | null = null;

  // --- chrome.tabCapture: stream ids, made for the page that uses them -------------------------------------

  const captureTokens = new Map<
    string,
    { s: Session; id: string; tabId: number; consumer: number | null; at: number }
  >();
  const captured = new Map<number, string>();
  /** Extensions about to turn a capture id into a stream: their pages get the media permission for that, briefly. */
  const mediaGrants = new Map<string, number>();
  const grantMedia = (s: Session, id: string) => mediaGrants.set(`${env.workspaceOf(s)}|${id}`, Date.now() + 15_000);
  const expectsMedia = (s: Session, id: string) => (mediaGrants.get(`${env.workspaceOf(s)}|${id}`) ?? 0) > Date.now();

  // --- chrome.power -------------------------------------------------------------------------------------------

  const keepAwake = new Map<string, number>();

  // --- chrome.proxy ---------------------------------------------------------------------------------------------

  /** What a session's proxy was before an extension set one (the command line's, or the system's). */
  const defaultProxy = (): Electron.ProxyConfig => {
    if (app.commandLine.hasSwitch("no-proxy-server")) return { mode: "direct" };
    const server = app.commandLine.getSwitchValue("proxy-server");
    if (server)
      return {
        mode: "fixed_servers",
        proxyRules: server,
        proxyBypassRules: app.commandLine.getSwitchValue("proxy-bypass-list") || undefined,
      };
    const pac = app.commandLine.getSwitchValue("proxy-pac-url");
    if (pac) return { mode: "pac_script", pacScript: pac };
    return { mode: "system" };
  };
  const proxyApplied = new WeakMap<Session, string>();
  async function applyProxy(s: Session, id: string, value: unknown | null) {
    const config = value === null ? defaultProxy() : proxyConfigToElectron(value);
    await s.setProxy(config);
    if (value === null) proxyApplied.delete(s);
    else proxyApplied.set(s, id);
  }

  // --- The calls ------------------------------------------------------------------------------------------------

  const handlers: Record<string, Handler> = {
    // chrome.history
    "history.search": async (ctx, q: Record<string, unknown> | undefined) => {
      if (isPrivate(ctx.session)) return [];
      const text = typeof q?.text === "string" ? q.text : "";
      const max = typeof q?.maxResults === "number" ? q.maxResults : 100;
      // Like Chrome: the last 24 hours unless it says when.
      const since = timeParam(q?.startTime) ?? new Date(Date.now() - DAY).toISOString();
      const list = await visits(ctx.session, { search: text, since, until: timeParam(q?.endTime), limit: 5000 });
      return historyItems(list, max || 5000);
    },
    "history.getVisits": async (ctx, details: unknown) => {
      if (isPrivate(ctx.session)) return [];
      const list = await visits(ctx.session, { url: urlOf(details), limit: 5000 });
      const latest = list[0];
      return latest ? visitItems(list, String(latest.id)) : [];
    },
    "history.addUrl": async (ctx, details: Record<string, unknown> | undefined) => {
      if (isPrivate(ctx.session)) return;
      const url = urlOf(details);
      await env.serverApi(`/api/visits/add?workspace=${encodeURIComponent(workspace(ctx.session))}`, "POST", {
        url,
        ...(typeof details?.title === "string" ? { title: details.title } : {}),
      });
      visited(ctx.session, url);
    },
    "history.deleteUrl": async (ctx, details: unknown) => {
      if (isPrivate(ctx.session)) return;
      const url = urlOf(details);
      await env.serverApi(`/api/visits/delete-url?workspace=${encodeURIComponent(workspace(ctx.session))}`, "POST", {
        url,
      });
      historyRemoved(ctx.session, { allHistory: false, urls: [url] });
    },
    "history.deleteRange": async (ctx, range: Record<string, unknown> | undefined) => {
      if (isPrivate(ctx.session)) return;
      const since = timeParam(range?.startTime);
      const until = timeParam(range?.endTime);
      if (!since || !until) throw err("startTime and endTime are needed.");
      const gone = await visits(ctx.session, { since, until, limit: 5000 });
      await env.serverApi(`/api/visits/clear?workspace=${encodeURIComponent(workspace(ctx.session))}`, "POST", {
        since,
        until,
      });
      historyRemoved(ctx.session, { allHistory: false, urls: [...new Set(gone.map((v) => v.url))] });
    },
    "history.deleteAll": async (ctx) => {
      if (isPrivate(ctx.session)) return;
      await env.serverApi(`/api/visits/clear?workspace=${encodeURIComponent(workspace(ctx.session))}`, "POST", {
        since: null,
      });
      historyRemoved(ctx.session, { allHistory: true, urls: [] });
    },

    // chrome.topSites: the pages visited most often and lately (what the address bar suggests first).
    "topSites.get": async (ctx) => {
      if (isPrivate(ctx.session)) return [];
      const q = new URLSearchParams({ workspace: workspace(ctx.session), q: "", limit: "10" });
      const pages = await env.serverApi<VisitSuggestion[]>(`/api/visits/suggest?${q}`);
      return pages.map((p) => ({ url: p.url, title: p.title }));
    },

    // chrome.sessions
    "sessions.getRecentlyClosed": async (ctx, filter: Record<string, unknown> | undefined) => {
      const max = Math.min(25, typeof filter?.maxResults === "number" ? filter.maxResults : 25);
      const closed = await env.ask<ClosedTab[]>({ action: "closed", workspaceId: workspace(ctx.session) }, [], 5000);
      return (Array.isArray(closed) ? closed : [])
        .slice(0, max)
        .map((c) => closedSession(ctx.session, ctx.extensionId, c));
    },
    "sessions.restore": async (ctx, sessionId: unknown) => {
      const at = typeof sessionId === "string" && sessionId ? Number(sessionId) : null;
      if (at !== null && !Number.isFinite(at)) throw err(`Invalid session id: "${String(sessionId)}".`);
      const tabId = await env.ask<number | null>(
        { action: "restore", workspaceId: workspace(ctx.session), closedAt: at },
        null,
        15_000,
      );
      const contents = await env.waitForContents(tabId);
      if (!contents)
        throw err(at === null ? "There are no recently closed sessions." : "Couldn't restore that session.");
      return {
        lastModified: Math.floor(Date.now() / 1000),
        tab: env.tabObject(ctx.session, ctx.extensionId, contents),
      };
    },
    "sessions.getDevices": () => [],
    "sessions.getValue": (ctx, kind: "tab" | "window", target: unknown, key: unknown) =>
      sessionValues.get(valueKey(ctx.session, ctx.extensionId, kind, target))?.[String(key)],
    "sessions.setValue": (ctx, kind: "tab" | "window", target: unknown, key: unknown, value: unknown) => {
      if (kind === "tab") env.tabContents(ctx.session, target);
      const k = valueKey(ctx.session, ctx.extensionId, kind, target);
      sessionValues.set(k, { ...sessionValues.get(k), [String(key)]: value });
    },
    "sessions.removeValue": (ctx, kind: "tab" | "window", target: unknown, key: unknown) => {
      const values = sessionValues.get(valueKey(ctx.session, ctx.extensionId, kind, target));
      if (values) delete values[String(key)];
    },

    // chrome.downloads
    "downloads.download": async (ctx, options: Record<string, unknown> | undefined) => {
      const url = typeof options?.url === "string" ? options.url : "";
      let resolved: string;
      try {
        resolved = new URL(url, `chrome-extension://${ctx.extensionId}/`).href;
      } catch {
        throw err("Invalid URL.");
      }
      if (!/^(https?|data|blob|chrome-extension|file):/i.test(resolved)) throw err("Invalid URL.");
      if (resolved.startsWith("chrome-extension:") && extensionIdOf(resolved) !== ctx.extensionId)
        throw err("Invalid URL.");
      if (resolved.startsWith("file:") && !env.hostAccess(ctx.session, ctx.extensionId, resolved))
        throw err("Access to that file isn't allowed.");
      const filename = typeof options?.filename === "string" ? options.filename : undefined;
      if (filename && (/^([a-z]:|[\\/])/i.test(filename) || filename.split(/[\\/]/).includes("..")))
        throw err("Invalid filename");
      const headers: Record<string, string> = {};
      if (Array.isArray(options?.headers))
        for (const h of options.headers)
          if (isObject(h) && typeof h.name === "string" && typeof h.value === "string") headers[h.name] = h.value;
      watchDownloads();
      const id = await downloadsOrFail().download(ctx.session, resolved, {
        filename,
        saveAs: options?.saveAs === true,
        conflictAction: typeof options?.conflictAction === "string" ? options.conflictAction : undefined,
        headers,
      });
      return numberOf(id);
    },
    "downloads.search": (ctx, q: Record<string, unknown> | undefined) => {
      watchDownloads();
      return searchDownloads(itemsOf(ctx.session), q ?? {});
    },
    "downloads.act": async (ctx, n: unknown, action: "pause" | "resume" | "cancel" | "show") => {
      const d = downloadOf(ctx.session, n);
      if (action === "pause" && d.state !== "progressing") throw err("Download must be in progress");
      if (action === "resume" && !d.paused && d.state === "progressing") return;
      const failed = await downloadsOrFail().act(d.id, action);
      if (failed && action !== "cancel") throw err(failed);
    },
    "downloads.open": async (ctx, n: unknown) => {
      if (!env.hasPermission(ctx.session, ctx.extensionId, "downloads.open"))
        throw err("The 'downloads.open' permission is required.");
      const d = downloadOf(ctx.session, n);
      const failed = await downloadsOrFail().act(d.id, "open");
      if (failed) throw err(failed);
    },
    "downloads.showDefaultFolder": () => downloadsOrFail().showFolder(),
    "downloads.erase": async (ctx, q: Record<string, unknown> | undefined) => {
      const found = searchDownloads(itemsOf(ctx.session), q ?? {});
      const ids = found.map((d) => downloadIds.get(d.id)).filter((x): x is string => !!x);
      await downloadsOrFail().erase(ids);
      return found.map((d) => d.id);
    },
    "downloads.removeFile": (ctx, n: unknown) => downloadsOrFail().removeFile(downloadOf(ctx.session, n).id),
    "downloads.acceptDanger": async (ctx, n: unknown) => {
      const d = downloadOf(ctx.session, n);
      if (!d.danger) return;
      const ok = await env.ask<boolean>(
        {
          action: "confirm",
          workspaceId: workspace(ctx.session),
          message: `${nameOf(ctx.session, ctx.extensionId)} wants to keep ${d.filename}. This type of file can harm your computer. Keep it?`,
          confirmLabel: "Keep",
        },
        false,
        5 * 60_000,
      );
      if (!ok) throw err("The user didn't keep the download.");
      const failed = await downloadsOrFail().act(d.id, "keep");
      if (failed) throw err(failed);
    },
    "downloads.getFileIcon": async (ctx, n: unknown, options: { size?: unknown } | undefined) => {
      const d = downloadOf(ctx.session, n);
      const file = downloadsOrFail().fileOf(d.id);
      if (!file) throw err("The download has no file yet.");
      const size =
        options?.size === 16 ? "small" : options?.size === 32 || options?.size === undefined ? "normal" : null;
      if (!size) throw err("Invalid size: it's 16 or 32.");
      const icon = await app.getFileIcon(file, { size });
      return icon.toDataURL();
    },
    "downloads.setUi": (ctx, enabled: unknown) =>
      void env.ask({ action: "downloads-ui", enabled: enabled !== false }, null, 5000),

    // chrome.browsingData
    "browsingData.remove": async (ctx, options: Record<string, unknown> | undefined, dataToRemove: unknown) => {
      const s = ctx.session;
      const plan = browsingDataPlan(dataToRemove);
      const since = typeof options?.since === "number" && options.since > 0 ? options.since : 0;
      const given = (v: unknown) =>
        Array.isArray(v)
          ? v
              .filter((o): o is string => typeof o === "string")
              .flatMap((o) => {
                try {
                  return [new URL(o).origin];
                } catch {
                  return [];
                }
              })
          : null;
      let origins = given(options?.origins);
      const excluded = given(options?.excludeOrigins) ?? [];
      if (origins && options?.excludeOrigins) throw err("origins and excludeOrigins can't be used together.");
      // Electron can't clear by time: what was visited since then is cleared (like Clear browsing data).
      const ws = workspace(s);
      if (since && !origins && !isPrivate(s)) {
        const q = new URLSearchParams({ workspace: ws, since: new Date(since).toISOString() });
        origins = await env.serverApi<string[]>(`/api/visits/origins?${q}`).catch(() => []);
      }
      // Extensions keep their own data, like in Chrome (it isn't "unprotected web").
      const extensionOrigins = s.extensions.getAllExtensions().map((e) => `chrome-extension://${e.id}`);
      if (origins) origins = origins.filter((o) => !o.startsWith("chrome-extension:"));
      const scope = origins
        ? origins.length
          ? { origins }
          : null
        : { excludeOrigins: [...new Set([...excluded, ...extensionOrigins])] };
      if (scope && plan.session.length) await s.clearData({ dataTypes: plan.session, ...scope });
      if (scope && plan.cacheStorage) {
        if ("origins" in scope && scope.origins)
          for (const origin of scope.origins) await s.clearStorageData({ origin, storages: ["cachestorage"] });
        else await s.clearStorageData({ storages: ["cachestorage"] });
      }
      if (plan.history && !isPrivate(s)) {
        await env.serverApi(`/api/visits/clear?workspace=${encodeURIComponent(ws)}`, "POST", {
          since: since ? new Date(since).toISOString() : null,
        });
        historyRemoved(s, { allHistory: !since, urls: [] });
      }
      if (plan.downloads) await env.downloads()?.clear(since, [ws]);
    },
    "browsingData.settings": () => {
      const all = (value: boolean) =>
        Object.fromEntries(
          [
            "appcache",
            "cache",
            "cacheStorage",
            "cookies",
            "downloads",
            "fileSystems",
            "formData",
            "history",
            "indexedDB",
            "localStorage",
            "passwords",
            "pluginData",
            "serviceWorkers",
            "webSQL",
          ].map((k) => [k, value]),
        );
      return {
        options: { since: 0 },
        // What Clear browsing data offers checked.
        dataToRemove: { ...all(false), history: true, cookies: true, cache: true },
        dataRemovalPermitted: all(true),
      };
    },

    // chrome.contentSettings: Rune Browser's site settings.
    "contentSettings.get": (ctx, type: string, details: Record<string, unknown> | undefined) => {
      if (!(type in CONTENT_SETTINGS)) throw err(`Unknown content setting '${type}'.`);
      const key = CONTENT_SETTINGS[type];
      if (!key) return { setting: FIXED_CONTENT[type] ?? "allow" };
      const url = typeof details?.primaryUrl === "string" ? details.primaryUrl : "";
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        throw err("Invalid primaryUrl.");
      }
      return { setting: siteSetting(settingsNow(), host, key) };
    },
    "contentSettings.set": async (ctx, type: string, details: Record<string, unknown> | undefined) => {
      if (!(type in CONTENT_SETTINGS)) throw err(`Unknown content setting '${type}'.`);
      const key = CONTENT_SETTINGS[type];
      const setting = details?.setting === "session_only" ? "allow" : details?.setting;
      if (setting !== "allow" && setting !== "block" && setting !== "ask")
        throw err(`Invalid setting '${String(details?.setting)}'.`);
      if (!key) {
        if (setting === (FIXED_CONTENT[type] ?? "allow")) return;
        throw err(`Rune Browser has no site setting for ${type}: it's always "${FIXED_CONTENT[type] ?? "allow"}".`);
      }
      const site = contentPatternSite(details?.primaryPattern);
      if (site === undefined) throw err(`Invalid pattern '${String(details?.primaryPattern)}'.`);
      if (details?.secondaryPattern !== undefined && contentPatternSite(details.secondaryPattern) !== null)
        throw err("Rune Browser's site settings don't have a secondary pattern: leave it out.");
      const kind = siteSettings[key].kind;
      if (site === null) {
        if (kind === "permission" && setting === "allow")
          throw err(`Every site can only be set to "ask" or "block" for ${type}.`);
        if (kind === "content" && setting === "ask") throw err(`${type} is "allow" or "block".`);
        await changeSettings({ kind: "default", key, value: setting });
      } else await changeSettings({ kind: "site", site, key, value: setting === "ask" ? null : setting });
      const list = contentSet.get(ctx.extensionId) ?? [];
      list.push({ key, site });
      contentSet.set(ctx.extensionId, list);
    },
    "contentSettings.clear": async (ctx, type: string) => {
      const key = CONTENT_SETTINGS[type];
      if (!key) return;
      const mine = (contentSet.get(ctx.extensionId) ?? []).filter((c) => c.key === key);
      contentSet.set(
        ctx.extensionId,
        (contentSet.get(ctx.extensionId) ?? []).filter((c) => c.key !== key),
      );
      for (const c of mine) {
        if (c.site === null)
          await changeSettings({
            kind: "default",
            key,
            value: siteSettings[key].kind === "permission" ? "ask" : "allow",
          });
        else await changeSettings({ kind: "site", site: c.site, key, value: null });
      }
    },

    // chrome.privacy
    "privacy.get": (ctx, name: string) => privacyDetails(name, ctx.extensionId),
    "privacy.set": async (ctx, name: string, details: Record<string, unknown> | undefined) => {
      const value = details?.value;
      if (details?.scope && details.scope !== "regular") throw err("Only the regular scope can be changed.");
      if (!privacyValue(name).controllable) throw err(`Rune Browser doesn't let ${name} be changed.`);
      if (name === "network.webRTCIPHandlingPolicy") {
        const policies = [
          "default",
          "default_public_and_private_interfaces",
          "default_public_interface_only",
          "disable_non_proxied_udp",
        ];
        if (typeof value !== "string" || !policies.includes(value)) throw err(`Invalid value '${String(value)}'.`);
        webrtcPolicy = value;
        webrtcBy = ctx.extensionId;
        for (const s of env.sessions()) for (const c of env.tabsIn(s)) applyWebrtc(c);
      } else {
        if (typeof value !== "boolean") throw err(`Invalid value '${String(value)}': it's true or false.`);
        if (name === "websites.thirdPartyCookiesAllowed")
          await changeSettings({ kind: "privacy", thirdPartyCookies: value ? "allow" : "block" });
        else await changeSettings({ kind: "privacy", doNotTrack: value });
        privacyBy.set(name, ctx.extensionId);
      }
      privacyChanged(name);
    },
    "privacy.clear": async (ctx, name: string) => {
      if (name === "network.webRTCIPHandlingPolicy") {
        if (webrtcBy !== ctx.extensionId) return;
        webrtcPolicy = "default";
        for (const s of env.sessions()) for (const c of env.tabsIn(s)) applyWebrtc(c);
        webrtcPolicy = null;
        webrtcBy = null;
      } else {
        if (privacyBy.get(name) !== ctx.extensionId) return;
        privacyBy.delete(name);
        if (name === "websites.thirdPartyCookiesAllowed")
          await changeSettings({ kind: "privacy", thirdPartyCookies: "allow" });
        else if (name === "websites.doNotTrackEnabled") await changeSettings({ kind: "privacy", doNotTrack: false });
      }
      privacyChanged(name);
    },

    // chrome.fontSettings: Settings → Appearance → Fonts and zoom.
    "fontSettings.getFontList": async () => {
      const list = await env.ask<string[]>({ action: "font-list" }, [], 10_000);
      return (Array.isArray(list) ? list : []).map((f) => ({ fontId: f, displayName: f }));
    },
    "fontSettings.getFont": (ctx, details: Record<string, unknown> | undefined) => {
      const field = FONT_FIELDS[String(details?.genericFamily)];
      if (field === undefined) throw err(`Invalid genericFamily '${String(details?.genericFamily)}'.`);
      const fonts = settingsNow().fonts;
      return {
        fontId: field ? fonts[field] : "",
        levelOfControl: field ? "controllable_by_this_extension" : "not_controllable",
      };
    },
    "fontSettings.setFont": async (ctx, details: Record<string, unknown> | undefined) => {
      const field = FONT_FIELDS[String(details?.genericFamily)];
      if (!field) throw err(`Rune Browser has no ${String(details?.genericFamily)} font setting.`);
      const fontId = typeof details?.fontId === "string" ? details.fontId.slice(0, 200) : "";
      await changeSettings({ kind: "fonts", [field]: fontId });
      fontChanged(String(details?.genericFamily), fontId);
    },
    "fontSettings.clearFont": async (ctx, details: Record<string, unknown> | undefined) => {
      const field = FONT_FIELDS[String(details?.genericFamily)];
      if (!field) return;
      await changeSettings({ kind: "fonts", [field]: "" });
      fontChanged(String(details?.genericFamily), "");
    },
    "fontSettings.getSize": (ctx, which: FontSize) => ({
      pixelSize: settingsNow().fonts[FONT_SIZES[which].field],
      levelOfControl: "controllable_by_this_extension",
    }),
    "fontSettings.setSize": async (ctx, which: FontSize, details: Record<string, unknown> | undefined) => {
      const size = FONT_SIZES[which];
      const pixelSize = details?.pixelSize;
      if (typeof pixelSize !== "number" || !Number.isInteger(pixelSize) || pixelSize < size.min || pixelSize > size.max)
        throw err(`pixelSize must be a whole number from ${size.min} to ${size.max}.`);
      await changeSettings({ kind: "fonts", [size.field]: pixelSize });
      sizeChanged(which, pixelSize);
    },
    "fontSettings.clearSize": async (ctx, which: FontSize) => {
      const size = FONT_SIZES[which];
      await changeSettings({ kind: "fonts", [size.field]: size.default });
      sizeChanged(which, size.default);
    },

    // chrome.proxy
    "proxy.get": (ctx) => {
      const by = proxyApplied.get(ctx.session);
      const stored = env.state(ctx.session, by ?? ctx.extensionId)?.stored.proxy;
      return {
        value: by && stored ? stored : { mode: "system" },
        levelOfControl:
          by === ctx.extensionId
            ? "controlled_by_this_extension"
            : by
              ? "controlled_by_other_extensions"
              : "controllable_by_this_extension",
      };
    },
    "proxy.set": async (ctx, details: Record<string, unknown> | undefined) => {
      if (details?.scope && details.scope !== "regular") throw err("Only the regular scope can be changed.");
      await applyProxy(ctx.session, ctx.extensionId, details?.value);
      const state = env.state(ctx.session, ctx.extensionId);
      if (state) {
        state.stored.proxy = details?.value;
        state.save();
      }
      env.emit(ctx.session, "proxy.settings.onChange", (id) =>
        env.hasPermission(ctx.session, id, "proxy")
          ? [
              {
                value: details?.value,
                levelOfControl:
                  id === ctx.extensionId ? "controlled_by_this_extension" : "controlled_by_other_extensions",
              },
            ]
          : null,
      );
    },
    "proxy.clear": async (ctx) => {
      if (proxyApplied.get(ctx.session) !== ctx.extensionId) return;
      await applyProxy(ctx.session, ctx.extensionId, null);
      const state = env.state(ctx.session, ctx.extensionId);
      if (state) {
        delete state.stored.proxy;
        state.save();
      }
      env.emit(ctx.session, "proxy.settings.onChange", (id) =>
        env.hasPermission(ctx.session, id, "proxy")
          ? [{ value: { mode: "system" }, levelOfControl: "controllable_by_this_extension" }]
          : null,
      );
    },

    // chrome.debugger: a tab's DevTools protocol, shared with Rune Browser's own users of it (main/cdp.ts).
    "debugger.attach": async (ctx, target: Record<string, unknown> | undefined, _version: unknown) => {
      if (target?.tabId === undefined) throw err("Only tabs can be debugged in Rune Browser.");
      const contents = env.tabContents(ctx.session, target.tabId);
      if (
        !env.hostAccess(ctx.session, ctx.extensionId, contents.getURL()) &&
        !env.canSee(ctx.session, ctx.extensionId, contents)
      )
        throw err("Cannot access the contents of this tab (it needs access to the site, or the tabs permission).");
      const tabId = contents.id;
      const existing = debugged.get(tabId);
      if (existing)
        throw err(
          existing.id === ctx.extensionId
            ? "Already attached to the tab with id: " + tabId
            : "Another debugger is already attached to the tab with id: " + tabId,
        );
      if (!cdp.acquire(contents, `extension:${ctx.extensionId}`)) throw err("Cannot attach to this target.");
      const s = ctx.session;
      const id = ctx.extensionId;
      const onMessage = (_e: unknown, method: string, params: unknown, sessionId?: string) =>
        void dispatch(env.contexts, env.state(s, id), s, id, "debugger.onEvent", [
          { tabId, ...(sessionId ? { sessionId } : {}) },
          method,
          params,
        ]);
      const onGone = () => detachDebugger(tabId, "target_closed");
      contents.debugger.on("message", onMessage);
      contents.once("destroyed", onGone);
      debugged.set(tabId, {
        s,
        id,
        stop: () => {
          contents.debugger.removeListener("message", onMessage);
          contents.removeListener("destroyed", onGone);
          if (!contents.isDestroyed()) cdp.release(contents, `extension:${id}`);
        },
      });
      // Chrome shows that an extension is debugging the browser.
      void env.ask(
        {
          action: "notice",
          workspaceId: workspace(s),
          message: `${nameOf(s, id)} started debugging “${contents.getTitle() || contents.getURL()}”.`,
        },
        null,
        5000,
      );
    },
    "debugger.detach": (ctx, target: Record<string, unknown> | undefined) => {
      const tabId = Number(target?.tabId);
      const d = debugged.get(tabId);
      if (!d || d.id !== ctx.extensionId)
        throw err(`Debugger is not attached to the tab with id: ${String(target?.tabId)}.`);
      debugged.delete(tabId);
      d.stop();
    },
    "debugger.sendCommand": async (
      ctx,
      target: Record<string, unknown> | undefined,
      method: unknown,
      params: unknown,
    ) => {
      const tabId = Number(target?.tabId);
      const d = debugged.get(tabId);
      if (!d || d.id !== ctx.extensionId)
        throw err(`Debugger is not attached to the tab with id: ${String(target?.tabId)}.`);
      if (typeof method !== "string") throw err("Invalid method.");
      const contents = env.tabContents(ctx.session, tabId);
      return contents.debugger.sendCommand(
        method,
        isObject(params) ? params : {},
        typeof target?.sessionId === "string" ? target.sessionId : undefined,
      );
    },
    "debugger.getTargets": (ctx) =>
      env.tabsIn(ctx.session).map((c) => ({
        type: "page",
        id: String(c.id),
        tabId: c.id,
        attached: debugged.has(c.id) || c.debugger.isAttached(),
        ...(env.canSee(ctx.session, ctx.extensionId, c)
          ? { title: c.getTitle(), url: c.getURL() }
          : { title: "", url: "" }),
      })),

    // chrome.declarativeContent
    "declarativeContent.add": (ctx, rules: unknown) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state || !Array.isArray(rules)) throw err("Invalid rules.");
      const existing = (state.stored.pageRules ?? []) as Record<string, unknown>[];
      const added: PageRule[] = [];
      for (const [i, r] of rules.entries()) {
        const rule = parsePageRule(r, `_${Date.now()}_${i}`);
        if (!rule) throw err("Invalid rule: conditions and actions are needed.");
        if (existing.some((e) => e.id === rule.id) || added.some((a) => a.id === rule.id))
          throw err(`Duplicate rule ID: ${rule.id}`);
        added.push(rule);
      }
      state.stored.pageRules = [...existing, ...added];
      state.save();
      evaluateAll(ctx.session);
      return added;
    },
    "declarativeContent.remove": (ctx, ids: unknown) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state) return;
      const list = (state.stored.pageRules ?? []) as Record<string, unknown>[];
      state.stored.pageRules = Array.isArray(ids) ? list.filter((r) => !ids.includes(r.id)) : [];
      state.save();
      evaluateAll(ctx.session);
    },
    "declarativeContent.get": (ctx, ids: unknown) => {
      const rules = rulesOf(ctx.session, ctx.extensionId);
      return Array.isArray(ids) ? rules.filter((r) => ids.includes(r.id)) : rules;
    },

    // chrome.desktopCapture: Rune Browser's screen picker.
    "desktopCapture.choose": async (ctx, sources: unknown, targetTabId: unknown) => {
      const kinds = Array.isArray(sources) ? sources.filter((x): x is string => typeof x === "string") : [];
      const types = kinds.filter((k) => k === "screen" || k === "window");
      if (!types.length) throw err("At least one of screen or window is needed.");
      const tab =
        typeof targetTabId === "number" ? env.tabContents(ctx.session, targetTabId) : env.activeContents(ctx.session);
      if (!tab) throw err("There's no tab to show the picker over.");
      const pick = await env.pickDesktop(
        ctx.session,
        tab,
        nameOf(ctx.session, ctx.extensionId),
        types,
        kinds.includes("audio"),
      );
      if (pick) grantMedia(ctx.session, ctx.extensionId);
      return pick
        ? { streamId: pick.id, canRequestAudioTrack: pick.audio && process.platform === "win32" }
        : { streamId: "", canRequestAudioTrack: false };
    },

    // chrome.tabCapture: an id the page that uses it turns into a stream (see tabCapture.resolve).
    "tabCapture.getMediaStreamId": (ctx, options: Record<string, unknown> | undefined) => {
      const target =
        options?.targetTabId !== undefined
          ? env.tabContents(ctx.session, options.targetTabId)
          : env.activeContents(ctx.session);
      if (!target) throw err("No tab to capture.");
      if (!env.canSee(ctx.session, ctx.extensionId, target))
        throw err("Extension has not been invoked for the current page (see activeTab permission).");
      const consumer =
        options?.consumerTabId !== undefined ? env.tabContents(ctx.session, options.consumerTabId).id : null;
      const token = `rune-tab:${randomUUID()}`;
      for (const [k, t] of captureTokens) if (Date.now() - t.at > 60_000) captureTokens.delete(k);
      captureTokens.set(token, { s: ctx.session, id: ctx.extensionId, tabId: target.id, consumer, at: Date.now() });
      return token;
    },
    "tabCapture.resolve": (ctx, token: unknown) => {
      const t = typeof token === "string" ? captureTokens.get(token) : undefined;
      if (!t || t.id !== ctx.extensionId || t.s !== ctx.session) throw err("Invalid stream id.");
      const target = webContents.fromId(t.tabId);
      const requester = ctx.contents;
      if (!target || target.isDestroyed() || !requester) throw err("The tab is gone.");
      if (t.consumer !== null && t.consumer !== requester.id) throw err("This stream id is for another tab.");
      const id = target.getMediaSourceId(requester);
      grantMedia(ctx.session, ctx.extensionId);
      captured.set(target.id, ctx.extensionId);
      target.once("destroyed", () => captured.delete(t.tabId));
      env.emit(ctx.session, "tabCapture.onStatusChanged", (ext) =>
        ext === ctx.extensionId ? [{ tabId: t.tabId, status: "active", fullscreen: false }] : null,
      );
      return id;
    },
    "tabCapture.activeTab": (ctx) => {
      const tab = env.activeContents(ctx.session);
      if (!tab) throw err("No tab to capture.");
      return tab.id;
    },
    "tabCapture.getCapturedTabs": (ctx) =>
      [...captured.entries()]
        .filter(([, id]) => id === ctx.extensionId)
        .map(([tabId]) => ({ tabId, status: "active", fullscreen: false })),

    // chrome.identity: signing in on websites in a window of its own (getAuthToken needs a browser account).
    "identity.launchWebAuthFlow": (ctx, details: Record<string, unknown> | undefined) =>
      webAuthFlow(ctx.session, ctx.extensionId, details ?? {}),

    // chrome.pageCapture
    "pageCapture.saveAsMHTML": async (ctx, details: Record<string, unknown> | undefined) => {
      const contents = env.tabContents(ctx.session, details?.tabId);
      const file = join(tmpdir(), `rune-page-${randomUUID()}.mhtml`);
      try {
        await contents.savePage(file, "MHTML");
        return (await readFile(file)).toString("base64");
      } finally {
        await rm(file, { force: true }).catch(() => {});
      }
    },

    // chrome.power
    "power.requestKeepAwake": (ctx, level: unknown) => {
      const key = `${env.workspaceOf(ctx.session)}|${ctx.extensionId}`;
      const old = keepAwake.get(key);
      if (old !== undefined) powerSaveBlocker.stop(old);
      keepAwake.set(
        key,
        powerSaveBlocker.start(level === "display" ? "prevent-display-sleep" : "prevent-app-suspension"),
      );
    },
    "power.releaseKeepAwake": (ctx) => {
      const key = `${env.workspaceOf(ctx.session)}|${ctx.extensionId}`;
      const old = keepAwake.get(key);
      if (old !== undefined) powerSaveBlocker.stop(old);
      keepAwake.delete(key);
    },

    // chrome.system.storage
    "system.storage": () => storageUnits().map(({ path: _path, ...unit }) => unit),
    "system.storageAvailable": (_ctx, id: unknown) => {
      const unit = storageUnits().find((u) => u.id === id);
      if (!unit) throw err(`No storage device with id ${String(id)}.`);
      const fs = statfsSync(unit.path);
      return { id: unit.id, availableCapacity: fs.bavail * fs.bsize };
    },

    // chrome.tts
    "tts.speak": async (ctx, text: unknown, options: Record<string, unknown> | undefined) => {
      const utterance = typeof text === "string" ? text.slice(0, 32768) : "";
      if (!utterance.trim()) return { type: "end" };
      const voiceName = typeof options?.voiceName === "string" ? options.voiceName : undefined;
      const extensionId = typeof options?.extensionId === "string" ? options.extensionId : undefined;
      const voice = allEngineVoices(ctx.session).find(
        (v) => (voiceName && v.voiceName === voiceName) || (extensionId && v.extensionId === extensionId && !voiceName),
      );
      if (!options?.enqueue) await stopSpeaking(ctx.session);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      if (voice?.extensionId) {
        const requestId = randomUUID();
        const s = ctx.session;
        speakingEngine = { s, id: voice.extensionId, requestId };
        return new Promise<TtsResult>((resolve) => {
          engineRequests.set(requestId, resolve);
          void dispatch(env.contexts, env.state(s, voice.extensionId!), s, voice.extensionId!, "ttsEngine.onSpeak", [
            requestId,
            utterance,
            {
              voiceName: voice.voiceName,
              ...(voice.lang ? { lang: voice.lang } : {}),
              rate: num(options?.rate) ?? 1,
              pitch: num(options?.pitch) ?? 1,
              volume: num(options?.volume) ?? 1,
            },
          ]).then((n) => {
            if (!n && engineRequests.delete(requestId))
              resolve({ type: "error", errorMessage: "The voice isn't available." });
          });
        });
      }
      return env.ask<TtsResult>(
        {
          action: "speak",
          utterance: {
            text: utterance,
            ...(typeof options?.lang === "string" ? { lang: options.lang } : {}),
            ...(voiceName ? { voiceName } : {}),
            ...(num(options?.rate) !== undefined ? { rate: num(options?.rate) } : {}),
            ...(num(options?.pitch) !== undefined ? { pitch: num(options?.pitch) } : {}),
            ...(num(options?.volume) !== undefined ? { volume: num(options?.volume) } : {}),
          },
        },
        { type: "error", errorMessage: "No window to speak in." },
        30 * 60_000,
      );
    },
    "tts.stop": (ctx) => stopSpeaking(ctx.session),
    "tts.pause": async (ctx) => {
      if (speakingEngine)
        void dispatch(
          env.contexts,
          env.state(speakingEngine.s, speakingEngine.id),
          speakingEngine.s,
          speakingEngine.id,
          "ttsEngine.onPause",
          [],
        );
      else await env.ask({ action: "tts", command: "pause" }, null, 5000);
    },
    "tts.resume": async (ctx) => {
      if (speakingEngine)
        void dispatch(
          env.contexts,
          env.state(speakingEngine.s, speakingEngine.id),
          speakingEngine.s,
          speakingEngine.id,
          "ttsEngine.onResume",
          [],
        );
      else await env.ask({ action: "tts", command: "resume" }, null, 5000);
    },
    "tts.isSpeaking": async () =>
      !!speakingEngine || (await env.ask<boolean>({ action: "tts", command: "speaking" }, false, 5000)) === true,
    "tts.getVoices": async (ctx) => {
      const system = await env.ask<SystemVoice[]>({ action: "tts", command: "voices" }, [], 5000);
      return [
        ...(Array.isArray(system) ? system : []).map((v) => ({
          voiceName: v.voiceName,
          lang: v.lang,
          remote: v.remote,
          eventTypes: ["start", "end", "interrupted", "cancelled", "error", "word", "sentence"],
        })),
        ...allEngineVoices(ctx.session),
      ];
    },
    "ttsEngine.event": (ctx, requestId: unknown, event: Record<string, unknown> | undefined) => {
      const resolve = typeof requestId === "string" ? engineRequests.get(requestId) : undefined;
      if (!resolve) return;
      const type = event?.type;
      if (type === "end" || type === "interrupted" || type === "cancelled") {
        engineRequests.delete(requestId as string);
        if (speakingEngine?.requestId === requestId) speakingEngine = null;
        resolve({ type });
      } else if (type === "error") {
        engineRequests.delete(requestId as string);
        if (speakingEngine?.requestId === requestId) speakingEngine = null;
        resolve({ type: "error", errorMessage: typeof event?.errorMessage === "string" ? event.errorMessage : "" });
      }
    },
    "ttsEngine.updateVoices": (ctx, voices: unknown) => {
      if (!Array.isArray(voices)) throw err("Invalid voices.");
      engineVoiceOverrides.set(
        ctx.extensionId,
        voices.flatMap((v) =>
          isObject(v) && typeof v.voiceName === "string"
            ? [
                {
                  voiceName: v.voiceName,
                  ...(typeof v.lang === "string" ? { lang: v.lang } : {}),
                  remote: v.remote === true,
                  extensionId: ctx.extensionId,
                  eventTypes: Array.isArray(v.eventTypes)
                    ? v.eventTypes.filter((t): t is string => typeof t === "string")
                    : ["start", "end"],
                },
              ]
            : [],
        ),
      );
    },

    // chrome.userScripts
    "userScripts.register": (ctx, scripts: unknown) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state || !Array.isArray(scripts)) throw err("Invalid scripts.");
      const existing = scriptsOf(ctx.session, ctx.extensionId);
      const added = scripts.map((v) => parseUserScript(v));
      for (const script of added)
        if (existing.some((e) => e.id === script.id) || added.filter((a) => a.id === script.id).length > 1)
          throw err(`Duplicate script ID '${script.id}'`);
      state.stored.userScripts = [...existing, ...added];
      state.save();
    },
    "userScripts.update": (ctx, scripts: unknown) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state || !Array.isArray(scripts)) throw err("Invalid scripts.");
      const existing = scriptsOf(ctx.session, ctx.extensionId);
      const next = [...existing];
      for (const change of scripts) {
        const id = isObject(change) ? change.id : undefined;
        const i = next.findIndex((s) => s.id === id);
        if (i === -1) throw err(`Script with ID '${String(id)}' does not exist or is not fully registered`);
        next[i] = parseUserScript(change, next[i]);
      }
      state.stored.userScripts = next;
      state.save();
    },
    "userScripts.unregister": (ctx, filter: Record<string, unknown> | undefined) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state) return;
      const ids = Array.isArray(filter?.ids) ? filter.ids : null;
      state.stored.userScripts = ids ? scriptsOf(ctx.session, ctx.extensionId).filter((s) => !ids.includes(s.id)) : [];
      state.save();
    },
    "userScripts.getScripts": (ctx, filter: Record<string, unknown> | undefined) => {
      const ids = Array.isArray(filter?.ids) ? filter.ids : null;
      return scriptsOf(ctx.session, ctx.extensionId).filter((s) => !ids || ids.includes(s.id));
    },
    "userScripts.configureWorld": (ctx, config: Record<string, unknown> | undefined) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state) return;
      const worldId = typeof config?.worldId === "string" ? config.worldId : "";
      state.stored.userScriptWorlds = { ...state.stored.userScriptWorlds, [worldId]: { ...config, worldId } };
      state.save();
    },
    "userScripts.getWorldConfigurations": (ctx) =>
      Object.values(env.state(ctx.session, ctx.extensionId)?.stored.userScriptWorlds ?? {}),
    "userScripts.resetWorldConfiguration": (ctx, worldId: unknown) => {
      const state = env.state(ctx.session, ctx.extensionId);
      if (!state?.stored.userScriptWorlds) return;
      delete state.stored.userScriptWorlds[typeof worldId === "string" ? worldId : ""];
      state.save();
    },
    "userScripts.execute": async (ctx, injection: Record<string, unknown> | undefined) => {
      const target = isObject(injection?.target) ? injection.target : {};
      const contents = env.tabContents(ctx.session, target.tabId);
      const js = parseUserScript({ id: "execute", matches: ["<all_urls>"], js: injection?.js }).js;
      const world = injection?.world === "MAIN" ? "MAIN" : "USER_SCRIPT";
      const worldNumber = worldOf(ctx.extensionId, typeof injection?.worldId === "string" ? injection.worldId : "");
      const frameIds = Array.isArray(target.frameIds) ? target.frameIds : null;
      const frames = [
        contents.mainFrame,
        ...(target.allFrames === true || frameIds
          ? contents.mainFrame.framesInSubtree.filter((f) => f !== contents.mainFrame)
          : []),
      ].filter((f) => !frameIds || frameIds.includes(f === contents.mainFrame ? 0 : f.frameTreeNodeId));
      const results = [];
      for (const frame of frames) {
        if (!env.hostAccess(ctx.session, ctx.extensionId, frame.url)) continue;
        let result: unknown;
        for (const code of scriptCode(ctx.session, ctx.extensionId, js))
          result = await runIn(contents, frame, code, world, worldNumber).catch((e) => ({ error: String(e) }));
        results.push({
          frameId: frame === contents.mainFrame ? 0 : frame.frameTreeNodeId,
          documentId: "",
          result,
        });
      }
      return results;
    },

    // Websites' icons for its pages (chrome-extension://<id>/_favicon/?pageUrl=…).
    "favicon.get": async (ctx, pageUrl: unknown, size: unknown) => {
      if (typeof pageUrl !== "string" || !/^https?:/i.test(pageUrl)) return null;
      return faviconFor(ctx.session, pageUrl, typeof size === "number" ? size : 16);
    },

    // chrome.sidePanel: a panel beside the workspace's tabs.
    "sidePanel.open": async (ctx) => {
      const url = env.sidePanelUrl(ctx.session, ctx.extensionId);
      if (!url) throw err("No active side panel for this extension.");
      await openSidePanel(ctx.session, ctx.extensionId, url);
    },
    "sidePanel.close": async (ctx) => openSidePanel(ctx.session, ctx.extensionId, null),

    // chrome.management: turning extensions on and off, removing one (the user says yes first).
    "management.setEnabled": async (ctx, id: unknown, enabled: unknown) => {
      if (typeof id !== "string" || (!ctx.session.extensions.getExtension(id) && enabled !== true))
        throw err(`Failed to find extension with id ${String(id)}.`);
      if (id === ctx.extensionId) throw err("An extension can't turn itself on or off.");
      if (!env.hasPermission(ctx.session, ctx.extensionId, "management"))
        throw err("The 'management' permission is required.");
      if (enabled === true) {
        const ok = await env.ask<boolean>(
          {
            action: "confirm",
            workspaceId: workspace(ctx.session),
            message: `${nameOf(ctx.session, ctx.extensionId)} wants to turn on another extension (${id}).`,
            confirmLabel: "Turn on",
          },
          false,
          5 * 60_000,
        );
        if (!ok) throw err("The user didn't allow it.");
      }
      env.setEnabled(id, enabled === true);
    },
    "management.uninstall": async (ctx, id: unknown, options: Record<string, unknown> | undefined) => {
      const target = id === null || id === undefined ? ctx.extensionId : String(id);
      if (target !== ctx.extensionId && !env.hasPermission(ctx.session, ctx.extensionId, "management"))
        throw err("The 'management' permission is required.");
      if (target !== ctx.extensionId || options?.showConfirmDialog === true) {
        const name = nameOf(ctx.session, target);
        const ok = await env.ask<boolean>(
          {
            action: "confirm",
            workspaceId: workspace(ctx.session),
            message:
              target === ctx.extensionId
                ? `Remove ${name}? Its data in every workspace goes with it.`
                : `${nameOf(ctx.session, ctx.extensionId)} wants to remove ${name}. Its data in every workspace goes with it.`,
            confirmLabel: "Remove",
          },
          false,
          5 * 60_000,
        );
        if (!ok) throw err("User cancelled uninstall");
      }
      await env.remove(target);
    },

    // chrome.tabs.discard: unloads the tab (Rune Browser's tab unloading), detectLanguage: the page's language.
    "tabs.discard": async (ctx, tabId: unknown) => {
      const contents = typeof tabId === "number" ? env.tabContents(ctx.session, tabId) : null;
      const target = contents ?? env.tabsIn(ctx.session).find((c) => !c.isFocused());
      if (!target) return undefined;
      const tab = env.tabObject(ctx.session, ctx.extensionId, target);
      const done = await env.ask<boolean>(
        { action: "discard", workspaceId: workspace(ctx.session), tabId: target.id },
        false,
        10_000,
      );
      return done ? { ...tab, discarded: true } : tab;
    },
    "tabs.detectLanguage": async (ctx, tabId: unknown) => {
      const contents =
        typeof tabId === "number" ? env.tabContents(ctx.session, tabId) : env.activeContents(ctx.session);
      if (!contents) throw err("No tab.");
      const lang = await contents
        .executeJavaScriptInIsolatedWorld(DECLARATIVE_WORLD, [{ code: "document.documentElement.lang || ''" }])
        .catch(() => "");
      return typeof lang === "string" && /^[a-z]{2,3}(-|$)/i.test(lang) ? lang.split("-")[0]!.toLowerCase() : "und";
    },
  };

  // --- Helpers that need the handlers' state ----------------------------------------------------------------------

  function* listenersFor(s: Session, event: string) {
    const ids = new Set<string>();
    for (const ctx of env.contexts.inSession(s)) if (ctx.events.has(event)) ids.add(ctx.extensionId);
    for (const ext of s.extensions.getAllExtensions())
      if (env.state(s, ext.id)?.backgroundEvents.has(event)) ids.add(ext.id);
    yield* ids;
  }

  const fontChanged = (genericFamily: string, fontId: string) => {
    for (const s of env.sessions())
      env.emit(s, "fontSettings.onFontChanged", (id) =>
        env.hasPermission(s, id, "fontSettings")
          ? [{ genericFamily, fontId, levelOfControl: "controllable_by_this_extension" }]
          : null,
      );
  };
  const sizeChanged = (which: FontSize, pixelSize: number) => {
    for (const s of env.sessions())
      env.emit(s, FONT_SIZES[which].event, (id) =>
        env.hasPermission(s, id, "fontSettings")
          ? [{ pixelSize, levelOfControl: "controllable_by_this_extension" }]
          : null,
      );
  };

  async function stopSpeaking(s: Session) {
    void s;
    if (speakingEngine) {
      const { s: es, id, requestId } = speakingEngine;
      speakingEngine = null;
      void dispatch(env.contexts, env.state(es, id), es, id, "ttsEngine.onStop", []);
      engineRequests.get(requestId)?.({ type: "interrupted" });
      engineRequests.delete(requestId);
    }
    await env.ask({ action: "tts", command: "stop" }, null, 5000);
  }

  async function openSidePanel(s: Session, id: string, url: string | null) {
    const workspaceId = workspace(s);
    const shown = await env.ask<boolean>(
      { action: "side-panel", workspaceId, extensionId: id, name: nameOf(s, id), url },
      false,
      10_000,
    );
    if (!shown && url) throw err("There's no window to show the side panel in.");
    env.emit(s, url ? "sidePanel.onOpened" : "sidePanel.onClosed", (ext) =>
      ext === id ? [{ windowId: env.windowId(), path: url ?? "" }] : null,
    );
  }

  /** chrome.identity.launchWebAuthFlow: the page in a window of its own until it goes to the extension's redirect URL. */
  function webAuthFlow(s: Session, id: string, details: Record<string, unknown>) {
    const url = typeof details.url === "string" ? details.url : "";
    if (!/^https?:\/\//i.test(url)) return Promise.reject(err("Authorization page could not be loaded."));
    const interactive = details.interactive === true;
    const redirect = `https://${id}.chromiumapp.org/`;
    return new Promise<string>((resolve, reject) => {
      const parent = env.window();
      const win = new BrowserWindow({
        width: 520,
        height: 700,
        show: false,
        title: nameOf(s, id),
        ...(parent ? { parent } : {}),
        autoHideMenuBar: true,
        webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      let done = false;
      const finish = (error: string | null, result?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
        if (error) reject(err(error));
        else resolve(result!);
      };
      const timeout =
        typeof details.timeoutMsForNonInteractive === "number" ? details.timeoutMsForNonInteractive : 1000;
      const timer = setTimeout(
        () => finish(interactive ? "Authorization page could not be loaded." : "User interaction required."),
        interactive ? 10 * 60_000 : Math.max(timeout, 1000) + 30_000,
      );
      const check = (event: { preventDefault: () => void } | null, target: string) => {
        if (!target.startsWith(redirect)) return false;
        event?.preventDefault();
        finish(null, target);
        return true;
      };
      const contents = win.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-redirect", (e) => check(e, e.url));
      contents.on("will-navigate", (e) => check(e, e.url));
      contents.on("did-navigate", (_e, to) => check(null, to));
      contents.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
        if (!isMainFrame || check(null, failedUrl) || code === -3) return;
        finish("Authorization page could not be loaded.");
      });
      contents.on("did-finish-load", () => {
        if (done) return;
        if (interactive) {
          win.show();
          return;
        }
        // Not interactive: it had to get through without the user.
        if (details.abortOnLoadForNonInteractive !== false) finish("User interaction required.");
        else setTimeout(() => finish("User interaction required."), timeout);
      });
      win.on("closed", () => finish("The user did not approve access."));
      contents.loadURL(url).catch(() => {});
    });
  }

  /** A website's icon as a data URL: the one a tab shows for it, the site's own /favicon.ico, or none. */
  const faviconCache = new Map<string, string | null>();
  async function faviconFor(s: Session, pageUrl: string, size: number) {
    void size;
    let origin: string;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return null;
    }
    if (faviconCache.has(origin)) return faviconCache.get(origin) ?? null;
    const candidates = [`${origin}/favicon.ico`];
    for (const c of env.tabsIn(s)) {
      try {
        if (new URL(c.getURL()).origin === origin) {
          const icon = await c
            .executeJavaScriptInIsolatedWorld(DECLARATIVE_WORLD, [
              { code: `document.querySelector('link[rel~="icon"]')?.href || ""` },
            ])
            .catch(() => "");
          if (typeof icon === "string" && icon) candidates.unshift(icon);
          break;
        }
      } catch {
        // a page that isn't a website
      }
    }
    for (const candidate of candidates) {
      try {
        const res = await s.fetch(candidate, { credentials: "omit" } as RequestInit);
        const type = res.headers.get("content-type") ?? "image/x-icon";
        if (!res.ok || !/^image\//i.test(type)) continue;
        const data = Buffer.from(await res.arrayBuffer());
        if (!data.length || data.length > 1_000_000) continue;
        const icon = `data:${type.split(";")[0]};base64,${data.toString("base64")}`;
        faviconCache.set(origin, icon);
        return icon;
      } catch {
        // the next one
      }
    }
    faviconCache.set(origin, null);
    return null;
  }

  // --- Following web tabs -------------------------------------------------------------------------------------------

  /** A web tab: its visits (history.onVisited), declarativeContent's conditions, user scripts, the WebRTC policy. */
  function trackGuest(contents: WebContents) {
    const s = contents.session;
    applyWebrtc(contents);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void evaluatePage(contents), 1500);
    };
    contents.on("did-navigate", (_e, url) => {
      visited(s, url);
      void evaluatePage(contents);
    });
    contents.on("did-navigate-in-page", (_e, _url, isMainFrame) => isMainFrame && void evaluatePage(contents));
    contents.on("dom-ready", () => {
      injectUserScripts(contents, contents.mainFrame, "start");
      void evaluatePage(contents);
      later();
    });
    contents.on("did-finish-load", () => injectUserScripts(contents, contents.mainFrame, "idle"));
    contents.on("did-frame-finish-load", (_e, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      const frame = contents.mainFrame.framesInSubtree.find(
        (f) => f.processId === processId && f.routingId === routingId,
      );
      if (frame && !frame.isDestroyed()) {
        injectUserScripts(contents, frame, "start");
        injectUserScripts(contents, frame, "idle");
      }
    });
    contents.once("destroyed", () => {
      clearTimeout(timer);
      if (debugged.has(contents.id)) detachDebugger(contents.id, "target_closed");
      for (const ext of s.extensions.getAllExtensions()) env.state(s, ext.id)?.pageActions.delete(contents.id);
    });
  }

  /** A tab closed: sessions.onChanged (it's in the recently closed ones now). */
  function tabsClosed(s: Session) {
    env.emit(s, "sessions.onChanged", (id) => (env.hasPermission(s, id, "sessions") ? [] : null));
  }

  /** The extension loaded in a session (or its worker started): what it set that's kept is put back (its proxy). */
  async function restore(s: Session, id: string) {
    const proxy = env.state(s, id)?.stored.proxy;
    if (proxy && !proxyApplied.has(s) && env.hasPermission(s, id, "proxy"))
      await applyProxy(s, id, proxy).catch((e) => console.warn(`Restoring the proxy of ${id} failed:`, e));
    watchDownloads();
  }

  return { handlers, trackGuest, tabsClosed, restore, openSidePanel, evaluateAll, expectsMedia };
}

/** The isolated world declarativeContent and the page's language are looked up in. */
const DECLARATIVE_WORLD = 1_999_999;
/** User scripts' worlds: one per extension and worldId, from here on. */
const USER_SCRIPT_WORLDS = 2_000_000;

const FONT_FIELDS: Record<string, "standard" | "serif" | "sansSerif" | "fixed" | null> = {
  standard: "standard",
  serif: "serif",
  sansserif: "sansSerif",
  fixed: "fixed",
  cursive: null,
  fantasy: null,
  math: null,
};
type FontSize = "default" | "fixed" | "minimum";
const FONT_SIZES: Record<
  FontSize,
  { field: "size" | "fixedSize" | "minimumSize"; min: number; max: number; default: number; event: string }
> = {
  default: { field: "size", min: 6, max: 72, default: 16, event: "fontSettings.onDefaultFontSizeChanged" },
  fixed: { field: "fixedSize", min: 6, max: 72, default: 13, event: "fontSettings.onDefaultFixedFontSizeChanged" },
  minimum: { field: "minimumSize", min: 0, max: 24, default: 0, event: "fontSettings.onMinimumFontSizeChanged" },
};

/** The computer's storage devices (chrome.system.storage), with their mount points. */
function storageUnits() {
  const units: { id: string; name: string; type: "fixed" | "removable" | "unknown"; capacity: number; path: string }[] =
    [];
  const add = (path: string, name: string, type: "fixed" | "removable") => {
    try {
      const fs = statfsSync(path);
      if (!fs.blocks) return;
      units.push({ id: path, name, type, capacity: fs.blocks * fs.bsize, path });
    } catch {
      // not there
    }
  };
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      if (existsSync(root)) add(root, `${letter}:`, letter === "C" ? "fixed" : "removable");
    }
  } else if (process.platform === "darwin") {
    add("/", "Macintosh HD", "fixed");
    try {
      for (const v of readdirSync("/Volumes")) if (v !== "Macintosh HD") add(join("/Volumes", v), v, "removable");
    } catch {
      // no volumes
    }
  } else {
    try {
      const seen = new Set<string>();
      for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
        const [device, mount] = line.split(" ");
        if (!device?.startsWith("/dev/") || !mount || /^\/dev\/loop/.test(device) || seen.has(device)) continue;
        if (/^\/(snap|boot|var\/lib|run\/(user|snapd))/.test(mount)) continue;
        seen.add(device);
        const path = mount.replace(/\\040/g, " ");
        const removable = /^\/(media|run\/media|mnt)\//.test(path);
        add(path, path === "/" ? "File system" : basename(path), removable ? "removable" : "fixed");
      }
    } catch {
      add("/", "File system", "fixed");
    }
  }
  return units;
}
