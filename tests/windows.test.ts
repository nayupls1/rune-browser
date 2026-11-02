// Windows (shared/windows.ts, main/windows.ts): what comes back at startup, where
// tabs go when windows close or are forgotten, moving tabs between windows,
// private windows' tabs (web only, no agents, deleted with their window), and
// agents' page requests going to the window a tab is in (Hub.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { AppSummary, AppDetail, WorkspaceInfo } from "../src/shared/api";
import { shareRefusal } from "../src/shared/api";
import { make as makeHub } from "../src/server/Hub";
import {
  CLOSED_WINDOWS_MAX,
  isPrivateWindow,
  newWindowId,
  parseWindowsFile,
  startupPlan,
  tabFate,
  trimClosed,
  WINDOW_ID_PATTERN,
  type SavedWindow,
  type TabFate,
} from "../src/shared/windows";
import { startServer } from "./lib/server";

const saved = (id: string, extra: Partial<SavedWindow> = {}): SavedWindow => ({
  id,
  bounds: { width: 1000, height: 700 },
  maximized: false,
  ...extra,
});

describe("window ids and windows.json", () => {
  test("ids say whether a window is private", () => {
    const normal = newWindowId();
    const priv = newWindowId(true);
    expect(WINDOW_ID_PATTERN.test(normal)).toBe(true);
    expect(WINDOW_ID_PATTERN.test(priv)).toBe(true);
    expect(isPrivateWindow(normal)).toBe(false);
    expect(isPrivateWindow(priv)).toBe(true);
    expect(isPrivateWindow(null)).toBe(false);
    expect(newWindowId()).not.toBe(normal);
  });

  test("a saved file keeps only valid, normal windows, each once", () => {
    const file = parseWindowsFile({
      version: 1,
      open: [
        saved("w-a", { maximized: true, bounds: { x: 10, y: 20, width: 900, height: 600 } }),
        saved("private-b"),
        { id: "w-c", bounds: { width: 10, height: 10 } },
        { id: "../evil", bounds: { width: 900, height: 600 } },
        "nonsense",
      ],
      closed: [saved("w-a"), saved("w-d", { closedAt: 5 })],
    });
    expect(file.open.map((w) => w.id)).toEqual(["w-a"]);
    expect(file.open[0]).toEqual({ id: "w-a", bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true });
    expect(file.closed).toEqual([saved("w-d", { closedAt: 5 })]);
    expect(parseWindowsFile(null)).toEqual({ version: 1, open: [], closed: [] });
  });
});

describe("startup", () => {
  test("the first start opens one new window", () => {
    const plan = startupPlan({ version: 1, open: [], closed: [] }, "continue");
    expect(plan.open).toHaveLength(1);
    expect(isPrivateWindow(plan.open[0]!.id)).toBe(false);
  });

  test("continue: the windows come back as they were, closed ones stay reopenable", () => {
    const plan = startupPlan({ version: 1, open: [saved("w-a"), saved("w-b")], closed: [saved("w-c")] }, "continue");
    expect(plan.open.map((w) => w.id)).toEqual(["w-a", "w-b"]);
    expect(plan.closed.map((w) => w.id)).toEqual(["w-c"]);
    expect(plan.forget).toEqual([]);
  });

  test.each(["newTab", "pages"] as const)("%s: only the first window; the others become closed windows", (mode) => {
    const plan = startupPlan({ version: 1, open: [saved("w-a"), saved("w-b")], closed: [saved("w-c")] }, mode, 42);
    expect(plan.open.map((w) => w.id)).toEqual(["w-a"]);
    expect(plan.closed.map((w) => [w.id, w.closedAt])).toEqual([
      ["w-b", 42],
      ["w-c", undefined],
    ]);
  });

  test("only the newest closed windows are kept; the others are forgotten", () => {
    const closed = Array.from({ length: CLOSED_WINDOWS_MAX + 2 }, (_, i) => saved(`w-${i}`));
    const plan = trimClosed({ closed, forget: [] as string[] });
    expect(plan.closed).toHaveLength(CLOSED_WINDOWS_MAX);
    expect(plan.forget).toEqual([`w-${CLOSED_WINDOWS_MAX}`, `w-${CLOSED_WINDOWS_MAX + 1}`]);
  });
});

describe("where tabs go when the windows change", () => {
  const sync = { open: ["private-p", "w-a"], closed: ["w-c"], forget: ["w-f"] };
  test.each<[{ windowId: string | null; kind: "app" | "web" }, TabFate]>([
    [{ windowId: "w-a", kind: "web" as const }, "keep"],
    [{ windowId: "private-p", kind: "web" as const }, "keep"],
    [{ windowId: "private-gone", kind: "web" as const }, "delete"],
    [{ windowId: "w-c", kind: "app" as const }, "keep"],
    [{ windowId: "w-f", kind: "app" as const }, "close"],
    [{ windowId: "w-f", kind: "web" as const }, "delete"],
    // Unknown windows (or none): the first open normal window takes them in.
    [{ windowId: "w-unknown", kind: "web" as const }, { adopt: "w-a" }],
    [{ windowId: null, kind: "app" as const }, { adopt: "w-a" }],
  ])("%o → %o", (tab, fate) => {
    expect(tabFate(tab, sync)).toEqual(fate);
  });

  test("with no normal window open, tabs of unknown windows wait", () => {
    expect(tabFate({ windowId: null, kind: "web" }, { open: ["private-p"], closed: [], forget: [] })).toBe("keep");
  });
});

test("agents can't be shown a private tab", () => {
  const me = { id: "a", kind: "web" as const, workspaceId: "default" };
  const other = { id: "b", kind: "web" as const, workspaceId: "default", name: "Bank", private: false };
  expect(shareRefusal(me, other)).toBeNull();
  expect(shareRefusal(me, { ...other, private: true })).toBe("That tab doesn't exist anymore.");
});

describe("the server's windows", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const tab = (body: Record<string, unknown>) => server.api<AppSummary>("/api/apps", { method: "POST", json: body });
  const tabs = () => server.api<AppSummary[]>("/api/apps");
  const syncWindows = (open: string[], closed: string[] = [], forget: string[] = []) =>
    server.api<{ deleted: number; closed: number; adopted: number }>("/api/windows", {
      method: "POST",
      json: { open, closed, forget },
    });

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server?.stop());

  test("tabs belong to the window they're made in; private ones are web tabs only", async () => {
    const web = await tab({ kind: "web", url: "https://example.com/", windowId: "w-one" });
    expect(web.windowId).toBe("w-one");
    expect(web.private).toBe(false);
    const priv = await tab({ kind: "web", url: "https://example.org/", windowId: "private-one" });
    expect(priv.private).toBe(true);
    await expect(tab({ kind: "app", windowId: "private-one" })).rejects.toThrow("400");
    await expect(tab({ kind: "web", windowId: "not a window" })).rejects.toThrow("400");
  });

  test("agents don't work in private tabs", async () => {
    const priv = (await tabs()).find((t) => t.private)!;
    await expect(server.api(`/api/apps/${priv.id}/chat`, { method: "POST", json: { prompt: "hi" } })).rejects.toThrow(
      "Agents don't work in private windows",
    );
  });

  test("tabs move between windows of their kind, leaving their split view", async () => {
    const a = await tab({ kind: "web", url: "https://a.example/", windowId: "w-one" });
    const b = await tab({ kind: "web", url: "https://b.example/", windowId: "w-one" });
    const [space] = await server.api<WorkspaceInfo[]>("/api/workspaces");
    const split = { id: "s1", direction: "row", tabs: [a.id, b.id], sizes: [0.5, 0.5] };
    await server.api(`/api/workspaces/${space!.id}/splits`, { method: "PUT", json: { splits: [split] } });

    const moved = await server.api<AppSummary>(`/api/apps/${a.id}/window`, {
      method: "POST",
      json: { windowId: "w-two" },
    });
    expect(moved.windowId).toBe("w-two");
    const after = (await server.api<WorkspaceInfo[]>("/api/workspaces")).find((w) => w.id === space!.id)!;
    expect(after.splits).toEqual([]);

    await expect(
      server.api(`/api/apps/${a.id}/window`, { method: "POST", json: { windowId: "private-one" } }),
    ).rejects.toThrow("Tabs don't move between private and normal windows");
    const priv = (await tabs()).find((t) => t.private)!;
    await expect(
      server.api(`/api/apps/${priv.id}/window`, { method: "POST", json: { windowId: "w-one" } }),
    ).rejects.toThrow("400");
  });

  test("a sync deletes closed private windows' tabs, closes forgotten windows' and adopts the rest", async () => {
    const old = await tab({ kind: "web", url: "https://old.example/", windowId: "w-forgotten" });
    const oldApp = await tab({ kind: "app", windowId: "w-forgotten" });
    const stray = await tab({ kind: "web", url: "https://stray.example/", windowId: "w-unknown" });
    const kept = await tab({ kind: "web", url: "https://kept.example/", windowId: "w-closed" });

    const result = await syncWindows(["w-one", "w-two"], ["w-closed"], ["w-forgotten"]);
    expect(result.deleted).toBeGreaterThanOrEqual(2); // the private tab and the forgotten web tab
    const now = await tabs();
    expect(now.some((t) => t.private)).toBe(false);
    expect(now.some((t) => t.id === old.id)).toBe(false);
    // An app with nothing built yet has nothing to keep; it's gone too.
    expect(now.some((t) => t.id === oldApp.id)).toBe(false);
    expect(now.find((t) => t.id === stray.id)?.windowId).toBe("w-one");
    expect(now.find((t) => t.id === kept.id)?.windowId).toBe("w-closed");
  });

  test("a tab made without a window (a scheduled run) goes to the first open window", async () => {
    await syncWindows(["w-two", "w-one"]);
    const made = await tab({ kind: "web", url: "https://later.example/" });
    expect(made.windowId).toBe("w-two");
    const detail = await server.api<AppDetail>(`/api/apps/${made.id}`);
    expect(detail.windowId).toBe("w-two");
  });
});

describe("the hub sends agents' page requests to the window with the tab", () => {
  /** A fake WebSocket connection: what the hub sends, and a way to send to it. */
  function connection() {
    const sent: { type: string; id?: number; method?: string; params?: unknown }[] = [];
    const inbox: string[] = [];
    let wake: (() => void) | undefined;
    const socket = {
      writer: Effect.succeed({ write: (text: string) => Effect.sync(() => void sent.push(JSON.parse(text))) }),
      reader: Effect.succeed({
        pull: Effect.promise(async () => {
          while (!inbox.length) await new Promise<void>((r) => (wake = r));
          return inbox.splice(0) as [string, ...string[]];
        }),
      }),
    };
    return {
      socket: socket as never,
      sent,
      send: (msg: unknown) => {
        inbox.push(JSON.stringify(msg));
        wake?.();
      },
    };
  }

  test("by the tabs each window reported; requests about no tab never go to a private window", async () => {
    const hub = Effect.runSync(makeHub);
    const normal = connection();
    const priv = connection();
    Effect.runFork(hub.serve(normal.socket, { renderer: true, window: "w-a" }));
    Effect.runFork(hub.serve(priv.socket, { renderer: true, window: "private-b" }));
    await Bun.sleep(20);
    normal.send({ type: "tabs", ids: ["tab-1"] });
    priv.send({ type: "tabs", ids: ["tab-2"] });
    await Bun.sleep(20);

    const ask = (params: unknown) => {
      const done = Effect.runPromise(Effect.result(hub.rpc("page.info", params, 1000)));
      return done;
    };
    const answer = async (conn: ReturnType<typeof connection>) => {
      await Bun.sleep(20);
      const call = conn.sent.findLast((m) => m.type === "rpc")!;
      conn.send({ type: "rpc-result", id: call.id, result: { from: conn === normal ? "normal" : "private" } });
    };

    let pending = ask({ tabId: "tab-2" });
    await answer(priv);
    expect(await pending).toMatchObject({ _tag: "Success", success: { from: "private" } });

    pending = ask({ tabId: "tab-1" });
    await answer(normal);
    expect(await pending).toMatchObject({ _tag: "Success", success: { from: "normal" } });

    // No tab, or one no window has: the newest normal window, never the private one.
    pending = ask({});
    await answer(normal);
    expect(await pending).toMatchObject({ _tag: "Success", success: { from: "normal" } });
    expect(priv.sent.filter((m) => m.type === "rpc")).toHaveLength(1);
  });
});
