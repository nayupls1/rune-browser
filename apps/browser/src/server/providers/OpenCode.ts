// OpenCode through `opencode serve` (HTTP + server-sent events). A server per
// turn, started in the project folder with Rune Browser's MCP server in its config;
// sessions are stored by OpenCode, so a new server resumes them by id.
import { createServer } from "node:net";
import { Effect } from "effect";
import type { ProviderModel } from "../../shared/api";
import type { ProviderSettings } from "../../shared/settings";
import { readConfig } from "../Config";
import { describeTool, streamFrom, type McpEndpoint, type Probe, type ProviderDriver } from "./Provider";
import { agentEnv, findBinary, kill, readLines, runCommand, tailOf } from "./process";

type Json = Record<string, any>;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

/**
 * Without tools of its own (untrusted input): every tool asks for permission
 * and the driver rejects the request, except Rune Browser's own MCP tools. Disabling
 * the tools instead isn't possible: OpenCode's free models refuse requests
 * without its usual tool set. Verified: reads, globs and shell commands are
 * all rejected, inside and outside the working directory.
 */
const askEverything = (mcp: McpEndpoint | null) => ({ "*": "ask", ...(mcp ? { [`${mcp.name}_*`]: "allow" } : {}) });

// Every `opencode serve` still running, killed when the server exits: on their
// own they'd outlive it (a server stopped during its startup probe left one behind).
const running = new Set<ReturnType<typeof Bun.spawn>>();
process.on("exit", () => {
  for (const proc of running) kill(proc);
});

class OpenCodeServer {
  private constructor(
    private proc: ReturnType<typeof Bun.spawn>,
    readonly url: string,
    private auth: string,
    private directory: string,
  ) {}

  static async start(
    binary: string,
    cwd: string,
    env: Record<string, string>,
    mcp: McpEndpoint | null,
    access: "workspace" | "none",
  ) {
    const port = await freePort();
    const password = crypto.randomUUID();
    const config: Json = {
      // Not interactive: in a project everything inside it is allowed, outside it isn't.
      permission:
        access === "workspace"
          ? { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "deny" }
          : askEverything(mcp),
      ...(mcp ? { mcp: { [mcp.name]: { type: "remote", url: mcp.url, headers: mcp.headers, enabled: true } } } : {}),
    };
    const proc = Bun.spawn([binary, "serve", "--hostname=127.0.0.1", `--port=${port}`], {
      cwd,
      env: { ...agentEnv(env), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    running.add(proc);
    void proc.exited.then(() => running.delete(proc));
    const stderr = tailOf(proc.stderr);
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCode didn't start within 30s")), 30_000);
      void readLines(proc.stdout, (line) => {
        const match = /listening on (https?:\/\/\S+)/.exec(line);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      void proc.exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`OpenCode exited (code ${code})${stderr() ? `: ${stderr().slice(-1500)}` : ""}`));
      });
    }).catch((err) => {
      kill(proc);
      throw err;
    });
    return new OpenCodeServer(proc, url, `Basic ${btoa(`opencode:${password}`)}`, cwd);
  }

  private path(path: string) {
    return `${this.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(this.directory)}`;
  }

  async request<T = Json>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.path(path), {
      method,
      headers: { Authorization: this.auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenCode ${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Calls `fn` for every event until the signal aborts. */
  async events(fn: (event: Json) => void, signal: AbortSignal) {
    const res = await fetch(this.path("/event"), {
      headers: { Authorization: this.auth, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`OpenCode events: ${res.status}`);
    await readLines(res.body, (line) => {
      if (!line.startsWith("data:")) return;
      try {
        fn(JSON.parse(line.slice(5)));
      } catch {
        // ignore malformed events
      }
    }).catch((err) => {
      if (!signal.aborted) throw err;
    });
  }

  close() {
    kill(this.proc);
  }
}

const binaryFor = (settings: ProviderSettings) => findBinary("opencode", settings.binaryPath);

/** "provider/model" → { providerID, modelID } */
const splitModel = (model: string) => {
  const i = model.indexOf("/");
  return i === -1 ? null : { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
};

export const OpenCodeDriver: ProviderDriver = {
  id: "opencode",
  label: "OpenCode",

  probe: (settings) =>
    Effect.tryPromise(async (): Promise<Probe> => {
      const binary = binaryFor(settings);
      if (!binary) {
        return {
          state: "missing",
          version: null,
          binary: null,
          message: "Install OpenCode: curl -fsSL https://opencode.ai/install | bash",
          models: [],
          defaultModel: null,
        };
      }
      const version = (await runCommand(binary, ["--version"], { timeoutMs: 10_000 })).stdout.trim() || null;
      const server = await OpenCodeServer.start(binary, readConfig().agentDir, {}, null, "none");
      try {
        const { providers, default: defaults } = await server.request<{
          providers: Json[];
          default: Record<string, string>;
        }>("GET", "/config/providers");
        const models: ProviderModel[] = providers.flatMap((p) =>
          Object.values(p.models as Record<string, Json>).map((m) => ({
            id: `${p.id}/${m.id}`,
            name: m.name ?? m.id,
            group: p.name ?? p.id,
            efforts: [],
          })),
        );
        const [provider, model] = Object.entries(defaults)[0] ?? [];
        return {
          state: models.length ? "ready" : "signed-out",
          version,
          binary,
          message: models.length ? null : "Connect a model provider by running `opencode auth login` in a terminal.",
          models,
          defaultModel: provider && model ? `${provider}/${model}` : null,
        };
      } finally {
        server.close();
      }
    }).pipe(
      Effect.timeout("45 seconds"),
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
      if (!binary) throw new Error("OpenCode isn't installed (https://opencode.ai).");
      const server = await OpenCodeServer.start(binary, input.cwd, input.env, input.mcp, input.access);
      const events = new AbortController();
      let sessionId: string | undefined;
      const onAbort = () => {
        if (sessionId) void server.request("POST", `/session/${sessionId}/abort`).catch(() => {});
        setTimeout(() => events.abort(), 500);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const existing = input.resume
          ? await server.request("GET", `/session/${input.resume}`).catch(() => null)
          : null;
        const session: Json = existing ?? (await server.request("POST", "/session", { title: "Rune Browser" }));
        sessionId = session.id as string;
        emit({ type: "session", id: sessionId });

        // Which messages are the assistant's and which of their parts are text.
        const assistant = new Set<string>();
        const textParts = new Set<string>();
        const reported = new Set<string>();
        let idle!: () => void;
        const finished = new Promise<void>((resolve) => (idle = resolve));

        const listening = server.events((event) => {
          const p = event.properties ?? {};
          if (
            p.sessionID &&
            p.sessionID !== sessionId &&
            p.info?.sessionID !== sessionId &&
            p.part?.sessionID !== sessionId
          )
            return;
          switch (event.type) {
            case "message.updated":
              if (p.info?.role === "assistant") assistant.add(p.info.id);
              if (p.info?.error && !reported.has(p.info.id)) {
                reported.add(p.info.id);
                const err = p.info.error;
                if (err.name !== "MessageAbortedError")
                  emit({ type: "error", message: err.data?.message ?? err.name ?? "OpenCode failed" });
              }
              break;
            case "message.part.delta":
              if (p.field === "text" && textParts.has(p.partID) && assistant.has(p.messageID))
                emit({ type: "delta", text: p.delta });
              break;
            case "message.part.updated": {
              const part = p.part as Json;
              if (!assistant.has(part.messageID)) break;
              if (part.type === "text") {
                textParts.add(part.id);
                if (part.time?.end && part.text?.trim() && !reported.has(part.id)) {
                  reported.add(part.id);
                  emit({ type: "text", text: part.text.trim() });
                }
              } else if (
                part.type === "tool" &&
                (part.state?.status === "completed" || part.state?.status === "error")
              ) {
                if (reported.has(part.id) || (input.mcp && String(part.tool).startsWith(`${input.mcp.name}_`))) break;
                reported.add(part.id);
                const activity = describeTool(part.tool, part.state.input ?? {}, input.cwd);
                if (activity.kind === "other" && part.state.title) activity.title = part.state.title;
                if (part.state.status === "error") activity.failed = true;
                emit({ type: "tool", activity });
              }
              break;
            }
            case "permission.asked": {
              // Nobody can answer: Rune Browser's own tools are fine, everything else is refused.
              const ours = !!input.mcp && String(p.permission ?? "").startsWith(`${input.mcp.name}_`);
              void server
                .request("POST", `/permission/${p.id}/reply`, {
                  reply: ours ? "once" : "reject",
                  message: "Not allowed here.",
                })
                .catch(() => {});
              if (!ours && input.access === "workspace")
                emit({ type: "tool", activity: { kind: "other", title: `Refused: ${p.permission}`, failed: true } });
              break;
            }
            case "session.error":
              if (p.error && p.error.name !== "MessageAbortedError")
                emit({ type: "error", message: p.error.data?.message ?? p.error.name });
              break;
            case "session.idle":
              idle();
              break;
          }
        }, events.signal);
        listening.catch(() => idle());

        const model = input.model ? splitModel(input.model) : null;
        await server.request(
          "POST",
          `/session/${sessionId}/message`,
          {
            ...(model ? { model } : {}),
            system: input.instructions,
            parts: [
              // Attached images and PDFs as files the model sees.
              ...(await Promise.all(
                (input.files ?? []).map(async (f) => ({
                  type: "file",
                  mime: f.mime,
                  filename: f.name,
                  url: `data:${f.mime};base64,${Buffer.from(await Bun.file(f.path).arrayBuffer()).toString("base64")}`,
                })),
              )),
              { type: "text", text: input.prompt },
            ],
          },
          signal,
        );
        // The reply is complete; give the last events a moment to arrive.
        await Promise.race([finished, Bun.sleep(1500)]);
      } finally {
        signal.removeEventListener("abort", onAbort);
        events.abort();
        if (input.ephemeral && sessionId) await server.request("DELETE", `/session/${sessionId}`).catch(() => {});
        server.close();
      }
    }),
};
