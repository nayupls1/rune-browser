// Restoring everything to one moment (Snapshots page): settings and site
// customizations go back together.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HistoryEntry } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.stop());

test("settings and sites back to one snapshot", async () => {
  const settings = () => server.api<Settings>("/api/settings");
  await server.api("/api/settings", { method: "PUT", json: { ...(await settings()), theme: { mode: "light" } } });
  await server.api("/api/sites/example.com", { method: "PUT", json: { css: "body { color: red }", js: "" } });
  // The moment to go back to: the newest snapshot so far.
  const point = (await server.api<HistoryEntry[]>("/api/history?limit=1"))[0]!;

  // Later: another workspace name and a page change. (Changes of the same kind in a row are folded
  // into one snapshot, so these are other kinds.)
  await server.api("/api/workspaces/default", { method: "PATCH", json: { name: "Renamed later" } });
  await server.api("/api/page-changes", {
    method: "POST",
    json: { title: "Later", scope: { type: "site", value: "example.com" }, action: "hide", selector: ".ad" },
  });

  const { restored } = await server.api<{ restored: string[] }>(`/api/history/${point.id}/restore-all`, {
    method: "POST",
    json: {},
  });
  expect(restored.sort()).toEqual(["settings", "sites"]);
  expect((await server.api<{ name: string }[]>("/api/workspaces"))[0]!.name).toBe("Personal");
  expect(await server.api<unknown[]>("/api/page-changes")).toEqual([]);
  expect((await server.api<{ css: string }>("/api/sites/example.com")).css).toBe("body { color: red }");
  expect((await settings()).theme.mode).toBe("light");
  // Already that way: nothing to do.
  expect(
    (await server.api<{ restored: string[] }>(`/api/history/${point.id}/restore-all`, { method: "POST", json: {} }))
      .restored,
  ).toEqual([]);
});
