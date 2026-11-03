// Codex through `codex app-server` (JSON-RPC over stdio). A process per turn:
// threads are stored by Codex itself, so a new process resumes them by id.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProviderModel } from "../../shared/api";
import type { ProviderSettings } from "../../shared/settings";
import { readConfig } from "../Config";
import { commandActivity, describeTool, displayPath, streamFrom, type Probe, type ProviderDriver } from "./Provider";
import { agentEnv, findBinary, kill, readLines, runCommand, tailOf } from "./process";
import { VERSION } from "../../shared/version";

type Json = Record<string, any>;

/** A running app-server with request/response matching. */
class AppServer {
  private proc;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr: () => string;
  onNotification: (method: string, params: Json) => void = () => {};
  readonly exited: Promise<number>;

  constructor(binary: string, cwd: string, env: Record<string, string>) {
    this.proc = Bun.spawn([binary, "app-server"], {
      cwd,
      env: agentEnv(env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stderr = tailOf(this.proc.stderr);
    this.exited = this.proc.exited;
    void readLines(this.proc.stdout, (line) => this.receive(line));
    void this.exited.then((code) => {
      const error = new Error(`Codex exited (code ${code})${this.stderr() ? `: ${this.stderr().slice(-1500)}` : ""}`);
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
    });
  }

  private receive(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // A request from the server (approvals, user input). Rune Browser runs Codex
      // without approvals, so anything that still asks is declined.
      this.write({ id: msg.id, error: { code: -32601, message: "Rune Browser doesn't handle this request" } });
    } else if (msg.id !== undefined) {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (msg.error) call.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else call.resolve(msg.result);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params ?? {});
    }
  }

  private write(msg: Json) {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    this.proc.stdin.flush();
  }

  request<T = any>(method: string, params: Json = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Json) {
    this.write(params ? { method, params } : { method });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "rune", title: "Rune Browser", version: VERSION },
      capabilities: null,
    });
    this.notify("initialized");
  }

  close() {
    kill(this.proc);
  }
}

const binaryFor = (settings: ProviderSettings) => findBinary("codex", settings.binaryPath);

/** MCP servers from the user's own Codex config (turned off when Codex must not have tools). */
function userMcpServers(): string[] {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    const config = Bun.TOML.parse(readFileSync(file, "utf8")) as { mcp_servers?: Record<string, unknown> };
    return Object.keys(config.mcp_servers ?? {});
  } catch {
    return [];
  }
}

/**
 * Codex without any tools of its own: no shell, code execution, file viewing,
 * web search or connected apps, and none of the user's MCP servers. For
 * untrusted input (web pages, apps' AI requests). Verified by asking it to
 * read a file: it can't.
 */
const noTools = () => ({
  features: {
    shell_tool: false,
    unified_exec: false,
    code_mode: false,
    js_repl: false,
    view_image: false,
    apps: false,
    goals: false,
  },
  web_search: "disabled",
  mcp_servers: Object.fromEntries(userMcpServers().map((name) => [name, { enabled: false }])),
});

export const CodexDriver: ProviderDriver = {
  id: "codex",
  label: "Codex",

  probe: (settings) =>
    Effect.tryPromise(async (): Promise<Probe> => {
      const binary = binaryFor(settings);
      if (!binary) {
        return {
          state: "missing",
          version: null,
          binary: null,
          message: "Install Codex: npm install -g @openai/codex",
          models: [],
          defaultModel: null,
        };
      }
      const version =
        (await runCommand(binary, ["--version"], { timeoutMs: 10_000 })).stdout.trim().replace(/^codex-cli\s*/, "") ||
        null;
      const server = new AppServer(binary, readConfig().agentDir, {});
      try {
        await server.initialize();
        const [account, models] = await Promise.all([
          server.request<{ account: Json | null; requiresOpenaiAuth: boolean }>("account/read", {}),
          server.request<{ data: Json[] }>("model/list", {}),
        ]);
        const signedIn = !!account.account || !account.requiresOpenaiAuth;
        const list: ProviderModel[] = models.data
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.model,
            name: m.displayName,
            description: m.description,
            efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => e.reasoningEffort),
          }));
        const plan =
          account.account?.type === "chatgpt" ? `ChatGPT ${account.account.planType}` : account.account?.type;
        return {
          state: signedIn ? "ready" : "signed-out",
          version,
          binary,
          message: signedIn ? (plan ? `Signed in (${plan})` : null) : "Sign in by running `codex login` in a terminal.",
          models: list,
          defaultModel: models.data.find((m) => m.isDefault)?.model ?? null,
        };
      } finally {
        server.close();
      }
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((err) =>
        Effect.succeed<Probe>({
          state: "error",
          version: null,
          binary: binaryFor(settings),
          message: err instanceof Error ? err.message : String(err),
          models: [],
          defaultModel: null,
        }),
      ),
    ),

  run: (input, settings) =>
    streamFrom(async (emit, signal) => {
      const binary = binaryFor(settings);
      if (!binary) throw new Error("Codex isn't installed (npm install -g @openai/codex).");
      const server = new AppServer(binary, input.cwd, input.env);
      let threadId: string | undefined;
      let turnId: string | undefined;
      const onAbort = () => {
        if (threadId && turnId) void server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
        setTimeout(() => server.close(), 1000);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const done = new Promise<void>((resolve, reject) => {
          server.onNotification = (method, params) => {
            if (params.threadId && threadId && params.threadId !== threadId) return;
            switch (method) {
              case "item/agentMessage/delta":
                emit({ type: "delta", text: params.delta });
                break;
              case "item/completed": {
                const item = params.item as Json;
                if (item.type === "agentMessage" && item.text?.trim()) emit({ type: "text", text: item.text.trim() });
                else if (item.type === "commandExecution")
                  emit({
                    type: "tool",
                    activity: commandActivity(
                      item.command,
                      item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0),
                    ),
                  });
                else if (item.type === "fileChange") {
                  for (const change of item.changes ?? [])
                    emit({
                      type: "tool",
                      activity: {
                        kind: change.kind?.type === "add" ? "create" : "edit",
                        title: `${change.kind?.type === "add" ? "Created" : change.kind?.type === "delete" ? "Deleted" : "Edited"} ${displayPath(change.path, input.cwd)}`,
                      },
                    });
                } else if (item.type === "webSearch") {
                  emit({
                    type: "tool",
                    activity: {
                      kind: "web",
                      title: item.query
                        ? `Searched the web for “${String(item.query).slice(0, 60)}”`
                        : "Searched the web",
                    },
                  });
                } else if (item.type === "mcpToolCall" && item.server !== input.mcp?.name) {
                  // Rune Browser's own tools report themselves (Agent.ts).
                  const activity = describeTool(`mcp__${item.server}__${item.tool}`, item.arguments ?? {}, input.cwd);
                  if (item.status === "failed" || item.error) activity.failed = true;
                  emit({ type: "tool", activity });
                } else if (item.type === "imageView") {
                  emit({
                    type: "tool",
                    activity: { kind: "read", title: `Viewed ${displayPath(item.path, input.cwd)}` },
                  });
                }
                break;
              }
              case "error":
                if (!params.willRetry)
                  emit({ type: "error", message: params.error?.message ?? "Codex reported an error" });
                break;
              case "turn/completed": {
                const turn = params.turn as Json;
                if (turn.status === "failed")
                  emit({ type: "error", message: turn.error?.message ?? "The turn failed" });
                resolve();
                break;
              }
            }
          };
          server.exited.then((code) => reject(new Error(`Codex exited unexpectedly (code ${code})`)));
        });

        await server.initialize();
        const common = {
          cwd: input.cwd,
          model: input.model,
          approvalPolicy: "never",
          sandbox: input.access === "workspace" ? "workspace-write" : "read-only",
          developerInstructions: input.instructions,
          ...(input.ephemeral ? { ephemeral: true } : {}),
          config: (() => {
            const locked = input.access === "none" ? noTools() : null;
            const rune = input.mcp
              ? { [input.mcp.name]: { url: input.mcp.url, default_tools_approval_mode: "approve" } }
              : {};
            return {
              ...locked,
              mcp_servers: { ...locked?.mcp_servers, ...rune },
              sandbox_workspace_write: { network_access: true },
            };
          })(),
        };
        const thread = input.resume
          ? await server
              .request("thread/resume", { threadId: input.resume, ...common })
              .catch(() => server.request("thread/start", common))
          : await server.request("thread/start", common);
        threadId = thread.thread.id as string;
        emit({ type: "session", id: threadId });

        const turn = await server.request("turn/start", {
          threadId,
          // Attached images as local images the model sees; PDFs by their path.
          input: [
            ...(input.files ?? [])
              .filter((f) => f.mime.startsWith("image/"))
              .map((f) => ({ type: "localImage", path: f.path })),
            { type: "text", text: withPdfPaths(input), text_elements: [] },
          ],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        });
        turnId = turn.turn.id;
        await done;
      } finally {
        signal.removeEventListener("abort", onAbort);
        server.close();
      }
    }),
};

/** Codex can't take PDFs as content: it gets their paths to read. */
const withPdfPaths = (input: { prompt: string; files?: readonly { path: string; mime: string; name: string }[] }) => {
  const pdfs = (input.files ?? []).filter((f) => f.mime === "application/pdf");
  return pdfs.length
    ? `${input.prompt}\n\nPDFs the user attached: ${pdfs.map((f) => `${f.name} (${f.path})`).join(", ")}`
    : input.prompt;
};
