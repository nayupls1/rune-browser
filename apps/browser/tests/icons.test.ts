// Tabs' own icons: what the user picks (a Lucide icon, an emoji or an image),
// what the agent may set, and images the agent takes from the project.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { DEFAULT_WORKSPACE, type AppSummary } from "../src/shared/api";
import { readIconFile } from "../src/server/agent/tools";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { core } from "../src/server/services";
import { startServer } from "./lib/server";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const pngUrl = `data:image/png;base64,${PNG.toString("base64")}`;

describe("icon files from the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-icons-"));
  const project = join(dir, "project");
  beforeAll(() => {
    mkdirSync(join(project, "public"), { recursive: true });
    writeFileSync(join(project, "public", "icon.png"), PNG);
    writeFileSync(
      join(project, "logo.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`,
    );
    writeFileSync(join(project, "fake.png"), "not a png");
    writeFileSync(join(project, "big.png"), Buffer.concat([PNG, Buffer.alloc(120_000)]));
    writeFileSync(join(dir, "secret.png"), PNG);
    symlinkSync(join(dir, "secret.png"), join(project, "link.png"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("images inside the project become data URLs", async () => {
    expect(await readIconFile(project, "public/icon.png")).toBe(pngUrl);
    expect(await readIconFile(project, "./logo.svg")).toStartWith("data:image/svg+xml;base64,");
  });

  test("anything else is refused", async () => {
    expect(await readIconFile(project, "../secret.png")).toEqual({ error: "../secret.png isn't inside the project." });
    expect(await readIconFile(project, join(dir, "secret.png"))).toMatchObject({
      error: expect.stringContaining("isn't inside"),
    });
    expect(await readIconFile(project, "link.png")).toMatchObject({ error: expect.stringContaining("isn't inside") });
    expect(await readIconFile(project, "fake.png")).toMatchObject({
      error: expect.stringContaining("isn't a valid PNG"),
    });
    expect(await readIconFile(project, "big.png")).toMatchObject({ error: expect.stringContaining("too big") });
    expect(await readIconFile(project, "missing.png")).toMatchObject({
      error: expect.stringContaining("doesn't exist"),
    });
    expect(await readIconFile(project, "notes.txt")).toMatchObject({ error: expect.stringContaining("use a PNG") });
  });
});

describe("the agent and the user's icon", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-icons-db-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("the agent sets the icon until the user picks one; resetting hands it back", async () => {
    const icons = await runtime.runPromise(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const app = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
        const seen: (string | null | undefined)[] = [];
        seen.push((yield* apps.setInfo(app.id, { icon: "wallet" }))?.icon);
        seen.push((yield* apps.setIcon(app.id, "🐢"))?.icon);
        seen.push((yield* apps.setInfo(app.id, { icon: "rocket" }))?.icon);
        // A copy keeps the user's choice.
        const copy = (yield* apps.duplicate(app.id))!;
        seen.push((yield* apps.setInfo(copy.id, { icon: "rocket" }))?.icon);
        seen.push((yield* apps.setIcon(app.id, null))?.icon);
        seen.push((yield* apps.setInfo(app.id, { icon: "rocket" }))?.icon);
        return seen;
      }),
    );
    expect(icons).toEqual(["wallet", "🐢", "🐢", "🐢", null, "rocket"]);
  });
});

describe("PUT /api/apps/:id/icon", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let tab: AppSummary;
  beforeAll(async () => {
    server = await startServer();
    tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com/" },
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
