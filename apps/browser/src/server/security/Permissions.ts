// Permissions: what an app or agent may do beyond its own sandbox. When
// something new is requested, the user is asked in the UI (allow once,
// always allow, deny); remembered choices are stored and can be revoked.
// A choice can be remembered for one app or for every app in its workspace
// (subject "workspace:<id>"); the app's own choice wins. Unanswered requests
// are denied after a timeout.
import { Context, Deferred, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import {
  workspaceOfScope,
  workspaceScope,
  type PermissionAction,
  type PermissionGrant,
  type PermissionRequest,
} from "../../shared/api";
import { topics } from "../../shared/hub";
import { Apps } from "../db/Apps";
import { Settings } from "../db/Settings";
import { Hub } from "../Hub";
import { Audit } from "./Audit";

/** The website agents of all web tabs share their site permissions. */
export const WEBSITE_AGENT = "website-agent";

interface GrantRow {
  id: number;
  subject: string;
  action: PermissionAction;
  resource: string;
  decision: "allow" | "deny";
  created_at: string;
  app_name: string | null;
  app_workspace: string | null;
  workspace_name: string | null;
}

/** Grants with the names of their app or workspace. */
const GRANTS = `
  SELECT p.*, a.name AS app_name, a.workspace_id AS app_workspace, w.name AS workspace_name
  FROM permissions p
  LEFT JOIN apps a ON a.id = p.subject
  LEFT JOIN workspaces w ON 'workspace:' || w.id = p.subject`;

export interface AskInput {
  readonly subject: string;
  readonly action: PermissionAction;
  readonly resource: string;
  readonly title: string;
  readonly detail: string;
  readonly timeoutMs: number;
  /** Asked every time: the answer is never remembered (confirming one action). */
  readonly once?: boolean;
  /** The change it's about, as a unified diff (shown as code). */
  readonly diff?: string;
  /** The tab whose agent asks. With full access (Settings → Agent) it's allowed without asking, and logged. */
  readonly agentTab?: string;
}

export interface PermissionsShape {
  /** The remembered decision, if any. */
  readonly decision: (
    subject: string,
    action: PermissionAction,
    resource: string,
  ) => Effect.Effect<"allow" | "deny" | null>;
  /** The remembered decision, else asks the user (false if they deny or don't answer in time). */
  readonly ask: (input: AskInput) => Effect.Effect<boolean>;
  /** remember: for this subject, or (apps) for every app in its workspace. */
  readonly answer: (id: string, allow: boolean, remember: false | "subject" | "workspace") => Effect.Effect<boolean>;
  readonly pending: Effect.Effect<PermissionRequest[]>;
  readonly list: Effect.Effect<PermissionGrant[]>;
  /** Remembers a decision (from the UI, e.g. letting an app use a global secret). */
  readonly set: (
    subject: string,
    action: PermissionAction,
    resource: string,
    decision: "allow" | "deny",
  ) => Effect.Effect<void>;
  readonly revoke: (id: number) => Effect.Effect<PermissionGrant | null>;
  /** Forgets everything about a subject (the app was deleted). */
  readonly forget: (subject: string) => Effect.Effect<void>;
}

export class Permissions extends Context.Service<Permissions, PermissionsShape>()("rune/Permissions") {}

export const subjectName = (subject: string, appName: string | null, workspaceName: string | null = null) =>
  subject === WEBSITE_AGENT
    ? "Website agent"
    : workspaceOfScope(subject)
      ? `Apps in ${workspaceName ?? "a deleted workspace"}`
      : (appName ?? "A deleted app");

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Hub;
  const audit = yield* Audit;
  const apps = yield* Apps;
  const settings = yield* Settings;
  const waiting = new Map<string, { request: PermissionRequest; deferred: Deferred.Deferred<boolean> }>();

  const toGrant = (r: GrantRow): PermissionGrant => ({
    id: r.id,
    subject: r.subject,
    subjectName: subjectName(r.subject, r.app_name, r.workspace_name),
    workspaceId: workspaceOfScope(r.subject) ?? r.app_workspace,
    action: r.action,
    resource: r.resource,
    decision: r.decision,
    createdAt: r.created_at,
  });

  const changed = hub.publish({ type: "permissions-changed", topic: topics.activity });

  // The subject's own decision, else (apps) the one for its workspace.
  const decision = (subject: string, action: PermissionAction, resource: string) =>
    sql<{ decision: "allow" | "deny" }>`
      SELECT decision FROM permissions
      WHERE action = ${action} AND resource = ${resource}
        AND (subject = ${subject} OR subject = (SELECT 'workspace:' || workspace_id FROM apps WHERE id = ${subject}))
      ORDER BY subject = ${subject} DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]?.decision ?? null),
      Effect.orDie,
    );

  const set = (subject: string, action: PermissionAction, resource: string, value: "allow" | "deny") =>
    sql`INSERT INTO permissions (subject, action, resource, decision) VALUES (${subject}, ${action}, ${resource}, ${value})
        ON CONFLICT (subject, action, resource) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`.pipe(
      Effect.orDie,
      Effect.andThen(changed),
    );

  const nameOf = (subject: string) =>
    subject === WEBSITE_AGENT
      ? Effect.succeed("Website agent")
      : apps.get(subject).pipe(Effect.map((a) => a?.name ?? "A deleted app"));

  const workspaceOf = (subject: string) =>
    sql<{
      id: string;
      name: string;
    }>`SELECT w.id, w.name FROM workspaces w JOIN apps a ON a.workspace_id = w.id WHERE a.id = ${subject}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );

  const resolve = (id: string, allow: boolean) =>
    Effect.gen(function* () {
      const entry = waiting.get(id);
      if (!entry) return false;
      waiting.delete(id);
      yield* Deferred.succeed(entry.deferred, allow);
      yield* hub.publish({ type: "permission-resolved", topic: topics.permissions, id });
      return true;
    });

  return {
    decision,
    set,

    ask: (input) =>
      Effect.gen(function* () {
        if (input.agentTab && (yield* settings.get()).agent.permissions === "full") {
          yield* audit.record({
            actor: "rune",
            actorLabel: "Full access",
            tabId: input.agentTab,
            action: "permission.auto",
            target: `${input.action}${input.resource ? ` ${input.resource}` : ""}`,
            detail: `Allowed without asking (full access): ${input.title}`,
          });
          return true;
        }
        const known = input.once ? null : yield* decision(input.subject, input.action, input.resource);
        if (known) return known === "allow";
        // The same question asked twice while waiting gets the same answer.
        let entry = [...waiting.values()].find(
          (w) =>
            w.request.subject === input.subject &&
            w.request.action === input.action &&
            w.request.resource === input.resource,
        );
        if (!entry) {
          const request: PermissionRequest = {
            id: crypto.randomUUID(),
            subject: input.subject,
            subjectName: yield* nameOf(input.subject),
            workspace: yield* workspaceOf(input.subject),
            action: input.action,
            resource: input.resource,
            title: input.title,
            detail: input.detail,
            ...(input.once ? { once: true } : {}),
            ...(input.diff ? { diff: input.diff } : {}),
            createdAt: new Date().toISOString(),
          };
          entry = { request, deferred: yield* Deferred.make<boolean>() };
          waiting.set(request.id, entry);
          yield* hub.publish({ type: "permission-request", topic: topics.permissions, request });
        }
        const { request, deferred } = entry;
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: input.timeoutMs,
            orElse: () =>
              resolve(request.id, false).pipe(
                Effect.andThen(
                  audit.record({
                    actor: "rune",
                    actorLabel: "Rune Browser",
                    tabId: input.subject === WEBSITE_AGENT ? null : input.subject,
                    action: "permission.timeout",
                    target: `${input.action}${input.resource ? ` ${input.resource}` : ""}`,
                    detail: `${request.subjectName}: nobody answered, denied`,
                    outcome: "denied",
                  }),
                ),
                Effect.as(false),
              ),
          }),
        );
      }),

    answer: (id, allow, remember) =>
      Effect.gen(function* () {
        const entry = waiting.get(id);
        if (!entry) return false;
        const { request } = entry;
        // Confirmations of one action are never remembered.
        if (request.once) remember = false;
        const forWorkspace = remember === "workspace" && request.workspace;
        if (remember) {
          const subject = forWorkspace ? workspaceScope(request.workspace!.id) : request.subject;
          yield* set(subject, request.action, request.resource, allow ? "allow" : "deny");
        }
        yield* audit.record({
          actor: "user",
          actorLabel: "You",
          tabId: request.subject === WEBSITE_AGENT ? null : request.subject,
          action: allow ? "permission.allow" : "permission.deny",
          target: `${request.action}${request.resource ? ` ${request.resource}` : ""}`,
          detail: `${request.subjectName}${forWorkspace ? ` (remembered for all apps in ${request.workspace!.name})` : remember ? " (remembered)" : " (once)"}`,
          outcome: allow ? "ok" : "denied",
        });
        return yield* resolve(id, allow);
      }),

    pending: Effect.sync(() => [...waiting.values()].map((w) => w.request)),

    list: sql.unsafe<GrantRow>(`${GRANTS} ORDER BY p.created_at DESC`).pipe(
      Effect.map((rows) => rows.map(toGrant)),
      Effect.orDie,
    ),

    revoke: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<GrantRow>(`${GRANTS} WHERE p.id = ?`, [id]);
        const row = rows[0];
        if (!row) return null;
        yield* sql`DELETE FROM permissions WHERE id = ${id}`;
        yield* changed;
        return toGrant(row);
      }).pipe(Effect.orDie),

    forget: (subject) =>
      sql`DELETE FROM permissions WHERE subject = ${subject}`.pipe(Effect.orDie, Effect.andThen(changed)),
  } satisfies PermissionsShape;
});

export const layer = Layer.effect(Permissions, make);
