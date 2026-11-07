// The audit log: what agents, apps and the user did, with who, what and when.
// Entries never contain secret values or file contents, only names, targets
// and short summaries. Old entries are pruned to keep the log bounded.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { AuditEntry } from "../../shared/api";
import { topics } from "../../shared/hub";
import { Hub } from "../Hub";

const MAX_ENTRIES = 20_000;
const clip = (s: string | null | undefined, max: number) =>
  s == null ? null : s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** The workspace defaults to the tab's. */
export type AuditInput = Omit<AuditEntry, "id" | "at" | "outcome" | "tabId" | "workspaceId" | "target" | "detail"> &
  Partial<Pick<AuditEntry, "outcome" | "tabId" | "workspaceId" | "target" | "detail">>;

interface AuditRow {
  id: number;
  at: string;
  actor: AuditEntry["actor"];
  actor_label: string;
  tab_id: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  outcome: AuditEntry["outcome"];
}

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  actorLabel: r.actor_label,
  tabId: r.tab_id,
  workspaceId: r.workspace_id,
  action: r.action,
  target: r.target,
  detail: r.detail,
  outcome: r.outcome,
});

export interface AuditShape {
  readonly record: (entry: AuditInput) => Effect.Effect<void>;
  /** Newest first. A workspace filter includes entries that belong to no workspace (global secrets, the website agent). */
  readonly list: (filter: {
    tabId?: string;
    workspaceId?: string;
    actor?: AuditEntry["actor"];
    before?: number;
    limit?: number;
  }) => Effect.Effect<AuditEntry[]>;
}

export class Audit extends Context.Service<Audit, AuditShape>()("rune/Audit") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Hub;
  let sincePrune = 0;

  const prune = sql`DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ${MAX_ENTRIES}`.pipe(
    Effect.asVoid,
    Effect.orDie,
  );
  yield* prune;

  return {
    record: (entry) =>
      Effect.gen(function* () {
        const rows = yield* sql<AuditRow>`
          INSERT INTO audit (actor, actor_label, tab_id, workspace_id, action, target, detail, outcome)
          VALUES (${entry.actor}, ${clip(entry.actorLabel, 200)}, ${entry.tabId ?? null},
                  COALESCE(${entry.workspaceId ?? null}, (SELECT workspace_id FROM apps WHERE id = ${entry.tabId ?? null})),
                  ${entry.action}, ${clip(entry.target, 500)}, ${clip(entry.detail, 1000)}, ${entry.outcome ?? "ok"})
          RETURNING *`;
        if (rows[0]) yield* hub.publish({ type: "audit", topic: topics.activity, entry: toEntry(rows[0]) });
        if (++sincePrune >= 500) {
          sincePrune = 0;
          yield* prune;
        }
      }).pipe(Effect.orDie),

    list: ({ tabId, workspaceId, actor, before, limit = 200 }) =>
      sql<AuditRow>`
        SELECT * FROM audit
        WHERE ${tabId ? sql`tab_id = ${tabId}` : sql`1 = 1`}
          AND ${workspaceId ? sql`(workspace_id = ${workspaceId} OR workspace_id IS NULL)` : sql`1 = 1`}
          AND ${actor ? sql`actor = ${actor}` : sql`1 = 1`}
          AND ${before ? sql`id < ${before}` : sql`1 = 1`}
        ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`.pipe(
        Effect.map((rows) => rows.map(toEntry)),
        Effect.orDie,
      ),
  } satisfies AuditShape;
});

export const layer = Layer.effect(Audit, make);
