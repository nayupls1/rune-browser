// Tabs' own icons: what the user picks (a Lucide icon, an emoji or an image),
// and that a copy of a tab keeps it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { DEFAULT_WORKSPACE, type AppSummary } from "../src/shared/api";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { core } from "../src/server/services";
import { startServer } from "./lib/server";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const pngUrl = `data:image/png;base64,${PNG.toString("base64")}`;

describe("the user's icon", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-icons-db-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a copy keeps it; resetting goes back to the default", async () => {
    const icons = await runtime.runPromise(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const tab = yield* apps.create(DEFAULT_WORKSPACE, "https://example.com/");
        const seen: (string | null | undefined)[] = [];
        seen.push((yield* apps.setIcon(tab.id, "🐢"))?.icon);
        seen.push((yield* apps.duplicate(tab.id))?.icon);
        seen.push((yield* apps.setIcon(tab.id, null))?.icon);
        return seen;
      }),
    );
    expect(icons).toEqual(["🐢", "🐢", null]);
  });
});

describe("PUT /api/apps/:id/icon", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let tab: AppSummary;
  beforeAll(async () => {
    server = await startServer();
    tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { url: "https://example.com/" },
    });
  });
  afterAll(() => server.stop());

  const put = (icon: string | null) =>
    server.api<AppSummary>(`/api/apps/${tab.id}/icon`, { method: "PUT", json: { icon } });

  test("takes a Lucide icon, an emoji or a small image", async () => {
    expect((await put("rocket")).icon).toBe("rocket");
    expect((await put("🦊")).icon).toBe("🦊");
    expect((await put(pngUrl)).icon).toBe(pngUrl);
    expect((await put(null)).icon).toBeNull();
  });

  test("refuses anything else", async () => {
    await expect(put("not-an-icon-name")).rejects.toThrow("400");
    await expect(put("hello")).rejects.toThrow("400");
    await expect(put("<img src=x onerror=alert(1)>🦊")).rejects.toThrow("400");
    await expect(put("data:text/html;base64,PGI+aGk8L2I+")).rejects.toThrow("400");
    await expect(put("data:image/png;base64,abc def")).rejects.toThrow("400");
    await expect(put(`data:image/png;base64,${"A".repeat(200_000)}`)).rejects.toThrow("400");
    await expect(server.api(`/api/apps/nope/icon`, { method: "PUT", json: { icon: "rocket" } })).rejects.toThrow("404");
  });
});
