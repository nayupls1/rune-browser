// The parts of the chrome.* APIs Rune Browser adds that don't need Electron (src/shared/extensionApis.ts):
// proxy settings, declarativeContent's conditions, history and downloads as Chrome's objects, content
// settings' patterns, browsingData's types, user scripts and text-to-speech engines. The APIs themselves run
// in Electron (main/extensions/browserApis.ts).
import { describe, expect, test } from "bun:test";
import type { DownloadInfo } from "../src/shared/downloads";
import {
  browsingDataPlan,
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
  urlFilterMatches,
  userScriptMatches,
  visitItems,
} from "../src/shared/extensionApis";

describe("chrome.proxy", () => {
  test("modes without servers", () => {
    expect(proxyConfigToElectron({ mode: "direct" })).toEqual({ mode: "direct" });
    expect(proxyConfigToElectron({ mode: "system" })).toEqual({ mode: "system" });
    expect(proxyConfigToElectron({ mode: "auto_detect" })).toEqual({ mode: "auto_detect" });
  });

  test("one proxy for everything, with what bypasses it", () => {
    expect(
      proxyConfigToElectron({
        mode: "fixed_servers",
        rules: { singleProxy: { scheme: "socks5", host: "127.0.0.1", port: 1080 }, bypassList: ["<local>", "*.lan"] },
      }),
    ).toEqual({ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:1080", proxyBypassRules: "<local>,*.lan" });
    // The scheme's port when it's left out.
    expect(proxyConfigToElectron({ mode: "fixed_servers", rules: { singleProxy: { host: "proxy" } } }).proxyRules).toBe(
      "http://proxy:80",
    );
  });

  test("a proxy per scheme, and a fallback", () => {
    expect(
      proxyConfigToElectron({
        mode: "fixed_servers",
        rules: {
          proxyForHttp: { host: "a", port: 8080 },
          proxyForHttps: { scheme: "https", host: "b" },
          fallbackProxy: { scheme: "socks4", host: "c" },
        },
      }).proxyRules,
    ).toBe("http=http://a:8080;https=https://b:443;socks=socks4://c:1080");
  });

  test("a PAC script by URL or inline", () => {
    expect(proxyConfigToElectron({ mode: "pac_script", pacScript: { url: "https://x/proxy.pac" } })).toEqual({
      mode: "pac_script",
      pacScript: "https://x/proxy.pac",
    });
    const inline = proxyConfigToElectron({ mode: "pac_script", pacScript: { data: "function FindProxyForURL(){}" } });
    expect(inline.pacScript!.startsWith("data:application/x-ns-proxy-autoconfig;base64,")).toBe(true);
    expect(atob(inline.pacScript!.split(",")[1]!)).toBe("function FindProxyForURL(){}");
  });

  test("invalid settings are refused", () => {
    expect(() => proxyConfigToElectron({ mode: "nope" })).toThrow();
    expect(() => proxyConfigToElectron({ mode: "fixed_servers", rules: {} })).toThrow();
    expect(() => proxyConfigToElectron({ mode: "fixed_servers", rules: { singleProxy: { host: "a b" } } })).toThrow();
    expect(() =>
      proxyConfigToElectron({ mode: "fixed_servers", rules: { singleProxy: { host: "a", port: 70000 } } }),
    ).toThrow();
    expect(() =>
      proxyConfigToElectron({
        mode: "fixed_servers",
        rules: { singleProxy: { host: "a" }, proxyForHttp: { host: "b" } },
      }),
    ).toThrow();
  });
});

describe("chrome.declarativeContent", () => {
  test("URL filters, like Chrome's", () => {
    const url = "https://www.example.com:8443/docs/page.html?x=1#top";
    expect(urlFilterMatches({ hostSuffix: "example.com" }, url)).toBe(true);
    expect(urlFilterMatches({ hostEquals: "example.com" }, url)).toBe(false);
    expect(urlFilterMatches({ hostContains: ".example." }, url)).toBe(true);
    expect(urlFilterMatches({ pathPrefix: "/docs/", schemes: ["https"] }, url)).toBe(true);
    expect(urlFilterMatches({ schemes: ["http"] }, url)).toBe(false);
    expect(urlFilterMatches({ queryEquals: "x=1" }, url)).toBe(true);
    expect(urlFilterMatches({ urlMatches: "page\\.html\\?x=1$" }, url)).toBe(true);
    expect(urlFilterMatches({ ports: [[8000, 9000]] }, url)).toBe(true);
    expect(urlFilterMatches({ ports: [443] }, url)).toBe(false);
    expect(urlFilterMatches({ ports: [443] }, "https://example.com/")).toBe(true);
    expect(urlFilterMatches({ urlEquals: "https://www.example.com:8443/docs/page.html?x=1" }, url)).toBe(true);
  });

  test("rules: a page that meets a condition gets the actions", () => {
    const show = parsePageRule(
      { conditions: [{ pageUrl: { hostEquals: "example.com" }, css: ["video"] }], actions: [{ type: "show" }] },
      "r1",
    )!;
    const icon = parsePageRule(
      { id: "icon", priority: 200, conditions: [{ isBookmarked: true }], actions: [{ type: "icon", icon: "data:x" }] },
      "r2",
    )!;
    expect(show.id).toBe("r1");
    expect(pageSelectors([show, icon])).toEqual(["video"]);
    const page = (url: string, css: string[], bookmarked = false) => ({ url, css: new Set(css), bookmarked });
    expect(pageActions([show], page("https://example.com/", ["video"]))).toEqual([{ type: "show" }]);
    expect(pageActions([show], page("https://example.com/", []))).toEqual([]);
    expect(pageActions([show, icon], page("https://example.com/", ["video"], true))).toEqual([
      { type: "icon", icon: "data:x" },
      { type: "show" },
    ]);
    expect(parsePageRule({ conditions: [], actions: [{ type: "nope" }] }, "x")).toBeNull();
  });
});

describe("chrome.history", () => {
  const visit = (id: number, url: string, title: string, visitedAt: string) => ({ id, url, title, visitedAt });

  test("visits as history items: one per page, newest first", () => {
    const items = historyItems([
      visit(5, "https://a.test/", "A again", "2026-11-09T10:00:00Z"),
      visit(4, "https://b.test/", "B", "2026-11-09T09:00:00Z"),
      visit(3, "https://a.test/", "A", "2026-11-09T08:00:00Z"),
    ]);
    expect(items).toEqual([
      {
        id: "5",
        url: "https://a.test/",
        title: "A again",
        lastVisitTime: Date.parse("2026-11-09T10:00:00Z"),
        visitCount: 2,
        typedCount: 0,
      },
      {
        id: "4",
        url: "https://b.test/",
        title: "B",
        lastVisitTime: Date.parse("2026-11-09T09:00:00Z"),
        visitCount: 1,
        typedCount: 0,
      },
    ]);
    expect(historyItems([visit(1, "https://a.test/", "", "2026-11-09T10:00:00Z")], 0)).toEqual([]);
  });

  test("a page's visits, oldest first", () => {
    const items = visitItems(
      [visit(5, "u", "", "2026-11-09T10:00:00Z"), visit(3, "u", "", "2026-11-09T08:00:00Z")],
      "5",
    );
    expect(items.map((v) => v.visitId)).toEqual(["3", "5"]);
    expect(items[0]).toMatchObject({ id: "5", transition: "link", isLocal: true });
  });
});

describe("chrome.contentSettings and chrome.browsingData", () => {
  test("patterns: a site, or every site", () => {
    expect(contentPatternSite("<all_urls>")).toBeNull();
    expect(contentPatternSite("*://*/*")).toBeNull();
    expect(contentPatternSite("https://*.example.com/*")).toBe("example.com");
    expect(contentPatternSite("https://www.example.com:443/*")).toBe("example.com");
    expect(contentPatternSite("nope")).toBeUndefined();
    expect(contentPatternSite("https://a*b.com/*")).toBeUndefined();
  });

  test("what to remove, by where it's kept", () => {
    expect(
      browsingDataPlan({ cookies: true, cache: true, history: true, downloads: false, cacheStorage: true }),
    ).toEqual({
      session: ["cache", "cookies"],
      cacheStorage: true,
      history: true,
      downloads: false,
    });
    expect(browsingDataPlan({ appcache: true, localStorage: true, passwords: true }).session).toEqual([
      "cache",
      "localStorage",
    ]);
    expect(browsingDataPlan(null)).toEqual({ session: [], cacheStorage: false, history: false, downloads: false });
  });
});

describe("chrome.userScripts", () => {
  test("registered scripts are checked", () => {
    const script = parseUserScript({ id: "a", matches: ["https://*.example.com/*"], js: [{ code: "1" }] });
    expect(script).toMatchObject({ runAt: "document_idle", world: "USER_SCRIPT", allFrames: false, worldId: "" });
    expect(() => parseUserScript({ id: "a", matches: [], js: [{ code: "1" }] })).toThrow();
    expect(() => parseUserScript({ id: "a", matches: ["nope"], js: [{ code: "1" }] })).toThrow();
    expect(() => parseUserScript({ id: "_a", matches: ["<all_urls>"], js: [{ code: "1" }] })).toThrow();
    expect(() => parseUserScript({ id: "a", matches: ["<all_urls>"], js: [] })).toThrow();
    // An update keeps what it doesn't change.
    const updated = parseUserScript({ id: "a", runAt: "document_start" }, script);
    expect(updated).toMatchObject({ matches: ["https://*.example.com/*"], runAt: "document_start" });
  });

  test("where they run: patterns, then globs", () => {
    const script = {
      matches: ["https://*.example.com/*"],
      excludeMatches: ["https://admin.example.com/*"],
      includeGlobs: ["*docs*"],
      excludeGlobs: ["*?draft"],
    };
    expect(userScriptMatches(script, "https://www.example.com/docs/a")).toBe(true);
    expect(userScriptMatches(script, "https://www.example.com/blog")).toBe(false);
    expect(userScriptMatches(script, "https://admin.example.com/docs")).toBe(false);
    expect(userScriptMatches(script, "https://www.example.com/docs/a?draft")).toBe(false);
    expect(userScriptMatches(script, "https://other.test/docs")).toBe(false);
  });
});

describe("chrome.ttsEngine", () => {
  test("an engine's voices from its manifest", () => {
    expect(
      engineVoices("abc", {
        tts_engine: { voices: [{ voice_name: "Alice", lang: "en-US", event_types: ["start", "end"] }, { nope: 1 }] },
      } as never),
    ).toEqual([{ voiceName: "Alice", lang: "en-US", remote: false, extensionId: "abc", eventTypes: ["start", "end"] }]);
    expect(engineVoices("abc", {})).toEqual([]);
  });
});

describe("chrome.downloads", () => {
  const info = (over: Partial<DownloadInfo>): DownloadInfo => ({
    id: "x",
    url: "https://example.com/a.pdf",
    pageUrl: null,
    filename: "a.pdf",
    path: "/d/a.pdf",
    mime: "application/pdf",
    totalBytes: 100,
    receivedBytes: 100,
    state: "completed",
    paused: false,
    danger: null,
    unconfirmedPath: null,
    kept: false,
    discarded: false,
    error: null,
    workspaceId: "w",
    partition: "",
    startedAt: Date.parse("2026-11-09T10:00:00Z"),
    endedAt: Date.parse("2026-11-09T10:00:05Z"),
    exists: true,
    ...over,
  });

  test("as Chrome's DownloadItem", () => {
    expect(downloadItem(info({}), 1)).toMatchObject({
      id: 1,
      filename: "/d/a.pdf",
      state: "complete",
      danger: "safe",
      exists: true,
      fileSize: 100,
      startTime: "2026-11-09T10:00:00.000Z",
    });
    expect(downloadItem(info({ state: "progressing", receivedBytes: 10, endedAt: null }), 2)).toMatchObject({
      state: "in_progress",
      bytesReceived: 10,
    });
    expect(downloadItem(info({ state: "cancelled" }), 3)).toMatchObject({
      state: "interrupted",
      error: "USER_CANCELED",
    });
    expect(downloadItem(info({ danger: "file", unconfirmedPath: "/d/Unconfirmed 1.download" }), 4)).toMatchObject({
      danger: "file",
      filename: "/d/Unconfirmed 1.download",
    });
  });

  test("searched like chrome.downloads.search", () => {
    const items = [
      downloadItem(info({ id: "a", url: "https://example.com/a.pdf", startedAt: 1000 }), 1),
      downloadItem(info({ id: "b", url: "https://other.test/b.zip", path: "/d/b.zip", startedAt: 2000 }), 2),
      downloadItem(info({ id: "c", state: "progressing", url: "https://example.com/c.iso", startedAt: 3000 }), 3),
    ];
    expect(searchDownloads(items, {}).map((d) => d.id)).toEqual([3, 2, 1]);
    expect(searchDownloads(items, { state: "complete" }).map((d) => d.id)).toEqual([2, 1]);
    expect(searchDownloads(items, { query: ["example", "-iso"] }).map((d) => d.id)).toEqual([1]);
    expect(searchDownloads(items, { urlRegex: "\\.zip$" }).map((d) => d.id)).toEqual([2]);
    expect(searchDownloads(items, { orderBy: ["startTime"], limit: 2 }).map((d) => d.id)).toEqual([1, 2]);
    expect(searchDownloads(items, { id: 2 }).map((d) => d.id)).toEqual([2]);
  });
});
