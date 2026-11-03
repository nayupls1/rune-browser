// Workspaces: groups of tabs, each with its own agent defaults and
// instructions, secrets shared by its apps, remembered permissions and web
// session. (Not to be confused with workspace/Workspace.ts, an app's project
// folder.) There is always at least one.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { normalizeSplits, type TabSplit, type WorkspaceInfo } from "../../shared/api";
import { decodeWorkspaceSettings, type WorkspaceSettings } from "../../shared/settings";
import { orDieAll, type OrDie } from "./Db";

interface WorkspaceRow {
  id: string;
  name: string;
  icon: string | null;
  settings: string;
  splits: string;
  position: number;
  created_at: string;
}

const parseSettings = (json: string): WorkspaceSettings => {
  try {
    return decodeWorkspaceSettings(JSON.parse(json));
  } catch {
    return decodeWorkspaceSettings({});
  }
};

const parseSplits = (json: string): TabSplit[] => {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const toInfo = (r: WorkspaceRow): WorkspaceInfo => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  settings: parseSettings(r.settings),
  splits: parseSplits(r.splits),
  createdAt: r.created_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = (id: string) =>
    sql<WorkspaceRow>`SELECT * FROM workspaces WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toInfo(rows[0]) : null)),
    );

  return {
    /** In the user's order. */
    list: () =>
      sql<WorkspaceRow>`SELECT * FROM workspaces ORDER BY position, created_at, rowid`.pipe(
        Effect.map((rows) => rows.map(toInfo)),
      ),

    get,

    /** The workspace a tab belongs to. */
    ofApp: (appId: string) =>
      sql<WorkspaceRow>`SELECT w.* FROM workspaces w JOIN apps a ON a.workspace_id = w.id WHERE a.id = ${appId}`.pipe(
        Effect.map((rows) => (rows[0] ? toInfo(rows[0]) : null)),
      ),

    /** Where tabs go when no workspace is given. */
    first: () =>
      sql<WorkspaceRow>`SELECT * FROM workspaces ORDER BY position, created_at, rowid LIMIT 1`.pipe(
        Effect.map((rows) => toInfo(rows[0]!)),
      ),

    create: (name: string, icon: string | null) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        yield* sql`INSERT INTO workspaces (id, name, icon, position)
          VALUES (${id}, ${name}, ${icon}, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspaces))`;
        return (yield* get(id))!;
      }),

    update: (id: string, fields: { name?: string; icon?: string | null; settings?: WorkspaceSettings }) =>
      Effect.gen(function* () {
        const current = yield* get(id);
        if (!current) return null;
        yield* sql`UPDATE workspaces SET
          name = ${fields.name ?? current.name},
          icon = ${fields.icon !== undefined ? fields.icon : current.icon},
          settings = ${JSON.stringify(fields.settings ?? current.settings)}
          WHERE id = ${id}`;
        return yield* get(id);
      }),

    /** Saves its splits, made consistent with its tabs (see normalizeSplits). */
    setSplits: (id: string, splits: readonly TabSplit[]) =>
      Effect.gen(function* () {
        const tabs = yield* sql<{ id: string }>`SELECT id FROM apps WHERE workspace_id = ${id}`;
        const clean = normalizeSplits(
          splits,
          tabs.map((t) => t.id),
        );
        yield* sql`UPDATE workspaces SET splits = ${JSON.stringify(clean)} WHERE id = ${id}`;
        return yield* get(id);
      }),

    /** The ids of its tabs, in their order. */
    appIds: (id: string) =>
      sql<{ id: string }>`SELECT id FROM apps WHERE workspace_id = ${id} ORDER BY position, created_at, rowid`.pipe(
        Effect.map((rows) => rows.map((r) => r.id)),
      ),

    /** Puts the workspaces in this order (unknown ids are ignored, missing ones follow in their old order). */
    reorder: (ids: readonly string[]) =>
      Effect.gen(function* () {
        const current = (yield* sql<{
          id: string;
        }>`SELECT id FROM workspaces ORDER BY position, created_at, rowid`).map((r) => r.id);
        const order = [...ids.filter((id) => current.includes(id)), ...current.filter((id) => !ids.includes(id))];
        yield* sql.withTransaction(
          Effect.forEach(order, (id, i) => sql`UPDATE workspaces SET position = ${i} WHERE id = ${id}`, {
            discard: true,
          }),
        );
        return order;
      }),

    count: () => sql<{ n: number }>`SELECT COUNT(*) AS n FROM workspaces`.pipe(Effect.map((rows) => rows[0]!.n)),

    /** Only the row: its tabs, secrets and permissions are removed by the caller first. */
    remove: (id: string) => sql`DELETE FROM workspaces WHERE id = ${id}`.pipe(Effect.asVoid),
  };
});

export class Workspaces extends Context.Service<Workspaces, OrDie<Effect.Success<typeof make>>>()("rune/Workspaces") {}

export const layer = Layer.effect(Workspaces, Effect.map(make, orDieAll));
