import { describe, expect, test } from "bun:test";
import { defaultBrowserSettings, searchEngines, suggestUrlOf, type BrowserSettings } from "../src/shared/browser";
import {
  MAX_SEARCH_SUGGESTIONS,
  maySuggestFor,
  parseSuggestions,
  suggestRequestUrl,
} from "../src/shared/searchSuggestions";

const withSearch = (search: Partial<BrowserSettings["search"]>, on = true): BrowserSettings => {
  const b = defaultBrowserSettings();
  return { ...b, search: { ...b.search, ...search }, privacy: { ...b.privacy, searchSuggestions: on } };
};

describe("search suggestions: the engines", () => {
  test("every engine has a suggest URL with %s, over HTTPS", () => {
    for (const [id, engine] of Object.entries(searchEngines)) {
      expect(engine.suggest, id).toMatch(/^https:\/\/[^\s]+%s/);
    }
  });

  test("the engine in use's, a custom engine's own, none when off", () => {
    expect(suggestUrlOf(defaultBrowserSettings())).toBe(searchEngines.duckduckgo.suggest);
    expect(suggestUrlOf(withSearch({ engine: "google" }))).toBe(searchEngines.google.suggest);
    expect(suggestUrlOf(withSearch({ engine: "google" }, false))).toBeNull();
    const custom = { engine: "custom" as const, url: "https://en.wikipedia.org/w/index.php?search=%s" };
    expect(suggestUrlOf(withSearch({ ...custom, suggestUrl: "" }))).toBeNull();
    expect(suggestUrlOf(withSearch({ ...custom, suggestUrl: "https://example.org/no-placeholder" }))).toBeNull();
    expect(
      suggestUrlOf(
        withSearch({ ...custom, suggestUrl: " https://en.wikipedia.org/w/api.php?action=opensearch&search=%s " }),
      ),
    ).toBe("https://en.wikipedia.org/w/api.php?action=opensearch&search=%s");
    // A custom engine without a usable search URL searches, and suggests, with DuckDuckGo.
    expect(suggestUrlOf(withSearch({ engine: "custom", url: "nope", suggestUrl: "" }))).toBe(
      searchEngines.duckduckgo.suggest,
    );
  });

  test("the request's URL has the words encoded", () => {
    expect(suggestRequestUrl(searchEngines.duckduckgo.suggest, " café & co ")).toBe(
      "https://duckduckgo.com/ac/?q=caf%C3%A9%20%26%20co&type=list",
    );
  });
});

describe("search suggestions: reading each engine's answer", () => {
  // As the engines answered (shortened).
  const answers: Record<keyof typeof searchEngines, string> = {
    google:
      '["weath",["weather","weather portland","weather tomorrow"],["","",""],[],{"google:clientdata":{"bpc":false,"tlw":false},"google:suggesttype":["QUERY","QUERY","QUERY"]}]',
    bing: '["weath",["weather","weather channel","weather radar"]]',
    duckduckgo: '["weath",["weather","weather underground","weather channel"]]',
    brave: '["weath",["weather","weather radar","weather today"]]',
    kagi: '["weath",["weather","weather channel","weather forecast 10 day"]]',
    ecosia: '["weath",["weather","weather underground","weather channel"]]',
    startpage: '["weath",["weather","weather tomorrow","weather channel"]]\n',
  };
  for (const [id, body] of Object.entries(answers))
    test(`${searchEngines[id as keyof typeof searchEngines].label}: OpenSearch JSON`, () => {
      const out = parseSuggestions(body, "weath");
      expect(out.length).toBe(3);
      expect(out[0]).toBe("weather");
      expect(out.every((s) => s.startsWith("weather"))).toBe(true);
    });

  test("DuckDuckGo's default answer (a list of phrases)", () => {
    expect(parseSuggestions('[{"phrase":"weather"},{"phrase":"weather channel"},{"other":1}]', "weath")).toEqual([
      "weather",
      "weather channel",
    ]);
  });

  test("a byte order mark and an anti-XSSI prefix are skipped", () => {
    expect(parseSuggestions('\uFEFF["a",["ab"]]', "a")).toEqual(["ab"]);
    expect(parseSuggestions(')]}\'\n["a",["ab"]]', "a")).toEqual(["ab"]);
  });

  test("at most a few, none twice, not what's typed, only strings", () => {
    const many = JSON.stringify([
      "q",
      ["Q", "q", "a", "A", " a ", 1, null, { x: 1 }, ["b"], "b", "c", "d", "e", "f", "g"],
    ]);
    expect(parseSuggestions(many, "q")).toEqual(["a", "b", "c", "d", "e"]);
    expect(parseSuggestions(many, "q").length).toBe(MAX_SEARCH_SUGGESTIONS);
    expect(parseSuggestions(many, "q", 2)).toEqual(["a", "b"]);
  });

  test("one line, without control or bidi override characters, not too long", () => {
    const body = JSON.stringify([
      "q",
      ["two\nlines", "tab\there", "evil\u202eexe.txt", "x".repeat(201), "  spaced   out  "],
    ]);
    expect(parseSuggestions(body, "q")).toEqual(["two lines", "tab here", "evil exe.txt", "spaced out"]);
  });

  test("anything else is no suggestions", () => {
    for (const body of [
      "",
      "not json",
      "<!doctype html><title>Too many requests</title>",
      "null",
      "{}",
      '{"suggestions":["a"]}',
      '"a"',
      "[1, 2]",
      '["q"]',
      '["q", "a"]',
      '[["a"], ["b"]]',
    ])
      expect(parseSuggestions(body, "q"), body).toEqual([]);
  });
});

describe("search suggestions: what's never sent", () => {
  test("words and plain site names are sent", () => {
    for (const text of [
      "weather",
      "weather tomorrow",
      "why?",
      "c#",
      "c++ templates",
      "2024 election",
      "example.com",
      "github",
      "home",
      "@someone",
      "what is a 404",
      "define:word",
    ])
      expect(maySuggestFor(text), text).toBe(true);
  });

  test("nothing empty, too long, or with control characters", () => {
    expect(maySuggestFor("")).toBe(false);
    expect(maySuggestFor("   ")).toBe(false);
    expect(maySuggestFor("word ".repeat(50))).toBe(false);
    expect(maySuggestFor("a\u0000b")).toBe(false);
  });

  test("no credentials or email addresses, pasted with or without a scheme", () => {
    for (const text of [
      "user:pass@example.com",
      "https://user:pass@example.com/",
      "http://admin@192.168.0.1",
      "admin:hunter2@router",
      ":secret@host",
      "me@example.com",
      "mail me@example.com please",
      "login with user:pass@example.com",
    ])
      expect(maySuggestFor(text), text).toBe(false);
  });

  test("no addresses with a scheme: web, rune://, file://, extensions, javascript:, data:", () => {
    for (const text of [
      "https://example.com",
      "http://example.com/path?token=abc",
      "see https://example.com/reset?token=abc",
      "rune://settings",
      "rune:settings",
      "file:///home/me/secret.pdf",
      "chrome://flags",
      "chrome-extension://abcdef/options.html",
      "about:blank",
      "javascript:alert(1)",
      "data:text/html,hi",
      "view-source:https://example.com",
      "ftp://files.example.com",
      "//example.com/x",
    ])
      expect(maySuggestFor(text), text).toBe(false);
  });

  test("no local or intranet addresses", () => {
    for (const text of [
      "localhost",
      "localhost:3000",
      "127.0.0.1",
      "192.168.1.20",
      "10.0.0.1:8080",
      "192.168.1",
      "192.168",
      "127.0.",
      "[::1]",
      "[fe80::1]:8080",
      "printer.local",
      "nas.home.arpa",
      "wiki.corp",
      "jira.internal",
      "router.lan",
      "app.localhost",
      "router:8080",
      "example.com:8443",
      "intranet/wiki",
    ])
      expect(maySuggestFor(text), text).toBe(false);
  });

  test("no file paths", () => {
    for (const text of [
      "/etc/passwd",
      "~/Documents/taxes.pdf",
      "./notes.txt",
      "../x",
      "C:\\Users\\me",
      "\\\\server\\share",
    ])
      expect(maySuggestFor(text), text).toBe(false);
  });

  test("no addresses with a path, a query or a fragment, nor long tokens", () => {
    for (const text of [
      "example.com/",
      "example.com/account",
      "example.com?session=abc",
      "docs.example.com#private",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "0123456789abcdef0123456789abcdef",
    ])
      expect(maySuggestFor(text), text).toBe(false);
  });
});
