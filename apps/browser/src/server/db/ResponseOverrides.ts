// Response overrides (shared/overrides.ts): what a workspace's web tabs get
// back from a site's requests, made by the website agent (the user sees and
// removes them). Scoped to a tab, a site or the workspace; they can expire,
// and tab-scoped ones go away with their tab.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { ResponseOverride, ResponseOverrideSpec } from "../../shared/api";
import { overrideSpec } from "../../shared/overrides";
import { orDieAll, type OrDie } from "./Db";

interface OverrideRow {
  id: string;
  workspace_id: string;
  spec: string;
  created_at: string;
}

const toOverride = (r: OverrideRow): ResponseOverride => ({
  ...overrideSpec(JSON.parse(r.spec) as ResponseOverrideSpec),
  id: r.id,
  workspaceId: r.workspace_id,
  createdAt: r.created_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = (id: string) =>
    sql<OverrideRow>`SELECT * FROM response_overrides WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toOverride(rows[0]) : null)),
    );
  /** Expired ones are deleted when anything is listed; returns how many. */
  const sweep = () =>
    Effect.gen(function* () {
      const expired = yield* sql<{ id: string }>`SELECT id FROM response_overrides
        WHERE json_extract(spec, '$.expiresAt') IS NOT NULL AND json_extract(spec, '$.expiresAt') <= ${new Date().toISOString()}`;
      if (expired.length)
        yield* sql`DELETE FROM response_overrides WHERE ${sql.in(
          "id",
          expired.map((r) => r.id),
        )}`;
      return expired.length;
    });

  return {
    get,
    sweep,
    list: (workspaceId?: string) =>
      Effect.gen(function* () {
        yield* sweep();
        const rows = workspaceId
          ? yield* sql<OverrideRow>`SELECT * FROM response_overrides WHERE workspace_id = ${workspaceId} ORDER BY created_at, rowid`
          : yield* sql<OverrideRow>`SELECT * FROM response_overrides ORDER BY created_at, rowid`;
        return rows.map(toOverride);
      }),
    count: (workspaceId: string) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM response_overrides WHERE workspace_id = ${workspaceId}`.pipe(
        Effect.map((rows) => rows[0]!.n),
      ),
    /** The spec is expected to be valid (overrideProblem). */
    create: (workspaceId: string, spec: ResponseOverrideSpec) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID().slice(0, 8);
        yield* sql`INSERT INTO response_overrides (id, workspace_id, spec)
          VALUES (${id}, ${workspaceId}, ${JSON.stringify(overrideSpec(spec))})`;
        return (yield* get(id))!;
      }),
    remove: (id: string) => sql`DELETE FROM response_overrides WHERE id = ${id}`.pipe(Effect.asVoid),
    /** A closed tab's overrides; returns how many there were. */
    removeTab: (tabId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`SELECT id FROM response_overrides
          WHERE json_extract(spec, '$.scope.type') = 'tab' AND json_extract(spec, '$.scope.tabId') = ${tabId}`;
        if (rows.length)
          yield* sql`DELETE FROM response_overrides WHERE ${sql.in(
            "id",
            rows.map((r) => r.id),
          )}`;
        return rows.length;
      }),
    removeWorkspace: (workspaceId: string) =>
      sql`DELETE FROM response_overrides WHERE workspace_id = ${workspaceId}`.pipe(Effect.asVoid),
  };
});

export class ResponseOverrides extends Context.Service<ResponseOverrides, OrDie<Effect.Success<typeof make>>>()(
  "rune/ResponseOverrides",
) {}

export const layer = Layer.effect(ResponseOverrides, Effect.map(make, orDieAll));
