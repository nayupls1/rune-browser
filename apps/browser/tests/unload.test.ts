// Tab unloading: pinned tabs are kept loaded (the flag is saved with the tab;
// the renderer does the unloading), and the setting has sane bounds.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppSummary } from "../src/shared/api";
import { decodeSettings, defaultSettings } from "../src/shared/settings";
import { startServer } from "./lib/server";

describe("PUT /api/apps/:id/pinned", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("pins and unpins a tab; new tabs and copies aren't pinned", async () => {
    const tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com/" },
    });
    expect(tab.pinned).toBe(false);
    const pinned = await server.api<AppSummary>(`/api/apps/${tab.id}/pinned`, {
      method: "PUT",
      json: { pinned: true },
    });
    expect(pinned.pinned).toBe(true);
    const listed = await server.api<AppSummary[]>("/api/apps");
    expect(listed.find((t) => t.id === tab.id)?.pinned).toBe(true);
    const copy = await server.api<AppSummary>(`/api/apps/${tab.id}/duplicate`, { method: "POST" });
    expect(copy.pinned).toBe(false);
    expect(
      (await server.api<AppSummary>(`/api/apps/${tab.id}/pinned`, { method: "PUT", json: { pinned: false } })).pinned,
    ).toBe(false);
  });

  test("refuses bad input and unknown tabs", async () => {
    await expect(server.api("/api/apps/nope/pinned", { method: "PUT", json: { pinned: true } })).rejects.toThrow("404");
    const tab = await server.api<AppSummary>("/api/apps", { method: "POST", json: { kind: "web" } });
    await expect(server.api(`/api/apps/${tab.id}/pinned`, { method: "PUT", json: { pinned: "yes" } })).rejects.toThrow(
      "400",
    );
  });
});

test("idle tabs unload after 30 minutes by default; 0 turns it off; at most a day", () => {
  expect(defaultSettings().tabs.unloadAfterMinutes).toBe(30);
  expect(decodeSettings({ tabs: { unloadAfterMinutes: 0 } }).tabs.unloadAfterMinutes).toBe(0);
  expect(() => decodeSettings({ tabs: { unloadAfterMinutes: 24 * 60 + 1 } })).toThrow();
  expect(() => decodeSettings({ tabs: { unloadAfterMinutes: -1 } })).toThrow();
});
