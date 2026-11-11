// Rune Browser used to build apps in tabs of their own. A profile from then
// starts fine: its app tabs go with their chats, chat folders, attached code,
// snapshots and permissions, the tables and columns only they used go too, and
// web tabs stay (db/Db.ts: dropApps).
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { DEFAULT_WORKSPACE } from "../src/shared/api";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { removeChild } from "../src/server/db/Db";
import { core } from "../src/server/services";

const dir = mkdtempSync(join(tmpdir(), "rune-drop-apps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const start = <A>(effect: Effect.Effect<A, never, Apps>) => {
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dir, PORT: "1" })));
  return runtime.runPromise(effect as Effect.Effect<A>).finally(() => runtime.dispose());
};
const sqlite = <A>(fn: (db: Database) => A) => {
  const db = new Database(join(dir, "rune.sqlite"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const columns = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
const tables = (db: Database) =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => t.name);

test("an app tab and what only apps used go; web tabs stay, and so do new tabs", async () => {
  // A database as the current version makes it, then turned into one from when there were apps.
  await start(Effect.void);
  sqlite((db) => {
    db.run("ALTER TABLE apps ADD COLUMN kind TEXT NOT NULL DEFAULT 'app'");
    db.run("ALTER TABLE apps ADD COLUMN mode TEXT NOT NULL DEFAULT 'dev'");
    db.run("ALTER TABLE apps ADD COLUMN closed_at TEXT");
    db.run("ALTER TABLE apps ADD COLUMN icon_locked INTEGER NOT NULL DEFAULT 0");
    db.run("ALTER TABLE snapshots ADD COLUMN tab_id TEXT");
    db.run("ALTER TABLE snapshots ADD COLUMN workspace_id TEXT");
    db.run("ALTER TABLE snapshots ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
    db.run("CREATE INDEX snapshots_workspace ON snapshots (workspace_id, id)");
    db.run("CREATE TABLE secrets (id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL)");
    db.run("CREATE TABLE ai_usage (app_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0)");
    db.run("INSERT INTO secrets VALUES ('s', 'app-tab', 'KEY', 'sealed')");
    const tab = (id: string, kind: string, closed: string | null = null) =>
      db.run("INSERT INTO apps (id, workspace_id, name, kind, closed_at, chat_folder) VALUES (?, ?, ?, ?, ?, 'f')", [
        id,
        DEFAULT_WORKSPACE,
        id,
        kind,
        closed,
      ]);
    tab("app-tab", "app");
    tab("closed-app", "app", "2026-01-01T00:00:00Z");
    tab("web-tab", "web");
    for (const id of ["app-tab", "web-tab"]) {
      db.run("INSERT INTO messages (app_id, role, content) VALUES (?, 'user', 'hi')", [id]);
      db.run("INSERT INTO chats (app_id, title, created_at, updated_at) VALUES (?, 'Earlier', 'x', 'x')", [id]);
      db.run("INSERT INTO sources (id, tab_id, kind, name, path) VALUES (?, ?, 'git', 'repo', 'x')", [`src-${id}`, id]);
      db.run("INSERT INTO permissions (subject, action, resource, decision) VALUES (?, 'agent.tab', 'x', 'allow')", [
        id,
      ]);
    }
    db.run(
      "INSERT INTO permissions (subject, action, resource, decision) VALUES ('workspace:default', 'app.ai', '', 'allow')",
    );
    db.run(
      "INSERT INTO snapshots (target, tab_id, workspace_id, actor, actor_label, summary, tree, changes) VALUES ('app:app-tab', 'app-tab', 'default', 'agent', 'App builder', 'Built it', '{}', '{}')",
    );
  });
  for (const id of ["app-tab", "web-tab"]) {
    mkdirSync(join(dir, "chats", id, "f"), { recursive: true });
    writeFileSync(join(dir, "chats", id, "f", "notes.md"), "x");
    mkdirSync(join(dir, "sources", `src-${id}`), { recursive: true });
  }
  // The app's project is the user's work: it stays on disk.
  mkdirSync(join(dir, "apps", "app-tab"), { recursive: true });
  writeFileSync(join(dir, "apps", "app-tab", "rune.json"), "{}");

  const listed = await start(Effect.flatMap(Apps, (apps) => apps.list()));
  expect(listed.map((t) => t.id)).toEqual(["web-tab"]);
  sqlite((db) => {
    expect(columns(db, "apps")).not.toContain("kind");
    expect(columns(db, "apps")).not.toContain("mode");
    expect(columns(db, "apps")).not.toContain("closed_at");
    expect(columns(db, "snapshots")).not.toContain("data");
    expect(tables(db)).not.toContain("secrets");
    expect(tables(db)).not.toContain("ai_usage");
    const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE app_id = 'app-tab'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM chats WHERE app_id = 'app-tab'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM sources WHERE tab_id = 'app-tab'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE app_id = 'web-tab'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sources WHERE tab_id = 'web-tab'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM snapshots WHERE target LIKE 'app:%'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM permissions WHERE subject = 'app-tab' OR action LIKE 'app.%'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM permissions WHERE subject = 'web-tab'")).toBe(1);
  });
  expect(existsSync(join(dir, "chats", "app-tab"))).toBe(false);
  expect(existsSync(join(dir, "sources", "src-app-tab"))).toBe(false);
  expect(existsSync(join(dir, "chats", "web-tab", "f", "notes.md"))).toBe(true);
  expect(existsSync(join(dir, "sources", "src-web-tab"))).toBe(true);
  expect(existsSync(join(dir, "apps", "app-tab", "rune.json"))).toBe(true);

  // Tabs made from now on aren't mistaken for apps on the next start.
  const made = await start(Effect.flatMap(Apps, (apps) => apps.create(DEFAULT_WORKSPACE, null)));
  const again = await start(Effect.flatMap(Apps, (apps) => apps.list()));
  expect(again.map((t) => t.id).sort()).toEqual([made.id, "web-tab"].sort());
});

test("only a direct child of its folder is ever removed", () => {
  const parent = join(dir, "guarded");
  for (const name of ["a", "b"]) mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(join(dir, "outside.txt"), "keep");
  // Names that sanitize to nothing, or would lead elsewhere, remove nothing.
  for (const name of ["", "..", "../", "/", "./.", "../outside.txt", "%%"]) removeChild(parent, name);
  expect(existsSync(join(parent, "a")) && existsSync(join(parent, "b"))).toBe(true);
  expect(existsSync(join(dir, "outside.txt"))).toBe(true);
  // "../a" sanitizes to "a": still a child of the folder.
  removeChild(parent, "../a");
  expect(existsSync(join(parent, "a"))).toBe(false);
  expect(existsSync(join(parent, "b"))).toBe(true);
});
