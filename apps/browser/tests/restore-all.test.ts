// Restoring everything to one moment (History page): settings, site
// customizations and the workspace's apps go back together; what didn't exist
// yet stays.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSummary, HistoryEntry } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.stop());

test("settings, sites and apps back to one snapshot", async () => {
  const snapshot = (target: string) =>
    server.api<HistoryEntry | undefined>("/api/history", { method: "POST", json: { target } });
  const settings = () => server.api<Settings>("/api/settings");
  const app = await server.api<AppSummary>("/api/apps", { method: "POST" });
  await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
  await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "stop" } });
  await server.api("/api/settings", { method: "PUT", json: { ...(await settings()), theme: { mode: "light" } } });
  await server.api("/api/sites/example.com", { method: "PUT", json: { css: "body { color: red }", js: "" } });
  // The moment to go back to: the newest snapshot so far.
  const point = (await server.api<HistoryEntry[]>("/api/history?limit=1"))[0]!;

  // Later: a file in the app, another theme, other CSS, and an app made afterwards.
  const dir = join(server.dataDir, "apps", app.id);
  writeFileSync(join(dir, "later.txt"), "added later");
  await snapshot(`app:${app.id}`);
  // (Changes of the same kind in a row are folded into one snapshot, so these are other kinds.)
  await server.api("/api/workspaces/default", { method: "PATCH", json: { name: "Renamed later" } });
  await server.api("/api/page-changes", {
    method: "POST",
    json: { title: "Later", scope: { type: "site", value: "example.com" }, action: "hide", selector: ".ad" },
  });
  const later = await server.api<AppSummary>("/api/apps", { method: "POST" });
  await server.api(`/api/apps/${later.id}/project`, { method: "POST", json: { preset: "api" } });
  await server.api(`/api/apps/${later.id}/runtime`, { method: "POST", json: { action: "stop" } });

  const { restored } = await server.api<{ restored: string[] }>(`/api/history/${point.id}/restore-all`, {
    method: "POST",
    json: { workspaceId: "default" },
  });
  expect(restored.sort()).toEqual([`app:${app.id}`, "settings", "sites"].sort());
  expect(existsSync(join(dir, "later.txt"))).toBe(false);
  expect((await server.api<{ name: string }[]>("/api/workspaces"))[0]!.name).toBe("Personal");
  expect(await server.api<unknown[]>("/api/page-changes")).toEqual([]);
  expect((await server.api<{ css: string }>("/api/sites/example.com")).css).toBe("body { color: red }");
  // Made afterwards: left alone.
  expect(existsSync(join(server.dataDir, "apps", later.id, "rune.json"))).toBe(true);
  // Already that way: nothing to do.
  expect(
    (await server.api<{ restored: string[] }>(`/api/history/${point.id}/restore-all`, { method: "POST", json: {} }))
      .restored,
  ).toEqual([]);
});
