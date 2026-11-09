// The parts of the chrome.* APIs Rune Browser adds for extensions that don't need Electron (so they're tested on
// their own): proxy settings as Electron's, declarativeContent's page conditions, history and downloads as
// Chrome's objects, content settings as Rune Browser's site settings, browsingData's types, user scripts' URL
// matching, and the voices of text-to-speech engines. main/extensions/browserApis.ts uses them.
import type { DownloadInfo } from "./downloads";
import { matchPattern, type Manifest } from "./extensions";
import type { SiteSettingKey } from "./browser";
import type { Visit } from "./visits";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// --- chrome.proxy -----------------------------------------------------------------------------------

/** chrome.proxy's ProxyConfig, as an extension sets it. */
export interface ChromeProxyConfig {
  mode: "direct" | "auto_detect" | "pac_script" | "fixed_servers" | "system";
  rules?: {
    singleProxy?: ChromeProxyServer;
    proxyForHttp?: ChromeProxyServer;
    proxyForHttps?: ChromeProxyServer;
    proxyForFtp?: ChromeProxyServer;
    fallbackProxy?: ChromeProxyServer;
    bypassList?: string[];
  };
  pacScript?: { url?: string; data?: string; mandatory?: boolean };
}

export interface ChromeProxyServer {
  scheme?: "http" | "https" | "quic" | "socks4" | "socks5";
  host: string;
  port?: number;
}

const PROXY_SCHEMES = ["http", "https", "quic", "socks4", "socks5"];
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, quic: 443, socks4: 1080, socks5: 1080 };

function proxyUri(server: unknown, what: string) {
  if (!isObject(server) || typeof server.host !== "string" || !server.host.trim())
    throw new Error(`Invalid proxy: ${what} needs a host.`);
  const scheme = server.scheme === undefined ? "http" : String(server.scheme);
  if (!PROXY_SCHEMES.includes(scheme)) throw new Error(`Invalid proxy scheme '${scheme}'.`);
  const host = server.host.trim();
  if (/[\s;,=/]/.test(host)) throw new Error(`Invalid proxy host '${host}'.`);
  const port = server.port === undefined ? DEFAULT_PORTS[scheme]! : Number(server.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid proxy port '${server.port}'.`);
  return `${scheme}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/** Electron's ProxyConfig (`session.setProxy`). */
export interface ElectronProxyConfig {
  mode?: "direct" | "auto_detect" | "pac_script" | "fixed_servers" | "system";
  pacScript?: string;
  proxyRules?: string;
  proxyBypassRules?: string;
}

const base64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** An extension's proxy settings as Electron's `session.setProxy` takes them; throws when they aren't valid. */
export function proxyConfigToElectron(value: unknown): ElectronProxyConfig {
  if (!isObject(value)) throw new Error("Invalid proxy settings.");
  const mode = value.mode;
  if (mode === "direct" || mode === "auto_detect" || mode === "system") return { mode };
  if (mode === "pac_script") {
    const pac = value.pacScript;
    if (!isObject(pac)) throw new Error("pac_script needs a pacScript.");
    if (typeof pac.url === "string" && pac.url) return { mode, pacScript: pac.url };
    if (typeof pac.data === "string" && pac.data) {
      return { mode, pacScript: `data:application/x-ns-proxy-autoconfig;base64,${base64(pac.data)}` };
    }
    throw new Error("pacScript needs a url or data.");
  }
  if (mode !== "fixed_servers") throw new Error(`Invalid proxy mode '${String(mode)}'.`);
  const rules = value.rules;
  if (!isObject(rules)) throw new Error("fixed_servers needs rules.");
  const parts: string[] = [];
  if (rules.singleProxy !== undefined) {
    if (rules.proxyForHttp || rules.proxyForHttps || rules.proxyForFtp)
      throw new Error("singleProxy can't be used together with proxyForHttp, proxyForHttps or proxyForFtp.");
    parts.push(proxyUri(rules.singleProxy, "singleProxy"));
  } else {
    if (rules.proxyForHttp !== undefined) parts.push(`http=${proxyUri(rules.proxyForHttp, "proxyForHttp")}`);
    if (rules.proxyForHttps !== undefined) parts.push(`https=${proxyUri(rules.proxyForHttps, "proxyForHttps")}`);
    if (rules.proxyForFtp !== undefined) parts.push(`ftp=${proxyUri(rules.proxyForFtp, "proxyForFtp")}`);
    if (rules.fallbackProxy !== undefined) parts.push(`socks=${proxyUri(rules.fallbackProxy, "fallbackProxy")}`);
  }
  if (!parts.length) throw new Error("fixed_servers needs at least one proxy.");
  const bypass = Array.isArray(rules.bypassList)
    ? rules.bypassList.filter((b): b is string => typeof b === "string" && !!b.trim()).map((b) => b.trim())
    : [];
  return { mode, proxyRules: parts.join(";"), ...(bypass.length ? { proxyBypassRules: bypass.join(",") } : {}) };
}

// --- chrome.declarativeContent ----------------------------------------------------------------------

/** declarativeContent's UrlFilter (also events.UrlFilter). */
export type UrlFilter = Partial<
  Record<
    | "hostContains"
    | "hostEquals"
    | "hostPrefix"
    | "hostSuffix"
    | "pathContains"
    | "pathEquals"
    | "pathPrefix"
    | "pathSuffix"
    | "queryContains"
    | "queryEquals"
    | "queryPrefix"
    | "querySuffix"
    | "urlContains"
    | "urlEquals"
    | "urlMatches"
    | "originAndPathMatches"
    | "urlPrefix"
    | "urlSuffix",
    string
  >
> & { schemes?: string[]; ports?: (number | [number, number])[] };

const DEFAULT_URL_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21 };

/** Whether a URL passes a UrlFilter (every criterion it has, like Chrome's). */
export function urlFilterMatches(filter: UrlFilter, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const query = u.search.replace(/^\?/, "");
  // Chrome compares URLs without their fragment, with the port only when it isn't the scheme's.
  const plain = url.split("#")[0]!;
  const lower = (s: string) => s.toLowerCase();
  const checks: [string | undefined, (v: string) => boolean][] = [
    [filter.hostContains, (v) => `.${host}`.includes(lower(v))],
    [filter.hostEquals, (v) => host === lower(v)],
    [filter.hostPrefix, (v) => host.startsWith(lower(v))],
    [filter.hostSuffix, (v) => host.endsWith(lower(v))],
    [filter.pathContains, (v) => path.includes(v)],
    [filter.pathEquals, (v) => path === v],
    [filter.pathPrefix, (v) => path.startsWith(v)],
    [filter.pathSuffix, (v) => path.endsWith(v)],
    [filter.queryContains, (v) => query.includes(v)],
    [filter.queryEquals, (v) => query === v],
    [filter.queryPrefix, (v) => query.startsWith(v)],
    [filter.querySuffix, (v) => query.endsWith(v)],
    [filter.urlContains, (v) => plain.includes(v)],
    [filter.urlEquals, (v) => plain === v],
    [filter.urlPrefix, (v) => plain.startsWith(v)],
    [filter.urlSuffix, (v) => plain.endsWith(v)],
    [filter.urlMatches, (v) => safeRegExp(v)?.test(plain) ?? false],
    [filter.originAndPathMatches, (v) => safeRegExp(v)?.test(`${u.origin}${path}`) ?? false],
  ];
  for (const [value, test] of checks) if (typeof value === "string" && !test(value)) return false;
  if (Array.isArray(filter.schemes) && filter.schemes.length && !filter.schemes.map(lower).includes(scheme))
    return false;
  if (Array.isArray(filter.ports) && filter.ports.length) {
    const port = u.port ? Number(u.port) : (DEFAULT_URL_PORTS[scheme] ?? -1);
    const ok = filter.ports.some((p) =>
      Array.isArray(p) ? port >= Number(p[0]) && port <= Number(p[1]) : port === Number(p),
    );
    if (!ok) return false;
  }
  return true;
}

function safeRegExp(source: string) {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/** A declarativeContent.PageStateMatcher, as the shim sends it. */
export interface PageStateMatcher {
  pageUrl?: UrlFilter;
  css?: string[];
  isBookmarked?: boolean;
}

/** A declarativeContent rule: a page that meets one of its conditions gets its actions. */
export interface PageRule {
  id: string;
  priority: number;
  conditions: PageStateMatcher[];
  /** "show" (ShowAction, ShowPageAction), "icon" (SetIcon) or "script" (RequestContentScript). */
  actions: PageAction[];
}

export type PageAction =
  | { type: "show" }
  | { type: "icon"; icon: string }
  | { type: "script"; js: string[]; css: string[]; allFrames: boolean };

/** What a page is, for the conditions: its URL, the CSS selectors that match in it, and whether it's bookmarked. */
export interface PageState {
  url: string;
  css: ReadonlySet<string>;
  bookmarked: boolean;
}

export function pageStateMatches(matcher: PageStateMatcher, page: PageState) {
  if (matcher.pageUrl && !urlFilterMatches(matcher.pageUrl, page.url)) return false;
  if (matcher.css?.length && !matcher.css.every((selector) => page.css.has(selector))) return false;
  if (typeof matcher.isBookmarked === "boolean" && matcher.isBookmarked !== page.bookmarked) return false;
  return true;
}

/** The actions of the rules a page meets (highest priority first). */
export function pageActions(rules: readonly PageRule[], page: PageState): PageAction[] {
  return [...rules]
    .sort((a, b) => b.priority - a.priority)
    .filter((r) => r.conditions.some((c) => pageStateMatches(c, page)))
    .flatMap((r) => r.actions);
}

/** The CSS selectors the rules ask about (pages are asked which of them match). */
export const pageSelectors = (rules: readonly PageRule[]) => [
  ...new Set(rules.flatMap((r) => r.conditions.flatMap((c) => c.css ?? []))),
];

/** Checks a rule the shim sent; null if it isn't one. */
export function parsePageRule(value: unknown, fallbackId: string): PageRule | null {
  if (!isObject(value) || !Array.isArray(value.conditions) || !Array.isArray(value.actions)) return null;
  const conditions: PageStateMatcher[] = [];
  for (const c of value.conditions) {
    if (!isObject(c)) return null;
    const matcher: PageStateMatcher = {};
    if (isObject(c.pageUrl)) matcher.pageUrl = c.pageUrl as UrlFilter;
    if (Array.isArray(c.css)) matcher.css = c.css.filter((s): s is string => typeof s === "string").slice(0, 100);
    if (typeof c.isBookmarked === "boolean") matcher.isBookmarked = c.isBookmarked;
    conditions.push(matcher);
  }
  const actions: PageAction[] = [];
  for (const a of value.actions) {
    if (!isObject(a)) return null;
    if (a.type === "show") actions.push({ type: "show" });
    else if (a.type === "icon" && typeof a.icon === "string") actions.push({ type: "icon", icon: a.icon });
    else if (a.type === "script")
      actions.push({
        type: "script",
        js: Array.isArray(a.js) ? a.js.filter((s): s is string => typeof s === "string") : [],
        css: Array.isArray(a.css) ? a.css.filter((s): s is string => typeof s === "string") : [],
        allFrames: a.allFrames === true,
      });
    else return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : fallbackId,
    priority: typeof value.priority === "number" ? value.priority : 100,
    conditions,
    actions,
  };
}

// --- chrome.history ---------------------------------------------------------------------------------

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
}

/** Visits (newest first) as Chrome's history items: one per page, newest first, at most `max`. */
export function historyItems(visits: readonly Pick<Visit, "id" | "url" | "title" | "visitedAt">[], max = 100) {
  const byUrl = new Map<string, HistoryItem>();
  for (const v of visits) {
    const time = Date.parse(v.visitedAt);
    const item = byUrl.get(v.url);
    if (!item) {
      byUrl.set(v.url, {
        id: String(v.id),
        url: v.url,
        title: v.title,
        lastVisitTime: time,
        visitCount: 1,
        typedCount: 0,
      });
      continue;
    }
    item.visitCount++;
    if (time > item.lastVisitTime) {
      item.lastVisitTime = time;
      item.id = String(v.id);
      if (v.title) item.title = v.title;
    } else if (!item.title && v.title) item.title = v.title;
  }
  return [...byUrl.values()].sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, Math.max(0, max));
}

/** A page's visits as Chrome's VisitItems (oldest first, like Chrome). */
export function visitItems(visits: readonly Pick<Visit, "id" | "visitedAt">[], pageId: string) {
  return [...visits]
    .sort((a, b) => a.id - b.id)
    .map((v) => ({
      id: pageId,
      visitId: String(v.id),
      visitTime: Date.parse(v.visitedAt),
      referringVisitId: "0",
      transition: "link",
      isLocal: true,
    }));
}

// --- chrome.contentSettings -----------------------------------------------------------------------

/** Chrome's content setting types and the site setting each is in Rune Browser (null: Rune Browser has none). */
export const CONTENT_SETTINGS: Record<string, SiteSettingKey | null> = {
  cookies: null,
  images: "images",
  javascript: "javascript",
  location: "location",
  plugins: null,
  popups: null,
  notifications: "notifications",
  microphone: "microphone",
  camera: "camera",
  unsandboxedPlugins: null,
  automaticDownloads: null,
  autoVerify: null,
  clipboard: "clipboard",
  sound: "sound",
};

/** A content settings pattern's site: null for every site ("<all_urls>", "*://*\/*"), undefined if it isn't valid. */
export function contentPatternSite(pattern: unknown): string | null | undefined {
  if (typeof pattern !== "string") return undefined;
  if (pattern === "<all_urls>") return null;
  const m = /^(\*|https?|file|ftp|chrome-extension):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!m) return undefined;
  const host = m[2]!.toLowerCase().replace(/:\d+$/, "");
  if (host === "*" || host === "") return null;
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  if (!/^[a-z0-9.-]+$/.test(bare) || bare.includes("*")) return undefined;
  return bare.replace(/^www\./, "");
}

// --- chrome.browsingData ------------------------------------------------------------------------------

/** What browsingData can remove (DataTypeSet's keys). */
export const BROWSING_DATA_TYPES = [
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
] as const;
export type BrowsingDataType = (typeof BROWSING_DATA_TYPES)[number];

/** Electron's `session.clearData` data types. */
type ElectronDataType =
  | "backgroundFetch"
  | "cache"
  | "cookies"
  | "downloads"
  | "fileSystems"
  | "indexedDB"
  | "localStorage"
  | "serviceWorkers"
  | "webSQL";

/** The data types to remove, split by where they're kept: the session (Electron's), Cache Storage, the server's history, the downloads list. */
export function browsingDataPlan(dataToRemove: unknown) {
  const wanted = new Set<BrowsingDataType>(
    isObject(dataToRemove) ? BROWSING_DATA_TYPES.filter((t) => dataToRemove[t] === true) : [],
  );
  const session = new Set<ElectronDataType>();
  if (wanted.has("cache") || wanted.has("appcache")) session.add("cache");
  if (wanted.has("cookies")) session.add("cookies");
  if (wanted.has("fileSystems")) session.add("fileSystems");
  if (wanted.has("indexedDB")) session.add("indexedDB");
  if (wanted.has("localStorage")) session.add("localStorage");
  if (wanted.has("serviceWorkers")) session.add("serviceWorkers");
  if (wanted.has("webSQL")) session.add("webSQL");
  return {
    session: [...session],
    cacheStorage: wanted.has("cacheStorage"),
    history: wanted.has("history"),
    downloads: wanted.has("downloads"),
  };
}

// --- chrome.userScripts --------------------------------------------------------------------------------

export interface UserScript {
  id: string;
  matches: string[];
  excludeMatches: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  js: ({ code: string } | { file: string })[];
  runAt: "document_start" | "document_end" | "document_idle";
  allFrames: boolean;
  world: "USER_SCRIPT" | "MAIN";
  worldId: string;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** Checks a script an extension registers (or the changes to one, over `base`); throws when it isn't valid. */
export function parseUserScript(value: unknown, base?: UserScript): UserScript {
  if (!isObject(value) || typeof value.id !== "string" || !value.id) throw new Error("A user script needs an id.");
  if (value.id.startsWith("_")) throw new Error("A user script's id can't start with '_'.");
  const pick = <K extends keyof UserScript>(key: K, parse: (v: unknown) => UserScript[K], fallback: UserScript[K]) =>
    value[key] !== undefined ? parse(value[key]) : base ? base[key] : fallback;
  const script: UserScript = {
    id: value.id,
    matches: pick("matches", strings, []),
    excludeMatches: pick("excludeMatches", strings, []),
    includeGlobs: pick("includeGlobs", strings, []),
    excludeGlobs: pick("excludeGlobs", strings, []),
    js: pick(
      "js",
      (v) =>
        Array.isArray(v)
          ? v.flatMap((s): UserScript["js"] =>
              isObject(s) && typeof s.code === "string"
                ? [{ code: s.code }]
                : isObject(s) && typeof s.file === "string"
                  ? [{ file: s.file }]
                  : [],
            )
          : [],
      [],
    ),
    runAt: pick(
      "runAt",
      (v) => (v === "document_start" || v === "document_end" ? v : "document_idle"),
      "document_idle",
    ),
    allFrames: pick("allFrames", (v) => v === true, false),
    world: pick("world", (v) => (v === "MAIN" ? "MAIN" : "USER_SCRIPT"), "USER_SCRIPT"),
    worldId: pick("worldId", (v) => (typeof v === "string" ? v : ""), ""),
  };
  if (!script.matches.length) throw new Error(`User script '${script.id}' needs at least one match pattern.`);
  for (const p of [...script.matches, ...script.excludeMatches])
    if (!matchPattern(p)) throw new Error(`Invalid match pattern '${p}'.`);
  if (!script.js.length) throw new Error(`User script '${script.id}' needs code or a file to run.`);
  return script;
}

const globRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .split("")
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );

/** Whether a user script (or a content script) runs on a URL: its patterns, then its globs. */
export function userScriptMatches(
  script: Pick<UserScript, "matches" | "excludeMatches" | "includeGlobs" | "excludeGlobs">,
  url: string,
) {
  const match = (p: string) => matchPattern(p)?.(url) ?? false;
  if (!script.matches.some(match) || script.excludeMatches.some(match)) return false;
  if (script.includeGlobs.length && !script.includeGlobs.some((g) => globRegExp(g).test(url))) return false;
  if (script.excludeGlobs.some((g) => globRegExp(g).test(url))) return false;
  return true;
}

// --- chrome.tts / ttsEngine -----------------------------------------------------------------------------

export interface TtsVoice {
  voiceName: string;
  lang?: string;
  remote: boolean;
  extensionId?: string;
  eventTypes: string[];
}

/** The voices an extension's text-to-speech engine offers (its manifest's tts_engine). */
export function engineVoices(id: string, manifest: Manifest): TtsVoice[] {
  const engine = (manifest as { tts_engine?: { voices?: unknown } }).tts_engine;
  if (!engine || !Array.isArray(engine.voices)) return [];
  return engine.voices.flatMap((v) =>
    isObject(v) && typeof v.voice_name === "string"
      ? [
          {
            voiceName: v.voice_name,
            ...(typeof v.lang === "string" ? { lang: v.lang } : {}),
            remote: v.remote === true,
            extensionId: id,
            eventTypes: strings(v.event_types).length ? strings(v.event_types) : ["start", "end"],
          },
        ]
      : [],
  );
}

// --- chrome.downloads ---------------------------------------------------------------------------------

const DOWNLOAD_STATES: Record<DownloadInfo["state"], string> = {
  progressing: "in_progress",
  completed: "complete",
  cancelled: "interrupted",
  interrupted: "interrupted",
};

/** A download as Chrome's DownloadItem (`id` is its number for extensions). */
export function downloadItem(d: DownloadInfo, id: number) {
  const filename = (d.unconfirmedPath && !d.kept ? d.unconfirmedPath : d.path) || "";
  const state = DOWNLOAD_STATES[d.state];
  return {
    id,
    url: d.url,
    finalUrl: d.url,
    referrer: d.pageUrl ?? "",
    filename,
    incognito: false,
    danger: d.danger === "file" ? "file" : d.danger === "insecure" ? "url" : d.kept ? "accepted" : "safe",
    mime: d.mime,
    startTime: new Date(d.startedAt).toISOString(),
    ...(d.endedAt ? { endTime: new Date(d.endedAt).toISOString() } : {}),
    state,
    paused: d.paused,
    canResume: d.canResume ?? false,
    ...(d.state === "cancelled"
      ? { error: "USER_CANCELED" }
      : d.state === "interrupted"
        ? { error: d.error && /network/i.test(d.error) ? "NETWORK_FAILED" : "FILE_FAILED" }
        : {}),
    bytesReceived: d.receivedBytes,
    totalBytes: d.totalBytes || -1,
    fileSize: d.state === "completed" ? d.receivedBytes : d.totalBytes || -1,
    exists: d.state === "completed" ? d.exists !== false : true,
  };
}

export type DownloadItem = ReturnType<typeof downloadItem>;

/** chrome.downloads.search: the downloads that match a query (newest first, unless it orders them). */
export function searchDownloads(items: readonly DownloadItem[], q: Record<string, unknown>) {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const time = (v: unknown) => (typeof v === "string" ? Date.parse(v) : undefined);
  let list = items.filter((d) => {
    if (num(q.id) !== undefined && d.id !== q.id) return false;
    if (typeof q.url === "string" && d.url !== q.url) return false;
    if (typeof q.finalUrl === "string" && d.finalUrl !== q.finalUrl) return false;
    if (typeof q.urlRegex === "string" && !safeRegExp(q.urlRegex)?.test(d.url)) return false;
    if (typeof q.finalUrlRegex === "string" && !safeRegExp(q.finalUrlRegex)?.test(d.finalUrl)) return false;
    if (typeof q.filename === "string" && d.filename !== q.filename) return false;
    if (typeof q.filenameRegex === "string" && !safeRegExp(q.filenameRegex)?.test(d.filename)) return false;
    if (typeof q.mime === "string" && d.mime !== q.mime) return false;
    if (typeof q.state === "string" && d.state !== q.state) return false;
    if (typeof q.paused === "boolean" && d.paused !== q.paused) return false;
    if (typeof q.danger === "string" && d.danger !== q.danger) return false;
    if (typeof q.exists === "boolean" && d.exists !== q.exists) return false;
    if (typeof q.error === "string" && (d as { error?: string }).error !== q.error) return false;
    const started = Date.parse(d.startTime);
    const ended = "endTime" in d && d.endTime ? Date.parse(d.endTime) : undefined;
    if (time(q.startedBefore) !== undefined && !(started < time(q.startedBefore)!)) return false;
    if (time(q.startedAfter) !== undefined && !(started > time(q.startedAfter)!)) return false;
    if (time(q.endedBefore) !== undefined && !(ended !== undefined && ended < time(q.endedBefore)!)) return false;
    if (time(q.endedAfter) !== undefined && !(ended !== undefined && ended > time(q.endedAfter)!)) return false;
    if (num(q.totalBytesGreater) !== undefined && !(d.totalBytes > num(q.totalBytesGreater)!)) return false;
    if (num(q.totalBytesLess) !== undefined && !(d.totalBytes < num(q.totalBytesLess)!)) return false;
    if (num(q.bytesReceived) !== undefined && d.bytesReceived !== q.bytesReceived) return false;
    if (num(q.totalBytes) !== undefined && d.totalBytes !== q.totalBytes) return false;
    if (num(q.fileSize) !== undefined && d.fileSize !== q.fileSize) return false;
    if (typeof q.query === "string" || Array.isArray(q.query)) {
      const terms = (Array.isArray(q.query) ? q.query : q.query!.split(/\s+/)).filter(
        (t): t is string => typeof t === "string" && !!t,
      );
      const text = `${d.url} ${d.filename}`.toLowerCase();
      for (const t of terms) {
        const negative = t.startsWith("-");
        const has = text.includes((negative ? t.slice(1) : t).toLowerCase());
        if (negative === has) return false;
      }
    }
    return true;
  });
  const order = (Array.isArray(q.orderBy) ? q.orderBy : ["-startTime"]).filter(
    (o): o is string => typeof o === "string",
  );
  list = [...list].sort((a, b) => {
    for (const o of order) {
      const desc = o.startsWith("-");
      const key = (desc ? o.slice(1) : o) as keyof DownloadItem;
      const x = a[key] ?? "";
      const y = b[key] ?? "";
      if (x === y) continue;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
  const limit = num(q.limit);
  return limit === undefined || limit === 0 ? (limit === 0 ? list : list.slice(0, 1000)) : list.slice(0, limit);
}
