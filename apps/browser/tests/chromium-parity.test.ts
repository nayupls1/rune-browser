import { describe, expect, test } from "bun:test";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import {
  buildContextMenu,
  mediaActionScript,
  quoteSelection,
  selectionUrl,
  type MenuActions,
} from "../src/main/contextMenu";
import { cleanFlagState, flagSwitches, flags, flagsFor } from "../src/shared/flags";
import {
  chromiumPages,
  flattenGpuInfo,
  gpuFeatureRows,
  internalPages,
  internalUrlOf,
  parseInternalUrl,
  settingsCategoryOf,
  formatCpu,
  formatMemory,
  sortProcesses,
  taskLabel,
  type ProcessInfo,
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
    expect(parseInternalUrl("chrome://task-manager")?.url).toBe("rune://task-manager");
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
      "browser-clear",
      "about",
      "network",
    ];
    expect(settingsCategoryOf("search", known)).toBe("browser-search");
    expect(settingsCategoryOf("onStartup", known)).toBe("browser-startup");
    expect(settingsCategoryOf("content/camera", known)).toBe("browser-sites");
    expect(settingsCategoryOf("clearBrowserData", known)).toBe("browser-clear");
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
    // A page Rune Browser doesn't have yet isn't claimed.
    expect(parseInternalUrl("rune://password-manager")?.page).toBeUndefined();
    expect(parseInternalUrl("chrome://history")?.page?.target).toEqual({ view: "history" });
    expect(parseInternalUrl("chrome://downloads")?.page?.target).toEqual({ view: "downloads" });
    expect(parseInternalUrl("chrome://bookmarks")?.page?.target).toEqual({ view: "bookmarks" });
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
    openWindow: (url, isPrivate) => calls.push(`window ${url} ${isPrivate}`),
    isPrivate: false,
    media: (action) => calls.push(`media ${action.kind} ${action.on}`),
    copyVideoFrame: () => calls.push("copy frame"),
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
      "Open link in new window",
      "Open link in private window",
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

  test("a link from a private window: a new window is private too, and no other private window", () => {
    const items = buildContextMenu(params({ linkURL: "https://a.test/x" }), { ...actions, isPrivate: true });
    expect(items.find((i) => i.label === "Open link in private window")!.enabled).toBe(false);
    calls.length = 0;
    click(items, "Open link in new window");
    click(buildContextMenu(params({ linkURL: "https://a.test/x" }), actions), "Open link in private window");
    expect(calls).toEqual(["window https://a.test/x true", "window https://a.test/x true"]);
    click(buildContextMenu(params({ linkURL: "https://a.test/x" }), actions), "Open link in new window");
    expect(calls.at(-1)).toBe("window https://a.test/x false");
  });

  test("a video: Loop and Show controls reflect it, then its address, frame and picture in picture", () => {
    const flags = {
      canSave: true,
      inError: false,
      isLooping: true,
      isControlsVisible: false,
      canToggleControls: true,
      canShowPictureInPicture: true,
      isShowingPictureInPicture: false,
    };
    const items = buildContextMenu(
      params({
        mediaType: "video",
        srcURL: "https://a.test/v.webm",
        mediaFlags: flags as ContextMenuParams["mediaFlags"],
      }),
      actions,
    );
    expect(labels(items)).toEqual([
      "Loop",
      "Show controls",
      "—",
      "Open video in new tab",
      "Save video as…",
      "Copy video address",
      "Copy video frame",
      "Picture in picture",
      "—",
      "Inspect",
    ]);
    const item = (label: string) => items.find((i) => i.label === label)!;
    expect([item("Loop").type, item("Loop").checked]).toEqual(["checkbox", true]);
    expect([item("Show controls").type, item("Show controls").checked]).toEqual(["checkbox", false]);
    expect(item("Picture in picture").checked).toBe(false);
    calls.length = 0;
    click(items, "Loop");
    click(items, "Show controls");
    click(items, "Picture in picture");
    click(items, "Copy video frame");
    expect(calls).toEqual(["media loop false", "media controls true", "media pip true", "copy frame"]);
    // A stream (no address of its own) and audio: only what applies.
    expect(labels(buildContextMenu(params({ mediaType: "video", mediaFlags: flags as never }), actions))).toEqual([
      "Loop",
      "Show controls",
      "—",
      "Copy video frame",
      "Picture in picture",
      "—",
      "Inspect",
    ]);
    expect(
      labels(
        buildContextMenu(
          params({ mediaType: "audio", srcURL: "https://a.test/a.mp3", mediaFlags: flags as never }),
          actions,
        ),
      ),
    ).toEqual([
      "Loop",
      "Show controls",
      "—",
      "Open audio in new tab",
      "Save audio as…",
      "Copy audio address",
      "—",
      "Inspect",
    ]);
  });

  test("the video items' script: only numbers and a quoted address from the page", () => {
    const script = mediaActionScript({ kind: "loop", on: true }, { x: 10.4, y: 20.6 }, 'x"); alert(1); ("');
    expect(script).toContain("document.elementsFromPoint(10, 21)");
    expect(script).toContain("el.loop = true;");
    expect(script).toContain(JSON.stringify('x"); alert(1); ("'));
    expect(script).not.toContain('x"); alert(1)');
    expect(mediaActionScript({ kind: "controls", on: false }, null, "")).toContain("let el = undefined;");
    expect(mediaActionScript({ kind: "pip", on: true }, { x: NaN, y: 1 }, "")).toContain("requestPictureInPicture");
    expect(mediaActionScript({ kind: "pip", on: false }, null, "")).toContain("exitPictureInPicture");
    // Every variant is valid JavaScript.
    for (const kind of ["loop", "controls", "pip"] as const)
      for (const on of [true, false])
        expect(() => new Function(mediaActionScript({ kind, on }, { x: 1, y: 2 }, "a"))).not.toThrow();
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

describe("rune://task-manager", () => {
  const proc = (pid: number, over: Partial<ProcessInfo>): ProcessInfo => ({
    pid,
    kind: "tab",
    tasks: [{ kind: "tab", title: `Page ${pid}` }],
    memory: 0,
    cpu: 0,
    canEnd: true,
    ...over,
  });
  const list = [
    proc(30, { memory: 50_000_000, cpu: 2, tasks: [{ kind: "tab", title: "Zebra" }] }),
    proc(10, { kind: "browser", tasks: [{ kind: "browser", title: "Browser" }], memory: 90_000_000, canEnd: false }),
    proc(20, { memory: 10_000_000, cpu: 7.25, tasks: [{ kind: "tab", title: "Apple" }] }),
    proc(40, { kind: "gpu", tasks: [{ kind: "gpu", title: "GPU Process" }], canEnd: false }),
  ];

  test("sorted like Chrome's columns: the browser and GPU first by name, then memory, CPU, process ID", () => {
    expect(sortProcesses(list, "task", false).map((p) => p.pid)).toEqual([10, 40, 20, 30]);
    expect(sortProcesses(list, "memory", true).map((p) => p.pid)).toEqual([10, 30, 20, 40]);
    expect(sortProcesses(list, "cpu", true).map((p) => p.pid)).toEqual([20, 30, 10, 40]);
    expect(sortProcesses(list, "pid", false).map((p) => p.pid)).toEqual([10, 20, 30, 40]);
    expect(list.map((p) => p.pid)).toEqual([30, 10, 20, 40]);
  });

  test("names and numbers as Chrome writes them", () => {
    expect(taskLabel({ kind: "tab", title: "Example" })).toBe("Tab: Example");
    expect(taskLabel({ kind: "extension", title: "Bitwarden" })).toBe("Extension: Bitwarden");
    expect(taskLabel({ kind: "utility", title: "Network Service" })).toBe("Utility: Network Service");
    expect(taskLabel({ kind: "gpu", title: "GPU Process" })).toBe("GPU Process");
    expect(formatMemory(155_955_200)).toBe("152,300K");
    expect(formatCpu(0.25)).toBe("0.3");
    expect(formatCpu(Number.NaN)).toBe("0.0");
  });
});

describe("the reference list", () => {
  test("docs/chromium-parity.md covers every Chromium page rune://rune-urls lists", async () => {
    const doc = await Bun.file(new URL("../docs/chromium-parity.md", import.meta.url)).text();
    for (const page of chromiumPages) expect(doc).toContain(`chrome://${page.host}`);
  });
});
