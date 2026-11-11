// Tab cleanup against the real server: which tabs are idle long enough to close
// (Tabs.idle, GET /api/apps/idle), when they were last used (POST /api/apps/used,
// kept in the database), and closing one (POST /api/apps/:id/clean-up). What only
// a window knows (on screen, sound, typed input) is left out in the renderer
// (lib/cleanup.ts) and checked by e2e. No model is called.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, type AppSummary, type AuditEntry, type WorkspaceInfo } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

describe("tab cleanup", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  const newTab = (body: Record<string, unknown> = {}) =>
    server.api<AppSummary>("/api/apps", { method: "POST", json: { url: "https://example.com/page", ...body } });
  /** Pretends a tab was last used this many hours ago. */
  const usedHoursAgo = (id: string, hours: number) => {
    const db = new Database(join(server.dataDir, "rune.sqlite"));
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.run("UPDATE apps SET last_used_at = ? WHERE id = ?", [
        new Date(Date.now() - hours * 3_600_000).toISOString(),
        id,
      ]);
    } finally {
      db.close();
    }
  };
  const idle = () => server.api<string[]>("/api/apps/idle");
  const setCloseAfter = async (hours: number) => {
    const settings = await server.api<Settings>("/api/settings");
    await server.api("/api/settings", {
      method: "PUT",
      json: { ...settings, tabs: { ...settings.tabs, closeAfterHours: hours } },
    });
  };

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("off by default: no tab is idle, however old", async () => {
    const tab = await newTab();
    usedHoursAgo(tab.id, 24 * 365);
    expect((await server.api<Settings>("/api/settings")).tabs.closeAfterHours).toBe(0);
    expect(await idle()).toEqual([]);
    await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
  });

  test("tabs unused for longer than the setting are idle; using one counts", async () => {
    await setCloseAfter(24);
    const old = await newTab();
    const recent = await newTab();
    const fresh = await newTab();
    usedHoursAgo(old.id, 25);
    usedHoursAgo(recent.id, 23);
    expect(await idle()).toEqual([old.id]);
    // On screen in a window: used now.
    await server.api("/api/apps/used", { method: "POST", json: { ids: [old.id] } });
    expect(await idle()).toEqual([]);
    for (const tab of [old, recent, fresh]) await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
  });

  test("never pinned or private tabs, nor tabs a scheduled task runs in", async () => {
    const pinned = await newTab();
    await server.api(`/api/apps/${pinned.id}/pinned`, { method: "PUT", json: { pinned: true } });
    const privateTab = await newTab({ windowId: "private-test" });
    const scheduled = await newTab();
    const plain = await newTab();
    for (const tab of [pinned, privateTab, scheduled, plain]) usedHoursAgo(tab.id, 100);
    await server.api("/api/schedules", {
      method: "POST",
      json: {
        name: "Morning check",
        trigger: { type: "cron", cron: "0 8 * * *" },
        prompt: "Check the page",
        target: { workspaceId: DEFAULT_WORKSPACE, tabId: scheduled.id, url: null },
        agent: null,
        notify: "failure",
        timeoutSec: 300,
      },
    });
    expect(await idle()).toEqual([plain.id]);
    for (const tab of [pinned, privateTab, scheduled, plain])
      await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
  });

  test("a workspace's own setting wins over the global one", async () => {
    const work = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Work" } });
    const setWorkspace = (closeAfterHours: number | null) =>
      server.api(`/api/workspaces/${work.id}`, {
        method: "PATCH",
        json: { settings: { ...work.settings, closeAfterHours } },
      });
    const inWork = await newTab({ workspaceId: work.id });
    const inPersonal = await newTab();
    usedHoursAgo(inWork.id, 30);
    usedHoursAgo(inPersonal.id, 30);
    await setWorkspace(0);
    expect(await idle()).toEqual([inPersonal.id]);
    await setWorkspace(72);
    expect(await idle()).toEqual([inPersonal.id]);
    usedHoursAgo(inWork.id, 80);
    expect((await idle()).sort()).toEqual([inPersonal.id, inWork.id].sort());
    // Off globally, on in the workspace.
    await setCloseAfter(0);
    await setWorkspace(12);
    expect(await idle()).toEqual([inWork.id]);
    await setCloseAfter(24);
    await setWorkspace(null);
    for (const tab of [inWork, inPersonal]) await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
  });

  test("closing an idle tab: checked again, recorded, and its pages stay in History", async () => {
    const tab = await newTab({ url: "https://example.com/kept-in-history" });
    // Not idle (used just now): refused.
    await expect(server.api(`/api/apps/${tab.id}/clean-up`, { method: "POST" })).rejects.toThrow("409");
    usedHoursAgo(tab.id, 48);
    expect(await server.api(`/api/apps/${tab.id}/clean-up`, { method: "POST" })).toEqual({ closed: true });
    expect((await server.api<AppSummary[]>("/api/apps")).some((t) => t.id === tab.id)).toBe(false);
    const audit = await server.api<AuditEntry[]>("/api/audit");
    expect(audit.find((e) => e.action === "tab.cleanup")).toMatchObject({ actor: "rune", actorLabel: "Tab cleanup" });
    const visits = await server.api<{ url: string }[]>("/api/visits");
    expect(visits.some((v) => v.url === "https://example.com/kept-in-history")).toBe(true);
    await expect(server.api(`/api/apps/${tab.id}/clean-up`, { method: "POST" })).rejects.toThrow("404");
  });
});

describe("tab cleanup on an existing profile", () => {
  test("tabs from before last use was kept count as used now when Rune Browser starts, not as unused since made", async () => {
    const first = await startServer();
    const tab = await first.api<AppSummary>("/api/apps", { method: "POST", json: { url: "https://example.com/" } });
    await first.kill();
    // An old profile: no last_used_at yet, and the tab made long ago.
    const db = new Database(join(first.dataDir, "rune.sqlite"));
    db.run("ALTER TABLE apps DROP COLUMN last_used_at");
    db.run("UPDATE apps SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [tab.id]);
    db.close();
    const again = await startServer({ dataDir: first.dataDir });
    try {
      const settings = await again.api<Settings>("/api/settings");
      await again.api("/api/settings", {
        method: "PUT",
        json: { ...settings, tabs: { ...settings.tabs, closeAfterHours: 12 } },
      });
      expect(await again.api<string[]>("/api/apps/idle")).toEqual([]);
    } finally {
      await again.stop();
    }
  });
});
