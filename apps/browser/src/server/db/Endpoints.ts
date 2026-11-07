// The API endpoint map's storage: every endpoint web tabs called, per
// workspace and host, with what was seen of it merged (shared/endpoints.ts).
// Only shapes are stored, never values. Paths that turn out to differ only in
// one place (/users/alice, /users/bob…) become one template.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  collapsed,
  isPlaceholder,
  mergeEndpoints,
  mergeObservation,
  templateMatches,
  type Endpoint,
  type EndpointData,
  type EndpointHost,
  type Observation,
} from "../../shared/endpoints";
import { now, orDieAll, type OrDie } from "./Db";

/** Endpoints kept per host and per workspace (the least used go once a host is full). */
export const MAX_PER_HOST = 300;
export const MAX_PER_WORKSPACE = 5000;
/** Largest merged shape kept (characters of JSON); a bigger one keeps its earlier shape. */
const MAX_DATA = 64 * 1024;

interface Row {
  id: string;
  workspace_id: string;
  host: string;
  method: string;
  path: string;
  operation: string;
  data: string;
  seen: number;
  first_seen: string;
  last_seen: string;
}

const toEndpoint = (r: Row): Endpoint => {
  const data = JSON.parse(r.data) as EndpointData;
  return {
    ...data,
    id: r.id,
    workspaceId: r.workspace_id,
    host: r.host,
    method: r.method,
    path: r.path,
    operation: r.operation || null,
    seen: r.seen,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
};

const dataOf = (e: Endpoint | EndpointData): EndpointData => ({
  host: e.host,
  method: e.method,
  path: e.path,
  operation: e.operation,
  sites: e.sites,
  query: e.query,
  headers: e.headers,
  requestType: e.requestType,
  requestBody: e.requestBody,
  responses: e.responses,
  seen: e.seen,
});

const placeholders = (path: string) => path.split("/").filter(isPlaceholder).length;

/** Paths of the same length that differ from `path` in exactly one literal segment. */
const siblingOf = (path: string, other: string) => {
  const a = path.split("/");
  const b = other.split("/");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (isPlaceholder(a[i]!) || isPlaceholder(b[i]!)) return false;
    diff++;
  }
  return diff === 1;
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rowsOf = (workspaceId: string, host: string) =>
    sql<Row>`SELECT * FROM api_endpoints WHERE workspace_id = ${workspaceId} AND host = ${host}`;

  const write = (id: string, data: EndpointData) => {
    const json = JSON.stringify(data);
    return sql`UPDATE api_endpoints SET path = ${data.path}, data = ${json.length > MAX_DATA ? sql.literal("data") : json},
      seen = ${data.seen}, last_seen = ${sql.literal(now)} WHERE id = ${id}`;
  };

  const recordOne = (workspaceId: string, o: Observation) =>
    Effect.gen(function* () {
      const operation = o.operation ?? "";
      const rows = (yield* rowsOf(workspaceId, o.host)).filter(
        (r) => r.method === o.method && r.operation === operation,
      );
      // The template it falls under, the most specific first.
      const match = rows
        .filter((r) => r.path === o.path || templateMatches(r.path, o.path))
        .sort((a, b) => placeholders(a.path) - placeholders(b.path))[0];
      if (match) {
        yield* write(match.id, mergeObservation(dataOf(toEndpoint(match)), o));
        return;
      }
      // Enough paths that differ in one place: they're one endpoint with a parameter there.
      const siblings = rows.filter((r) => siblingOf(r.path, o.path));
      const template = collapsed([...siblings.map((r) => r.path), o.path]);
      if (template) {
        const group = siblings.filter((r) => templateMatches(template, r.path));
        let data = mergeObservation(null, { ...o, path: template });
        for (const r of group) data = mergeEndpoints(data, dataOf(toEndpoint(r)), template);
        const keep = group[0]!;
        yield* write(keep.id, data);
        for (const r of group.slice(1)) yield* sql`DELETE FROM api_endpoints WHERE id = ${r.id}`;
        yield* sql`UPDATE api_endpoints SET first_seen = ${group.map((r) => r.first_seen).sort()[0]!} WHERE id = ${keep.id}`;
        return;
      }
      const counted = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM api_endpoints WHERE workspace_id = ${workspaceId}`;
      if ((counted[0]?.n ?? 0) >= MAX_PER_WORKSPACE) return;
      if (rows.length >= MAX_PER_HOST) {
        // A full host makes room by forgetting its least used endpoint.
        const all = yield* rowsOf(workspaceId, o.host);
        if (all.length >= MAX_PER_HOST) {
          const least = [...all].sort((a, b) => a.seen - b.seen || a.last_seen.localeCompare(b.last_seen))[0]!;
          yield* sql`DELETE FROM api_endpoints WHERE id = ${least.id}`;
        }
      }
      const data = mergeObservation(null, o);
      yield* sql`INSERT INTO api_endpoints (id, workspace_id, host, method, path, operation, data, seen)
        VALUES (${crypto.randomUUID()}, ${workspaceId}, ${o.host}, ${o.method}, ${o.path}, ${operation},
          ${JSON.stringify(data)}, ${data.seen})`;
    });

  return {
    /** Merges what web tabs of a workspace saw into its map. */
    record: (workspaceId: string, observations: readonly Observation[]) =>
      sql.withTransaction(Effect.forEach(observations, (o) => recordOne(workspaceId, o), { discard: true })),

    /** The hosts in the map (of a workspace, or all), the most recently used first. */
    hosts: (workspaceId?: string) =>
      Effect.gen(function* () {
        const rows = yield* workspaceId
          ? sql<Row>`SELECT * FROM api_endpoints WHERE workspace_id = ${workspaceId}`
          : sql<Row>`SELECT * FROM api_endpoints`;
        const byHost = new Map<string, EndpointHost>();
        for (const row of rows) {
          const key = `${row.workspace_id} ${row.host}`;
          const sites = (JSON.parse(row.data) as EndpointData).sites ?? [];
          const host = byHost.get(key) ?? {
            workspaceId: row.workspace_id,
            host: row.host,
            endpoints: 0,
            requests: 0,
            lastSeen: row.last_seen,
            sites: [],
          };
          host.endpoints++;
          host.requests += row.seen;
          if (row.last_seen > host.lastSeen) host.lastSeen = row.last_seen;
          host.sites = [...new Set([...host.sites, ...sites])].slice(0, 20);
          byHost.set(key, host);
        }
        return [...byHost.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      }),

    /** A host's endpoints, by path. */
    endpoints: (workspaceId: string, host: string) =>
      sql<Row>`SELECT * FROM api_endpoints WHERE workspace_id = ${workspaceId} AND host = ${host}
        ORDER BY path, method, operation`.pipe(Effect.map((rows) => rows.map(toEndpoint))),

    /** Endpoints of a workspace whose host, path, operation or calling site contains the text, the most used first. */
    search: (workspaceId: string, text: string, limit = 50) =>
      sql<Row>`SELECT * FROM api_endpoints WHERE workspace_id = ${workspaceId} ORDER BY seen DESC`.pipe(
        Effect.map((rows) => {
          const q = text.trim().toLowerCase();
          return rows
            .map(toEndpoint)
            .filter(
              (e) =>
                !q ||
                [e.host, e.path, e.operation ?? "", e.method, ...e.sites].some((v) => v.toLowerCase().includes(q)),
            )
            .slice(0, limit);
        }),
      ),

    /** Forgets a host's endpoints (or, without a host, the workspace's whole map). */
    remove: (workspaceId: string, host?: string) =>
      (host
        ? sql`DELETE FROM api_endpoints WHERE workspace_id = ${workspaceId} AND host = ${host}`
        : sql`DELETE FROM api_endpoints WHERE workspace_id = ${workspaceId}`
      ).pipe(Effect.asVoid),

    /** Forgets every endpoint that a site's pages called, or that's on its host. */
    removeSite: (workspaceId: string, site: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<Row>`SELECT * FROM api_endpoints WHERE workspace_id = ${workspaceId}`;
        for (const row of rows) {
          const sites = (JSON.parse(row.data) as EndpointData).sites ?? [];
          if (row.host === site || row.host.split(":")[0] === site) {
            yield* sql`DELETE FROM api_endpoints WHERE id = ${row.id}`;
          } else if (sites.includes(site)) {
            const rest = sites.filter((s) => s !== site);
            if (!rest.length) yield* sql`DELETE FROM api_endpoints WHERE id = ${row.id}`;
            else yield* write(row.id, { ...dataOf(toEndpoint(row)), sites: rest });
          }
        }
      }),
  };
});

export class Endpoints extends Context.Service<Endpoints, OrDie<Effect.Success<typeof make>>>()("rune/Endpoints") {}

export const layer = Layer.effect(Endpoints, Effect.map(make, orDieAll));
