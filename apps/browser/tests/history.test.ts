// Snapshots, diffs, undo and restore against the real server: an app's files
// and its database, settings and site customizations. No model is called.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSummary, HistoryDetail, HistoryEntry, SiteOverride } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";

describe("history", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let app: AppSummary;
  let dir: string;
  /** The app's managed data (outside the project). */
  let dataDir: string;
  const target = () => `app:${app.id}`;
  const list = (t = target()) => server.api<HistoryEntry[]>(`/api/history?target=${encodeURIComponent(t)}`);
  const snapshot = (t = target()) =>
    server.api<HistoryEntry | undefined>("/api/history", { method: "POST", json: { target: t } });
  const file = (path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null);
  const rows = () => {
    const db = new Database(join(dataDir, "data.sqlite"));
    try {
      return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes").get()!.n;
    } catch {
      return null;
    } finally {
      db.close();
    }
  };
  const addNotes = (n: number) => {
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(join(dataDir, "data.sqlite"));
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
    for (let i = 0; i < n; i++) db.run("INSERT INTO notes (text) VALUES (?)", [`note ${i}`]);
    // Left open, like a running app: the rows are only in the WAL so far.
    return db;
  };

  beforeAll(async () => {
    server = await startServer();
    app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    dir = join(server.dataDir, "apps", app.id);
    dataDir = join(server.dataDir, "appdata", app.id);
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "stop" } });
  });
  afterAll(() => server.stop());

  test("starting from a template is the first snapshot; dependencies and builds aren't in it", async () => {
    const [first] = await list();
    expect(first).toMatchObject({
      summary: "Started from the api template",
      actor: "user",
      first: true,
      tabId: app.id,
      workspaceId: "default",
    });
    expect(first!.added).toContain("src/server.ts");
    expect(first!.added).toContain("rune.json");
    expect(first!.added.some((p) => p.startsWith("node_modules/") || p.startsWith(".rune/home"))).toBe(false);
    // Nothing changed: no new snapshot.
    expect(await snapshot()).toBeUndefined();
  });

  test("a change to code and data: files with line diffs, tables with row counts", async () => {
    writeFileSync(join(dir, "src/server.ts"), `${file("src/server.ts")}\n// a change\n`);
    writeFileSync(join(dir, "notes.md"), "hello\n");
    const db = addNotes(3);
    const entry = (await snapshot())!;
    db.close();
    expect(entry.added).toEqual(["@data/data.sqlite", "notes.md"]);
    expect(entry.modified).toEqual(["src/server.ts"]);
    expect(entry.data).toEqual({ "@data/data.sqlite": { notes: [null, 3] } });

    const detail = await server.api<HistoryDetail>(`/api/history/${entry.id}`);
    const server_ = detail.files.find((f) => f.path === "src/server.ts")!;
    expect(server_).toMatchObject({ kind: "text", status: "modified", linesAdded: 2, linesRemoved: 0 });
    expect(server_.hunks![0]!.lines.some((l) => l.type === "+" && l.text === "// a change")).toBe(true);
    expect(detail.files.find((f) => f.path === "@data/data.sqlite")).toMatchObject({
      kind: "data",
      tables: { notes: [null, 3] },
    });
  });

  test("undo reverts just that change", async () => {
    writeFileSync(join(dir, "notes.md"), "hello\nworld\n");
    const change = (await snapshot())!;
    writeFileSync(join(dir, "other.md"), "unrelated\n");
    const result = await server.api<{ note: string | null }>(`/api/history/${change.id}/undo`, {
      method: "POST",
      json: {},
    });
    expect(result.note).toBeNull();
    expect(file("notes.md")).toBe("hello\n");
    expect(file("other.md")).toBe("unrelated\n");
    const [latest, before] = await list();
    expect(latest!.summary).toBe("Undid: Saved a snapshot");
    expect(before!.summary).toBe("Before undoing a change");
  });

  test("undo leaves the data alone unless asked", async () => {
    const db = addNotes(1); // 4 notes
    db.close();
    writeFileSync(join(dir, "notes.md"), "with data\n");
    const change = (await snapshot())!;
    expect(change.data["@data/data.sqlite"]).toEqual({ notes: [3, 4] });
    await server.api(`/api/history/${change.id}/undo`, { method: "POST", json: {} });
    expect(file("notes.md")).toBe("hello\n");
    expect(rows()).toBe(4);
    // Redo, then undo with the data.
    const [undone] = await list();
    await server.api(`/api/history/${undone!.id}/undo`, { method: "POST", json: {} });
    expect(file("notes.md")).toBe("with data\n");
    await server.api(`/api/history/${change.id}/undo`, { method: "POST", json: { data: true } });
    expect(rows()).toBe(3);
    expect(file("notes.md")).toBe("hello\n");
  });

  test("undo refuses when the files changed again since", async () => {
    writeFileSync(join(dir, "notes.md"), "v2\n");
    const change = (await snapshot())!;
    writeFileSync(join(dir, "notes.md"), "v3\n");
    await expect(server.api(`/api/history/${change.id}/undo`, { method: "POST", json: {} })).rejects.toThrow("409");
    expect(file("notes.md")).toBe("v3\n");
  });

  test("restore puts an earlier version back, with or without its data", async () => {
    const db = addNotes(2); // 5 notes now
    writeFileSync(join(dir, "other.md"), "unrelated\n");
    db.close();
    const entries = await list();
    // The snapshot where the database first appeared, with 3 notes.
    const withThreeNotes = entries.find((e) => e.data["@data/data.sqlite"]?.notes?.[0] === null)!;

    await server.api(`/api/history/${withThreeNotes.id}/restore`, { method: "POST", json: { data: false } });
    expect(file("notes.md")).toBe("hello\n");
    expect(file("other.md")).toBeNull();
    expect(rows()).toBe(5);

    await server.api(`/api/history/${withThreeNotes.id}/restore`, { method: "POST", json: { data: true } });
    expect(rows()).toBe(3);
    // No stale WAL left to replay over it (macOS's SQLite keeps an empty one after reads).
    const wal = join(dataDir, "data.sqlite-wal");
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);

    // The very first version had no database at all.
    const first = (await list()).at(-1)!;
    await server.api(`/api/history/${first.id}/restore`, { method: "POST", json: { data: true } });
    expect(existsSync(join(dataDir, "data.sqlite"))).toBe(false);
    expect(file("notes.md")).toBeNull();
    // ...and that restore can be undone in turn.
    const [restored] = await list();
    expect(restored!.summary).toMatch(/^Restored the version from /);
    await server.api(`/api/history/${restored!.id}/undo`, { method: "POST", json: { data: true } });
    expect(rows()).toBe(3);
    expect(file("notes.md")).toBe("hello\n");
  });

  test("settings changes are snapshots too, typed changes folded into one", async () => {
    const [start] = await list("settings");
    expect(start).toMatchObject({ summary: "As it was when Rune Browser started", actor: "rune" });
    const settings = await server.api<Settings>("/api/settings");
    for (const instructions of ["A", "AB", "ABC"]) {
      await server.api("/api/settings", {
        method: "PUT",
        json: { ...settings, agent: { ...settings.agent, instructions } },
      });
    }
    const entries = await list("settings");
    expect(entries.map((e) => e.summary)).toEqual(["Changed settings", "As it was when Rune Browser started"]);
    expect(entries[0]!.modified).toEqual(["settings.json"]);
    const detail = await server.api<HistoryDetail>(`/api/history/${entries[0]!.id}`);
    expect(
      detail.files[0]!.hunks!.flatMap((h) => h.lines).some(
        (l) => l.type === "+" && l.text.includes('"instructions": "ABC"'),
      ),
    ).toBe(true);

    await server.api(`/api/history/${entries[0]!.id}/undo`, { method: "POST", json: {} });
    expect((await server.api<Settings>("/api/settings")).agent.instructions).toBe("");
  });

  test("site customizations can be undone", async () => {
    await server.api("/api/sites/example.com", { method: "PUT", json: { css: "body { color: red }" } });
    const [change] = await list("sites");
    expect(change).toMatchObject({
      summary: "Changed the customizations of example.com",
      added: ["example.com/site.json", "example.com/style.css"],
    });
    await server.api(`/api/history/${change!.id}/undo`, { method: "POST", json: {} });
    expect(await server.api<SiteOverride | null>("/api/sites/example.com")).toBeNull();
  });

  test("a deleted app's history goes with it", async () => {
    await server.api(`/api/apps/${app.id}`, { method: "DELETE" });
    expect(await list()).toEqual([]);
  });
});
