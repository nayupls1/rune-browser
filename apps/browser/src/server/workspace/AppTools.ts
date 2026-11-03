// The tool registry: what apps can do, for the user, agents and other apps.
// An app's tools are the actions it declares in rune.json and the basic
// ones Rune Browser derives from its data (list, get, add, update, delete per
// table); an action with a data tool's id replaces it, and "dataTools" in
// rune.json turns the derived ones down to read-only or off.
//
// Every call goes through here, so Rune Browser is the hub between apps: nobody
// talks to another app directly. The user may call anything. An app (its
// server or its agent) may call its own tools; another app's only in the same
// workspace and after the user allows it (reading data: "app.data", the same
// permission as the data API; anything else: "app.tool", per tool). Every call
// is in the audit log.
import { Context, Data, Effect, Layer } from "effect";
import type { AppSummary, AppTool, AppToolsInfo, ToolParam, ToolResult } from "../../shared/api";
import { Apps } from "../db/Apps";
import { Audit } from "../security/Audit";
import { Permissions } from "../security/Permissions";
import { AppData, AppDataError, type TableSchema } from "./AppData";
import { Runtime } from "./Runtime";
import { Workspace } from "./Workspace";

export class AppToolError extends Data.TaggedError("AppToolError")<{
  readonly status: 400 | 403 | 404 | 409 | 502;
  readonly message: string;
}> {}

/** Who is calling: the user (Rune Browser's UI), an agent working in a tab, or an app's server. */
export type ToolCaller =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly tabId: string; readonly label: string }
  | { readonly kind: "app"; readonly appId: string };

export interface ToolArgs {
  readonly params?: Record<string, unknown>;
  /** Actions that ask for text. */
  readonly input?: string | null;
}

export interface AppToolsShape {
  /** An app's tools (its actions, then the ones from its data). */
  readonly list: (appId: string) => Effect.Effect<AppTool[]>;
  /** The tools of every app in a workspace. */
  readonly catalog: (workspaceId: string) => Effect.Effect<AppToolsInfo[]>;
  readonly call: (
    caller: ToolCaller,
    appId: string,
    toolId: string,
    args: ToolArgs,
  ) => Effect.Effect<ToolResult, AppToolError>;
}

export class AppTools extends Context.Service<AppTools, AppToolsShape>()("rune/AppTools") {}

const MAX_REPLY = 64_000;

/** "Expense items" → "expense-items"; tables starting with "_" are the app's own business. */
const slug = (table: string) =>
  table.startsWith("_")
    ? ""
    : table
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);

const paramType = (sqlType: string): ToolParam["type"] =>
  /INT/i.test(sqlType)
    ? "integer"
    : /REAL|FLOA|DOUB|NUM|DEC/i.test(sqlType)
      ? "number"
      : /BOOL/i.test(sqlType)
        ? "boolean"
        : "string";

/** The basic tools for one table. */
export function dataTools(table: TableSchema, mode: "all" | "read"): AppTool[] {
  const name = slug(table.name);
  if (!name) return [];
  const columnParam = (c: TableSchema["columns"][number], required: boolean): ToolParam => ({
    type: paramType(c.type),
    ...(c.type ? { description: c.type } : {}),
    ...(required ? { required: true } : {}),
  });
  const keyParams = Object.fromEntries(
    table.key.map((k) => {
      const column = table.columns.find((c) => c.name === k);
      return [
        k,
        column ? columnParam(column, true) : { type: "integer", description: "The row's id (rowid)", required: true },
      ];
    }),
  ) as Record<string, ToolParam>;
  const base = { source: "data" as const, table: table.name };
  const tools: AppTool[] = [
    {
      ...base,
      id: `list-${name}`,
      title: `List ${table.name}`,
      description: `Rows of ${table.name}, a page at a time; optionally only those containing a text or with given column values.`,
      readOnly: true,
      op: "list",
      params: {
        search: { type: "string", description: "Text to look for in any text column" },
        where: {
          type: "object",
          description: `Column values the rows must have, e.g. {"${table.columns[0]?.name ?? "id"}": …}`,
        },
        order: { type: "string", description: "Column to sort by" },
        desc: { type: "boolean", description: "Newest/largest first" },
        limit: { type: "integer", description: "Rows per page (default 50, at most 500)" },
        offset: { type: "integer", description: "Rows to skip" },
      },
    },
    { ...base, id: `get-${name}`, title: `Get a row of ${table.name}`, readOnly: true, op: "get", params: keyParams },
  ];
  if (mode === "read") return tools;
  const editable = table.columns.filter((c) => !table.key.includes(c.name) || c.required);
  tools.push(
    {
      ...base,
      id: `add-${name}`,
      title: `Add to ${table.name}`,
      description: `Adds a row to ${table.name} and returns it.`,
      readOnly: false,
      op: "add",
      params: Object.fromEntries(editable.map((c) => [c.name, columnParam(c, c.required)])),
    },
    {
      ...base,
      id: `update-${name}`,
      title: `Change a row of ${table.name}`,
      description: `Changes the given columns of one row (picked by ${table.key.join(", ")}).`,
      readOnly: false,
      op: "update",
      params: {
        ...Object.fromEntries(
          editable.filter((c) => !table.key.includes(c.name)).map((c) => [c.name, columnParam(c, false)]),
        ),
        ...keyParams,
      },
    },
    {
      ...base,
      id: `delete-${name}`,
      title: `Delete a row of ${table.name}`,
      readOnly: false,
      op: "delete",
      params: keyParams,
    },
  );
  return tools;
}

/** Checks arguments against a tool's params: required ones present, types right, nothing unknown. */
export function checkParams(tool: AppTool, params: Record<string, unknown>): string | null {
  for (const [name, spec] of Object.entries(tool.params)) {
    const value = params[name];
    if (value === undefined || value === null) {
      if (spec.required) return `Missing ${name}`;
      continue;
    }
    const ok =
      spec.type === "string"
        ? typeof value === "string" || typeof value === "number"
        : spec.type === "number"
          ? typeof value === "number" ||
            (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
          : spec.type === "integer"
            ? Number.isInteger(typeof value === "string" && value.trim() !== "" ? Number(value) : value)
            : spec.type === "boolean"
              ? typeof value === "boolean" || value === 0 || value === 1
              : typeof value === "object";
    if (!ok) return `${name} should be ${spec.type === "integer" ? "an integer" : `a ${spec.type}`}`;
  }
  const unknown = Object.keys(params).filter((k) => !(k in tool.params));
  return unknown.length
    ? `${tool.id} has no ${unknown.join(", ")} (it takes ${Object.keys(tool.params).join(", ") || "nothing"})`
    : null;
}

/** Strings from forms as the param's type. */
const coerce = (tool: AppTool, params: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(params).map(([k, v]) => {
      const type = tool.params[k]?.type;
      if (typeof v === "string" && (type === "number" || type === "integer") && v.trim() !== "") return [k, Number(v)];
      return [k, v];
    }),
  );

export const make = Effect.gen(function* () {
  const apps = yield* Apps;
  const workspace = yield* Workspace;
  const appData = yield* AppData;
  const runtime = yield* Runtime;
  const permissions = yield* Permissions;
  const audit = yield* Audit;

  /** The app's tools, and where its actions are served. */
  const toolsOf = (appId: string) =>
    Effect.gen(function* () {
      const manifest = yield* workspace.manifest(appId).pipe(Effect.orElseSucceed(() => null));
      const endpoints = new Map(
        (manifest?.actions ?? []).flatMap((a) => (a.endpoint ? [[a.id, a.endpoint] as const] : [])),
      );
      if (!manifest) return { tools: [] as AppTool[], endpoints };
      const actions: AppTool[] = (manifest.actions ?? []).map((a) => ({
        id: a.id,
        title: a.title,
        ...(a.description ? { description: a.description } : {}),
        source: "action",
        readOnly: false,
        params: a.params ?? {},
        ...(a.input ? { input: a.input } : {}),
        ...(a.path ? { path: a.path } : {}),
      }));
      const mode = manifest.dataTools ?? "all";
      const derived = mode === "none" ? [] : (yield* appData.schema(appId)).flatMap((t) => dataTools(t, mode));
      const taken = new Set(actions.map((a) => a.id));
      const seen = new Set<string>();
      const tools = [
        ...actions,
        ...derived.filter((t) => {
          if (taken.has(t.id) || seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        }),
      ];
      return { tools, endpoints };
    });

  const list = (appId: string) => toolsOf(appId).pipe(Effect.map((t) => t.tools));

  /** The app making the call (its own, or the one its agent works on); null for the user. */
  const callerApp = (caller: ToolCaller) =>
    caller.kind === "user" ? Effect.succeed(null) : apps.get(caller.kind === "agent" ? caller.tabId : caller.appId);

  const describe = (tool: AppTool, target: AppSummary) =>
    tool.op === "list" || tool.op === "get"
      ? `read the rows of ${tool.table}`
      : tool.op === "add"
        ? `add rows to ${tool.table}`
        : tool.op === "update"
          ? `change rows of ${tool.table}`
          : tool.op === "delete"
            ? `delete rows of ${tool.table}`
            : `run "${tool.title}" in ${target.name}`;

  /** Whether the caller may use the tool (asks the user when needed). */
  const authorize = (caller: ToolCaller, from: AppSummary | null, target: AppSummary, tool: AppTool) =>
    Effect.gen(function* () {
      if (caller.kind === "user" || from?.id === target.id) return;
      if (!from || from.workspaceId !== target.workspaceId)
        return yield* new AppToolError({ status: 404, message: "No such app in this workspace" });
      const who = caller.kind === "agent" ? `The agent in "${from.name}"` : `"${from.name}"`;
      const allowed = tool.readOnly
        ? yield* permissions.ask({
            ...(caller.kind === "agent" ? { agentTab: caller.tabId } : {}),
            subject: from.id,
            action: "app.data",
            resource: target.id,
            title: `Let ${who} read the data of "${target.name}"?`,
            detail: `It wants to ${describe(tool, target)} (${tool.id}). It can't change anything.`,
            timeoutMs: 120_000,
          })
        : yield* permissions.ask({
            ...(caller.kind === "agent" ? { agentTab: caller.tabId } : {}),
            subject: from.id,
            action: "app.tool",
            resource: `${target.id}/${tool.id}`,
            title: `Let ${who} ${tool.source === "data" ? `${describe(tool, target)} in "${target.name}"` : describe(tool, target)}?`,
            detail:
              tool.source === "data"
                ? `It wants to use "${tool.title}" (${tool.id}), which changes what "${target.name}" stored.`
                : `It wants to use "${tool.title}" (${tool.id}), an action "${target.name}" offers. What it does is up to "${target.name}".`,
            timeoutMs: 120_000,
          });
      if (!allowed) {
        return yield* new AppToolError({
          status: 403,
          message: `The user didn't allow using ${tool.id} in "${target.name}". It can be allowed in Rune Browser's Settings → Permissions.`,
        });
      }
    });

  const runData = (appId: string, tool: AppTool, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const table = tool.table!;
      const keyOf = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, params[k]]));
      const schema = (yield* appData.schema(appId)).find((t) => t.name === table);
      if (!schema) return yield* new AppDataError({ status: 404, message: `No table "${table}"` });
      const rest = () => Object.fromEntries(Object.entries(params).filter(([k]) => !schema.key.includes(k)));
      switch (tool.op) {
        case "list": {
          const where = (params.where ?? {}) as Record<string, string | number | null>;
          const page = yield* appData.rows(appId, table, {
            search: params.search as string | undefined,
            where: Object.fromEntries(
              Object.entries(where).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v]),
            ),
            orderBy: params.order as string | undefined,
            desc: params.desc === true,
            limit: (params.limit as number | undefined) ?? 50,
            offset: params.offset as number | undefined,
          });
          return {
            ok: true,
            status: 200,
            message: `${page.total} rows${page.rows.length < page.total ? ` (${page.rows.length} shown)` : ""}`,
            data: page,
          };
        }
        case "get":
          return {
            ok: true,
            status: 200,
            message: "Found it",
            data: yield* appData.getRow(appId, table, keyOf([...schema.key])),
          };
        case "add":
          return {
            ok: true,
            status: 200,
            message: `Added a row to ${table}`,
            data: yield* appData.insertRow(appId, table, params),
          };
        case "update":
          return {
            ok: true,
            status: 200,
            message: `Changed a row of ${table}`,
            data: yield* appData.updateRow(appId, table, keyOf([...schema.key]), rest()),
          };
        default:
          yield* appData.deleteRow(appId, table, keyOf([...schema.key]));
          return { ok: true, status: 200, message: `Deleted a row of ${table}` };
      }
    }).pipe(
      Effect.catchTag("AppDataError", (e) =>
        Effect.succeed({ ok: false, status: e.status, message: e.message } satisfies ToolResult),
      ),
    );

  /** POSTs { input, params } to the app's endpoint (starting the app if needed). */
  const runAction = (
    target: AppSummary,
    endpoint: string,
    caller: ToolCaller,
    args: ToolArgs,
    params: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      yield* runtime.ensure(target.id);
      const status = yield* runtime.settled(target.id, 90_000);
      if (status.state !== "running" || !status.url) {
        return yield* new AppToolError({
          status: 409,
          message: `${target.name} isn't running${status.error ? `: ${status.error}` : ""}`,
        });
      }
      return yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${status.url}${endpoint}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Who asked: "user", "agent" or "app:<id>" (the app may treat them differently).
              "X-Rune-Caller": caller.kind === "app" ? `app:${caller.appId}` : caller.kind,
            },
            body: JSON.stringify({ input: args.input ?? null, params }),
            signal: AbortSignal.timeout(30_000),
          });
          const text = (await res.text()).slice(0, MAX_REPLY);
          let message = text.trim();
          let data: unknown;
          try {
            data = JSON.parse(text);
            const body = data as { message?: unknown; error?: unknown } | null;
            if (typeof body?.message === "string") message = body.message;
            else if (typeof body?.error === "string") message = body.error;
          } catch {
            // plain text
          }
          return {
            ok: res.ok,
            status: res.status,
            message: message.slice(0, 500),
            ...(data !== undefined ? { data } : {}),
          } satisfies ToolResult;
        },
        catch: (err) =>
          new AppToolError({
            status: 502,
            message: `${target.name} didn't answer: ${err instanceof Error ? err.message : String(err)}`,
          }),
      });
    });

  const call = (caller: ToolCaller, appId: string, toolId: string, args: ToolArgs) =>
    Effect.gen(function* () {
      const target = yield* apps.get(appId);
      if (!target || target.kind !== "app") return yield* new AppToolError({ status: 404, message: "No such app" });
      const { tools, endpoints } = yield* toolsOf(appId);
      const tool = tools.find((t) => t.id === toolId);
      if (!tool) return yield* new AppToolError({ status: 404, message: `${target.name} has no tool "${toolId}"` });
      const from = yield* callerApp(caller);
      const actor =
        caller.kind === "user"
          ? { actor: "user" as const, actorLabel: "You" }
          : caller.kind === "agent"
            ? { actor: "agent" as const, actorLabel: caller.label }
            : { actor: "app" as const, actorLabel: from?.name ?? "An app" };
      const record = (outcome: "ok" | "error" | "denied", detail: string | null) =>
        audit.record({
          ...actor,
          tabId: from?.id ?? target.id,
          action: "app.action",
          target: from && from.id !== target.id ? `${target.name} · ${tool.title}` : tool.title,
          outcome,
          detail,
        });

      if (tool.path)
        return yield* new AppToolError({
          status: 400,
          message: `"${tool.title}" opens a page in ${target.name}; only the user can do that.`,
        });
      yield* authorize(caller, from, target, tool).pipe(
        Effect.tapError((e) => (e.status === 403 ? record("denied", null) : Effect.void)),
      );
      const params = coerce(tool, args.params ?? {});
      const problem = checkParams(tool, params);
      if (problem) {
        yield* record("error", problem);
        return yield* new AppToolError({ status: 400, message: problem });
      }
      const result: ToolResult =
        tool.source === "data"
          ? yield* runData(appId, tool, params)
          : yield* runAction(target, endpoints.get(tool.id)!, caller, args, params).pipe(
              Effect.tapError((e) => record("error", e.message)),
            );
      yield* record(result.ok ? "ok" : "error", result.ok ? null : `${result.status}: ${result.message.slice(0, 200)}`);
      return result;
    });

  return {
    list,
    catalog: (workspaceId) =>
      Effect.gen(function* () {
        const out: AppToolsInfo[] = [];
        for (const app of yield* apps.list()) {
          if (app.kind !== "app" || app.workspaceId !== workspaceId) continue;
          out.push({
            appId: app.id,
            appName: app.name,
            appIcon: app.icon,
            workspaceId: app.workspaceId,
            tools: yield* list(app.id),
          });
        }
        return out;
      }),
    call,
  } satisfies AppToolsShape;
});

export const layer = Layer.effect(AppTools, make);
