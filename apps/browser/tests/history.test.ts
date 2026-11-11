// Snapshots, diffs, undo and restore against the real server: the site
// customizations and the settings. No model is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HistoryDetail, HistoryEntry, SiteOverride } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

describe("history", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const list = (target = "sites") => server.api<HistoryEntry[]>(`/api/history?target=${target}`);
  const snapshot = (target = "sites") =>
    server.api<HistoryEntry | undefined>("/api/history", { method: "POST", json: { target } });
  const site = (host: string) => server.api<SiteOverride | null>(`/api/sites/${host}`);
  const save = (host: string, css: string) =>
    server.api(`/api/sites/${host}`, { method: "PUT", json: { css, js: "" } });

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("the state at startup is the first snapshot; nothing changed, no new one", async () => {
    const entries = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ summary: "As it was when Rune Browser started", actor: "rune", first: true });
    expect(await snapshot()).toBeUndefined();
  });

  test("a change shows its files with line diffs", async () => {
    await save("example.com", "body {\n  color: red;\n}");
    const [entry] = await list();
    expect(entry).toMatchObject({
      summary: "Changed the customizations of example.com",
      added: ["example.com/site.json", "example.com/style.css"],
      first: false,
    });
    const detail = await server.api<HistoryDetail>(`/api/history/${entry!.id}`);
    expect(detail.files.find((f) => f.path === "example.com/style.css")).toMatchObject({
      kind: "text",
      status: "added",
      linesAdded: 3,
      linesRemoved: 0,
    });
  });

  test("undo reverts just that change", async () => {
    await save("other.test", "p { margin: 0 }");
    const change = (await list())[0]!;
    await save("third.test", "a { color: blue }");
    const result = await server.api<{ note: string | null }>(`/api/history/${change.id}/undo`, {
      method: "POST",
      json: {},
    });
    expect(result.note).toBeNull();
    expect(await site("other.test")).toBeNull();
    expect((await site("third.test"))?.css).toBe("a { color: blue }");
    expect((await site("example.com"))?.css).toContain("color: red");
    const [latest] = await list();
    expect(latest!.summary).toBe(`Undid: ${change.summary}`);
  });

  test("undo refuses when the files changed again since", async () => {
    await save("example.com", "body { color: green }");
    const change = (await list())[0]!;
    // Another kind of change in between, so the next one isn't folded into this one.
    await server.api("/api/page-changes", {
      method: "POST",
      json: { title: "Hide ads", scope: { type: "site", value: "example.com" }, action: "hide", selector: ".ad" },
    });
    await save("example.com", "body { color: purple }");
    await expect(server.api(`/api/history/${change.id}/undo`, { method: "POST", json: {} })).rejects.toThrow("409");
    expect((await site("example.com"))?.css).toBe("body { color: purple }");
  });

  test("restore puts an earlier version back, and can be undone", async () => {
    const first = (await list()).at(-1)!;
    await server.api(`/api/history/${first.id}/restore`, { method: "POST", json: {} });
    expect(await site("example.com")).toBeNull();
    expect(await site("third.test")).toBeNull();
    const [restored] = await list();
    expect(restored!.summary).toStartWith("Restored the version from");
    await server.api(`/api/history/${restored!.id}/undo`, { method: "POST", json: {} });
    expect((await site("third.test"))?.css).toBe("a { color: blue }");
  });

  test("settings changes are snapshots too, typed changes folded into one", async () => {
    const [start] = (await list("settings")).slice(-1);
    expect(start).toMatchObject({ summary: "As it was when Rune Browser started", actor: "rune" });
    const before = (await list("settings")).length;
    const settings = await server.api<Settings>("/api/settings");
    for (const webInstructions of ["A", "AB", "ABC"]) {
      await server.api("/api/settings", {
        method: "PUT",
        json: { ...settings, agent: { ...settings.agent, webInstructions } },
      });
    }
    const entries = await list("settings");
    expect(entries).toHaveLength(before + 1);
    expect(entries[0]!.summary).toBe("Changed settings");
    expect(entries[0]!.modified).toEqual(["settings.json"]);
    const detail = await server.api<HistoryDetail>(`/api/history/${entries[0]!.id}`);
    expect(
      detail.files[0]!.hunks!.flatMap((h) => h.lines).some(
        (l) => l.type === "+" && l.text.includes('"webInstructions": "ABC"'),
      ),
    ).toBe(true);

    await server.api(`/api/history/${entries[0]!.id}/undo`, { method: "POST", json: {} });
    expect((await server.api<Settings>("/api/settings")).agent.webInstructions).toBe("");
  });

  test("app snapshots aren't a target anymore", async () => {
    await expect(server.api("/api/history", { method: "POST", json: { target: "app:x" } })).rejects.toThrow("400");
  });
});
