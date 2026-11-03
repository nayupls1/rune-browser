// The network layer's stored parts: rules that block or change web tabs'
// requests (applied by Electron's main process), and saved requests to send
// again later with a workspace's session. Saved requests' credentials are
// sealed by the main process; the sealed blob is stored here but never sent
// out by the API.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { NetworkRule, RequestDraft, SavedRequest } from "../../shared/api";
import { now, orDieAll, type OrDie } from "./Db";

interface RuleRow {
  id: string;
  workspace_id: string | null;
  pattern: string;
  action: string;
  request_headers: string;
  response_headers: string;
  enabled: number;
  created_at: string;
}

interface SavedRow {
  id: string;
  workspace_id: string;
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string | null;
  sealed: string | null;
  created_at: string;
}

const toRule = (r: RuleRow): NetworkRule => ({
  id: r.id,
  workspaceId: r.workspace_id,
  pattern: r.pattern,
  action: r.action === "modify" ? "modify" : "block",
  requestHeaders: JSON.parse(r.request_headers),
  responseHeaders: JSON.parse(r.response_headers),
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});

const toSaved = (r: SavedRow): SavedRequest => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  method: r.method,
  url: r.url,
  headers: JSON.parse(r.headers),
  body: r.body,
  hasCredentials: r.sealed !== null,
  createdAt: r.created_at,
});

export type RuleFields = Omit<NetworkRule, "id" | "createdAt">;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getRule = (id: string) =>
    sql<RuleRow>`SELECT * FROM network_rules WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toRule(rows[0]) : null)),
    );
  const savedRow = (id: string) =>
    sql<SavedRow>`SELECT * FROM saved_requests WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0] ?? null));

  return {
    rules: () =>
      sql<RuleRow>`SELECT * FROM network_rules ORDER BY created_at, id`.pipe(Effect.map((rows) => rows.map(toRule))),
    getRule,
    countRules: () =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM network_rules`.pipe(Effect.map((rows) => rows[0]!.n)),
    addRule: (fields: RuleFields) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        yield* sql`INSERT INTO network_rules (id, workspace_id, pattern, action, request_headers, response_headers, enabled)
          VALUES (${id}, ${fields.workspaceId}, ${fields.pattern}, ${fields.action}, ${JSON.stringify(fields.requestHeaders)},
            ${JSON.stringify(fields.responseHeaders)}, ${fields.enabled ? 1 : 0})`;
        return (yield* getRule(id))!;
      }),
    updateRule: (id: string, fields: Partial<RuleFields>) =>
      Effect.gen(function* () {
        const current = yield* getRule(id);
        if (!current) return null;
        const next = { ...current, ...fields };
        yield* sql`UPDATE network_rules SET workspace_id = ${next.workspaceId}, pattern = ${next.pattern}, action = ${next.action},
          request_headers = ${JSON.stringify(next.requestHeaders)}, response_headers = ${JSON.stringify(next.responseHeaders)},
          enabled = ${next.enabled ? 1 : 0} WHERE id = ${id}`;
        return yield* getRule(id);
      }),
    removeRule: (id: string) => sql`DELETE FROM network_rules WHERE id = ${id}`.pipe(Effect.asVoid),

    saved: (workspaceId?: string) =>
      (workspaceId
        ? sql<SavedRow>`SELECT * FROM saved_requests WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC, id`
        : sql<SavedRow>`SELECT * FROM saved_requests ORDER BY created_at DESC, id`
      ).pipe(Effect.map((rows) => rows.map(toSaved))),
    getSaved: (id: string) => savedRow(id).pipe(Effect.map((row) => (row ? toSaved(row) : null))),
    /** A saved request with its sealed credentials, to hand to the main process for sending. */
    draftOf: (id: string) =>
      savedRow(id).pipe(
        Effect.map((row): { request: SavedRequest; draft: RequestDraft } | null =>
          row
            ? {
                request: toSaved(row),
                draft: {
                  method: row.method,
                  url: row.url,
                  headers: JSON.parse(row.headers),
                  body: row.body,
                  sealed: row.sealed,
                },
              }
            : null,
        ),
      ),
    save: (workspaceId: string, name: string, draft: RequestDraft) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        yield* sql`INSERT INTO saved_requests (id, workspace_id, name, method, url, headers, body, sealed, created_at)
          VALUES (${id}, ${workspaceId}, ${name}, ${draft.method}, ${draft.url}, ${JSON.stringify(draft.headers)}, ${draft.body}, ${draft.sealed},
            ${sql.literal(now)})`;
        return toSaved((yield* savedRow(id))!);
      }),
    renameSaved: (id: string, name: string) =>
      sql`UPDATE saved_requests SET name = ${name} WHERE id = ${id}`.pipe(Effect.asVoid),
    removeSaved: (id: string) => sql`DELETE FROM saved_requests WHERE id = ${id}`.pipe(Effect.asVoid),

    /** A deleted workspace's rules and saved requests. */
    removeWorkspace: (workspaceId: string) =>
      Effect.all([
        sql`DELETE FROM network_rules WHERE workspace_id = ${workspaceId}`,
        sql`DELETE FROM saved_requests WHERE workspace_id = ${workspaceId}`,
      ]).pipe(Effect.asVoid),
  };
});

export class Network extends Context.Service<Network, OrDie<Effect.Success<typeof make>>>()("rune/Network") {}

export const layer = Layer.effect(Network, Effect.map(make, orDieAll));
