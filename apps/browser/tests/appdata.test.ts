// Managed app data against the real server: where it lives, what the app's
// process sees, browsing, export, delete, and reading another app's data
// only after the user allows it. No model is called.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AppSummary,
  AuditEntry,
  DataOverview,
  DataRows,
  HistoryEntry,
  PermissionRequest,
  WorkspaceInfo,
} from "../src/shared/api";
import { startServer } from "./lib/server";
import { devScript } from "./lib/apps";

const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
};

describe("managed app data", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let notes: AppSummary;
  let other: AppSummary;
  let env: Record<string, string>;
  const projectOf = (app: AppSummary) => join(server.dataDir, "apps", app.id);
  const dataOf = (app: AppSummary) => join(server.dataDir, "appdata", app.id);

  /** An app whose dev command writes down the environment Rune Browser gave it. */
  const create = async (workspaceId?: string) => {
    const app = await server.api<AppSummary>("/api/apps", { method: "POST", json: workspaceId ? { workspaceId } : {} });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    devScript(
      projectOf(app),
      'await Bun.write("env.txt", Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join("\\n"));',
    );
    return app;
  };
  const envOf = async (app: AppSummary) => {
    const file = join(projectOf(app), "env.txt");
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
    const text = await waitFor(() =>
      existsSync(file) && readFileSync(file, "utf8").includes("RUNE_API_TOKEN=")
        ? readFileSync(file, "utf8")
        : undefined,
    );
    return Object.fromEntries(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  };
  const appApi = (path: string, token: string, origin?: string) =>
    fetch(`${server.url}/app-api/v1${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
    });

  beforeAll(async () => {
    server = await startServer();
    notes = await create();
    mkdirSync(dataOf(notes), { recursive: true });
    const db = new Database(join(dataOf(notes), "data.sqlite"));
    // Rune Browser may be reading it (History) while this writes.
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, done INTEGER)");
    for (let i = 1; i <= 120; i++)
      db.run("INSERT INTO notes (title, done) VALUES (?, ?)", [i === 7 ? "100% sure" : `note ${i}`, i % 2]);
    db.close();
    env = await envOf(notes);
    other = await create();
  });
  afterAll(() => server.stop());

  test("the app's database and files live outside the project, and the app's process gets their paths", () => {
    expect(env.DATABASE_PATH).toBe(join(dataOf(notes), "data.sqlite"));
    expect(env.RUNE_FILES_DIR).toBe(join(dataOf(notes), "files"));
    expect(env.RUNE_API_URL).toBe(`${server.url}/app-api/v1`);
    expect(env.RUNE_API_TOKEN).toMatch(/^nai_/);
    expect(existsSync(join(dataOf(notes), "data.sqlite"))).toBe(true);
  });

  test("the user sees the tables and pages through rows, with search", async () => {
    writeFileSync(join(dataOf(notes), "files", "a.txt"), "hello");
    const overview = await server.api<DataOverview>(`/api/apps/${notes.id}/data`);
    expect(overview.tables).toEqual([
      {
        name: "notes",
        rows: 120,
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "title", type: "TEXT", primaryKey: false },
          { name: "done", type: "INTEGER", primaryKey: false },
        ],
      },
    ]);
    expect(overview.files).toEqual({ count: 1, bytes: 5 });
    const page = await server.api<DataRows>(`/api/apps/${notes.id}/data/tables/notes?offset=100&limit=50`);
    expect(page.total).toBe(120);
    expect(page.rows).toHaveLength(20);
    expect(page.rows[0]).toEqual({ id: 101, title: "note 101", done: 1 });
    // LIKE wildcards are matched literally.
    const found = await server.api<DataRows>(
      `/api/apps/${notes.id}/data/tables/notes?search=${encodeURIComponent("0%")}`,
    );
    expect(found.rows.map((r) => r.title)).toEqual(["100% sure"]);
    const filtered = await server.api<DataRows>(
      `/api/apps/${notes.id}/data/tables/notes?where.done=0&order=id&desc=1&limit=2`,
    );
    expect(filtered.rows.map((r) => r.id)).toEqual([120, 118]);
    await expect(server.api(`/api/apps/${notes.id}/data/tables/nope`)).rejects.toThrow("404");
    await expect(
      server.api(`/api/apps/${notes.id}/data/tables/notes?order=${encodeURIComponent('id"; DROP TABLE notes; --')}`),
    ).rejects.toThrow("404");
  });

  test("the export has the database, the tables as JSON and the files", async () => {
    const res = await fetch(`${server.url}/api/apps/${notes.id}/data/export`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename=".+-data\.tar\.gz"$/);
    const files = await new Bun.Archive(await res.bytes()).files();
    expect([...files.keys()].sort()).toEqual(["data.sqlite", "files/a.txt", "tables/notes.json"]);
    expect(JSON.parse(await files.get("tables/notes.json")!.text())).toHaveLength(120);
    expect(await files.get("files/a.txt")!.text()).toBe("hello");
  });

  test("another app reads it only after the user allows it; browsers never", async () => {
    const otherEnv = await envOf(other);
    const token = otherEnv.RUNE_API_TOKEN!;
    // Its own data: no question.
    expect((await appApi(`/data/${other.id}`, token)).status).toBe(200);
    const listed = (await (await appApi("/data", token)).json()) as { id: string; self: boolean }[];
    expect(listed.find((a) => a.id === notes.id)).toMatchObject({ self: false });
    expect((await appApi(`/data/${notes.id}`, token, "http://127.0.0.1:5555")).status).toBe(403);
    expect((await appApi(`/data/${notes.id}`, "nai_nope")).status).toBe(401);

    const denied = appApi(`/data/${notes.id}/notes`, token);
    const request = await waitFor(async () => (await server.api<PermissionRequest[]>("/api/permissions/pending"))[0]);
    expect(request).toMatchObject({ subject: other.id, action: "app.data", resource: notes.id });
    await server.api(`/api/permissions/pending/${request.id}`, {
      method: "POST",
      json: { allow: false, remember: false },
    });
    expect((await denied).status).toBe(403);

    const allowed = appApi(`/data/${notes.id}/notes?limit=3`, token);
    const next = await waitFor(async () => (await server.api<PermissionRequest[]>("/api/permissions/pending"))[0]);
    await server.api(`/api/permissions/pending/${next.id}`, { method: "POST", json: { allow: true, remember: true } });
    const res = await allowed;
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataRows).rows).toHaveLength(3);
    // Remembered.
    expect((await appApi(`/data/${notes.id}`, token)).status).toBe(200);
    const audit = await server.api<AuditEntry[]>(`/api/audit?tab=${other.id}`);
    expect(audit.filter((e) => e.action === "data.read").map((e) => e.outcome)).toContain("denied");
    expect(audit.filter((e) => e.action === "data.read").map((e) => e.outcome)).toContain("ok");
  });

  test("apps in another workspace can't even ask", async () => {
    const client = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Client" } });
    const outsider = await create(client.id);
    const token = (await envOf(outsider)).RUNE_API_TOKEN!;
    expect((await appApi(`/data/${notes.id}`, token)).status).toBe(404);
    expect(((await (await appApi("/data", token)).json()) as { id: string }[]).map((a) => a.id)).toEqual([outsider.id]);
  });

  test("deleting the data takes a snapshot first, so History can bring it back", async () => {
    await server.api(`/api/apps/${notes.id}/data`, { method: "DELETE" });
    const overview = await server.api<DataOverview>(`/api/apps/${notes.id}/data`);
    expect(overview.tables).toEqual([]);
    expect(overview.files.count).toBe(0);
    const entries = await server.api<HistoryEntry[]>(`/api/history?target=${encodeURIComponent(`app:${notes.id}`)}`);
    expect(entries[0]!.summary).toBe("Deleted the app's data");
    const before = entries.find((e) => e.summary === "Before deleting the app's data")!;
    await server.api(`/api/history/${before.id}/restore`, { method: "POST", json: { data: true } });
    expect((await server.api<DataOverview>(`/api/apps/${notes.id}/data`)).tables[0]!.rows).toBe(120);
    expect(readFileSync(join(dataOf(notes), "files", "a.txt"), "utf8")).toBe("hello");
  });

  test("deleting the app deletes its data", async () => {
    await server.api(`/api/apps/${notes.id}`, { method: "DELETE" });
    expect(existsSync(dataOf(notes))).toBe(false);
  });
});
