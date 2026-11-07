// Site customizations for web tabs: CSS/JS per hostname, made by the website agent.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SiteOverride } from "../../shared/api";
import { now, orDieAll, type OrDie } from "./Db";

interface OverrideRow {
  host: string;
  css: string;
  js: string;
  enabled: number;
  updated_at: string;
}

const toOverride = (r: OverrideRow): SiteOverride => ({
  host: r.host,
  css: r.css,
  js: r.js,
  enabled: r.enabled === 1,
  updatedAt: r.updated_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = (host: string) =>
    sql<OverrideRow>`SELECT * FROM site_overrides WHERE host = ${host}`.pipe(
      Effect.map((rows) => (rows[0] ? toOverride(rows[0]) : null)),
    );

  return {
    get,
    list: () =>
      sql<OverrideRow>`SELECT * FROM site_overrides ORDER BY host`.pipe(Effect.map((rows) => rows.map(toOverride))),
    /** Updates the given fields (the rest stay as they are). */
    save: (host: string, fields: { css?: string; js?: string; enabled?: boolean }) =>
      Effect.gen(function* () {
        const current = yield* get(host);
        const css = fields.css ?? current?.css ?? "";
        const js = fields.js ?? current?.js ?? "";
        const enabled = fields.enabled ?? current?.enabled ?? true;
        yield* sql`INSERT INTO site_overrides (host, css, js, enabled, updated_at)
          VALUES (${host}, ${css}, ${js}, ${enabled ? 1 : 0}, ${sql.literal(now)})
          ON CONFLICT (host) DO UPDATE SET css = excluded.css, js = excluded.js, enabled = excluded.enabled, updated_at = excluded.updated_at`;
        return (yield* get(host))!;
      }),
    remove: (host: string) => sql`DELETE FROM site_overrides WHERE host = ${host}`.pipe(Effect.asVoid),
  };
});

export class Sites extends Context.Service<Sites, OrDie<Effect.Success<typeof make>>>()("rune/Sites") {}

export const layer = Layer.effect(Sites, Effect.map(make, orDieAll));
