// Mods: packaging your customizations, sharing them as a code, reviewing,
// installing, turning off and removing them (everything they did goes back).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PageChange } from "../src/shared/api";
import {
  encodeShareCode,
  decodeShareCode,
  parseMod,
  reviewMod,
  type GalleryResult,
  type InstalledMod,
  type Mod,
  type ModReview,
} from "../src/shared/mods";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

const base = {
  format: "rune-mod",
  version: 1,
  id: "test-mod",
  name: "Test",
  description: "",
  author: "Ana",
  modVersion: "1",
  theme: null,
  extensions: [],
};

describe("the mod format", () => {
  test("checks and normalizes untrusted mods", () => {
    expect(
      parseMod({
        ...base,
        pageChanges: [
          { title: "Hide ads", scope: { type: "site", value: "example.com" }, action: "hide", selector: ".ad" },
        ],
      }),
    ).toMatchObject({
      mod: { id: "test-mod", pageChanges: [{ title: "Hide ads" }] },
    });
    expect(parseMod({ ...base, format: "other", pageChanges: [] })).toEqual({
      error: expect.stringContaining("isn't a Rune Browser mod"),
    });
    expect(parseMod({ ...base, version: 2 })).toEqual({ error: expect.stringContaining("newer Rune Browser") });
    expect(parseMod({ ...base, pageChanges: [] })).toEqual({ error: "The mod doesn't change anything." });
    expect(
      parseMod({
        ...base,
        pageChanges: [{ title: "x", scope: { type: "site", value: "bad host!" }, action: "hide", selector: "p" }],
      }),
    ).toEqual({ error: expect.stringContaining("Page change 1") });
    expect(parseMod({ ...base, pageChanges: [], extensions: [{ id: "../../etc", name: "x" }] })).toEqual({
      error: expect.stringContaining("Chrome Web Store id"),
    });
    expect(parseMod({ ...base, pageChanges: [], theme: { accent: "red" } })).toEqual({
      error: expect.stringContaining("theme is invalid"),
    });
  });

  test("the review says where it runs code, what it installs and what it restyles", () => {
    const review: ModReview = reviewMod(
      (
        parseMod({
          ...base,
          pageChanges: [
            { title: "Tracker", scope: { type: "pattern", value: "*" }, action: "script", value: "console.log(1)" },
            {
              title: "Sneaky",
              scope: { type: "site", value: "bank.example" },
              action: "insert",
              selector: "body",
              value: '<img src=x onerror="steal()">',
            },
            {
              title: "Bigger",
              scope: { type: "site", value: "news.example" },
              action: "style",
              selector: "p",
              value: "font-size: 18px",
            },
          ],
          extensions: [{ id: "a".repeat(32), name: "uBlock" }],
          theme: { mode: "dark" },
        }) as { mod: Mod }
      ).mod,
    );
    expect(review.permissions.map((p) => p.level)).toEqual(["danger", "warning", "info", "info"]);
    expect(review.permissions[0]!.text).toContain("every site, bank.example");
    expect(review.permissions[1]!.text).toContain("uBlock");
    expect(review.permissions[2]!.text).toContain("news.example");
    expect(review.changes[1]).toMatchObject({ where: "bank.example", code: '<img src=x onerror="steal()">' });
  });

  test("share codes round-trip; damaged ones are refused", async () => {
    const mod = (parseMod({ ...base, pageChanges: [], theme: { accent: "#123456" } }) as { mod: Mod }).mod;
    const code = await encodeShareCode(mod);
    expect(code).toStartWith("RUNE-MOD:");
    expect(await decodeShareCode(`  ${code.slice(0, 40)}\n${code.slice(40)}  `)).toEqual(mod);
    await expect(decodeShareCode(code.slice(0, -6))).rejects.toThrow("damaged");
    await expect(decodeShareCode("hello")).rejects.toThrow("isn't a mod");
  });
});

describe("mods on the server", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  const changes = () => server.api<PageChange[]>("/api/page-changes");
  const theme = async () => (await server.api<Settings>("/api/settings")).theme;

  test("package, share, review, install, turn off and on, remove", async () => {
    const mine = await server.api<PageChange>("/api/page-changes", {
      method: "POST",
      json: {
        title: "Greet",
        scope: { type: "site", value: "example.com" },
        action: "script",
        value: "document.title = 'hi'",
      },
    });
    await server.api("/api/settings", {
      method: "PUT",
      json: { ...(await server.api<Settings>("/api/settings")), theme: { mode: "dark", accent: "#00aa55" } },
    });
    const packaged = await server.api<Mod>("/api/mods/package", {
      method: "POST",
      json: {
        name: "My tweaks",
        description: "Mine",
        author: "Ana",
        pageChangeIds: [mine.id],
        theme: true,
        extensions: [],
      },
    });
    expect(packaged).toMatchObject({
      name: "My tweaks",
      theme: { mode: "dark", accent: "#00aa55" },
      pageChanges: [{ title: "Greet", action: "script" }],
    });
    expect(packaged.id).toMatch(/^my-tweaks-[0-9a-f]{6}$/);

    // Someone else's Rune Browser: here, the same one after removing the original change and theme.
    await server.api(`/api/page-changes/${mine.id}`, { method: "DELETE" });
    await server.api("/api/settings", {
      method: "PUT",
      json: { ...(await server.api<Settings>("/api/settings")), theme: { mode: "light" } },
    });
    const code = await encodeShareCode(packaged);
    const review = await server.api<{ mod: Mod; review: ModReview; installed: InstalledMod | null; source: string }>(
      "/api/mods/review",
      { method: "POST", json: { code } },
    );
    expect(review).toMatchObject({ source: "code", installed: null, mod: { id: packaged.id } });
    expect(review.review.permissions[0]).toMatchObject({
      level: "danger",
      text: expect.stringContaining("example.com"),
    });

    const installed = await server.api<InstalledMod>("/api/mods", { method: "POST", json: { code } });
    expect(installed).toMatchObject({ enabled: true, source: "code", installedExtensions: [] });
    expect((await changes()).map((c) => [c.title, c.modId, c.enabled])).toEqual([["Greet", packaged.id, true]]);
    expect(await theme()).toEqual({ mode: "dark", accent: "#00aa55" });

    await server.api(`/api/mods/${packaged.id}`, { method: "PATCH", json: { enabled: false } });
    expect((await changes()).map((c) => c.enabled)).toEqual([false]);
    expect(await theme()).toEqual({ mode: "light" });

    await server.api(`/api/mods/${packaged.id}`, { method: "PATCH", json: { enabled: true } });
    expect((await changes()).map((c) => c.enabled)).toEqual([true]);
    expect(await theme()).toEqual({ mode: "dark", accent: "#00aa55" });

    // An update replaces its changes instead of adding them again.
    await server.api("/api/mods", {
      method: "POST",
      json: {
        mod: {
          ...packaged,
          modVersion: "2",
          pageChanges: [
            ...packaged.pageChanges,
            { title: "Hide", scope: { type: "site", value: "example.com" }, action: "hide", selector: ".x" },
          ],
        },
      },
    });
    expect((await changes()).map((c) => c.title)).toEqual(["Greet", "Hide"]);
    expect((await server.api<InstalledMod[]>("/api/mods")).map((m) => [m.mod.id, m.mod.modVersion])).toEqual([
      [packaged.id, "2"],
    ]);

    // The user changes the theme themselves: removing the mod leaves theirs alone.
    await server.api("/api/settings", {
      method: "PUT",
      json: { ...(await server.api<Settings>("/api/settings")), theme: { mode: "dark", accent: "#ff0000" } },
    });
    const removed = await server.api<InstalledMod>(`/api/mods/${packaged.id}`, { method: "DELETE" });
    expect(removed.mod.id).toBe(packaged.id);
    expect(await changes()).toEqual([]);
    expect(await theme()).toEqual({ mode: "dark", accent: "#ff0000" });
    expect(await server.api<InstalledMod[]>("/api/mods")).toEqual([]);
  });

  test("records only the mod's own extensions; refuses broken mods", async () => {
    const ext = "b".repeat(32);
    const mod = { ...base, id: "ext-mod", pageChanges: [], extensions: [{ id: ext, name: "Helper" }] };
    await server.api("/api/mods", { method: "POST", json: { mod } });
    const recorded = await server.api<InstalledMod>("/api/mods/ext-mod/extensions", {
      method: "POST",
      json: { installed: [ext, "c".repeat(32)] },
    });
    expect(recorded.installedExtensions).toEqual([ext]);
    await server.api("/api/mods/ext-mod", { method: "DELETE" });

    const broken = {
      ...base,
      id: "broken",
      pageChanges: [{ title: "Bad", scope: { type: "site", value: "example.com" }, action: "script", value: "if (" }],
    };
    await expect(server.api("/api/mods", { method: "POST", json: { mod: broken } })).rejects.toThrow(/400 .*syntax/);
    await expect(
      server.api("/api/mods", { method: "POST", json: { url: "http://example.com/mod.json" } }),
    ).rejects.toThrow(/502 .*https/);
    await expect(server.api("/api/mods/nope", { method: "PATCH", json: { enabled: true } })).rejects.toThrow("404");
  });

  test("the gallery has Rune Browser's examples, and says which galleries failed", async () => {
    await server.api("/api/settings", {
      method: "PUT",
      json: {
        ...(await server.api<Settings>("/api/settings")),
        mods: { galleries: ["http://insecure.example/mods.json"] },
      },
    });
    const gallery = await server.api<GalleryResult>("/api/mods/gallery");
    expect(gallery.entries.filter((e) => e.gallery === "Rune Browser").length).toBeGreaterThanOrEqual(3);
    expect(gallery.errors).toEqual([
      { gallery: "http://insecure.example/mods.json", error: expect.stringContaining("https") },
    ]);
  });
});
