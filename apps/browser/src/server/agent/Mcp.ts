// Rune Browser's tools for agents, served as an MCP server over streamable HTTP so
// every provider can use them. Each agent turn registers its tools under a
// random token (/mcp/<token>); the token is the only way in, and it's gone
// when the turn ends.
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { VERSION } from "../../shared/version";

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** A Schema.Struct describing the arguments. */
  readonly input: Schema.Top;
  readonly run: (args: any) => Effect.Effect<ToolResult>;
}

/** Defines a tool with typed arguments. Failures become error results the agent can read. */
export const tool = <S extends Schema.Top>(
  name: string,
  description: string,
  input: S,
  run: (args: S["Type"]) => Effect.Effect<ToolResult | string, unknown>,
): Tool => ({
  name,
  description,
  input,
  run: (args) =>
    run(args).pipe(
      Effect.map((result) => (typeof result === "string" ? text(result) : result)),
      Effect.catch((err) => Effect.succeed(text(errorText(err), true))),
    ),
});

const errorText = (err: unknown): string =>
  err instanceof Error ||
  (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string")
    ? (err as { message: string }).message
    : String(err);

export const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });

export const NoArgs = Schema.Struct({});

export interface McpShape {
  /** Registers tools for the length of the scope; returns their endpoint URL. */
  readonly register: (tools: Tool[]) => Effect.Effect<string, never, import("effect").Scope.Scope>;
  /** Handles one JSON-RPC message (or batch); null means "no response" (notifications). */
  readonly handle: (token: string, body: unknown) => Effect.Effect<unknown | null, McpUnknownToken>;
}

export class McpUnknownToken {
  readonly _tag = "McpUnknownToken";
}

export class Mcp extends Context.Service<Mcp, McpShape>()("rune/Mcp") {}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/** MCP clients require an object schema (an empty Struct comes out as `{ not: { type: "null" } }`). */
export const jsonSchema = (schema: Schema.Top) => {
  const doc = Schema.toJsonSchemaDocument(schema);
  const root = doc.schema as { type?: unknown; properties?: object };
  return {
    ...(root.type === "object" ? root : { type: "object", properties: {} }),
    ...(Object.keys(doc.definitions).length ? { $defs: doc.definitions } : {}),
  };
};

export const make = (baseUrl: string) =>
  Effect.sync((): McpShape => {
    const sessions = new Map<string, Map<string, Tool>>();

    const respond = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
    const failure = (id: Rpc["id"], code: number, message: string) => ({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    });

    const call = (tools: Map<string, Tool>, msg: Rpc): Effect.Effect<unknown | null> => {
      if (!msg.method) return Effect.succeed(failure(msg.id, -32600, "Invalid request"));
      // Notifications get no response.
      if (msg.id === undefined || msg.id === null) return Effect.succeed(null);
      switch (msg.method) {
        case "initialize":
          return Effect.succeed(
            respond(msg.id, {
              protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "rune", title: "Rune Browser", version: VERSION },
            }),
          );
        case "ping":
          return Effect.succeed(respond(msg.id, {}));
        case "tools/list":
          return Effect.succeed(
            respond(msg.id, {
              tools: [...tools.values()].map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: jsonSchema(t.input),
              })),
            }),
          );
        case "tools/call": {
          const t = tools.get(msg.params?.name);
          if (!t) return Effect.succeed(failure(msg.id, -32602, `Unknown tool: ${msg.params?.name}`));
          let args: unknown;
          try {
            args = Schema.decodeUnknownSync(t.input as Schema.Codec<unknown>)(msg.params?.arguments ?? {});
          } catch (err) {
            return Effect.succeed(respond(msg.id, text(`Invalid arguments: ${errorText(err)}`, true)));
          }
          return t.run(args).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed(text(`The tool failed: ${errorText(Cause.squash(cause))}`, true)),
            ),
            Effect.map((result) => respond(msg.id, result)),
          );
        }
        default:
          return Effect.succeed(failure(msg.id, -32601, `Method not found: ${msg.method}`));
      }
    };

    return {
      register: (tools) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const token = crypto.randomUUID().replaceAll("-", "");
            sessions.set(token, new Map(tools.map((t) => [t.name, t])));
            return token;
          }),
          (token) => Effect.sync(() => sessions.delete(token)),
        ).pipe(Effect.map((token) => `${baseUrl}/mcp/${token}`)),

      handle: (token, body) =>
        Effect.gen(function* () {
          const tools = sessions.get(token);
          if (!tools) return yield* Effect.fail(new McpUnknownToken());
          if (Array.isArray(body)) {
            const results = yield* Effect.forEach(body as Rpc[], (msg) => call(tools, msg));
            const out = results.filter((r) => r !== null);
            return out.length ? out : null;
          }
          return yield* call(tools, body as Rpc);
        }),
    };
  });

export const layer = (baseUrl: string) => Layer.effect(Mcp, make(baseUrl));
