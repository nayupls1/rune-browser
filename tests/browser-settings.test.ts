// Browser settings: site settings and their matching, permissions, zoom, the
// rules they become, the search engine, and importing a Chromium profile's
// Preferences. Also that the server keeps them with the other settings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyImport,
  browserRulesToDnr,
  browserSettingsFromChrome,
  defaultBrowserSettings,
  describeImport,
  patternSite,
  permissionAllowed,
  searchEngineOf,
  siteOf,
  siteSetting,
  withSiteSetting,
  withSiteZoom,
  zoomFactorOf,
  zoomFor,
  type BrowserSettings,
} from "../src/shared/browser";
import { decodeSettings, defaultSettings, type Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

const withSites = (sites: BrowserSettings["sites"], change: Partial<BrowserSettings> = {}): BrowserSettings => ({
  ...defaultBrowserSettings(),
  sites,
  ...change,
});

describe("site settings", () => {
  test("defaults follow Chrome's: permissions ask, content is allowed", () => {
    const b = defaultBrowserSettings();
    expect(b.defaults.camera).toBe("ask");
    expect(b.defaults.notifications).toBe("ask");
    expect(b.defaults.javascript).toBe("allow");
    expect(b.defaults.images).toBe("allow");
    expect(b.search.engine).toBe("duckduckgo");
    expect(b.startup.mode).toBe("continue");
    expect(b.fonts.size).toBe(16);
    expect(b.zoom.default).toBe(1);
  });

  test("a site covers its subdomains; the most specific site wins", () => {
    const b = withSites({ "example.com": { camera: "allow" }, "docs.example.com": { camera: "block" } });
    expect(siteSetting(b, "example.com", "camera")).toBe("allow");
    expect(siteSetting(b, "www.example.com", "camera")).toBe("allow");
    expect(siteSetting(b, "docs.example.com", "camera")).toBe("block");
    expect(siteSetting(b, "a.docs.example.com", "camera")).toBe("block");
    expect(siteSetting(b, "notexample.com", "camera")).toBe("ask");
    // A setting the specific site doesn't have comes from the broader one, then the default.
    expect(
      siteSetting(
        withSites({ "example.com": { sound: "block" }, "docs.example.com": {} }),
        "docs.example.com",
        "sound",
      ),
    ).toBe("block");
  });

  test("sites are hosts without www", () => {
    expect(siteOf("WWW.Example.com.")).toBe("example.com");
    expect(siteOf("docs.example.com")).toBe("docs.example.com");
  });

  test("setting and clearing a site's decision; an empty site goes", () => {
    let b = withSiteSetting(defaultBrowserSettings(), "example.com", "camera", "allow");
    b = withSiteSetting(b, "example.com", "images", "block");
    expect(b.sites["example.com"]).toEqual({ camera: "allow", images: "block" });
    b = withSiteSetting(b, "example.com", "camera", undefined);
    b = withSiteSetting(b, "example.com", "images", undefined);
    expect(b.sites["example.com"]).toBeUndefined();
  });

  test("permissions: only sites you allow get them (there's no prompt yet)", () => {
    const b = withSites({
      "meet.example.com": { camera: "allow", microphone: "allow" },
      "maps.example.com": { location: "allow" },
    });
    expect(permissionAllowed(b, "meet.example.com", "media", ["video", "audio"])).toBe(true);
    expect(permissionAllowed(b, "maps.example.com", "media", ["video"])).toBe(false);
    expect(permissionAllowed(b, "maps.example.com", "geolocation")).toBe(true);
    expect(permissionAllowed(b, "other.com", "notifications")).toBe(false);
    // Camera allowed but not the microphone: asking for both is refused.
    expect(permissionAllowed(withSites({ "a.com": { camera: "allow" } }), "a.com", "media", ["video", "audio"])).toBe(
      false,
    );
    // Not a site setting: the other checks decide.
    expect(permissionAllowed(b, "meet.example.com", "fullscreen")).toBeNull();
    // No page: refused.
    expect(permissionAllowed(b, "", "geolocation")).toBe(false);
  });
});

describe("zoom", () => {
  test("a site keeps its zoom; the default isn't remembered as the site's", () => {
    let b = withSiteZoom(defaultBrowserSettings(), "www.example.com", 1.25);
    expect(b.zoom.sites).toEqual({ "example.com": 1.25 });
    expect(zoomFor(b, "example.com")).toBe(1.25);
    expect(zoomFor(b, "docs.example.com")).toBe(1.25);
    expect(zoomFor(b, "other.com")).toBe(1);
    b = { ...b, zoom: { ...b.zoom, default: 1.1 } };
    expect(zoomFor(b, "other.com")).toBe(1.1);
    b = withSiteZoom(b, "example.com", 1.1);
    expect(b.zoom.sites).toEqual({});
  });

  test("Chromium's zoom levels as factors", () => {
    expect(zoomFactorOf(0)).toBe(1);
    expect(zoomFactorOf(1)).toBe(1.2);
    expect(zoomFactorOf(-1)).toBe(0.83);
  });
});

describe("rules", () => {
  test("nothing changes requests by default", () => {
    expect(browserRulesToDnr(defaultBrowserSettings(), 1)).toEqual([]);
  });

  test("blocked JavaScript, images, third-party cookies and Do Not Track", () => {
    const b = withSites(
      { "js-off.com": { javascript: "block" }, "pics-off.com": { images: "block" } },
      { privacy: { thirdPartyCookies: "block", doNotTrack: true } },
    );
    const rules = browserRulesToDnr(b, 10);
    expect(rules.map((r) => r.id)).toEqual([10, 11, 12, 13]);
    const [js, images, cookies, dnt] = rules;
    expect(js!.condition.requestDomains).toEqual(["js-off.com"]);
    expect(js!.condition.resourceTypes).toEqual(["main_frame", "sub_frame"]);
    expect(js!.action).toEqual({
      type: "modifyHeaders",
      responseHeaders: [{ header: "Content-Security-Policy", operation: "set", value: "script-src 'none'" }],
    });
    expect(images!.action).toEqual({ type: "block" });
    expect(images!.condition.initiatorDomains).toEqual(["pics-off.com"]);
    expect(images!.condition.resourceTypes).toEqual(["image"]);
    expect(cookies!.condition.domainType).toBe("thirdParty");
    expect(cookies!.condition.resourceTypes).not.toContain("main_frame");
    expect(dnt!.action).toEqual({
      type: "modifyHeaders",
      requestHeaders: [{ header: "DNT", operation: "set", value: "1" }],
    });
  });

  test("blocked by default, except the sites you allow", () => {
    const b = withSites(
      { "app.example.com": { javascript: "allow", images: "allow" } },
      { defaults: { ...defaultBrowserSettings().defaults, javascript: "block", images: "block" } },
    );
    const [js, images] = browserRulesToDnr(b, 1);
    expect(js!.condition.excludedRequestDomains).toEqual(["app.example.com"]);
    expect(js!.condition.requestDomains).toBeUndefined();
    expect(images!.condition.excludedInitiatorDomains).toEqual(["app.example.com"]);
  });
});

describe("search engine", () => {
  test("a known engine, a custom one, and DuckDuckGo until the custom URL works", () => {
    const b = defaultBrowserSettings();
    expect(searchEngineOf({ search: { ...b.search, engine: "google" } }).label).toBe("Google");
    expect(
      searchEngineOf({
        search: { engine: "custom", name: "Wiki", url: "https://en.wikipedia.org/w/index.php?search=%s" },
      }),
    ).toEqual({ label: "Wiki", url: "https://en.wikipedia.org/w/index.php?search=%s" });
    expect(
      searchEngineOf({ search: { engine: "custom", name: "", url: "https://search.example.org/?q=%s" } }).label,
    ).toBe("search.example.org");
    expect(searchEngineOf({ search: { engine: "custom", name: "Broken", url: "https://example.org/" } }).label).toBe(
      "DuckDuckGo",
    );
  });
});

describe("import from a Chromium profile", () => {
  const prefs = {
    default_search_provider_data: {
      template_url_data: {
        short_name: "Wikipedia",
        url: "https://en.wikipedia.org/w/index.php?search={searchTerms}&{google:RLZ}",
      },
    },
    session: { restore_on_startup: 4, startup_urls: ["https://news.example.com/", "javascript:alert(1)"] },
    profile: {
      cookie_controls_mode: 2,
      default_content_setting_values: { notifications: 2, javascript: 1, images: 2, geolocation: 3 },
      content_settings: {
        exceptions: {
          media_stream_camera: { "https://meet.example.com:443,*": { setting: 1, last_modified: "1" } },
          notifications: { "[*.]news.example.com,*": { setting: 1 }, "https://spam.example.com:443,*": { setting: 2 } },
          javascript: { "https://www.slow.example.com:443,*": { setting: 2 } },
          sound: { "*,*": { setting: 2 }, "https://loud.example.com:443,*": { setting: 3 } },
        },
      },
    },
    enable_do_not_track: true,
    partition: {
      default_zoom_level: { x: 1 },
      per_host_zoom_levels: { x: { "www.tiny.example.com": { last_modified: "1", zoom_level: 2 } } },
    },
    webkit: {
      webprefs: {
        default_font_size: 20,
        minimum_font_size: 10,
        fonts: { standard: { Zyyy: "Georgia" }, fixed: { Zyyy: "JetBrains Mono" } },
      },
    },
    intl: { accept_languages: "de-DE,de,en-US,not a language" },
    browser: { enable_spellchecking: false },
    spellcheck: { dictionaries: ["de-DE"] },
    download: { default_directory: "/home/me/Downloads/Browser", prompt_for_download: true },
  };

  test("reads the settings Rune Browser has too", () => {
    const found = browserSettingsFromChrome(prefs);
    expect(found.search).toEqual({
      engine: "custom",
      name: "Wikipedia",
      url: "https://en.wikipedia.org/w/index.php?search=%s&",
    });
    expect(found.startup).toEqual({ mode: "pages", pages: ["https://news.example.com/"] });
    expect(found.privacy).toEqual({ thirdPartyCookies: "block", doNotTrack: true });
    expect(found.defaults).toEqual({ notifications: "block", javascript: "allow", images: "block", location: "ask" });
    expect(found.sites).toEqual({
      "meet.example.com": { camera: "allow" },
      "news.example.com": { notifications: "allow" },
      "spam.example.com": { notifications: "block" },
      "slow.example.com": { javascript: "block" },
    });
    expect(found.zoom).toEqual({ default: 1.2, sites: { "tiny.example.com": 1.44 } });
    expect(found.fonts).toEqual({ size: 20, minimumSize: 10, standard: "Georgia", fixed: "JetBrains Mono" });
    expect(found.languages).toEqual({
      preferred: ["de-DE", "de", "en-US"],
      spellcheck: false,
      spellcheckLanguages: ["de-DE"],
    });
    expect(found.downloads).toEqual({ folder: "/home/me/Downloads/Browser", ask: true });
  });

  test("a known search engine is recognized; an empty profile has nothing", () => {
    expect(
      browserSettingsFromChrome({
        default_search_provider_data: { template_url_data: { url: "{google:baseURL}search?q={searchTerms}" } },
      }).search,
    ).toEqual({ engine: "google", name: "", url: "" });
    expect(browserSettingsFromChrome({})).toEqual({});
    expect(browserSettingsFromChrome(null)).toEqual({});
  });

  test("content settings patterns as sites", () => {
    expect(patternSite("https://www.example.com:443,*")).toBe("example.com");
    expect(patternSite("[*.]example.com,*")).toBe("example.com");
    expect(patternSite("http://localhost:8080,*")).toBeNull();
    expect(patternSite("*,*")).toBeNull();
    expect(patternSite("file:///home/x,*")).toBeNull();
  });

  test("the chosen parts go in; site settings and zooms are merged", () => {
    const found = browserSettingsFromChrome(prefs);
    const mine = withSiteZoom(
      withSiteSetting(defaultBrowserSettings(), "meet.example.com", "microphone", "allow"),
      "mine.com",
      1.5,
    );
    const next = applyImport(mine, found, ["sites", "zoom", "fonts"]);
    expect(next.sites["meet.example.com"]).toEqual({ microphone: "allow", camera: "allow" });
    expect(next.zoom.sites).toEqual({ "mine.com": 1.5, "tiny.example.com": 1.44 });
    expect(next.fonts.size).toBe(20);
    // Not chosen: kept.
    expect(next.search.engine).toBe("duckduckgo");
    expect(next.downloads.ask).toBe(false);
    expect(describeImport(found)).toMatchObject({ search: "Wikipedia", startup: "1 page", sites: "4 sites" });
  });
});

describe("settings", () => {
  test("older settings without browser settings get the defaults", () => {
    const s = decodeSettings({ web: { overrides: false } });
    expect(s.browser).toEqual(defaultBrowserSettings());
    expect(s.web.overrides).toBe(false);
  });

  test("invalid values are refused", () => {
    expect(() => decodeSettings({ browser: { zoom: { default: 9 } } })).toThrow();
    expect(() => decodeSettings({ browser: { languages: { preferred: ["not a language"] } } })).toThrow();
    expect(() => decodeSettings({ browser: { sites: { "a.com": { camera: "sometimes" } } } })).toThrow();
  });

  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("the server saves and returns them", async () => {
    const settings = defaultSettings();
    const browser = withSiteSetting(
      { ...settings.browser, search: { engine: "custom", name: "Wiki", url: "https://en.wikipedia.org/?search=%s" } },
      "example.com",
      "camera",
      "allow",
    );
    await server.api("/api/settings", { method: "PUT", json: { ...settings, browser } });
    const saved = await server.api<Settings>("/api/settings");
    expect(saved.browser.search.name).toBe("Wiki");
    expect(saved.browser.sites).toEqual({ "example.com": { camera: "allow" } });
  });
});
