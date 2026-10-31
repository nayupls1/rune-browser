// The host database (rune.sqlite): workspaces, tabs, chat history, settings,
// site customizations, secrets, permissions and the audit log. Apps keep
// their own data inside their project folders.
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { DEFAULT_WORKSPACE } from "../../shared/api";
import { ServerConfig } from "../Config";

export const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

type Fn = (...args: any[]) => Effect.Effect<any, any, any>;

/** A repository with database errors turned into defects. */
export type OrDie<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any, infer C>
    ? (...args: A) => Effect.Effect<R, never, C>
    : T[K];
};

/** Database errors are defects: there is nothing a caller could do about them. */
export const orDieAll = <T extends Record<string, Fn>>(repo: T) =>
  Object.fromEntries(
    Object.entries(repo).map(([k, fn]) => [k, (...args: unknown[]) => Effect.orDie(fn(...args))]),
  ) as OrDie<T>;

const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("PRAGMA foreign_keys = ON");
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS apps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      icon       TEXT,
      created_at TEXT NOT NULL DEFAULT (${now}),
      updated_at TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS messages_app ON messages (app_id, id)");
  yield* sql.unsafe("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
  // AI requests per app and day (AI for apps has a daily limit).
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      app_id   TEXT NOT NULL,
      day      TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, day)
    )`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS site_overrides (
      host       TEXT PRIMARY KEY,
      css        TEXT NOT NULL DEFAULT '',
      js         TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (${now})
    )`);

  // Page changes for web tabs (db/PageChanges.ts): the change itself as JSON.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS page_changes (
      id         TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${now}),
      updated_at TEXT NOT NULL DEFAULT (${now})
    )`);

  // Schedules and their runs (scheduler/Scheduler.ts).
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schedules (
      id          TEXT PRIMARY KEY,
      spec        TEXT NOT NULL,
      paused      INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT NOT NULL,
      creator_tab TEXT,
      next_run_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (${now}),
      updated_at  TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id   TEXT NOT NULL,
      schedule_name TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      status        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      message       TEXT NOT NULL DEFAULT '',
      output        TEXT
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs (schedule_id, id)");

  // Encrypted secrets (see security/Vault.ts): "global" or an app id as scope.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS secrets (
      id           TEXT PRIMARY KEY,
      scope        TEXT NOT NULL,
      name         TEXT NOT NULL,
      value        TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (${now}),
      updated_at   TEXT NOT NULL DEFAULT (${now}),
      last_used_at TEXT,
      UNIQUE (scope, name)
    )`);
  // Remembered permission decisions.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS permissions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      subject    TEXT NOT NULL,
      action     TEXT NOT NULL,
      resource   TEXT NOT NULL DEFAULT '',
      decision   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${now}),
      UNIQUE (subject, action, resource)
    )`);
  // What agents, apps and the user did.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT NOT NULL DEFAULT (${now}),
      actor       TEXT NOT NULL,
      actor_label TEXT NOT NULL,
      tab_id      TEXT,
      action      TEXT NOT NULL,
      target      TEXT,
      detail      TEXT,
      outcome     TEXT NOT NULL DEFAULT 'ok'
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS audit_tab ON audit (tab_id, id)");
  // Snapshots (see history/History.ts): file trees pointing into the content store.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      target       TEXT NOT NULL,
      tab_id       TEXT,
      workspace_id TEXT,
      at           TEXT NOT NULL DEFAULT (${now}),
      actor        TEXT NOT NULL,
      actor_label  TEXT NOT NULL,
      summary      TEXT NOT NULL,
      tree         TEXT NOT NULL,
      data         TEXT NOT NULL DEFAULT '{}',
      changes      TEXT NOT NULL
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS snapshots_target ON snapshots (target, id)");
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS snapshots_workspace ON snapshots (workspace_id, id)");
  // Groups of tabs. A database from before workspaces gets one for its tabs.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      icon       TEXT,
      settings   TEXT NOT NULL DEFAULT '{}',
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${now})
    )`);
  if (!(yield* sql.unsafe<{ name: string }>("PRAGMA table_info(workspaces)")).some((c) => c.name === "splits")) {
    // Tabs shown side by side (TabSplit[] as JSON).
    yield* sql.unsafe("ALTER TABLE workspaces ADD COLUMN splits TEXT NOT NULL DEFAULT '[]'");
  }
  yield* sql.unsafe(
    `INSERT INTO workspaces (id, name) SELECT '${DEFAULT_WORKSPACE}', 'Personal' WHERE NOT EXISTS (SELECT 1 FROM workspaces)`,
  );
  // The network layer (db/Network.ts): rules for web tabs' requests, and requests saved to send again.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS network_rules (
      id               TEXT PRIMARY KEY,
      workspace_id     TEXT,
      pattern          TEXT NOT NULL,
      action           TEXT NOT NULL,
      request_headers  TEXT NOT NULL DEFAULT '{}',
      response_headers TEXT NOT NULL DEFAULT '{}',
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS saved_requests (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      method       TEXT NOT NULL,
      url          TEXT NOT NULL,
      headers      TEXT NOT NULL DEFAULT '{}',
      body         TEXT,
      sealed       TEXT,
      created_at   TEXT NOT NULL DEFAULT (${now})
    )`);

  // What web tabs' requests get back instead of the site's answer, set by the website agent (db/ResponseOverrides.ts).
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS response_overrides (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      spec         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (${now})
    )`);

  // Columns added over time; created on existing databases.
  const columnsOf = (table: string) =>
    sql
      .unsafe<{ name: string }>(`PRAGMA table_info(${table})`)
      .pipe(Effect.map((rows) => new Set(rows.map((c) => c.name))));
  const columns = yield* columnsOf("apps");
  const added: [string, string][] = [
    ["kind", "TEXT NOT NULL DEFAULT 'app'"],
    ["url", "TEXT"],
    ["favicon", "TEXT"],
    // Set when the user renames a tab, so page titles / the agent stop renaming it.
    ["name_locked", "INTEGER NOT NULL DEFAULT 0"],
    // The agent: provider, model, effort, and the provider's session to resume.
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["effort", "TEXT"],
    ["session_id", "TEXT"],
    ["session_provider", "TEXT"],
    // dev (being edited: dev server) or live (done: built and started).
    ["mode", "TEXT NOT NULL DEFAULT 'dev'"],
    ["workspace_id", `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE}'`],
    // The tab's place in its workspace's list (ties: creation order).
    ["position", "INTEGER NOT NULL DEFAULT 0"],
    // Set when the user picks the icon, so the agent leaves it alone.
    ["icon_locked", "INTEGER NOT NULL DEFAULT 0"],
    // Kept loaded: never unloaded when it's idle.
    ["pinned", "INTEGER NOT NULL DEFAULT 0"],
    // Closed app tabs are kept (the library of saved apps) until they're deleted.
    ["closed_at", "TEXT"],
    // The current chat's folder (agent/ChatFiles.ts), made on first use.
    ["chat_folder", "TEXT"],
  ];
  for (const [name, type] of added) {
    if (!columns.has(name)) yield* sql.unsafe(`ALTER TABLE apps ADD COLUMN ${name} ${type}`);
  }
  // Earlier chats of a tab (its current one is the messages without a chat_id): kept when the
  // user starts a new chat, with the provider session to pick them up again.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS chats (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id           TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      title            TEXT NOT NULL,
      session_id       TEXT,
      session_provider TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS chats_app ON chats (app_id, id)");
  // An earlier chat's folder of files (agent/ChatFiles.ts) goes with it.
  if (!(yield* columnsOf("chats")).has("folder")) yield* sql.unsafe("ALTER TABLE chats ADD COLUMN folder TEXT");
  if (!(yield* columnsOf("messages")).has("chat_id"))
    yield* sql.unsafe("ALTER TABLE messages ADD COLUMN chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE");
  // The mod a page change came with (mods/Mods.ts), removed with it.
  if (!(yield* columnsOf("page_changes")).has("mod_id"))
    yield* sql.unsafe("ALTER TABLE page_changes ADD COLUMN mod_id TEXT");
  // Installed mods: the mod itself, and what installing it did (to take it back).
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS mods (
      id           TEXT PRIMARY KEY,
      mod          TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      source       TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT '{}',
      installed_at TEXT NOT NULL DEFAULT (${now})
    )`);
  if (!(yield* columnsOf("audit")).has("workspace_id")) {
    yield* sql.unsafe("ALTER TABLE audit ADD COLUMN workspace_id TEXT");
    yield* sql.unsafe(
      "UPDATE audit SET workspace_id = (SELECT workspace_id FROM apps WHERE apps.id = audit.tab_id) WHERE tab_id IS NOT NULL",
    );
  }
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS audit_workspace ON audit (workspace_id, id)");
  // Code attached to a tab for its agent: a folder of the user's, or a repository Rune Browser cloned (workspace/Sources.ts).
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sources (
      id         TEXT PRIMARY KEY,
      tab_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL,
      url        TEXT,
      branch     TEXT,
      state      TEXT NOT NULL DEFAULT 'ready',
      error      TEXT,
      added_at   TEXT NOT NULL DEFAULT (${now}),
      updated_at TEXT NOT NULL DEFAULT (${now})
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS sources_tab ON sources (tab_id, added_at)");
  // The API endpoint map (db/Endpoints.ts): the shapes of the APIs web tabs call, never values.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS api_endpoints (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      host         TEXT NOT NULL,
      method       TEXT NOT NULL,
      path         TEXT NOT NULL,
      operation    TEXT NOT NULL DEFAULT '',
      data         TEXT NOT NULL,
      seen         INTEGER NOT NULL DEFAULT 0,
      first_seen   TEXT NOT NULL DEFAULT (${now}),
      last_seen    TEXT NOT NULL DEFAULT (${now}),
      UNIQUE (workspace_id, host, method, path, operation)
    )`);
  yield* sql.unsafe("CREATE INDEX IF NOT EXISTS api_endpoints_host ON api_endpoints (workspace_id, host)");
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const filename = join(config.dataDir, "rune.sqlite");
    const client = SqliteClient.layer({ filename });
    return Layer.effectDiscard(migrate).pipe(Layer.provideMerge(client));
  }),
).pipe(Layer.orDie);
