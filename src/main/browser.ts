// The browser settings (Settings → Browser) put into effect in web tabs: site
// permissions, sound, fonts, languages and spell check, downloads, and the
// rules for JavaScript, images, third-party cookies and Do Not Track (applied
// by the built-in extension, see extensions/builtin.ts). Also clearing
// browsing data, sites' cookies, and reading other browsers' settings for
// Import. The renderer sends the settings whenever they change.
import { app, ipcMain, webContents, type BrowserWindow, type Session, type WebContents } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { Schema } from "effect";
import {
  BrowserSettings,
  browserRulesToDnr,
  browserSettingsFromChrome,
  coversHost,
  defaultBrowserSettings,
  permissionAllowed,
  siteOf,
  siteSetting,
  type ImportedBrowserSettings,
} from "../shared/browser";
import { DEFAULT_WORKSPACE } from "../shared/api";
import { hostOf } from "../shared/web";
import * as cdp from "./cdp";
import { browserProfiles } from "./extensions/browsers";

const decode = Schema.decodeUnknownSync(BrowserSettings);

/** What "cookies and other site data" clears, besides cookies. */
const SITE_DATA = ["localStorage", "indexedDB", "serviceWorkers", "fileSystems", "webSQL", "backgroundFetch"] as const;

export interface BrowserOptions {
  getWindow: () => BrowserWindow | undefined;
  /** The session of a workspace's web tabs (set up on first use). */
  webSession: (workspaceId: string) => Session;
  /** Whether a session is a workspace's web tab session. */
  isWebSession: (session: Session) => boolean;
  /** The rules (browserRules) changed. */
  rulesChanged: () => void;
}

export interface BrowserProfileSettings {
  key: string;
  browser: string;
  profile: string;
  found: ImportedBrowserSettings;
}

export function setupBrowser(options: BrowserOptions) {
  let browser = defaultBrowserSettings();
  const sessions = new Set<Session>();
  const fromWindow = (sender: WebContents) => sender === options.getWindow()?.webContents;
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

  /** A free file name in a folder, like Chrome's: "report.pdf", "report (1).pdf"… */
  function freePath(folder: string, name: string) {
    // Windows refuses its device names (CON, NUL…) and names ending in a dot or space.
    let safe =
      name
        .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
        .trim()
        .replace(/[. ]+$/, "") || "download";
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe)) safe = `_${safe}`;
    const ext = extname(safe);
    const base = safe.slice(0, safe.length - ext.length);
    let path = join(folder, safe);
    for (let i = 1; existsSync(path) && i < 1000; i++) path = join(folder, `${base} (${i})${ext}`);
    return path;
  }

  // --- Sessions and pages -------------------------------------------------------------------------

  /** A workspace's web tab session: the languages, spell check and where downloads go. */
  function setupSession(s: Session) {
    if (sessions.has(s)) return;
    sessions.add(s);
    applyLanguages(s);
    s.on("will-download", (_event, item) => {
      const folder = downloadsFolder();
      if (browser.downloads.ask) item.setSaveDialogOptions({ defaultPath: join(folder, item.getFilename()) });
      else item.setSavePath(freePath(folder, item.getFilename()));
    });
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
    const host = hostOf(contents.getURL());
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

  // --- Permissions --------------------------------------------------------------------------------

  /** Whether a site gets a permission (site settings); null: not one of them. */
  const permission = (permission: string, url: string | undefined, mediaTypes?: readonly string[]) =>
    permissionAllowed(browser, hostOf(url), permission, mediaTypes);

  // --- Settings from the renderer -----------------------------------------------------------------

  function update(next: BrowserSettings) {
    const before = browser;
    browser = next;
    const changed = (pick: (b: BrowserSettings) => unknown) =>
      JSON.stringify(pick(before)) !== JSON.stringify(pick(next));
    if (changed((b) => b.languages)) for (const s of sessions) applyLanguages(s);
    if (changed((b) => [b.defaults.sound, b.sites])) for (const c of guests()) applySound(c);
    if (changed((b) => [b.fonts.size, b.fonts.fixedSize])) for (const c of guests()) void applyFontSizes(c);
    if (changed((b) => browserRulesToDnr(b, 1))) options.rulesChanged();
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

  ipcMain.handle("rune:browser-clear-data", async (event, workspaceIds: unknown, what: unknown) => {
    if (!fromWindow(event.sender) || !Array.isArray(workspaceIds)) return;
    const w = (what ?? {}) as { cookies?: unknown; cache?: unknown };
    const dataTypes: NonNullable<Electron.ClearDataOptions["dataTypes"]> = [];
    if (w.cookies === true) dataTypes.push("cookies", ...SITE_DATA);
    if (w.cache === true) dataTypes.push("cache");
    if (!dataTypes.length) return;
    for (const id of workspaceIds.filter(validWorkspace)) {
      const s = options.webSession(id);
      const excludeOrigins = extensionOrigins(s);
      await s.clearData({ dataTypes, ...(excludeOrigins.length ? { excludeOrigins } : {}) });
      if (w.cache === true) await s.clearCache();
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
    const key = siteOf(site);
    if (!/^[a-z0-9.-]+$/.test(key)) return;
    for (const id of workspaceIds.filter(validWorkspace)) {
      const s = options.webSession(id);
      const origins = new Set([`https://${key}`, `http://${key}`, `https://www.${key}`, `http://www.${key}`]);
      for (const c of await s.cookies.get({})) {
        const domain = (c.domain ?? "").replace(/^\./, "");
        if (!coversHost(key, domain)) continue;
        const url = `${c.secure ? "https" : "http"}://${domain}${c.path ?? "/"}`;
        origins.add(`https://${domain}`).add(`http://${domain}`);
        await s.cookies.remove(url, c.name).catch(() => {});
      }
      await s.clearData({ dataTypes: [...SITE_DATA, "cache"], origins: [...origins] });
    }
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
    permission,
    /** The rules for the built-in extension, numbered from `firstId`. */
    rules: (firstId: number) => browserRulesToDnr(browser, firstId),
  };
}

export type BrowserControl = ReturnType<typeof setupBrowser>;
