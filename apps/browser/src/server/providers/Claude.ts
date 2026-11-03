// Claude Code through the Agent SDK. The SDK drives the Claude Code binary,
// which signs in with the user's own Claude login (subscription); API keys are
// stripped from its environment so it never bills an API account.
import { isAbsolute, relative, resolve } from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { ProviderModel } from "../../shared/api";
import type { ProviderSettings } from "../../shared/settings";
import { readConfig } from "../Config";
import { describeTool, streamFrom, type Probe, type ProviderDriver, type TurnInput } from "./Provider";
import { agentEnv, findBinary, runCommand } from "./process";
import { VERSION } from "../../shared/version";

/**
 * Environment for Claude Code. API keys are removed so it always uses the
 * logged-in Claude account, and variables leaked from a parent Claude Code
 * session (e.g. when Rune Browser is started from one) are dropped.
 */
export function claudeEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = agentEnv(extra);
  for (const key of Object.keys(env)) {
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN" || key === "CLAUDECODE") delete env[key];
    if (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `rune/${VERSION}`;
  // Only Rune Browser's own MCP server: no connectors from the user's claude.ai account.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

/** The user's own Claude Code: the path from Settings, or `claude` on PATH. */
const binaryFor = (settings: ProviderSettings) => findBinary("claude", settings.binaryPath);

const inside = (root: string, path: string) => {
  const rel = relative(root, isAbsolute(path) ? path : resolve(root, path));
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Keeps file tools inside the project. Bash runs in Claude Code's sandbox
 * when it's available (bubblewrap on Linux, Seatbelt on macOS).
 */
const projectPolicy =
  (cwd: string): CanUseTool =>
  async (toolName, input) => {
    const paths = ["file_path", "path", "notebook_path"]
      .map((k) => input[k])
      .filter((v): v is string => typeof v === "string");
    if (paths.some((p) => !inside(cwd, p))) {
      return { behavior: "deny", message: `Stay inside the project folder (${cwd}).` };
    }
    return { behavior: "allow", updatedInput: input };
  };

/** The prompt, with attached images and PDFs as content blocks the model sees (one message, then the input ends). */
function promptWithFiles(input: TurnInput): string | AsyncIterable<SDKUserMessage> {
  const files = input.files ?? [];
  if (!files.length) return input.prompt;
  return (async function* () {
    const blocks: unknown[] = [];
    for (const file of files) {
      const data = Buffer.from(await Bun.file(file.path).arrayBuffer()).toString("base64");
      if (file.mime === "application/pdf")
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
          title: file.name,
        });
      else blocks.push({ type: "image", source: { type: "base64", media_type: file.mime, data } });
    }
    blocks.push({ type: "text", text: input.prompt });
    yield {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
  })();
}

const idlePrompt = async function* () {
  await new Promise(() => {});
} as unknown as () => AsyncIterable<never>;

export const ClaudeDriver: ProviderDriver = {
  id: "claude",
  label: "Claude Code",

  probe: (settings) =>
    Effect.tryPromise(async (): Promise<Probe> => {
      const binary = binaryFor(settings);
      if (!binary) {
        return {
          state: "missing",
          version: null,
          binary: null,
          message: "Install Claude Code: npm install -g @anthropic-ai/claude-code",
          models: [],
          defaultModel: null,
        };
      }
      const version =
        (await runCommand(binary, ["--version"], { timeoutMs: 10_000 })).stdout.trim().split(" ")[0] ?? null;
      // A session that never receives a prompt: only used to ask for models and the account.
      const session = query({
        prompt: idlePrompt(),
        options: {
          tools: [],
          settingSources: [],
          cwd: readConfig().agentDir,
          env: claudeEnv(),
          persistSession: false,
          pathToClaudeCodeExecutable: binary,
        },
      });
      try {
        const [models, account] = await Promise.all([
          session.supportedModels(),
          session.accountInfo().catch(() => null),
        ]);
        const signedIn =
          !!account && (!!account.subscriptionType || !!account.tokenSource || account.apiProvider !== "firstParty");
        return {
          state: signedIn ? "ready" : "signed-out",
          version,
          binary,
          message: signedIn
            ? account?.subscriptionType
              ? `Signed in (${account.subscriptionType})`
              : null
            : "Sign in by running `claude` in a terminal and using /login.",
          models: models
            .filter((m) => m.value !== "default")
            .map((m): ProviderModel => ({
              id: m.value,
              name: m.displayName,
              description: m.description,
              efforts: m.supportedEffortLevels ?? [],
            })),
          defaultModel:
            models
              .find((m) => m.value === "default")
              ?.description?.match(/\b(opus|sonnet|haiku|fable)\b/i)?.[1]
              ?.toLowerCase() ?? null,
        };
      } finally {
        session.close();
      }
    }).pipe(
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
      if (!binary) throw new Error("Claude Code isn't installed (npm install -g @anthropic-ai/claude-code).");
      const abortController = new AbortController();
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
      const workspace = input.access === "workspace";
      const options: Options = {
        systemPrompt: workspace
          ? { type: "preset", preset: "claude_code", append: input.instructions }
          : { type: "custom", prompt: input.instructions, snapshot: false },
        resume: input.resume ?? undefined,
        // The website agent only gets Rune Browser's tools (pages, customizations), AI requests none.
        ...(workspace ? {} : { tools: [] }),
        mcpServers: input.mcp
          ? { [input.mcp.name]: { type: "http", url: input.mcp.url, headers: input.mcp.headers } }
          : {},
        strictMcpConfig: true, // no MCP servers from the user's own config
        settingSources: [], // ignore the user's CLAUDE.md, skills, settings
        ...(input.ephemeral ? { persistSession: false, maxTurns: 1 } : {}),
        cwd: input.cwd,
        env: claudeEnv(input.env),
        includePartialMessages: true,
        abortController,
        pathToClaudeCodeExecutable: binary,
        model: input.model ?? undefined,
        effort: (input.effort as Options["effort"]) ?? undefined,
        permissionMode: "acceptEdits",
        canUseTool: projectPolicy(input.cwd),
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true, network: { allowLocalBinding: true } },
      };

      for await (const msg of query({ prompt: promptWithFiles(input), options }) as AsyncIterable<SDKMessage>) {
        if (msg.type === "system" && msg.subtype === "init") {
          emit({ type: "session", id: msg.session_id });
        } else if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
            emit({ type: "delta", text: ev.delta.text });
        } else if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type !== "tool_use") continue;
            // Rune Browser's own tools report themselves (Agent.ts).
            if (input.mcp && block.name.startsWith(`mcp__${input.mcp.name}__`)) continue;
            emit({
              type: "tool",
              activity: describeTool(block.name, block.input as Record<string, unknown>, input.cwd),
            });
          }
          const text = msg.message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          if (text) emit({ type: "text", text });
        } else if (msg.type === "result" && msg.subtype !== "success") {
          const detail = "errors" in msg && msg.errors.length ? msg.errors.join("\n") : msg.subtype;
          emit({ type: "error", message: `Agent stopped: ${detail}` });
        }
      }
    }),
};
