// Page changes for web tabs: hide, restyle or rewrite elements, add elements
// and buttons, stylesheets and scripts, each scoped to a page, a site or a
// pattern of sites (shared/web.ts applies them). Made by the website agent or
// the user; each can be turned off or removed on its own.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { PageChange, PageChangeSpec } from "../../shared/api";
import { pageChangeProblem, pageChangeSpec } from "../../shared/web";
import { now, orDieAll, type OrDie } from "./Db";

const transpiler = new Bun.Transpiler({ loader: "js" });

/** What's wrong with a page change, including JavaScript that doesn't parse; null if it's fine. */
export function pageChangeError(spec: PageChangeSpec): string | null {
  const problem = pageChangeProblem(spec);
  if (problem) return problem;
  const js = spec.action === "script" ? spec.value : spec.action === "button" ? spec.onClick : undefined;
  if (js === undefined) return null;
  try {
    transpiler.transformSync(`(function (event, button) {\n${js}\n})`);
    return null;
  } catch (err) {
    return `JavaScript syntax error: ${err instanceof Error ? err.message : err}`;
  }
}

interface ChangeRow {
  id: string;
  spec: string;
  enabled: number;
  created_by: "agent" | "user";
  mod_id: string | null;
  created_at: string;
  updated_at: string;
}

const toChange = (r: ChangeRow): PageChange => ({
  ...(JSON.parse(r.spec) as PageChangeSpec),
  id: r.id,
  enabled: r.enabled === 1,
  createdBy: r.created_by,
  modId: r.mod_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = (id: string) =>
    sql<ChangeRow>`SELECT * FROM page_changes WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? toChange(rows[0]) : null)),
    );

  return {
    get,
    list: () =>
      sql<ChangeRow>`SELECT * FROM page_changes ORDER BY created_at, rowid`.pipe(
        Effect.map((rows) => rows.map(toChange)),
      ),
    /** The spec is expected to be valid (pageChangeProblem). */
    create: (
      spec: PageChangeSpec,
      createdBy: "agent" | "user",
      id: string = crypto.randomUUID().slice(0, 8),
      modId: string | null = null,
    ) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO page_changes (id, spec, created_by, mod_id) VALUES (${id}, ${JSON.stringify(pageChangeSpec(spec))}, ${createdBy}, ${modId})`;
        return (yield* get(id))!;
      }),
    update: (id: string, fields: { spec?: PageChangeSpec; enabled?: boolean }) =>
      Effect.gen(function* () {
        const current = yield* get(id);
        if (!current) return null;
        const spec = JSON.stringify(pageChangeSpec(fields.spec ?? current));
        const enabled = fields.enabled ?? current.enabled;
        yield* sql`UPDATE page_changes SET spec = ${spec}, enabled = ${enabled ? 1 : 0}, updated_at = ${sql.literal(now)} WHERE id = ${id}`;
        return yield* get(id);
      }),
    remove: (id: string) => sql`DELETE FROM page_changes WHERE id = ${id}`.pipe(Effect.asVoid),
    /** The changes a mod brought. */
    ofMod: (modId: string) =>
      sql<ChangeRow>`SELECT * FROM page_changes WHERE mod_id = ${modId} ORDER BY created_at, rowid`.pipe(
        Effect.map((rows) => rows.map(toChange)),
      ),
    removeMod: (modId: string) => sql`DELETE FROM page_changes WHERE mod_id = ${modId}`.pipe(Effect.asVoid),
    setModEnabled: (modId: string, enabled: boolean) =>
      sql`UPDATE page_changes SET enabled = ${enabled ? 1 : 0}, updated_at = ${sql.literal(now)} WHERE mod_id = ${modId}`.pipe(
        Effect.asVoid,
      ),
    /** Puts a change back as it was (restoring a snapshot). */
    put: (change: PageChange) =>
      sql`INSERT INTO page_changes (id, spec, enabled, created_by, mod_id, created_at, updated_at)
        VALUES (${change.id}, ${JSON.stringify(pageChangeSpec(change))}, ${change.enabled ? 1 : 0}, ${change.createdBy}, ${change.modId ?? null}, ${change.createdAt}, ${change.updatedAt})
        ON CONFLICT (id) DO UPDATE SET spec = excluded.spec, enabled = excluded.enabled, created_by = excluded.created_by,
          mod_id = excluded.mod_id, created_at = excluded.created_at, updated_at = excluded.updated_at`.pipe(
        Effect.asVoid,
      ),
  };
});

export class PageChanges extends Context.Service<PageChanges, OrDie<Effect.Success<typeof make>>>()(
  "rune/PageChanges",
) {}

export const layer = Layer.effect(PageChanges, Effect.map(make, orDieAll));
