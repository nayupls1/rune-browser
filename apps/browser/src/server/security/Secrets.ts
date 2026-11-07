// Secrets: environment variables for apps (API keys, passwords), encrypted at
// rest by the Vault. A secret belongs to one app tab, to a workspace (shared
// by all its apps) or is global; an app gets its own secrets, its
// workspace's, and the global ones the user allowed it to use, and only in
// its own processes' environment (dev, build, start), never in agents'
// prompts, commands, process arguments or logs. Values can be replaced or
// deleted but never read back through the API.
import { Context, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  isReservedSecretName,
  SECRET_NAME_PATTERN,
  workspaceScope,
  type SecretInfo,
  type SecretScope,
} from "../../shared/api";
import { topics } from "../../shared/hub";
import { Hub } from "../Hub";
import { now } from "../db/Db";
import { Permissions } from "./Permissions";
import { Vault, VaultLocked } from "./Vault";

export class SecretError extends Data.TaggedError("SecretError")<{ readonly message: string }> {}

const MAX_VALUE_BYTES = 64 * 1024;

interface SecretRow {
  id: string;
  scope: string;
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const toInfo = (r: SecretRow): SecretInfo => ({
  id: r.id,
  scope: r.scope,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
});

/** What the ciphertext is bound to (it can't be moved to another secret). */
const context = (scope: string, name: string) => `secret:${scope}:${name}`;

export function validateSecret(name: string, value: string): string | null {
  if (!SECRET_NAME_PATTERN.test(name))
    return "Names are environment variable names: capital letters, digits and _ (e.g. STRIPE_KEY)";
  if (isReservedSecretName(name)) return `${name} is set by Rune Browser itself; pick another name`;
  if (!value) return "The value is empty";
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) return "The value is too long (64 KB at most)";
  if (value.includes("\0")) return "The value can't contain NUL characters";
  return null;
}

export interface SecretsShape {
  readonly protection: "keychain" | "file" | "locked";
  /** Without values. */
  readonly list: (scope?: SecretScope) => Effect.Effect<SecretInfo[]>;
  readonly get: (id: string) => Effect.Effect<SecretInfo | null>;
  /** Creates or replaces a secret. */
  readonly set: (scope: SecretScope, name: string, value: string) => Effect.Effect<SecretInfo, SecretError>;
  readonly remove: (id: string) => Effect.Effect<SecretInfo | null>;
  readonly removeScope: (scope: string) => Effect.Effect<void>;
  /** The names an app can use: its own, its workspace's and the allowed global ones. */
  readonly available: (
    appId: string,
  ) => Effect.Effect<{ own: string[]; workspace: string[]; global: string[]; globalNotAllowed: string[] }>;
  /** The environment for an app's processes (marks the secrets as used). */
  readonly envFor: (appId: string) => Effect.Effect<Record<string, string>, VaultLocked>;
}

export class Secrets extends Context.Service<Secrets, SecretsShape>()("rune/Secrets") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const vault = yield* Vault;
  const permissions = yield* Permissions;
  const hub = yield* Hub;

  const changed = (scope: string) => hub.publish({ type: "secrets-changed", topic: topics.activity, scope });
  const rowsOf = (scope: string) =>
    sql<SecretRow>`SELECT * FROM secrets WHERE scope = ${scope} ORDER BY name`.pipe(Effect.orDie);
  const workspaceRows = (appId: string) =>
    sql<{ workspace_id: string }>`SELECT workspace_id FROM apps WHERE id = ${appId}`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => (rows[0] ? rowsOf(workspaceScope(rows[0].workspace_id)) : Effect.succeed([]))),
    );

  const allowedGlobals = (appId: string) =>
    Effect.gen(function* () {
      const globals = yield* rowsOf("global");
      const allowed: SecretRow[] = [];
      for (const row of globals) {
        if ((yield* permissions.decision(appId, "app.secret", row.name)) === "allow") allowed.push(row);
      }
      return { globals, allowed };
    });

  return {
    protection: vault.protection,

    list: (scope) =>
      (scope ? rowsOf(scope) : sql<SecretRow>`SELECT * FROM secrets ORDER BY scope, name`.pipe(Effect.orDie)).pipe(
        Effect.map((rows) => rows.map(toInfo)),
      ),

    get: (id) =>
      sql<SecretRow>`SELECT * FROM secrets WHERE id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] ? toInfo(rows[0]) : null)),
        Effect.orDie,
      ),

    set: (scope, name, value) =>
      Effect.gen(function* () {
        const problem = validateSecret(name, value);
        if (problem) return yield* new SecretError({ message: problem });
        const blob = yield* vault
          .encrypt(value, context(scope, name))
          .pipe(Effect.mapError((e) => new SecretError({ message: e.message })));
        const rows = yield* sql<SecretRow>`
          INSERT INTO secrets (id, scope, name, value) VALUES (${crypto.randomUUID()}, ${scope}, ${name}, ${blob})
          ON CONFLICT (scope, name) DO UPDATE SET value = excluded.value, updated_at = ${sql.literal(now)}
          RETURNING *`.pipe(Effect.orDie);
        yield* changed(scope);
        return toInfo(rows[0]!);
      }),

    remove: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<SecretRow>`DELETE FROM secrets WHERE id = ${id} RETURNING *`.pipe(Effect.orDie);
        if (!rows[0]) return null;
        yield* changed(rows[0].scope);
        return toInfo(rows[0]);
      }),

    removeScope: (scope) =>
      sql`DELETE FROM secrets WHERE scope = ${scope}`.pipe(Effect.orDie, Effect.andThen(changed(scope))),

    available: (appId) =>
      Effect.gen(function* () {
        const own = (yield* rowsOf(appId)).map((r) => r.name);
        const workspace = (yield* workspaceRows(appId)).map((r) => r.name).filter((n) => !own.includes(n));
        const shadowed = new Set([...own, ...workspace]);
        const { globals, allowed } = yield* allowedGlobals(appId);
        const allowedNames = new Set(allowed.map((r) => r.name));
        return {
          own,
          workspace,
          global: [...allowedNames].filter((n) => !shadowed.has(n)),
          globalNotAllowed: globals.map((r) => r.name).filter((n) => !allowedNames.has(n) && !shadowed.has(n)),
        };
      }),

    envFor: (appId) =>
      Effect.gen(function* () {
        const own = yield* rowsOf(appId);
        const workspace = yield* workspaceRows(appId);
        const { allowed } = yield* allowedGlobals(appId);
        const env: Record<string, string> = {};
        // The app's own secrets win over its workspace's, and those over global ones of the same name.
        const rows = [...allowed, ...workspace, ...own];
        for (const row of rows) env[row.name] = yield* vault.decrypt(row.value, context(row.scope, row.name));
        const used = rows.map((r) => r.id);
        if (used.length)
          yield* sql`UPDATE secrets SET last_used_at = ${sql.literal(now)} WHERE id IN ${sql.in(used)}`.pipe(
            Effect.orDie,
          );
        return env;
      }),
  } satisfies SecretsShape;
});

export const layer = Layer.effect(Secrets, make);
