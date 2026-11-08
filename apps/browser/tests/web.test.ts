import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Socket, type TopicMessage } from "../src/shared/hub";
import type { AppSummary, PageContext, SiteOverride } from "../src/shared/api";
import { searchEngines } from "../src/shared/browser";
import { fileNameOf, fileUrl, hostOf, isViewableFile, normalizeUrl, overrideScript } from "../src/shared/web";
import { contextSummary, withPageContext } from "../src/server/agent/prompts";
import { startServer } from "./lib/server";

describe("address bar input", () => {
  test("keeps URLs, completes domains, searches the rest", () => {
    expect(normalizeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("news.ycombinator.com/item?id=1")).toBe("https://news.ycombinator.com/item?id=1");
    expect(normalizeUrl("localhost:5173/x")).toBe("http://localhost:5173/x");
    expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("how do magnets work")).toBe("https://duckduckgo.com/?q=how%20do%20magnets%20work");
    expect(normalizeUrl("solid.js signals", searchEngines.google.url)).toBe(
      "https://www.google.com/search?q=solid.js%20signals",
    );
    expect(normalizeUrl("   ")).toBe("");
  });

  test("local files: paths and file:// URLs open as files", () => {
    expect(normalizeUrl("file:///tmp/a.pdf")).toBe("file:///tmp/a.pdf");
    expect(normalizeUrl("/home/me/My Report #2.pdf")).toBe("file:///home/me/My%20Report%20%232.pdf");
    expect(normalizeUrl("C:\\Users\\me\\a.png")).toBe("file:///C:/Users/me/a.png");
    expect(fileUrl("/tmp/what?.txt")).toBe("file:///tmp/what%3F.txt");
    expect(fileNameOf("file:///tmp/My%20Report.pdf")).toBe("My Report.pdf");
    for (const name of ["a.pdf", "b.PNG", "c.mp4", "d.txt", "e.html", "f.svg", "g.md"])
      expect(isViewableFile(name)).toBe(true);
    for (const name of ["a.zip", "b.exe", "c.docx", "d"]) expect(isViewableFile(name)).toBe(false);
    expect(isViewableFile("photo", "image/heic")).toBe(true);
  });

  test("hostOf", () => {
    expect(hostOf("https://sub.example.com:8080/x")).toBe("sub.example.com");
    expect(hostOf("not a url")).toBe("");
    expect(hostOf(null)).toBe("");
  });
});

describe("override script", () => {
  test("runs the code and reports what it throws", async () => {
    // Plain-JS stand-ins for the page APIs the wrapper touches.
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, MutationObserver: g.MutationObserver, console: g.console, window: g.window };
    const els = [{ n: 1 }, { n: 2 }];
    g.window = { addEventListener() {} };
    g.document = {
      readyState: "complete",
      querySelectorAll: () => els,
      getElementById: () => null,
      documentElement: {},
    };
    g.MutationObserver = class {
      observe() {}
    };
    g.console = { ...console, error: () => {} };
    try {
      const seen: number[] = [];
      g.__seen = seen;
      // A page no framework server-rendered: onElement runs at DOM ready, right away.
      expect(eval(overrideScript(`onElement(".x", (el) => __seen.push(el.n));`))).toBeNull();
      expect(seen).toEqual([1, 2]);
      expect(eval(overrideScript(`throw new Error("nope")`))).toContain("nope");

      // A server-rendered one (Next.js): it waits for the page to settle (loaded, scripts idle) first.
      seen.length = 0;
      g.window = { addEventListener() {}, __next_f: [] };
      eval(overrideScript(`onElement(".x", (el) => __seen.push(el.n));`));
      expect(seen).toEqual([]);
      await Bun.sleep(150);
      // Next.js hasn't started hydrating: still nothing.
      expect(seen).toEqual([]);
      // It has (its root is marked, its elements too).
      (g.document as Record<string, unknown>)["__reactContainer$x"] = {};
      for (const el of els) (el as Record<string, unknown>)["__reactFiber$x"] = {};
      await Bun.sleep(400);
      expect(seen).toEqual([1, 2]);
    } finally {
      Object.assign(g, saved);
      delete g.__seen;
    }
  });

  test("leaves elements a framework is still hydrating until it has", async () => {
    // A page as React leaves it mid-hydration: the root is marked, the header is hydrated, the
    // main part is a server-rendered Suspense boundary that isn't yet.
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, MutationObserver: g.MutationObserver, window: g.window };
    type Fake = { parentNode: Fake | null; previousSibling: Fake | null; nodeType: number; data?: string; n?: string };
    const node = (parent: Fake | null, extra: Partial<Fake> = {}): Fake => ({
      parentNode: parent,
      previousSibling: null,
      nodeType: 1,
      ...extra,
    });
    const doc = node(null, { nodeType: 9 });
    const root = node(doc) as Fake & Record<string, unknown>;
    root["__reactContainer$x"] = {};
    const app = node(root) as Fake & Record<string, unknown>;
    app["__reactFiber$x"] = {};
    const header = node(app, { n: "header" }) as Fake & Record<string, unknown>;
    header["__reactFiber$x"] = {};
    const open = node(app, { nodeType: 8, data: "$", previousSibling: header });
    const main = node(app, { n: "main", previousSibling: open }) as Fake & Record<string, unknown>;
    const close = node(app, { nodeType: 8, data: "/$", previousSibling: main });
    // Not React's (another script added it), and not in the boundary: ready with its owner.
    const foreign = node(app, { n: "foreign", previousSibling: close });
    const plain = node(null, { n: "plain" });
    g.window = { addEventListener() {} };
    g.document = Object.assign(doc, {
      readyState: "complete",
      querySelectorAll: () => [header, main, foreign, plain],
      getElementById: () => null,
      documentElement: {},
    });
    g.MutationObserver = class {
      observe() {}
    };
    try {
      const seen: string[] = [];
      g.__seen = seen;
      eval(overrideScript(`onElement("*", (el) => __seen.push(el.n));`));
      await Bun.sleep(150);
      expect(seen).toEqual(["header", "foreign", "plain"]);
      // React reaches the boundary: the element gets its fiber, and it's changed on the next look.
      main["__reactFiber$x"] = {};
      await Bun.sleep(400);
      expect(seen).toEqual(["header", "foreign", "plain", "main"]);
    } finally {
      Object.assign(g, saved);
      delete g.__seen;
    }
  });
});

describe("waiting for frameworks to hydrate (PAGE_READY)", () => {
  type El = Record<string, unknown> & { n: string; parentNode: unknown; previousSibling: null; nodeType: 1 };
  /** onElement on a fake page: what it changed so far, and the page to change. */
  const page = (win: Record<string, unknown>, doc: Record<string, unknown>, byId: Record<string, unknown> = {}) => {
    const g = globalThis as Record<string, unknown>;
    const els: El[] = ["a", "b"].map((n) => ({ n, parentNode: null, previousSibling: null, nodeType: 1 }));
    const saved = { document: g.document, MutationObserver: g.MutationObserver, window: g.window };
    g.window = { addEventListener() {}, ...win };
    g.document = Object.assign(doc, {
      readyState: "complete",
      querySelectorAll: () => els,
      getElementById: (id: string) => byId[id] ?? null,
      documentElement: {},
    });
    g.MutationObserver = class {
      observe() {}
    };
    const seen: string[] = [];
    g.__seen = seen;
    eval(overrideScript(`onElement("*", (el) => __seen.push(el.n));`));
    const restore = () => {
      Object.assign(g, saved);
      delete g.__seen;
    };
    return { els, seen, restore };
  };

  test("React 16: its legacy root and elements", async () => {
    const root: Record<string, unknown> = { parentNode: null };
    const p = page({ __NEXT_DATA__: {} }, {}, { __next: root });
    try {
      for (const el of p.els) el.parentNode = root;
      root["_reactRootContainer"] = {};
      await Bun.sleep(400);
      expect(p.seen).toEqual([]);
      for (const el of p.els) el["__reactInternalInstance$x"] = {};
      await Bun.sleep(400);
      expect(p.seen).toEqual(["a", "b"]);
    } finally {
      p.restore();
    }
  });

  test("Nuxt 2: waits until Vue has mounted its root", async () => {
    const root: Record<string, unknown> = {};
    const p = page({ __NUXT__: {} }, {}, { __nuxt: root });
    try {
      await Bun.sleep(400);
      expect(p.seen).toEqual([]);
      root.__vue__ = {};
      await Bun.sleep(400);
      expect(p.seen).toEqual(["a", "b"]);
    } finally {
      p.restore();
    }
  });

  test("Astro: no running at DOM ready, the island waits until it hydrated", async () => {
    let island = true;
    const p = page({}, { querySelector: (sel: string) => (sel.includes("astro-island") ? {} : null) });
    try {
      for (const el of p.els) el.closest = () => (island ? {} : null);
      // Not right away (the page is server-rendered), and not while the island has its ssr mark.
      expect(p.seen).toEqual([]);
      await Bun.sleep(400);
      expect(p.seen).toEqual([]);
      island = false;
      await Bun.sleep(400);
      expect(p.seen).toEqual(["a", "b"]);
    } finally {
      p.restore();
    }
  });

  test("a framework that never starts is given up on for the whole page", async () => {
    const now = Date.now;
    let offset = 0;
    Date.now = () => now() + offset;
    const p = page({ __next_f: [] }, {});
    try {
      await Bun.sleep(400);
      expect(p.seen).toEqual([]);
      // More than 10 seconds after the page settled.
      offset = 11_000;
      await Bun.sleep(400);
      expect(p.seen).toEqual(["a", "b"]);
    } finally {
      Date.now = now;
      p.restore();
    }
  });
});

describe("page context for the website agent", () => {
  const page: PageContext = {
    url: "https://example.com/",
    title: "Example",
    selection: [
      {
        selector: "main > h1",
        tag: "h1",
        text: "Example Domain",
        html: "<h1>Example Domain</h1>",
        rect: { x: 10, y: 20, width: 300, height: 40 },
        styles: { color: "rgb(0, 0, 0)", "font-size": "32px", display: "block", opacity: "1", "box-shadow": "none" },
      },
    ],
  };

  test("the prompt carries the page and picked elements", () => {
    const prompt = withPageContext("make this red", page);
    expect(prompt).toContain('<page url="https://example.com/"');
    expect(prompt).toContain("1. main > h1");
    expect(prompt).toContain("font-size: 32px");
    expect(prompt).not.toContain("box-shadow: none");
    expect(prompt.endsWith("make this red")).toBe(true);
    expect(withPageContext("hi", undefined)).toBe("hi");
  });

  test("the stored summary is small", () => {
    const summary = JSON.parse(contextSummary(page));
    expect(summary.selection).toEqual([{ selector: "main > h1", tag: "h1", text: "Example Domain" }]);
  });
});

describe("web tab routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("web tabs are named after the page until renamed", async () => {
    const tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com/" },
    });
    expect(tab).toMatchObject({ kind: "web", name: "example.com", url: "https://example.com/" });

    const titled = await server.api<AppSummary>(`/api/apps/${tab.id}/page`, {
      method: "PATCH",
      json: { url: "https://example.com/about", title: "About us", favicon: "https://example.com/favicon.ico" },
    });
    expect(titled).toMatchObject({
      name: "About us",
      url: "https://example.com/about",
      favicon: "https://example.com/favicon.ico",
    });

    await server.api(`/api/apps/${tab.id}`, { method: "PATCH", json: { name: "Mine" } });
    const after = await server.api<AppSummary>(`/api/apps/${tab.id}/page`, {
      method: "PATCH",
      json: { title: "Other" },
    });
    expect(after.name).toBe("Mine");

    const app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    expect(app.kind).toBe("app");
    await expect(server.api(`/api/apps/${app.id}/page`, { method: "PATCH", json: { title: "x" } })).rejects.toThrow(
      "404",
    );
    // Local files the user opens (dropped on Rune Browser, from a chat) are web tabs; other schemes aren't.
    const file = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "file:///tmp/report.pdf" },
    });
    expect(file.url).toBe("file:///tmp/report.pdf");
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file://host/share"])
      await expect(server.api("/api/apps", { method: "POST", json: { kind: "web", url } })).rejects.toThrow("400");
  });

  test("site customizations are stored per host and broadcast", async () => {
    const socket = new Socket(server.wsUrl);
    const messages: TopicMessage[] = [];
    socket.subscribe("sites", (msg) => messages.push(msg));
    await new Promise<void>((resolve) => socket.onConnection((c) => c && resolve()));
    await Bun.sleep(50);

    const saved = await server.api<SiteOverride>("/api/sites/example.com", {
      method: "PUT",
      json: { css: "h1 { color: red }" },
    });
    expect(saved).toMatchObject({ host: "example.com", css: "h1 { color: red }", js: "", enabled: true });
    const toggled = await server.api<SiteOverride>("/api/sites/example.com", {
      method: "PUT",
      json: { enabled: false },
    });
    expect(toggled).toMatchObject({ css: "h1 { color: red }", enabled: false });
    expect((await server.api<SiteOverride[]>("/api/sites")).map((o) => o.host)).toEqual(["example.com"]);

    for (let i = 0; i < 50 && messages.length < 2; i++) await Bun.sleep(20);
    expect(messages.filter((m) => m.type === "site" && m.host === "example.com").length).toBe(2);

    await server.api("/api/sites/example.com", { method: "DELETE" });
    expect(await server.api("/api/sites/example.com")).toBeNull();
    socket.close();
  });

  test("websites can't change customizations", async () => {
    const res = await fetch(`${server.url}/api/sites/evil.com`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.com",
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ js: "alert(1)" }),
    });
    expect(res.status).toBe(403);
  });

  test("the API needs the token", async () => {
    expect((await fetch(`${server.url}/api/apps`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/apps`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });
});
