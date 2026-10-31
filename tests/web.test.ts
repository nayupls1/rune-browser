import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Socket, type TopicMessage } from "../src/shared/hub";
import type { AppSummary, PageContext, SiteOverride } from "../src/shared/api";
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
    expect(normalizeUrl("solid.js signals", "google")).toBe("https://www.google.com/search?q=solid.js%20signals");
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
  test("runs the code and reports what it throws", () => {
    // Plain-JS stand-ins for the page APIs the wrapper touches.
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, MutationObserver: g.MutationObserver, console: g.console };
    const els = [{ n: 1 }, { n: 2 }];
    g.document = { querySelectorAll: () => els, documentElement: {} };
    g.MutationObserver = class {
      observe() {}
    };
    g.console = { ...console, error: () => {} };
    try {
      const seen: number[] = [];
      g.__seen = seen;
      expect(eval(overrideScript(`onElement(".x", (el) => __seen.push(el.n));`))).toBeNull();
      expect(seen).toEqual([1, 2]);
      expect(eval(overrideScript(`throw new Error("nope")`))).toContain("nope");
    } finally {
      Object.assign(g, saved);
      delete g.__seen;
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
