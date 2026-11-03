import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  byDay,
  dayKey,
  dayLabel,
  displayUrl,
  isRecordable,
  rankSuggestions,
  samePage,
  type Visit,
  type VisitSuggestion,
} from "../src/shared/visits";
import { startServer } from "./lib/server";

describe("history helpers", () => {
  test("only websites and files are recorded; hashes aren't another page", () => {
    expect(isRecordable("https://example.com/")).toBe(true);
    expect(isRecordable("file:///home/me/notes.txt")).toBe(true);
    expect(isRecordable("about:blank")).toBe(false);
    expect(isRecordable("chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html")).toBe(false);
    expect(isRecordable("data:text/html,hi")).toBe(false);
    expect(samePage("https://a.com/x#one", "https://a.com/x#two")).toBe(true);
    expect(samePage("https://a.com/x", "https://a.com/y")).toBe(false);
    expect(displayUrl("https://example.com/")).toBe("example.com");
    expect(displayUrl("https://example.com/docs/")).toBe("example.com/docs/");
  });

  test("visits are grouped by local day, labelled Today and Yesterday", () => {
    const now = new Date(2026, 10, 2, 15, 0);
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();
    const days = byDay([
      { visitedAt: at(2, 14) },
      { visitedAt: at(2, 9) },
      { visitedAt: at(1, 22) },
      { visitedAt: at(29, 8) },
    ]);
    expect(days.map((d) => d.visits.length)).toEqual([2, 1, 1]);
    expect(days[0]!.key).toBe(dayKey(at(2, 0)));
    expect(dayLabel(at(2, 14), now)).toStartWith("Today");
    expect(dayLabel(at(1, 22), now)).toStartWith("Yesterday");
    expect(dayLabel(at(29, 8), now)).not.toContain("Today");
  });

  test("suggestions: the site being typed first, then titles, then often and recently visited", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const page = (url: string, title: string, visits = 1, daysAgo = 1): VisitSuggestion => ({
      url,
      title,
      favicon: null,
      visits,
      lastVisit: new Date(now - daysAgo * 86400_000).toISOString(),
    });
    const ranked = rankSuggestions(
      "git",
      [
        page("https://example.com/blog/learning-git", "Learning git", 3),
        page("https://news.example.com/", "Something about digital things", 30),
        page("https://github.com/", "GitHub", 1, 10),
        page("https://www.gitlab.com/", "GitLab", 1, 20),
      ],
      now,
    );
    expect(ranked.map((p) => p.url)).toEqual([
      "https://github.com/",
      "https://www.gitlab.com/",
      "https://example.com/blog/learning-git",
      "https://news.example.com/",
    ]);
    // More visits win between otherwise equal pages.
    const often = rankSuggestions(
      "doc",
      [page("https://a.com/doc", "Doc", 1), page("https://b.com/doc", "Doc", 9)],
      now,
    );
    expect(often[0]!.url).toBe("https://b.com/doc");
  });
});

describe("browsing history", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let workspace: string;
  beforeAll(async () => {
    server = await startServer();
    workspace = (await server.api<{ id: string }[]>("/api/workspaces"))[0]!.id;
  });
  afterAll(() => server.stop());

  const newTab = (url?: string, workspaceId = workspace) =>
    server.api<{ id: string }>("/api/apps", { method: "POST", json: { kind: "web", url, workspaceId } });
  const report = (id: string, page: { url?: string; title?: string; favicon?: string | null }) =>
    server.api(`/api/apps/${id}/page`, { method: "PATCH", json: page });
  const visits = (query = `workspace=${workspace}`) => server.api<Visit[]>(`/api/visits?${query}`);

  test("navigation is recorded with title and icon; hashes, reloads and other tabs' pages aren't new visits", async () => {
    const tab = await newTab("https://example.com/");
    await report(tab.id, { url: "https://example.com/" });
    await report(tab.id, { title: "Example Domain", favicon: "https://example.com/favicon.ico" });
    await report(tab.id, { url: "https://example.com/docs", title: "Docs" });
    await report(tab.id, { url: "https://example.com/docs#install" });
    await report(tab.id, { url: "https://example.com/docs#install", title: "Docs – Install" });
    const list = await visits();
    expect(list.map((v) => [v.url, v.title])).toEqual([
      ["https://example.com/docs", "Docs – Install"],
      ["https://example.com/", "Example Domain"],
    ]);
    expect(list[1]!.favicon).toBe("https://example.com/favicon.ico");
    expect(list[0]!.tabId).toBe(tab.id);
    // Blank and internal pages aren't history.
    const blank = await newTab();
    await report(blank.id, { url: "about:blank", title: "" });
    expect((await visits()).length).toBe(2);
  });

  test("a page visited before has its title and icon until it reports them (back/forward cache)", async () => {
    const tab = await newTab();
    await report(tab.id, { url: "https://example.com/" });
    const [latest] = await visits();
    expect(latest).toMatchObject({
      tabId: tab.id,
      url: "https://example.com/",
      title: "Example Domain",
      favicon: "https://example.com/favicon.ico",
    });
  });

  test("a page without a title is a visit too, also when you move on quickly", async () => {
    const tab = await newTab("https://plain.test/data.json");
    await report(tab.id, { url: "https://plain.test/home" });
    await report(tab.id, { title: "Home" });
    const mine = (await visits()).filter((v) => v.tabId === tab.id);
    expect(mine.map((v) => [v.url, v.title])).toEqual([
      ["https://plain.test/home", "Home"],
      ["https://plain.test/data.json", ""],
    ]);
  });

  test("search, paging and suggestions", async () => {
    const tab = await newTab();
    for (const [url, title] of [
      ["https://github.com/", "GitHub"],
      ["https://news.ycombinator.com/", "Hacker News"],
      ["https://github.com/oven-sh/bun", "oven-sh/bun: Incredibly fast JavaScript runtime"],
    ] as const)
      await report(tab.id, { url, title });
    const found = await visits(`workspace=${workspace}&search=${encodeURIComponent("bun runtime")}`);
    expect(found.map((v) => v.url)).toEqual(["https://github.com/oven-sh/bun"]);
    // Case-insensitive beyond ASCII, in titles and in (encoded) addresses.
    await report(tab.id, { url: "https://de.example.com/%C3%BCber-uns", title: "ÜBER UNS – CAFÉ" });
    const search = (q: string) => visits(`workspace=${workspace}&search=${encodeURIComponent(q)}`);
    expect((await search("café")).map((v) => v.title)).toEqual(["ÜBER UNS – CAFÉ"]);
    expect((await search("über-uns")).length).toBe(1);
    await report(tab.id, { url: "https://github.com/", title: "GitHub" });
    const first = await visits(`workspace=${workspace}&limit=2`);
    const next = await visits(`workspace=${workspace}&limit=2&before=${first.at(-1)!.id}`);
    expect(first.length).toBe(2);
    expect(next[0]!.id).toBeLessThan(first[1]!.id);

    const suggested = await server.api<VisitSuggestion[]>(`/api/visits/suggest?workspace=${workspace}&q=git`);
    expect(suggested[0]).toMatchObject({ url: "https://github.com/", title: "GitHub", visits: 2 });
    expect(suggested.map((s) => s.url)).toContain("https://github.com/oven-sh/bun");
    expect(suggested.map((s) => s.url)).not.toContain("https://news.ycombinator.com/");
  });

  test("each workspace has its own history; deleting single visits, a time range and everything", async () => {
    const other = await server.api<{ id: string }>("/api/workspaces", { method: "POST", json: { name: "Work" } });
    const tab = await newTab("https://work.example.com/", other.id);
    await report(tab.id, { title: "Work" });
    expect((await visits(`workspace=${other.id}`)).map((v) => v.url)).toEqual(["https://work.example.com/"]);
    expect((await visits()).some((v) => v.url === "https://work.example.com/")).toBe(false);
    expect((await visits("")).some((v) => v.url === "https://work.example.com/")).toBe(true);
    const suggested = await server.api<VisitSuggestion[]>(`/api/visits/suggest?workspace=${workspace}&q=work`);
    expect(suggested).toEqual([]);

    // One visit; another workspace's visit can't be deleted through this one.
    const [latest] = await visits();
    const workVisit = (await visits(`workspace=${other.id}`))[0]!;
    const { removed } = await server.api<{ removed: number }>(`/api/visits/delete?workspace=${workspace}`, {
      method: "POST",
      json: { ids: [latest!.id, workVisit.id] },
    });
    expect(removed).toBe(1);
    expect((await visits()).some((v) => v.id === latest!.id)).toBe(false);

    // The last hour: everything here is newer.
    const before = (await visits()).length;
    const cleared = await server.api<{ removed: number }>(`/api/visits/clear?workspace=${workspace}`, {
      method: "POST",
      json: { since: new Date(Date.now() - 3600_000).toISOString() },
    });
    expect(cleared.removed).toBe(before);
    expect(await visits()).toEqual([]);
    expect((await visits(`workspace=${other.id}`)).length).toBe(1);

    // A range in the future removes nothing; all time in every workspace removes the rest.
    await report(tab.id, { url: "https://work.example.com/later", title: "Later" });
    const future = await server.api<{ removed: number }>(`/api/visits/clear?workspace=${other.id}`, {
      method: "POST",
      json: { since: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(future.removed).toBe(0);
    await server.api("/api/visits/clear", { method: "POST", json: { since: null } });
    expect(await visits("")).toEqual([]);

    // Clearing is in the activity log.
    const audit = await server.api<{ action: string }[]>("/api/audit");
    expect(audit.some((e) => e.action === "history.clear")).toBe(true);
  });

  test("private windows record no history", async () => {
    const tab = await server.api<{ id: string; private: boolean }>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://private.example.com/", workspaceId: workspace, windowId: "private-test1" },
    });
    expect(tab.private).toBe(true);
    await report(tab.id, { url: "https://private.example.com/next", title: "Secret" });
    expect((await visits("")).some((v) => v.url.includes("private.example.com"))).toBe(false);
  });

  test("history stays when a tab closes, and goes with its workspace", async () => {
    const space = await server.api<{ id: string }>("/api/workspaces", { method: "POST", json: { name: "Temp" } });
    const tab = await newTab("https://temp.example.com/", space.id);
    await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
    expect((await visits(`workspace=${space.id}`)).length).toBe(1);
    await server.api(`/api/workspaces/${space.id}`, { method: "DELETE" });
    expect((await visits("")).some((v) => v.workspaceId === space.id)).toBe(false);
  });
});
