// The provider abstraction: one interface over Claude Code, Codex and
// OpenCode. A driver runs a turn and reports it as a stream of AgentEvents;
// interrupting the stream stops the turn.
import { relative } from "node:path";
import { Data, Effect, Queue, Stream } from "effect";
import type { ProviderId, ProviderModel, ProviderStatus, ToolActivity } from "../../shared/api";
import type { ProviderSettings } from "../../shared/settings";

/** Rune Browser's MCP server for this turn (agent tools: app runtime, pages, …). */
export interface McpEndpoint {
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface TurnInput {
  readonly cwd: string;
  readonly prompt: string;
  /** Rune Browser's instructions, added to the provider's own system prompt. */
  readonly instructions: string;
  readonly model: string | null;
  readonly effort: string | null;
  /** Provider session to continue. */
  readonly resume: string | null;
  /** Rune Browser's tools for the turn; null for plain completions (AI for apps). */
  readonly mcp: McpEndpoint | null;
  /**
   * workspace: the provider's own file and shell tools, confined to `cwd`.
   * none: none of the provider's own tools (no files, shell, web, connectors),
   * only Rune Browser's MCP tools if there are any. Used for untrusted input: the
   * website agent and apps' AI requests.
   */
  readonly access: "workspace" | "none";
  /** A one-off request: don't keep the session around (AI for apps). */
  readonly ephemeral?: boolean;
  /** Extra environment for the agent process (PATH with bun). */
  readonly env: Record<string, string>;
  /** Images (and PDFs) the user attached: given to the model as content it sees. */
  readonly files?: readonly { readonly path: string; readonly mime: string; readonly name: string }[];
}

export type AgentEvent =
  /** The provider session (for resuming the conversation later). */
  | { readonly type: "session"; readonly id: string }
  /** Streamed assistant text. */
  | { readonly type: "delta"; readonly text: string }
  /** A finished assistant message. */
  | { readonly type: "text"; readonly text: string }
  /** A tool call, e.g. "Edited src/App.tsx". */
  | { readonly type: "tool"; readonly activity: ToolActivity }
  | { readonly type: "error"; readonly message: string };

export class ProviderError extends Data.TaggedError("ProviderError")<{ readonly message: string }> {}

export interface Probe {
  readonly state: ProviderStatus["state"];
  readonly version: string | null;
  readonly binary: string | null;
  readonly message: string | null;
  readonly models: ProviderModel[];
  readonly defaultModel: string | null;
}

export interface ProviderDriver {
  readonly id: ProviderId;
  readonly label: string;
  /** Checks that it's installed and signed in, and lists its models. */
  readonly probe: (settings: ProviderSettings) => Effect.Effect<Probe>;
  readonly run: (input: TurnInput, settings: ProviderSettings) => Stream.Stream<AgentEvent, ProviderError>;
}

// --- Describing tool calls ------------------------------------------------------------

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A path for display: relative to the project when inside it. */
export function displayPath(path: unknown, cwd: string): string {
  if (typeof path !== "string" || !path) return "a file";
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** A shell command without the `bash -lc "…"` Codex wraps it in. */
const innerCommand = (command: unknown) => {
  const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  return (/^(?:\/\S*\/)?(?:ba|z)?sh -l?c ['"]?([\s\S]*?)['"]?$/.exec(text)?.[1] ?? text).trim();
};

export const commandActivity = (command: unknown, failed?: boolean): ToolActivity => {
  const inner = innerCommand(command);
  const line = inner.replace(/\s+/g, " ");
  return {
    kind: "command",
    title: `Ran \`${clip(line, 80)}\``,
    ...(line.length > 80 || inner.includes("\n") ? { detail: clip(inner, 4000) } : {}),
    ...(failed ? { failed } : {}),
  };
};

/** Tool arguments as readable detail: short values as they are, long ones clipped. */
export function argsDetail(input: Record<string, unknown>): string | undefined {
  const lines = Object.entries(input).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}: ${clip(text ?? "", 400)}`;
  });
  return lines.length ? clip(lines.join("\n"), 4000) : undefined;
}

const humanize = (name: string) => {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "Edited src/App.tsx" etc. for the file/shell/web tools of any provider, and a plain line for any other tool. */
export function describeTool(name: string, input: Record<string, unknown>, cwd: string): ToolActivity {
  const tool = name.toLowerCase();
  const file = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  switch (tool) {
    case "read":
      return { kind: "read", title: `Read ${displayPath(file, cwd)}` };
    case "write":
      return { kind: "create", title: `Wrote ${displayPath(file, cwd)}` };
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "patch":
      return { kind: "edit", title: `Edited ${displayPath(file, cwd)}` };
    case "bash":
    case "shell":
      return commandActivity(input.command);
    case "glob":
    case "grep":
    case "list":
    case "ls":
      return input.pattern
        ? { kind: "search", title: `Searched for ${clip(String(input.pattern), 60)}`, detail: argsDetail(input) }
        : { kind: "search", title: "Looked through files" };
    case "webfetch":
      return input.url
        ? { kind: "web", title: `Fetched ${clip(String(input.url), 70)}` }
        : { kind: "web", title: "Fetched a page" };
    case "websearch":
      return input.query
        ? { kind: "web", title: `Searched the web for “${clip(String(input.query), 60)}”` }
        : { kind: "web", title: "Searched the web" };
    case "todowrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as { content?: string; status?: string }[]) : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        kind: "plan",
        title: todos.length ? `Updated the plan (${done}/${todos.length} done)` : "Updated the plan",
        ...(todos.length
          ? {
              detail: todos
                .map(
                  (t) =>
                    `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"} ${t.content ?? ""}`,
                )
                .join("\n"),
            }
          : {}),
      };
    }
    case "todoread":
      return { kind: "plan", title: "Checked the plan" };
    case "task":
    case "agent": {
      const what = input.description ?? input.subagent_type;
      return {
        kind: "agent",
        title: what ? `Started a subagent: ${clip(String(what), 60)}` : "Started a subagent",
        ...(typeof input.prompt === "string" ? { detail: clip(input.prompt, 4000) } : {}),
      };
    }
    case "exitplanmode":
      return { kind: "plan", title: "Made a plan" };
    case "toolsearch":
      return { kind: "search", title: "Looked up tools" };
  }
  // MCP tools of other servers: mcp__server__tool (Claude), server_tool (OpenCode).
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return {
    kind: "other",
    title: mcp ? `${humanize(mcp[2]!)} (${mcp[1]})` : humanize(name),
    detail: argsDetail(input),
  };
}

// --- Bridging async producers ---------------------------------------------------------

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A stream of events produced by an async function (SDK iterators, child
 * processes). Interrupting the stream aborts the signal, which must stop the
 * work; a failure after that is reported as a normal end.
 */
export const streamFrom = (
  run: (emit: (event: AgentEvent) => void, signal: AbortSignal) => Promise<void>,
): Stream.Stream<AgentEvent, ProviderError> =>
  Stream.callback<AgentEvent, ProviderError>((queue) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      yield* Effect.tryPromise({
        try: () => run((event) => void Queue.offerUnsafe(queue, event), controller.signal),
        catch: (err) => new ProviderError({ message: errorMessage(err) }),
      }).pipe(
        Effect.matchEffect({
          onSuccess: () => Queue.end(queue),
          onFailure: (err) => (controller.signal.aborted ? Queue.end(queue) : Queue.fail(queue, err)),
        }),
        Effect.forkScoped,
      );
    }),
  );
