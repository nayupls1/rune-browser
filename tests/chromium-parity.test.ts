import { describe, expect, test } from "bun:test";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { buildContextMenu, quoteSelection, selectionUrl, type MenuActions } from "../src/main/contextMenu";
import { cleanFlagState, flagSwitches, flags, flagsFor } from "../src/shared/flags";
import {
  chromiumPages,
  flattenGpuInfo,
  gpuFeatureRows,
  internalPages,
  internalUrlOf,
  parseInternalUrl,
  settingsCategoryOf,
} from "../src/shared/internalPages";
import { describeLoadError } from "../src/shared/loadErrors";
import { normalizeUrl } from "../src/shared/web";

describe("internal pages", () => {
  test("rune:// and chrome:// addresses open Rune Browser's pages", () => {
    expect(parseInternalUrl("rune://version")?.page?.host).toBe("version");
    expect(parseInternalUrl("chrome://gpu")?.url).toBe("rune://gpu");
    expect(parseInternalUrl("CHROME://Flags/")?.url).toBe("rune://flags");
    expect(parseInternalUrl("chrome://settings/search")).toMatchObject({
      url: "rune://settings/search",
      path: "search",
    });
    expect(parseInternalUrl("chrome://chrome-urls")?.url).toBe("rune://rune-urls");
    expect(parseInternalUrl("chrome://help")).toMatchObject({ url: "rune://settings/about" });
    expect(parseInternalUrl("about:version")?.url).toBe("rune://version");
    expect(parseInternalUrl("rune://extensions?id=x#y")?.url).toBe("rune://extensions");
  });

  test("not internal: about:blank, websites; unknown rune:// pages have no page", () => {
    expect(parseInternalUrl("about:blank")).toBeNull();
    expect(parseInternalUrl("https://example.com")).toBeNull();
    expect(parseInternalUrl("runes are cool")).toBeNull();
    expect(parseInternalUrl("chrome://dino")).toMatchObject({ url: "rune://dino", page: undefined });
  });

  test("the address bar turns them into rune:// addresses", () => {
    expect(normalizeUrl("chrome://extensions")).toBe("rune://extensions");
    expect(normalizeUrl(" rune://flags ")).toBe("rune://flags");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });

  test("Chromium's settings pages map to Settings categories", () => {
    const known = [
      "appearance",
      "web",
      "extensions",
      "browser-search",
      "browser-startup",
      "browser-sites",
      "about",
      "network",
    ];
    expect(settingsCategoryOf("search", known)).toBe("browser-search");
    expect(settingsCategoryOf("onStartup", known)).toBe("browser-startup");
    expect(settingsCategoryOf("content/camera", known)).toBe("browser-sites");
    expect(settingsCategoryOf("network", known)).toBe("network");
    expect(settingsCategoryOf("", known)).toBe("");
    expect(settingsCategoryOf("nonsense", known)).toBe("");
  });

  test("Settings pages have rune:// addresses for the address bar", () => {
    expect(internalUrlOf({ settings: "extensions" })).toBe("rune://extensions");
    expect(internalUrlOf({ settings: "appearance" })).toBe("rune://settings/appearance");
    expect(internalUrlOf({ view: "gpu" })).toBe("rune://gpu");
    expect(internalUrlOf({ view: "snapshots" })).toBe("rune://snapshots");
    expect(internalUrlOf({ view: "history" })).toBe("rune://history");
    expect(internalUrlOf({ newTab: true })).toBe("rune://newtab");
  });

  test("every page and alias is unique, and Chromium's list says what's matched", () => {
    const names = internalPages.flatMap((p) => [p.host, ...(p.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const page of chromiumPages.filter((p) => p.status === "matched" && !p.host.includes("/")))
      expect(parseInternalUrl(`chrome://${page.host}`)?.page).toBeDefined();
    // Pages other work is bringing aren't claimed yet.
    for (const host of ["bookmarks"]) expect(parseInternalUrl(`rune://${host}`)?.page).toBeUndefined();
    expect(parseInternalUrl("chrome://history")?.page?.target).toEqual({ view: "history" });
    expect(parseInternalUrl("chrome://downloads")?.page?.target).toEqual({ view: "downloads" });
  });

  test("GPU status reads like chrome://gpu", () => {
    expect(gpuFeatureRows({ gpu_compositing: "enabled", webgl: "unavailable_software" })).toEqual([
      { name: "Compositing", status: "Hardware accelerated", good: true },
      { name: "WebGL", status: "Software only, hardware acceleration unavailable", good: false },
    ]);
    expect(
      flattenGpuInfo({ gpuDevice: [{ vendorId: 4318, active: true }], auxAttributes: { glRenderer: "X" } }),
    ).toEqual([
      ["gpuDevice[0].vendorId", "0x10de"],
      ["gpuDevice[0].active", "true"],
      ["auxAttributes.glRenderer", "X"],
    ]);
  });
});

describe("flags", () => {
  test("only known flags and values are kept, defaults dropped", () => {
    expect(
      cleanFlagState(
        { "enable-quic": "enabled", "enable-force-dark": "default", nope: "enabled", "enable-zero-copy": "maybe" },
        "linux",
      ),
    ).toEqual({ "enable-quic": "enabled" });
    expect(cleanFlagState(null, "linux")).toEqual({});
    expect(cleanFlagState({ "smooth-scrolling": "enabled" }, "darwin")).toEqual({});
  });

  test("they become Chromium switches and features", () => {
    expect(
      flagSwitches(
        {
          "enable-quic": "disabled",
          "ignore-gpu-blocklist": "enabled",
          "enable-force-dark": "enabled",
          "overlay-scrollbars": "disabled",
        },
        "linux",
      ),
    ).toEqual({
      switches: [["ignore-gpu-blocklist"], ["disable-quic"]],
      enableFeatures: ["WebContentsForceDark"],
      disableFeatures: ["OverlayScrollbar"],
    });
  });

  test("every flag starts with Default and has unique ids", () => {
    expect(new Set(flags.map((f) => f.id)).size).toBe(flags.length);
    for (const flag of flags) expect(flag.options[0]!.value).toBe("default");
    expect(flagsFor("darwin").some((f) => f.id === "smooth-scrolling")).toBe(false);
  });
});

describe("load errors", () => {
  test("certificate errors: not private, with what's wrong", () => {
    const error = describeLoadError(-202, "ERR_CERT_AUTHORITY_INVALID", "https://self-signed.example:8443/x");
    expect(error).toMatchObject({
      kind: "certificate",
      title: "Your connection is not private",
      code: "NET::ERR_CERT_AUTHORITY_INVALID",
    });
    expect(error!.advanced).toContain("self-signed.example:8443");
    expect(describeLoadError(-201, "ERR_CERT_DATE_INVALID", "https://a.test")!.advanced).toContain("expired");
  });

  test("network errors read like Chromium's", () => {
    expect(describeLoadError(-105, "ERR_NAME_NOT_RESOLVED", "https://nope.invalid/")).toMatchObject({
      kind: "network",
      title: "This site can't be reached",
      message: "nope.invalid's server IP address could not be found.",
      code: "ERR_NAME_NOT_RESOLVED",
    });
    expect(describeLoadError(-102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:9/")!.message).toBe(
      "127.0.0.1:9 refused to connect.",
    );
    expect(describeLoadError(-106, "ERR_INTERNET_DISCONNECTED", "https://a.test")!.title).toBe("No internet");
    expect(describeLoadError(-999, "", "https://a.test")!.code).toBe("ERR_999");
  });

  test("an aborted load isn't an error", () => {
    expect(describeLoadError(-3, "ERR_ABORTED", "https://a.test")).toBeNull();
  });
});

describe("page context menu", () => {
  const params = (over: Partial<ContextMenuParams> = {}): ContextMenuParams =>
    ({
      x: 1,
      y: 2,
      linkURL: "",
      linkText: "",
      srcURL: "",
      pageURL: "https://example.com/",
      mediaType: "none",
      isEditable: false,
      selectionText: "",
      misspelledWord: "",
      dictionarySuggestions: [],
      mediaFlags: { canSave: true },
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
        canEditRichly: true,
        canDelete: false,
      },
      ...over,
    }) as ContextMenuParams;
  const calls: string[] = [];
  const actions: MenuActions = {
    openTab: (url, background) => calls.push(`tab ${url} ${background}`),
    openExternal: (url) => calls.push(`external ${url}`),
    copyText: (text) => calls.push(`copy ${text}`),
    download: (url) => calls.push(`download ${url}`),
    copyImageAt: () => calls.push("copy image"),
    edit: (command) => calls.push(`edit ${command}`),
    replaceMisspelling: (word) => calls.push(`replace ${word}`),
    addToDictionary: (word) => calls.push(`dictionary ${word}`),
    canGoBack: false,
    canGoForward: true,
    back: () => calls.push("back"),
    forward: () => calls.push("forward"),
    reload: () => calls.push("reload"),
    savePage: () => calls.push("save"),
    print: () => calls.push("print"),
    viewSource: () => calls.push("source"),
    inspect: (x, y) => calls.push(`inspect ${x},${y}`),
    pageUrl: "https://example.com/",
    search: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
    keys: () => ({}),
    extensionItems: [],
  };
  const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => (i.type === "separator" ? "—" : i.label));
  const click = (items: MenuItemConstructorOptions[], label: string) => {
    const item = items.find((i) => i.label === label);
    if (!item?.click) throw new Error(`no ${label}`);
    (item.click as () => void)();
  };

  test("on the page: navigation, save and print, source, inspect", () => {
    expect(labels(buildContextMenu(params(), actions))).toEqual([
      "Back",
      "Forward",
      "Reload",
      "—",
      "Save as…",
      "Print…",
      "—",
      "Open page in default browser",
      "View page source",
      "—",
      "Inspect",
    ]);
    expect(buildContextMenu(params(), actions)[0]!.enabled).toBe(false);
  });

  test("a link, an image: what Chromium offers, without the page's items", () => {
    const items = buildContextMenu(
      params({ linkURL: "https://a.test/x", linkText: "A link", mediaType: "image", srcURL: "https://a.test/i.png" }),
      actions,
    );
    expect(labels(items)).toEqual([
      "Open link in new tab",
      "Open link in default browser",
      "—",
      "Save link as…",
      "Copy link address",
      "Copy link text",
      "—",
      "Open image in new tab",
      "Save image as…",
      "Copy image",
      "Copy image address",
      "—",
      "Inspect",
    ]);
    calls.length = 0;
    click(items, "Save link as…");
    click(items, "Copy image address");
    click(items, "Open link in new tab");
    expect(calls).toEqual(["download https://a.test/x", "copy https://a.test/i.png", "tab https://a.test/x true"]);
  });

  test("a misspelled word in a field: suggestions first, then editing", () => {
    const items = buildContextMenu(
      params({ isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello", "help"] }),
      actions,
    );
    expect(labels(items)).toEqual([
      "hello",
      "help",
      "—",
      "Add to dictionary",
      "—",
      "Undo",
      "Redo",
      "—",
      "Cut",
      "Copy",
      "Paste",
      "Paste as plain text",
      "Select all",
      "—",
      "Inspect",
    ]);
    calls.length = 0;
    click(items, "hello");
    click(items, "Add to dictionary");
    click(items, "Paste as plain text");
    expect(calls).toEqual(["replace hello", "dictionary helo", "edit pasteAndMatchStyle"]);
  });

  test("selected text: copy, search with the chosen engine (or go to an address), print", () => {
    const items = buildContextMenu(params({ selectionText: "  what is a rune  " }), actions);
    expect(labels(items)).toEqual(["Copy", "Search DuckDuckGo for “what is a rune”", "Print…", "—", "Inspect"]);
    calls.length = 0;
    click(items, "Search DuckDuckGo for “what is a rune”");
    expect(calls).toEqual(["tab https://duckduckgo.com/?q=what%20is%20a%20rune false"]);
    expect(labels(buildContextMenu(params({ selectionText: "example.com/a" }), actions))[1]).toBe(
      "Go to example.com/a",
    );
    expect(quoteSelection("a".repeat(40))).toBe(`“${"a".repeat(31)}…”`);
    expect(selectionUrl("https://x.test/a")).toBe("https://x.test/a");
    expect(selectionUrl("two words")).toBeNull();
  });

  test("extensions' items come before Inspect", () => {
    const items = buildContextMenu(params(), { ...actions, extensionItems: [{ label: "Save to Pocket" }] });
    expect(labels(items).slice(-3)).toEqual(["Save to Pocket", "—", "Inspect"]);
  });
});

describe("the reference list", () => {
  test("docs/chromium-parity.md covers every Chromium page rune://rune-urls lists", async () => {
    const doc = await Bun.file(new URL("../docs/chromium-parity.md", import.meta.url)).text();
    for (const page of chromiumPages) expect(doc).toContain(`chrome://${page.host}`);
  });
});
