// Browser settings (Settings → Browser): what a browser like Chrome lets you
// set, kept apart from Rune Browser's own settings. The schema lives here with
// what's computed from it: a site's settings, the search engine, the
// declarativeNetRequest rules for the privacy and content settings, and what
// a Chromium profile's Preferences hold (Import).
import { Effect, Schema } from "effect";
import type { DnrRule } from "./extensions";

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value));

// --- Search engine -----------------------------------------------------------------------------

export const searchEngines = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { label: "Google", url: "https://www.google.com/search?q=%s" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=%s" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  kagi: { label: "Kagi", url: "https://kagi.com/search?q=%s" },
  ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/do/search?q=%s" },
} as const;
export type SearchEngineId = keyof typeof searchEngines;

/** A search URL: http(s), with %s where the words go. */
export const isSearchUrl = (url: string) => /^https?:\/\/[^\s]+$/i.test(url.trim()) && url.includes("%s");

// --- Site settings -----------------------------------------------------------------------------

/**
 * What can be set per site, like Chrome's site settings. Permissions are what
 * sites ask for (default: they can ask, or they can't); content is what pages
 * may do (default: allowed or not).
 */
export const siteSettings = {
  location: { label: "Location", kind: "permission", icon: "map-pin", about: "See where you are" },
  camera: { label: "Camera", kind: "permission", icon: "camera", about: "Use your camera" },
  microphone: { label: "Microphone", kind: "permission", icon: "mic", about: "Use your microphone" },
  notifications: { label: "Notifications", kind: "permission", icon: "bell", about: "Send notifications" },
  midi: { label: "MIDI devices", kind: "permission", icon: "piano", about: "Use your MIDI devices" },
  clipboard: { label: "Clipboard", kind: "permission", icon: "clipboard", about: "See text and images you copied" },
  screen: { label: "Screen sharing", kind: "permission", icon: "monitor-up", about: "Share your screen" },
  idle: {
    label: "Your device use",
    kind: "permission",
    icon: "activity",
    about: "Know when you're actively using this device",
  },
  windows: {
    label: "Window management",
    kind: "permission",
    icon: "app-window",
    about: "Manage windows on all your displays",
  },
  fonts: { label: "Fonts", kind: "permission", icon: "type", about: "Use the fonts on your computer" },
  files: { label: "File editing", kind: "permission", icon: "file-pen", about: "Edit files on your device" },
  storage: {
    label: "Embedded content",
    kind: "permission",
    icon: "cookie",
    about: "Let embedded sites use info they've saved about you",
  },
  localNetwork: {
    label: "Local network access",
    kind: "permission",
    icon: "network",
    about: "Look for and connect to any device on your local network",
  },
  javascript: { label: "JavaScript", kind: "content", icon: "braces", about: "Run JavaScript" },
  images: { label: "Images", kind: "content", icon: "image", about: "Show images" },
  sound: { label: "Sound", kind: "content", icon: "volume-2", about: "Play sound" },
} as const;
export type SiteSettingKey = keyof typeof siteSettings;
export const siteSettingKeys = Object.keys(siteSettings) as SiteSettingKey[];
export type SiteDecision = "allow" | "block";
/** A setting's default: permissions "ask" or "block", content "allow" or "block". */
export type SiteDefault = "allow" | "ask" | "block";

const Decision = Schema.Literals(["allow", "block"]);
const PermissionDefault = Schema.Literals(["ask", "block"]).pipe(withDefault("ask"));
const ContentDefault = Schema.Literals(["allow", "block"]).pipe(withDefault("allow"));

/** A site: a host, which covers its subdomains ("example.com" also covers "www.example.com"). */
const SiteKey = Schema.String.check(Schema.isMaxLength(253));

const SiteExceptions = Schema.Struct(
  Object.fromEntries(siteSettingKeys.map((k) => [k, Schema.optionalKey(Decision)])) as {
    [K in SiteSettingKey]: Schema.optionalKey<typeof Decision>;
  },
);
export type SiteExceptions = typeof SiteExceptions.Type;

const Zoom = Schema.Number.check(Schema.isBetween({ minimum: 0.25, maximum: 5 }));
const FontSize = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const FontName = Schema.String.check(Schema.isMaxLength(200)).pipe(withDefault(""));
const Language = Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/));
const Url = Schema.String.check(Schema.isMaxLength(2000));
/** A web page: http(s) only (startup pages open as tabs). */
const PageUrl = Url.check(Schema.isPattern(/^https?:\/\//i, { message: "must be an http(s) address" }));

export const BrowserSettings = Schema.Struct({
  search: Schema.Struct({
    engine: Schema.Literals([...(Object.keys(searchEngines) as SearchEngineId[]), "custom"]).pipe(
      withDefault("duckduckgo"),
    ),
    /** The custom engine (engine: "custom"). */
    name: Schema.String.check(Schema.isMaxLength(100)).pipe(withDefault("")),
    url: Url.pipe(withDefault("")),
  }).pipe(withDefault({})),
  startup: Schema.Struct({
    /** continue: the tabs you had; newTab: a new tab on top of them; pages: these pages. */
    mode: Schema.Literals(["continue", "newTab", "pages"]).pipe(withDefault("continue")),
    pages: Schema.Array(PageUrl).check(Schema.isMaxLength(20)).pipe(withDefault([])),
  }).pipe(withDefault({})),
  privacy: Schema.Struct({
    thirdPartyCookies: Schema.Literals(["allow", "block"]).pipe(withDefault("allow")),
    doNotTrack: Schema.Boolean.pipe(withDefault(false)),
  }).pipe(withDefault({})),
  /** Every site's default for each setting. */
  defaults: Schema.Struct({
    location: PermissionDefault,
    camera: PermissionDefault,
    microphone: PermissionDefault,
    notifications: PermissionDefault,
    midi: PermissionDefault,
    clipboard: PermissionDefault,
    screen: PermissionDefault,
    idle: PermissionDefault,
    windows: PermissionDefault,
    fonts: PermissionDefault,
    files: PermissionDefault,
    storage: PermissionDefault,
    localNetwork: PermissionDefault,
    javascript: ContentDefault,
    images: ContentDefault,
    sound: ContentDefault,
  }).pipe(withDefault({})),
  /** Sites' own settings, by site. */
  sites: Schema.Record(SiteKey, SiteExceptions).pipe(withDefault({})),
  zoom: Schema.Struct({
    default: Zoom.pipe(withDefault(1)),
    /** Sites zoomed to something else, by host. */
    sites: Schema.Record(SiteKey, Zoom).pipe(withDefault({})),
  }).pipe(withDefault({})),
  fonts: Schema.Struct({
    /** Pixels, like Chrome's (16 is Medium). */
    size: FontSize(6, 72).pipe(withDefault(16)),
    fixedSize: FontSize(6, 72).pipe(withDefault(13)),
    /** 0: none. */
    minimumSize: FontSize(0, 24).pipe(withDefault(0)),
    /** Font families; "" is the system's. */
    standard: FontName,
    serif: FontName,
    sansSerif: FontName,
    fixed: FontName,
  }).pipe(withDefault({})),
  languages: Schema.Struct({
    /** Preferred languages for websites, in order; empty: the system's. */
    preferred: Schema.Array(Language).check(Schema.isMaxLength(30)).pipe(withDefault([])),
    spellcheck: Schema.Boolean.pipe(withDefault(true)),
    /** Languages spell check uses; empty: the preferred ones it has dictionaries for. */
    spellcheckLanguages: Schema.Array(Language).check(Schema.isMaxLength(30)).pipe(withDefault([])),
  }).pipe(withDefault({})),
  downloads: Schema.Struct({
    /** "" is the system's Downloads folder. */
    folder: Schema.String.check(Schema.isMaxLength(4000)).pipe(withDefault("")),
    ask: Schema.Boolean.pipe(withDefault(false)),
  }).pipe(withDefault({})),
});
export type BrowserSettings = typeof BrowserSettings.Type;

export const defaultBrowserSettings = (): BrowserSettings => Schema.decodeUnknownSync(BrowserSettings)({});

/** The search engine in use: its name and URL (%s for the words). Without a usable custom URL, DuckDuckGo. */
export function searchEngineOf(browser: Pick<BrowserSettings, "search">): { label: string; url: string } {
  const { engine, name, url } = browser.search;
  if (engine !== "custom") return searchEngines[engine];
  return isSearchUrl(url) ? { label: name.trim() || hostLabel(url), url: url.trim() } : searchEngines.duckduckgo;
}

const hostLabel = (url: string) => {
  try {
    return new URL(url.replace("%s", "")).hostname.replace(/^www\./, "");
  } catch {
    return "Custom";
  }
};

/** The site a host belongs to for its settings: without "www.". */
export const siteOf = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

/** Whether a site key covers a host (the host itself or a subdomain). */
export const coversHost = (site: string, host: string) => host === site || host.endsWith(`.${site}`);

/** The site key whose settings apply to a host: the most specific one that covers it. */
export function siteKeyFor(sites: Record<string, unknown>, host: string) {
  const h = host.toLowerCase();
  let best: string | undefined;
  for (const key of Object.keys(sites)) if (coversHost(key, h) && (!best || key.length > best.length)) best = key;
  return best;
}

/** What applies to a host for a setting: the site's own decision, or the default. */
export function siteSetting(browser: Pick<BrowserSettings, "sites" | "defaults">, host: string, key: SiteSettingKey) {
  const own = siteOwnSetting(browser, host, key);
  return own ?? browser.defaults[key];
}

/** The site's own decision for a setting (from the most specific site that has one), if any. */
export function siteOwnSetting(
  browser: Pick<BrowserSettings, "sites">,
  host: string,
  key: SiteSettingKey,
): SiteDecision | undefined {
  const h = host.toLowerCase();
  let best: { key: string; value: SiteDecision } | undefined;
  for (const [site, exceptions] of Object.entries(browser.sites)) {
    const value = exceptions[key];
    if (value && coversHost(site, h) && (!best || site.length > best.key.length)) best = { key: site, value };
  }
  return best?.value;
}

/**
 * What a site gets for a setting without its own decision, in words: the
 * default ("Default (Ask)"), or a broader site's decision ("Allow, from example.com").
 */
export function inheritedLabel(
  browser: Pick<BrowserSettings, "sites" | "defaults">,
  site: string,
  key: SiteSettingKey,
) {
  const word = (v: SiteDefault) => (v === "ask" ? "Ask" : v === "allow" ? "Allow" : "Block");
  let best: { site: string; value: SiteDecision } | undefined;
  for (const [other, exceptions] of Object.entries(browser.sites)) {
    const value = exceptions[key];
    if (value && other !== site && coversHost(other, site) && (!best || other.length > best.site.length))
      best = { site: other, value };
  }
  return best ? `${word(best.value)}, from ${best.site}` : `Default (${word(browser.defaults[key])})`;
}

/** Sets (or clears, with undefined) a site's decision; a site with nothing left goes. */
export function withSiteSetting(
  browser: BrowserSettings,
  site: string,
  key: SiteSettingKey,
  value: SiteDecision | undefined,
): BrowserSettings {
  const current = { ...browser.sites[site] };
  if (value) current[key] = value;
  else delete current[key];
  const sites = { ...browser.sites };
  if (Object.keys(current).length) sites[site] = current;
  else delete sites[site];
  return { ...browser, sites };
}

/** The zoom for a host: the site's own, or the default. */
export function zoomFor(browser: Pick<BrowserSettings, "zoom">, host: string) {
  const key = siteKeyFor(browser.zoom.sites, siteOf(host));
  return key ? browser.zoom.sites[key]! : browser.zoom.default;
}

/** Remembers a site's zoom; the default zoom isn't remembered as the site's own. */
export function withSiteZoom(browser: BrowserSettings, host: string, factor: number): BrowserSettings {
  const site = siteOf(host);
  const sites = { ...browser.zoom.sites };
  delete sites[site];
  // What it gets without a zoom of its own: a broader site's, or the default.
  const inherited = zoomFor({ zoom: { ...browser.zoom, sites } }, site);
  if (Math.abs(factor - inherited) >= 0.001) sites[site] = Math.round(factor * 100) / 100;
  return { ...browser, zoom: { ...browser.zoom, sites } };
}

/** Chromium's permission names (Electron's) that are site settings. */
const permissionKeys: Record<string, SiteSettingKey> = {
  geolocation: "location",
  "geolocation-approximate": "location",
  notifications: "notifications",
  midi: "midi",
  midiSysex: "midi",
  "clipboard-read": "clipboard",
  "deprecated-sync-clipboard-read": "clipboard",
  "display-capture": "screen",
  "idle-detection": "idle",
  "window-management": "windows",
  "local-fonts": "fonts",
  fileSystem: "files",
  "storage-access": "storage",
  "local-network-access": "localNetwork",
  "local-network": "localNetwork",
  "loopback-network": "localNetwork",
  // Choosing the speakers comes with the microphone, as in Chromium.
  "speaker-selection": "microphone",
};

/** Chromium's permission names (Electron's) as site settings; media asks for the camera and microphone. */
export function permissionSettings(permission: string, mediaTypes: readonly string[] = []): SiteSettingKey[] | null {
  if (permission === "media") {
    const keys: SiteSettingKey[] = [];
    if (mediaTypes.includes("video")) keys.push("camera");
    if (mediaTypes.includes("audio")) keys.push("microphone");
    return keys.length ? keys : ["camera", "microphone"];
  }
  const key = permissionKeys[permission];
  return key ? [key] : null;
}

/**
 * What Chromium allows without a setting (true): full screen, pointer and keyboard lock, writing to the
 * clipboard, keeping the screen on, and motion sensors, protected content, background sync and payment
 * handlers (allowed by default there). Anything else without a setting isn't supported (false): device
 * pickers (USB, HID, serial, Bluetooth, NFC, smart cards), VR and AR, installing web apps, and opening
 * other apps (links to them are navigations).
 */
const fixedPermissions = new Set([
  "fullscreen",
  "pointerLock",
  "keyboardLock",
  "clipboard-sanitized-write",
  "screen-wake-lock",
  "persistent-storage",
  "sensors",
  "mediaKeySystem",
  "background-sync",
  "background-fetch",
  "periodic-background-sync",
  "payment-handler",
]);

/** The answer for a permission that isn't a site setting. */
export const fixedPermissionAllowed = (permission: string) => fixedPermissions.has(permission);

/**
 * What a site gets for a permission: allowed, asked (the tab prompts), or
 * blocked. Screen sharing can't be allowed for good (it always asks, with the
 * picker). Null: not a site setting.
 */
export function permissionDecision(
  browser: Pick<BrowserSettings, "sites" | "defaults">,
  host: string,
  permission: string,
  mediaTypes?: readonly string[],
): SiteDefault | null {
  const keys = permissionSettings(permission, mediaTypes);
  if (!keys) return null;
  if (!host) return "block";
  const each = keys.map((k) => {
    const value = siteSetting(browser, host, k);
    return k === "screen" && value === "allow" ? "ask" : value;
  });
  return each.includes("block") ? "block" : each.includes("ask") ? "ask" : "allow";
}

// --- Privacy and content as declarativeNetRequest rules ----------------------------------------

const SUBRESOURCES = [
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
];
const ALL = ["main_frame", ...SUBRESOURCES];

/**
 * Where a setting is blocked, as DNR domain lists (which cover subdomains):
 * one entry per blocked site (null: every site, a default of block), with the
 * more specific allowed sites under it left out. Blocked sites under an
 * allowed one get their own entry, so the most specific site wins, like
 * `siteSetting`. A blocked site under a blocked one adds nothing.
 */
export function blockedDomains(browser: Pick<BrowserSettings, "sites" | "defaults">, key: SiteSettingKey) {
  const decided = Object.entries(browser.sites)
    .filter(([, exceptions]) => exceptions[key])
    .map(([site, exceptions]) => ({ site, value: exceptions[key]! }));
  /** The decision a site inherits: from the most specific site above it, or the default. */
  const inherited = (site: string) => {
    let best: { site: string; value: SiteDecision } | undefined;
    for (const d of decided)
      if (d.site !== site && coversHost(d.site, site) && (!best || d.site.length > best.site.length)) best = d;
    return best?.value ?? (browser.defaults[key] === "block" ? "block" : "allow");
  };
  const allowedUnder = (site: string | null) =>
    decided.filter((d) => d.value === "allow" && (site === null || (d.site !== site && coversHost(site, d.site))));
  const out: { domain: string | null; except: string[] }[] = [];
  if (browser.defaults[key] === "block") out.push({ domain: null, except: allowedUnder(null).map((d) => d.site) });
  for (const d of decided)
    if (d.value === "block" && inherited(d.site) === "allow")
      out.push({ domain: d.site, except: allowedUnder(d.site).map((a) => a.site) });
  return out;
}

/**
 * Rules for what the browser settings change in requests: blocked JavaScript
 * (a Content-Security-Policy that allows no scripts), blocked images, blocked
 * third-party cookies (not sent, not set) and Do Not Track. They're applied
 * by Rune Browser's built-in extension next to the network rules, numbered
 * from `firstId`. Blocks rank with the network rules' blocks; header changes
 * rank below them, so a network rule's header wins.
 */
export function browserRulesToDnr(browser: BrowserSettings, firstId: number): DnrRule[] {
  const out: DnrRule[] = [];
  const add = (rule: Omit<DnrRule, "id">) => out.push({ ...rule, id: firstId + out.length });
  const condition = (extra: Partial<DnrRule["condition"]>, resourceTypes: string[]) => ({
    ...extra,
    resourceTypes,
    isUrlFilterCaseSensitive: false as const,
  });
  const noScripts = {
    type: "modifyHeaders" as const,
    responseHeaders: [{ header: "Content-Security-Policy", operation: "set" as const, value: "script-src 'none'" }],
  };

  for (const { domain, except } of blockedDomains(browser, "javascript")) {
    add({
      priority: 1,
      action: noScripts,
      condition: condition(
        {
          ...(domain ? { requestDomains: [domain] } : {}),
          ...(except.length ? { excludedRequestDomains: except } : {}),
        },
        ["main_frame", "sub_frame"],
      ),
    });
    // Frames a blocked site embeds directly from elsewhere (ads, widgets) run no scripts either,
    // unless they're from a site where JavaScript is allowed.
    if (domain)
      add({
        priority: 1,
        action: noScripts,
        condition: condition(
          {
            initiatorDomains: [domain],
            ...(except.length ? { excludedInitiatorDomains: except, excludedRequestDomains: except } : {}),
          },
          ["sub_frame"],
        ),
      });
  }

  for (const { domain, except } of blockedDomains(browser, "images")) {
    add({
      priority: 3,
      action: { type: "block" },
      condition: condition(
        {
          ...(domain ? { initiatorDomains: [domain] } : {}),
          ...(except.length ? { excludedInitiatorDomains: except } : {}),
        },
        ["image"],
      ),
    });
  }

  if (browser.privacy.thirdPartyCookies === "block") {
    add({
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Cookie", operation: "remove" }],
        responseHeaders: [{ header: "Set-Cookie", operation: "remove" }],
      },
      condition: condition({ domainType: "thirdParty" }, SUBRESOURCES),
    });
  }

  if (browser.privacy.doNotTrack) {
    add({
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "DNT", operation: "set", value: "1" }] },
      condition: condition({}, ALL),
    });
  }
  return out;
}

// --- Chromium profiles (Import) ----------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What a Chromium profile's settings can bring: only what it has. */
export interface ImportedBrowserSettings {
  search?: BrowserSettings["search"];
  startup?: BrowserSettings["startup"];
  privacy?: Partial<Mutable<BrowserSettings["privacy"]>>;
  defaults?: Partial<Mutable<BrowserSettings["defaults"]>>;
  sites?: Record<string, SiteExceptions>;
  zoom?: Partial<Mutable<BrowserSettings["zoom"]>>;
  fonts?: Partial<Mutable<BrowserSettings["fonts"]>>;
  languages?: Partial<Mutable<BrowserSettings["languages"]>>;
  downloads?: Partial<Mutable<BrowserSettings["downloads"]>>;
}

/** The parts of the settings Import offers, in its order. */
export const importParts = [
  ["search", "Search engine"],
  ["startup", "On startup"],
  ["sites", "Site settings and permissions"],
  ["privacy", "Cookies and Do Not Track"],
  ["zoom", "Page zoom"],
  ["fonts", "Fonts"],
  ["languages", "Languages and spell check"],
  ["downloads", "Downloads"],
] as const;
export type ImportPart = (typeof importParts)[number][0];

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as any)[k] : undefined), o);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Chromium's content setting types, as site settings. */
const contentTypes: Record<string, SiteSettingKey> = {
  geolocation: "location",
  media_stream_camera: "camera",
  media_stream_mic: "microphone",
  notifications: "notifications",
  midi_sysex: "midi",
  clipboard: "clipboard",
  idle_detection: "idle",
  window_placement: "windows",
  local_fonts: "fonts",
  file_system_write_guard: "files",
  storage_access: "storage",
  javascript: "javascript",
  images: "images",
  sound: "sound",
};

/** A content settings pattern's site: "https://www.example.com:443" → "example.com", "[*.]example.com" → "example.com". */
export function patternSite(pattern: string): string | null {
  const primary = pattern.split(",")[0]!.trim();
  if (!primary || primary === "*") return null;
  const host = primary
    .replace(/^[a-z*-]+:\/\//i, "")
    .replace(/^\[\*\.\]/, "")
    .replace(/[:/].*$/, "")
    .toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".") || host.length > 253) return null;
  return siteOf(host);
}

/** A Chromium search URL ({searchTerms} and its own placeholders) as one with %s. */
function searchUrlFrom(url: string) {
  const out = url
    .replace(/\{google:baseURL\}/g, "https://www.google.com/")
    .replace(/\{searchTerms\}/g, "%s")
    .replace(/\{[^}]*\}/g, "");
  return isSearchUrl(out) ? out : null;
}

/** A Chromium zoom level as a factor (each level is 20% more). */
export const zoomFactorOf = (level: number) => Math.round(Math.pow(1.2, level) * 100) / 100;

const clampZoom = (f: number) => Math.min(5, Math.max(0.25, f));

/** Reads what a Chromium profile's Preferences hold of the browser settings. */
export function browserSettingsFromChrome(prefs: unknown): ImportedBrowserSettings {
  const out: ImportedBrowserSettings = {};

  const searchData = get(prefs, "default_search_provider_data.template_url_data");
  const searchUrl = str(get(searchData, "url"));
  const search = searchUrl ? searchUrlFrom(searchUrl) : null;
  if (search) {
    const host = hostLabel(search);
    const known = (Object.keys(searchEngines) as SearchEngineId[]).find(
      (id) => hostLabel(searchEngines[id].url) === host,
    );
    out.search = known
      ? { engine: known, name: "", url: "" }
      : { engine: "custom", name: str(get(searchData, "short_name"))?.slice(0, 100) ?? "", url: search };
  }

  const restore = num(get(prefs, "session.restore_on_startup"));
  const urls = get(prefs, "session.startup_urls");
  const pages = Array.isArray(urls)
    ? urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u) && u.length <= 2000).slice(0, 20)
    : [];
  if (restore === 1) out.startup = { mode: "continue", pages };
  else if (restore === 4) out.startup = { mode: pages.length ? "pages" : "continue", pages };
  else if (restore === 5) out.startup = { mode: "newTab", pages };

  const privacy: NonNullable<ImportedBrowserSettings["privacy"]> = {};
  const cookieMode = num(get(prefs, "profile.cookie_controls_mode"));
  if (cookieMode !== undefined) privacy.thirdPartyCookies = cookieMode === 2 ? "block" : "allow";
  if (get(prefs, "profile.block_third_party_cookies") === true) privacy.thirdPartyCookies = "block";
  const dnt = get(prefs, "enable_do_not_track");
  if (typeof dnt === "boolean") privacy.doNotTrack = dnt;
  if (Object.keys(privacy).length) out.privacy = privacy;

  const defaults: Record<string, SiteDefault> = {};
  const defaultValues = get(prefs, "profile.default_content_setting_values");
  for (const [type, key] of Object.entries(contentTypes)) {
    const v = num(get(defaultValues, type));
    if (v === 1) defaults[key] = siteSettings[key].kind === "permission" ? "ask" : "allow";
    else if (v === 2) defaults[key] = "block";
    else if (v === 3 && siteSettings[key].kind === "permission") defaults[key] = "ask";
  }
  if (Object.keys(defaults).length) out.defaults = defaults as ImportedBrowserSettings["defaults"];

  const sites: Record<string, SiteExceptions> = {};
  const exceptions = get(prefs, "profile.content_settings.exceptions");
  for (const [type, key] of Object.entries(contentTypes)) {
    const list = get(exceptions, type);
    if (!list || typeof list !== "object") continue;
    for (const [pattern, entry] of Object.entries(list as Record<string, unknown>)) {
      const site = patternSite(pattern);
      const setting = num(get(entry, "setting"));
      if (!site || (setting !== 1 && setting !== 2)) continue;
      sites[site] = { ...sites[site], [key]: setting === 1 ? "allow" : "block" };
    }
  }
  if (Object.keys(sites).length) out.sites = sites;

  const zoom: NonNullable<ImportedBrowserSettings["zoom"]> = {};
  // Per partition: { "<partition>": level } (or a plain level in older profiles).
  const defaultZoom = get(prefs, "partition.default_zoom_level");
  const level =
    num(defaultZoom) ??
    Object.values(defaultZoom ?? {})
      .map(num)
      .find((v) => v !== undefined);
  if (level !== undefined) zoom.default = clampZoom(zoomFactorOf(level));
  const hostZooms: Record<string, number> = {};
  const perHost = get(prefs, "partition.per_host_zoom_levels");
  const collect = (map: unknown) => {
    if (!map || typeof map !== "object") return;
    for (const [host, value] of Object.entries(map as Record<string, unknown>)) {
      const l = num(value) ?? num(get(value, "zoom_level"));
      if (l === undefined) {
        // A partition's map.
        if (value && typeof value === "object" && !("zoom_level" in value)) collect(value);
        continue;
      }
      if (/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host) && host.length <= 253)
        hostZooms[siteOf(host)] = clampZoom(zoomFactorOf(l));
    }
  };
  collect(perHost);
  if (Object.keys(hostZooms).length) zoom.sites = hostZooms;
  if (Object.keys(zoom).length) out.zoom = zoom;

  const fonts: NonNullable<ImportedBrowserSettings["fonts"]> = {};
  const webprefs = get(prefs, "webkit.webprefs");
  const size = (v: unknown, min: number, max: number) => {
    const n = num(v);
    return n !== undefined && n >= min && n <= max ? Math.round(n) : undefined;
  };
  const fontSize = size(get(webprefs, "default_font_size"), 6, 72);
  if (fontSize) fonts.size = fontSize;
  const fixedSize = size(get(webprefs, "default_fixed_font_size"), 6, 72);
  if (fixedSize) fonts.fixedSize = fixedSize;
  const minimum = size(get(webprefs, "minimum_font_size"), 0, 24);
  if (minimum !== undefined) fonts.minimumSize = minimum;
  for (const [from, to] of [
    ["standard", "standard"],
    ["serif", "serif"],
    ["sansserif", "sansSerif"],
    ["fixed", "fixed"],
  ] as const) {
    const family = str(get(webprefs, `fonts.${from}.Zyyy`));
    if (family && family.length <= 200) fonts[to] = family;
  }
  if (Object.keys(fonts).length) out.fonts = fonts;

  const languages: NonNullable<ImportedBrowserSettings["languages"]> = {};
  const accept = str(get(prefs, "intl.accept_languages"));
  const langs = (list: unknown[]) =>
    list.filter((l): l is string => typeof l === "string" && Schema.is(Language)(l)).slice(0, 30);
  if (accept) languages.preferred = langs(accept.split(",").map((l) => l.trim()));
  const spellcheck = get(prefs, "browser.enable_spellchecking");
  if (typeof spellcheck === "boolean") languages.spellcheck = spellcheck;
  const dictionaries = get(prefs, "spellcheck.dictionaries");
  if (Array.isArray(dictionaries)) languages.spellcheckLanguages = langs(dictionaries);
  if (Object.keys(languages).length) out.languages = languages;

  const downloads: NonNullable<ImportedBrowserSettings["downloads"]> = {};
  const folder = str(get(prefs, "download.default_directory"));
  if (folder && folder.length <= 4000) downloads.folder = folder;
  const ask = get(prefs, "download.prompt_for_download");
  if (typeof ask === "boolean") downloads.ask = ask;
  if (Object.keys(downloads).length) out.downloads = downloads;

  return out;
}

/** What an import found, in a few words per part ("Google", "12 sites"). */
export function describeImport(found: ImportedBrowserSettings): Partial<Record<ImportPart, string>> {
  const out: Partial<Record<ImportPart, string>> = {};
  if (found.search) out.search = searchEngineOf({ search: found.search }).label;
  if (found.startup) {
    out.startup =
      found.startup.mode === "pages"
        ? `${found.startup.pages.length} page${found.startup.pages.length === 1 ? "" : "s"}`
        : found.startup.mode === "newTab"
          ? "New tab"
          : "Continue where you left off";
  }
  const siteCount = Object.keys(found.sites ?? {}).length;
  if (siteCount || found.defaults)
    out.sites = siteCount ? `${siteCount} site${siteCount === 1 ? "" : "s"}` : "Defaults";
  if (found.privacy) {
    out.privacy = [
      found.privacy.thirdPartyCookies === "block" ? "Third-party cookies blocked" : null,
      found.privacy.doNotTrack ? "Do Not Track" : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (!out.privacy) out.privacy = "Defaults";
  }
  if (found.zoom) {
    const n = Object.keys(found.zoom.sites ?? {}).length;
    out.zoom = [
      found.zoom.default !== undefined ? `${Math.round(found.zoom.default * 100)}%` : null,
      n ? `${n} site${n === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (found.fonts) out.fonts = found.fonts.size ? `${found.fonts.size} px` : "Font families";
  if (found.languages)
    out.languages =
      (found.languages.preferred ?? found.languages.spellcheckLanguages ?? []).join(", ") || "Spell check";
  if (found.downloads)
    out.downloads = found.downloads.ask ? "Ask where to save" : (found.downloads.folder ?? "Downloads");
  return out;
}

/** The settings with the chosen parts of an import put in (site settings and zooms are merged, the imported ones win). */
export function applyImport(
  browser: BrowserSettings,
  found: ImportedBrowserSettings,
  parts: readonly ImportPart[],
): BrowserSettings {
  const next = structuredClone(browser) as { -readonly [K in keyof BrowserSettings]: any };
  const has = (p: ImportPart) => parts.includes(p);
  if (has("search") && found.search) next.search = found.search;
  if (has("startup") && found.startup) next.startup = found.startup;
  if (has("privacy") && found.privacy) next.privacy = { ...next.privacy, ...found.privacy };
  if (has("sites")) {
    if (found.defaults) next.defaults = { ...next.defaults, ...found.defaults };
    for (const [site, exceptions] of Object.entries(found.sites ?? {}))
      next.sites[site] = { ...next.sites[site], ...exceptions };
  }
  if (has("zoom") && found.zoom) {
    if (found.zoom.default !== undefined) next.zoom.default = found.zoom.default;
    next.zoom.sites = { ...next.zoom.sites, ...found.zoom.sites };
  }
  if (has("fonts") && found.fonts) next.fonts = { ...next.fonts, ...found.fonts };
  if (has("languages") && found.languages) next.languages = { ...next.languages, ...found.languages };
  if (has("downloads") && found.downloads) next.downloads = { ...next.downloads, ...found.downloads };
  return Schema.decodeUnknownSync(BrowserSettings)(next);
}
