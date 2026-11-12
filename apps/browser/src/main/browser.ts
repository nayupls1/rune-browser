// The browser settings (Settings' Browser group) put into effect in web tabs:
// sound, fonts, languages and spell check, downloads, and the rules for
// JavaScript, images, third-party cookies and Do Not Track (applied
// by the built-in extension, see extensions/builtin.ts). Also clearing
// browsing data, sites' cookies, and reading other browsers' settings for
// Import. The renderer sends the settings whenever they change.
import { app, ipcMain, webContents, type Session, type WebContents } from "electron";
import { mkdirSync } from "node:fs";
import { Schema } from "effect";
import {
  BrowserSettings,
  browserRulesToDnr,
  browserSettingsFromChrome,
  coversHost,
  defaultBrowserSettings,
  siteOf,
  siteSetting,
  type ImportedBrowserSettings,
} from "../shared/browser";
import { DEFAULT_WORKSPACE } from "../shared/api";
import { hostOf } from "../shared/web";
import * as cdp from "./cdp";
import { browserProfiles } from "./extensions/browsers";
import type { AppWindows } from "./windows";

const decode = Schema.decodeUnknownSync(BrowserSettings);

/** What "cookies and other site data" clears, besides cookies. */
const SITE_DATA = ["localStorage", "indexedDB", "serviceWorkers", "fileSystems", "webSQL", "backgroundFetch"] as const;

export interface BrowserOptions {
  windows: AppWindows;
  /** The session of a workspace's web tabs (set up on first use). */
  webSession: (workspaceId: string) => Session;
  /** Whether a session is a workspace's web tab session. */
  isWebSession: (session: Session) => boolean;
  /** The rules (browserRules) changed. */
  rulesChanged: () => void;
  /** Sites' settings or the defaults changed (site permissions, main/sitePermissions.ts). */
  sitesChanged: () => void;
  /** The settings arrived or changed (push, main/push.ts). */
  settingsChanged?: () => void;
  /** Sites' data (`sites`, with their subdomains; null: every site's) was cleared in these workspaces. */
  siteDataCleared?: (workspaceIds: string[], sites: string[] | null) => void;
}

export interface BrowserProfileSettings {
  key: string;
  browser: string;
  profile: string;
  found: ImportedBrowserSettings;
}

export function setupBrowser(options: BrowserOptions) {
  let browser = defaultBrowserSettings();
  /** The renderer sent the settings (until then, they're the defaults). */
  let received = false;
  const sessions = new Set<Session>();
  const fromWindow = (sender: WebContents) => options.windows.isUi(sender);
  const validWorkspace = (id: unknown): id is string => typeof id === "string" && /^[\w-]+$/.test(id);
  const guests = () =>
    webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.getType() === "webview" && options.isWebSession(c.session));

  // --- Languages and spell check ------------------------------------------------------------------

  const preferredLanguages = () =>
    browser.languages.preferred.length ? [...browser.languages.preferred] : app.getPreferredSystemLanguages();

  /** The dictionaries spell check uses: the chosen languages (or the preferred ones) it has one for. */
  function spellcheckLanguages(s: Session) {
    const available = s.availableSpellCheckerLanguages;
    const wanted = browser.languages.spellcheckLanguages.length
      ? browser.languages.spellcheckLanguages
      : preferredLanguages();
    const out: string[] = [];
    for (const lang of wanted) {
      const lower = lang.toLowerCase();
      const match =
        available.find((a) => a.toLowerCase() === lower) ??
        available.find((a) => a.toLowerCase().split("-")[0] === lower.split("-")[0]);
      if (match && !out.includes(match)) out.push(match);
    }
    return out.slice(0, 5);
  }

  function applyLanguages(s: Session) {
    s.setUserAgent(s.getUserAgent(), preferredLanguages().join(","));
    s.setSpellCheckerEnabled(browser.languages.spellcheck);
    // macOS uses its own spell checker, with the system's languages.
    if (process.platform === "darwin" || !browser.languages.spellcheck) return;
    const languages = spellcheckLanguages(s);
    if (languages.length) {
      try {
        s.setSpellCheckerLanguages(languages);
      } catch (err) {
        console.warn("Setting the spell check languages failed:", err);
      }
    }
  }

  // --- Downloads ----------------------------------------------------------------------------------

  const downloadsFolder = () => {
    const folder = browser.downloads.folder;
    if (folder) {
      try {
        mkdirSync(folder, { recursive: true });
        return folder;
      } catch {
        // gone or not ours: the system's folder
      }
    }
    return app.getPath("downloads");
  };

  // --- Sessions and pages -------------------------------------------------------------------------

  /** A workspace's web tab session: the languages and spell check (downloads are main/downloads.ts's). */
  function setupSession(s: Session) {
    if (sessions.has(s)) return;
    sessions.add(s);
    applyLanguages(s);
  }

  /** The fonts of a web tab's page, set when its webview is attached. */
  function webPreferences(prefs: Electron.WebPreferences) {
    const f = browser.fonts;
    prefs.defaultFontSize = f.size;
    prefs.defaultMonospaceFontSize = f.fixedSize;
    prefs.minimumFontSize = f.minimumSize;
    const families: Electron.DefaultFontFamily = {};
    if (f.standard) families.standard = f.standard;
    if (f.serif) families.serif = f.serif;
    if (f.sansSerif) families.sansSerif = f.sansSerif;
    if (f.fixed) families.monospace = f.fixed;
    if (Object.keys(families).length) prefs.defaultFontFamily = families;
  }

  /**
   * Open pages get a changed font size too (the webview's preferences only
   * apply to new ones). Chromium lets a page's font families be set only once
   * this way, so changed families apply to pages opened from then on.
   */
  async function applyFontSizes(contents: WebContents) {
    if (!cdp.acquire(contents, "fonts")) return;
    const f = browser.fonts;
    try {
      await cdp.send(contents, "Page.setFontSizes", { fontSizes: { standard: f.size, fixed: f.fixedSize } });
    } catch (err) {
      console.warn("Changing an open page's font size failed:", err);
    } finally {
      cdp.release(contents, "fonts");
    }
  }

  /** Pages muted for their site's sound setting (others, muted by an extension, are left alone). */
  const mutedBySite = new WeakSet<WebContents>();
  /** A site whose sound is off stays muted; leaving it unmutes only what it muted. */
  const applySound = (contents: WebContents) => {
    const host = siteOf(hostOf(contents.getURL()));
    const off = !!host && siteSetting(browser, host, "sound") === "block";
    if (off && !contents.isAudioMuted()) {
      contents.setAudioMuted(true);
      mutedBySite.add(contents);
    } else if (!off && mutedBySite.has(contents)) {
      contents.setAudioMuted(false);
      mutedBySite.delete(contents);
    }
  };

  function trackGuest(contents: WebContents) {
    contents.on("did-navigate", () => applySound(contents));
  }

  // --- Settings from the renderer -----------------------------------------------------------------

  function update(next: BrowserSettings) {
    const before = browser;
    browser = next;
    received = true;
    const changed = (pick: (b: BrowserSettings) => unknown) =>
      JSON.stringify(pick(before)) !== JSON.stringify(pick(next));
    if (changed((b) => b.languages)) for (const s of sessions) applyLanguages(s);
    if (changed((b) => [b.defaults.sound, b.sites])) for (const c of guests()) applySound(c);
    if (changed((b) => [b.defaults, b.sites])) options.sitesChanged();
    if (changed((b) => [b.fonts.size, b.fonts.fixedSize])) for (const c of guests()) void applyFontSizes(c);
    if (changed((b) => browserRulesToDnr(b, 1))) options.rulesChanged();
    options.settingsChanged?.();
  }

  ipcMain.on("rune:browser-settings", (event, value: unknown) => {
    if (!fromWindow(event.sender)) return;
    try {
      update(decode(value));
    } catch (err) {
      console.warn("Ignoring invalid browser settings:", err);
    }
  });

  // --- Clearing browsing data ---------------------------------------------------------------------

  /** Extensions keep their data: it's theirs, not a site's (like in Chrome). */
  const extensionOrigins = (s: Session) => s.extensions.getAllExtensions().map((e) => `chrome-extension://${e.id}`);

  /**
   * Clears sites' data (their subdomains' too) in a session: cookies and other site data, the cache, or
   * both. `visited`: the origins of pages visited, cleared too, with the cookies of the parent domains
   * those pages got (mail.example.com gets example.com's).
   */
  async function clearSites(
    s: Session,
    sites: ReadonlySet<string>,
    what: { cookies: boolean; cache: boolean },
    visited: readonly string[] = [],
  ) {
    const keys = [...sites].filter((key) => /^[a-z0-9.-]+$/.test(key));
    if (!keys.length || (!what.cookies && !what.cache)) return;
    const all = new Set(visited);
    const parents = visited.length > 0;
    for (const key of keys) for (const host of [key, `www.${key}`]) all.add(`https://${host}`).add(`http://${host}`);
    for (const c of await s.cookies.get({})) {
      const domain = (c.domain ?? "").replace(/^\./, "");
      if (!keys.some((key) => coversHost(key, domain) || (parents && coversHost(domain, key)))) continue;
      all.add(`https://${domain}`).add(`http://${domain}`);
      if (!what.cookies) continue;
      const url = `${c.secure ? "https" : "http"}://${domain}${c.path ?? "/"}`;
      await s.cookies.remove(url, c.name).catch(() => {});
    }
    const dataTypes: NonNullable<Electron.ClearDataOptions["dataTypes"]> = [
      ...(what.cookies ? SITE_DATA : []),
      ...(what.cache ? (["cache"] as const) : []),
    ];
    await s.clearData({ dataTypes, origins: [...all] });
  }

  /** Web origins (scheme, host and port), checked: what the renderer says was visited. */
  const webOrigins = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .slice(0, 10_000)
      .filter((o): o is string => typeof o === "string" && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o))
      .map((o) => o.toLowerCase());

  /**
   * Clears cookies and other site data, the cache, or both. With `origins` (a time range: Electron can't clear
   * by time), only the sites of those origins (the ones visited in that time); otherwise everything.
   */
  ipcMain.handle("rune:browser-clear-data", async (event, workspaceIds: unknown, what: unknown) => {
    if (!fromWindow(event.sender) || !Array.isArray(workspaceIds)) return;
    const w = (what ?? {}) as { cookies?: unknown; cache?: unknown; origins?: unknown };
    const parts = { cookies: w.cookies === true, cache: w.cache === true };
    if (!parts.cookies && !parts.cache) return;
    const ranged = Array.isArray(w.origins);
    const origins = webOrigins(w.origins);
    const sites = new Set(origins.map((o) => siteOf(hostOf(o))).filter(Boolean));
    // Site data includes service workers, and with them their push subscriptions.
    if (parts.cookies) options.siteDataCleared?.(workspaceIds.filter(validWorkspace), ranged ? [...sites] : null);
    for (const id of workspaceIds.filter(validWorkspace)) {
      const s = options.webSession(id);
      if (ranged) {
        await clearSites(s, sites, parts, origins);
        continue;
      }
      const dataTypes: NonNullable<Electron.ClearDataOptions["dataTypes"]> = [];
      if (parts.cookies) dataTypes.push("cookies", ...SITE_DATA);
      if (parts.cache) dataTypes.push("cache");
      const excludeOrigins = extensionOrigins(s);
      await s.clearData({ dataTypes, ...(excludeOrigins.length ? { excludeOrigins } : {}) });
      if (parts.cache) await s.clearCache();
    }
  });

  /** The sites that have cookies in a workspace, with how many. */
  ipcMain.handle("rune:browser-site-data", async (event, workspaceId: unknown) => {
    if (!fromWindow(event.sender) || !validWorkspace(workspaceId)) return [];
    const cookies = await options.webSession(workspaceId).cookies.get({});
    const counts = new Map<string, number>();
    for (const c of cookies) {
      const site = siteOf((c.domain ?? "").replace(/^\./, ""));
      if (site) counts.set(site, (counts.get(site) ?? 0) + 1);
    }
    return [...counts].map(([site, count]) => ({ site, cookies: count })).sort((a, b) => a.site.localeCompare(b.site));
  });

  /** Clears a site's cookies and other data (its subdomains' too) in the given workspaces. */
  ipcMain.handle("rune:browser-clear-site", async (event, workspaceIds: unknown, site: unknown) => {
    if (!fromWindow(event.sender) || !Array.isArray(workspaceIds) || typeof site !== "string") return;
    options.siteDataCleared?.(workspaceIds.filter(validWorkspace), [siteOf(site)]);
    for (const id of workspaceIds.filter(validWorkspace))
      await clearSites(options.webSession(id), new Set([siteOf(site)]), { cookies: true, cache: true });
  });

  // --- Import -------------------------------------------------------------------------------------

  ipcMain.handle("rune:browser-import-detect", (event): BrowserProfileSettings[] => {
    if (!fromWindow(event.sender)) return [];
    return browserProfiles()
      .map((p) => ({ key: p.key, browser: p.browser, profile: p.name, found: browserSettingsFromChrome(p.prefs) }))
      .filter((p) => Object.keys(p.found).length > 0);
  });

  /** What the settings page shows as defaults: the system's languages, the dictionaries, the Downloads folder. */
  ipcMain.handle("rune:browser-info", (event) => {
    if (!fromWindow(event.sender)) return null;
    const s = options.webSession(DEFAULT_WORKSPACE);
    return {
      systemLanguages: app.getPreferredSystemLanguages(),
      spellcheckLanguages: process.platform === "darwin" ? [] : s.availableSpellCheckerLanguages,
      downloadsFolder: app.getPath("downloads"),
    };
  });

  return {
    setupSession,
    webPreferences,
    trackGuest,
    /** The settings in effect (site permissions read their sites' settings). */
    settings: () => browser,
    /** Whether the renderer sent the settings yet. */
    settingsReady: () => received,
    /**
     * The settings as saved (the server's), until a window sends them: with no window open (started in the
     * background), push and the rest still go by them.
     */
    seed(value: unknown) {
      if (received) return;
      try {
        update(decode(value ?? {}));
      } catch (err) {
        console.warn("Ignoring invalid saved browser settings:", err);
      }
    },
    /** The rules for the built-in extension, numbered from `firstId`. */
    rules: (firstId: number) => browserRulesToDnr(browser, firstId),
    /** Where downloads go (Settings → General → Downloads), made if it's missing. */
    downloadsFolder,
    /** Whether every download asks where to save. */
    askWhereToSave: () => browser.downloads.ask,
  };
}

export type BrowserControl = ReturnType<typeof setupBrowser>;
