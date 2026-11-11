// Tabs that survive a crash or a restart: the back/forward history kept with a tab (trimmed,
// never for private tabs) and Chromium's sad tab for a page whose process went away.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppSummary } from "../src/shared/api";
import { crashCode, describeCrash } from "../src/shared/loadErrors";
import { hasHistory, MAX_HISTORY, trimHistory, type TabHistory } from "../src/shared/tabHistory";
import { startServer } from "./lib/server";

const page = (n: number) => ({ url: `https://example.com/${n}`, title: `Page ${n}` });

describe("trimHistory", () => {
  test("keeps pages a tab can open again, and where it is", () => {
    const kept = trimHistory({
      entries: [
        { url: "about:blank", title: "" },
        page(1),
        { url: "data:text/html,hi", title: "data" },
        page(2),
        { url: "file:///home/me/notes.html", title: "notes" },
        { url: "chrome-extension://abc/options.html", title: "Options" },
      ],
      index: 3,
    });
    expect(kept).toEqual({
      entries: [
        page(1),
        page(2),
        { url: "file:///home/me/notes.html", title: "notes" },
        {
          url: "chrome-extension://abc/options.html",
          title: "Options",
        },
      ],
      index: 1,
    });
  });

  test("a current page that can't be kept: the closest one before it", () => {
    expect(trimHistory({ entries: [page(1), { url: "about:blank", title: "" }, page(2)], index: 1 })?.index).toBe(0);
    expect(trimHistory({ entries: [{ url: "about:blank", title: "" }, page(2)], index: 0 })?.index).toBe(0);
    expect(trimHistory({ entries: [{ url: "about:blank", title: "" }], index: 0 })).toBeNull();
    expect(trimHistory(null)).toBeNull();
    expect(trimHistory({ entries: "nope", index: 0 } as unknown as TabHistory)).toBeNull();
  });

  test("the tab's saved address wins: a new page after the current one, forward pages dropped", () => {
    const history = { entries: [page(1), page(2), page(3)], index: 1 };
    expect(trimHistory(history, page(2).url)).toEqual(history);
    expect(trimHistory(history, page(9).url)).toEqual({
      entries: [page(1), page(2), { url: page(9).url, title: "" }],
      index: 2,
    });
    expect(trimHistory(null, page(9).url)).toEqual({ entries: [{ url: page(9).url, title: "" }], index: 0 });
  });

  test(`at most ${MAX_HISTORY} pages, around the current one (more of them back)`, () => {
    const entries = Array.from({ length: 120 }, (_, i) => page(i));
    const atEnd = trimHistory({ entries, index: 119 })!;
    expect(atEnd.entries).toHaveLength(MAX_HISTORY);
    expect(atEnd.entries.at(-1)).toEqual(page(119));
    expect(atEnd.index).toBe(MAX_HISTORY - 1);
    const middle = trimHistory({ entries, index: 60 })!;
    expect(middle.entries).toHaveLength(MAX_HISTORY);
    expect(middle.entries[middle.index]).toEqual(page(60));
    const back = middle.index;
    const forward = middle.entries.length - 1 - middle.index;
    expect(back).toBeGreaterThan(forward);
    expect(forward).toBeGreaterThan(0);
    const start = trimHistory({ entries, index: 0 })!;
    expect(start.index).toBe(0);
    expect(start.entries[0]).toEqual(page(0));
  });

  test("long titles are shortened, long addresses dropped", () => {
    const kept = trimHistory({
      entries: [
        { url: "https://a.example/", title: "x".repeat(5000) },
        { url: `https://b.example/${"y".repeat(9000)}`, title: "" },
      ],
      index: 0,
    })!;
    expect(kept.entries).toHaveLength(1);
    expect(kept.entries[0]!.title.length).toBe(300);
  });

  test("only more than one page is worth restoring", () => {
    expect(hasHistory({ entries: [page(1)], index: 0 })).toBe(false);
    expect(hasHistory({ entries: [page(1), page(2)], index: 1 })).toBe(true);
    expect(hasHistory(null)).toBe(false);
  });
});

describe("crashed pages (Aw, Snap!)", () => {
  test("Chromium's words, with the error code", () => {
    expect(describeCrash("killed", 9, "linux")).toEqual({
      kind: "crash",
      title: "Aw, Snap!",
      message: "Something went wrong while displaying this webpage.",
      code: "Error code: SIGKILL",
      tips: undefined,
    });
    expect(describeCrash("oom", 0, "linux")!.code).toBe("Error code: Out of Memory");
    expect(describeCrash("crashed", 11, "linux")!.code).toBe("Error code: SIGSEGV");
  });

  test("a page that simply ended isn't a crash", () => {
    expect(describeCrash("clean-exit", 0, "linux")).toBeNull();
  });

  test("crashing again soon after a reload lists what to try", () => {
    expect(describeCrash("crashed", 11, "linux", true)!.tips).toEqual([
      "Closing other tabs, extensions, or apps",
      "Restarting Rune Browser",
      "Restarting your computer",
    ]);
  });

  test("error codes per platform", () => {
    expect(crashCode("killed", 15, "linux")).toBe("SIGTERM");
    expect(crashCode("crashed", 10, "linux")).toBe("SIGUSR1");
    expect(crashCode("crashed", 10, "darwin")).toBe("SIGBUS");
    expect(crashCode("crashed", 5, "darwin")).toBe("SIGTRAP");
    expect(crashCode("abnormal-exit", 9, "linux")).toBe("9");
    expect(crashCode("crashed", 0xc0000005, "win32")).toBe("STATUS_ACCESS_VIOLATION");
    expect(crashCode("crashed", -1073741819, "win32")).toBe("STATUS_ACCESS_VIOLATION");
    expect(crashCode("killed", 1, "win32")).toBe("RESULT_CODE_KILLED");
    expect(crashCode("crashed", 0xc0001234, "win32")).toBe("0xC0001234");
    expect(crashCode("crashed", 0xe0000008, "win32")).toBe("Out of Memory");
    expect(crashCode("memory-eviction", 0, "darwin")).toBe("Out of Memory");
  });
});

describe("/api/apps/:id/history", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  const history = { entries: [page(1), page(2), page(3)], index: 2 };

  test("kept with the tab, trimmed, and copied with it", async () => {
    const tab = await server.api<AppSummary>("/api/apps", { method: "POST", json: { url: page(3).url } });
    expect(await server.api(`/api/apps/${tab.id}/history`)).toEqual({ history: null });
    await server.api(`/api/apps/${tab.id}/history`, {
      method: "PUT",
      json: { history: { ...history, entries: [{ url: "about:blank", title: "" }, ...history.entries], index: 3 } },
    });
    expect(await server.api(`/api/apps/${tab.id}/history`)).toEqual({ history });
    const copy = await server.api<AppSummary>(`/api/apps/${tab.id}/duplicate`, { method: "POST" });
    expect(await server.api(`/api/apps/${copy.id}/history`)).toEqual({ history });
    await server.api(`/api/apps/${tab.id}/history`, { method: "PUT", json: { history: null } });
    expect(await server.api(`/api/apps/${tab.id}/history`)).toEqual({ history: null });
  });

  test("private tabs keep none", async () => {
    const tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { url: page(3).url, windowId: "private-history" },
    });
    await server.api(`/api/apps/${tab.id}/history`, { method: "PUT", json: { history } });
    expect(await server.api(`/api/apps/${tab.id}/history`)).toEqual({ history: null });
  });

  test("refuses bad input and unknown tabs", async () => {
    await expect(server.api("/api/apps/nope/history")).rejects.toThrow("404");
    await expect(server.api("/api/apps/nope/history", { method: "PUT", json: { history } })).rejects.toThrow("404");
    const tab = await server.api<AppSummary>("/api/apps", { method: "POST", json: {} });
    await expect(
      server.api(`/api/apps/${tab.id}/history`, { method: "PUT", json: { history: { entries: "x", index: 0 } } }),
    ).rejects.toThrow("400");
    const tooMany = Array.from({ length: 201 }, (_, i) => page(i));
    await expect(
      server.api(`/api/apps/${tab.id}/history`, { method: "PUT", json: { history: { entries: tooMany, index: 0 } } }),
    ).rejects.toThrow("400");
  });
});
