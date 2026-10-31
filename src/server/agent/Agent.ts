// Runs agent turns: picks the provider, gives it Rune Browser's instructions and tools,
// persists the conversation and pushes everything to the renderer on the hub
// (topic app:<id>). A turn runs in the background; stopping interrupts it.
import { delimiter } from "node:path";
import { Context, Data, Effect, Fiber, FiberMap, Layer, Option, Stream } from "effect";
import {
  appTarget,
  type AgentChoice,
  type ChatEvent,
  type ChatFile,
  type ChatMessage,
  type PageContext,
  type ProviderId,
} from "../../shared/api";
import { topics } from "../../shared/hub";
import { ServerConfig } from "../Config";
import { Apps, type AppRecord } from "../db/Apps";
import { Network } from "../db/Network";
import { Settings } from "../db/Settings";
import { Sites } from "../db/Sites";
import { Workspaces } from "../db/Workspaces";
import { History } from "../history/History";
import { Audit } from "../security/Audit";
import { ResponseOverrides } from "../db/ResponseOverrides";
import { Permissions } from "../security/Permissions";
import { Secrets } from "../security/Secrets";
import { Hub } from "../Hub";
import type { TurnInput } from "../providers/Provider";
import { Providers } from "../providers/Providers";
import { AppData } from "../workspace/AppData";
import { AppTools } from "../workspace/AppTools";
import { PageChanges } from "../db/PageChanges";
import { Scheduler, type Outcome, type PromptRun } from "../scheduler/Scheduler";
import { Projects } from "../workspace/Projects";
import type { Runtime } from "../workspace/Runtime";
import { Sandbox } from "../workspace/Sandbox";
import { Sources } from "../workspace/Sources";
import { Workspace } from "../workspace/Workspace";
import { Mcp, type Tool } from "./Mcp";
import { describeRuneTool, toolKind } from "./activity";
import { buildAppPrompt, buildWebPrompt, contextSummary, withPageContext } from "./prompts";
import { browseTools } from "./browseTools";
import { ChatFiles } from "./ChatFiles";
import { fileTools } from "./fileTools";
import { devtoolsTools } from "./devtoolsTools";
import { historyTools } from "./historyTools";
import { describeSource, sourceTools } from "./sourceTools";
import { Attachments, type AttachedFile } from "./Attachments";
import { networkReadTools, networkTools } from "./networkTools";
import { endpointTools } from "./endpointTools";
import { Endpoints } from "../db/Endpoints";
import { sharedContext, withSharedTabs, type SharedTabInput } from "./sharedTabs";
import { appTools, pageTools, registryTools, scheduleTools, siteTools, tabTools, type ToolEnv } from "./tools";

/** Tool arguments for the audit log: short values as they are, long ones by size. */
export function summarizeArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const parts = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 120 ? `${key}: ${text.length} chars` : `${key}: ${text}`;
  });
  return parts.length ? parts.join(", ") : null;
}

/** The Rune Browser tool call in progress: which tool, whether it logged a line of its own, the files it saved. */
const CurrentCall = Context.Reference<{ tool: string; logged: boolean; files: ChatFile[] } | null>(
  "rune/agent/CurrentCall",
  { defaultValue: () => null },
);

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly status: 404 | 409 | 400;
  readonly message: string;
}> {}

export interface TurnRequest {
  readonly prompt: string;
  readonly agent?: Partial<AgentChoice>;
  readonly page?: PageContext;
  /** Other tabs the user shared with the message (sharedTabs.ts). */
  readonly shared?: readonly SharedTabInput[];
  /** Files attached to the message (Attachments.ts), by id. */
  readonly attachments?: readonly string[];
}

export interface AgentShape {
  /** Starts a turn in the background. Fails if the tab is busy or the provider can't run. */
  readonly start: (appId: string, request: TurnRequest) => Effect.Effect<void, AgentError>;
  readonly stop: (appId: string) => Effect.Effect<void>;
  readonly isRunning: (appId: string) => Effect.Effect<boolean>;
}

export class Agent extends Context.Service<Agent, AgentShape>()("rune/Agent") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const apps = yield* Apps;
  const settings = yield* Settings;
  const hub = yield* Hub;
  const providers = yield* Providers;
  const mcp = yield* Mcp;
  const workspace = yield* Workspace;
  const workspaces = yield* Workspaces;
  const history = yield* History;
  const projects = yield* Projects;
  const sandbox = yield* Sandbox;
  const sources = yield* Sources;
  const attachments = yield* Attachments;
  const audit = yield* Audit;
  const scheduler = yield* Scheduler;
  const running = yield* FiberMap.make<string>();
  // Tools need the services; captured once.
  const context = yield* Effect.context<
    | Hub
    | Apps
    | Workspace
    | Runtime
    | Projects
    | Sites
    | Permissions
    | Secrets
    | Network
    | ResponseOverrides
    | Endpoints
    | AppData
    | AppTools
    | PageChanges
    | Scheduler
    | Sources
    | Audit
    | History
    | ChatFiles
  >();

  const emit = (appId: string, event: ChatEvent) =>
    hub.publish({ type: "chat", topic: topics.app(appId), appId, event });
  const message = (appId: string, role: ChatMessage["role"], content: string) =>
    apps.addMessage(appId, role, content).pipe(Effect.tap((m) => emit(appId, { type: "message", message: m })));

  /**
   * A tool whose calls show in the chat (its own line, or one from activity.ts)
   * and go to the audit log (arguments summarized; long text only as its length).
   */
  const audited = (t: Tool, tabId: string, actorLabel: string): Tool => ({
    ...t,
    run: (args) =>
      Effect.gen(function* () {
        const call = { tool: t.name, logged: false, files: [] as ChatFile[] };
        const result = yield* t.run(args).pipe(Effect.provideService(CurrentCall, call));
        if (!call.logged || result.isError) {
          const activity = {
            ...describeRuneTool(t.name, args),
            ...(call.files.length ? { files: call.files } : {}),
          };
          yield* message(tabId, "tool", JSON.stringify(result.isError ? { ...activity, failed: true } : activity));
        }
        yield* audit.record({
          actor: "agent",
          actorLabel,
          tabId,
          action: `tool.${t.name}`,
          target: summarizeArgs(args),
          outcome: result.isError ? "error" : "ok",
        });
        return result;
      }),
  });

  /** The request's choice, else the tab's last one, else the defaults (the workspace's or Settings'). */
  const resolveChoice = (
    request: Partial<AgentChoice> | undefined,
    app: AppRecord,
    defaults: AgentChoice,
  ): AgentChoice => {
    const provider: ProviderId = request?.provider ?? app.agent?.provider ?? defaults.provider;
    const previous = app.agent?.provider === provider ? app.agent : provider === defaults.provider ? defaults : null;
    return {
      provider,
      model: request?.model !== undefined ? request.model : (previous?.model ?? null),
      effort: request?.effort !== undefined ? request.effort : (previous?.effort ?? null),
    };
  };

  const turn = (
    app: AppRecord,
    choice: AgentChoice,
    request: TurnRequest,
    shared: { text: string; summaries: unknown[] },
  ) =>
    Effect.gen(function* () {
      const appId = app.id;
      const s = yield* settings.get();
      const space = (yield* workspaces.ofApp(appId))?.settings;
      // The workspace's instructions come after the global ones.
      const combine = (global: string, local: string | undefined) =>
        [global.trim(), local?.trim()].filter(Boolean).join("\n\n");
      yield* emit(appId, { type: "started" });
      const files: AttachedFile[] = [];
      for (const id of request.attachments ?? []) {
        const file = yield* attachments.get(appId, id);
        if (file) files.push(file);
      }
      if (files.length) yield* message(appId, "attachments", JSON.stringify(files));
      const turnInput = yield* attachments.forTurn(request.prompt, files);
      if (request.page?.selection.length) yield* message(appId, "context", contextSummary(request.page));
      if (shared.summaries.length) {
        yield* message(appId, "context", JSON.stringify({ shared: shared.summaries }));
        for (const s of shared.summaries as { tabId: string; name: string; what: string }[]) {
          yield* audit.record({
            actor: "user",
            actorLabel: "You",
            tabId: appId,
            action: "tab.share",
            target: s.name,
            detail: `${s.what} of tab ${s.tabId}`,
          });
        }
      }
      yield* message(appId, "user", request.prompt);
      yield* apps.touch(appId);

      const web = app.kind === "web";
      const status = (yield* providers.list).find((p) => p.id === choice.provider);
      const actorLabel = `${web ? "Website agent" : "App builder"} · ${status?.label ?? choice.provider}${choice.model ? ` (${choice.model})` : ""}`;
      const env: ToolEnv = {
        tabId: appId,
        log: (line) =>
          Effect.gen(function* () {
            const call = yield* CurrentCall;
            if (call) call.logged = true;
            const files = call?.files.length ? { files: call.files } : {};
            yield* message(appId, "tool", JSON.stringify({ kind: toolKind(call?.tool ?? ""), title: line, ...files }));
          }),
        message: (role, content) => Effect.asVoid(message(appId, role, content)),
        label: actorLabel,
        saved: (file) =>
          Effect.gen(function* () {
            const call = yield* CurrentCall;
            if (call && !call.files.some((f) => f.path === file.path)) call.files.push(file);
          }),
      };
      const tools = web
        ? [
            ...(yield* Effect.provide(pageTools(env, { site: true }), context)),
            ...(yield* Effect.provide(devtoolsTools(env, { site: true }), context)),
            ...(yield* Effect.provide(browseTools(env), context)),
            ...(yield* Effect.provide(siteTools(env), context)),
            ...(yield* Effect.provide(networkTools(env), context)),
            ...(yield* Effect.provide(endpointTools(env), context)),
            ...(yield* Effect.provide(historyTools(env, { site: true }), context)),
            ...(yield* Effect.provide(sourceTools(env), context)),
            ...(yield* Effect.provide(registryTools(env), context)),
            ...(yield* Effect.provide(tabTools(env), context)),
            ...(yield* Effect.provide(fileTools(env), context)),
          ]
        : [
            ...(yield* Effect.provide(appTools(env), context)),
            ...(yield* Effect.provide(pageTools(env, { site: false }), context)),
            ...(yield* Effect.provide(devtoolsTools(env, { site: false }), context)),
            ...(yield* Effect.provide(networkReadTools(env), context)),
            ...(yield* Effect.provide(endpointTools(env), context)),
            ...(yield* Effect.provide(historyTools(env, { site: false }), context)),
            ...(yield* Effect.provide(sourceTools(env), context)),
            ...(yield* Effect.provide(registryTools(env), context)),
            ...(yield* Effect.provide(scheduleTools(env), context)),
            ...(yield* Effect.provide(tabTools(env), context)),
            ...(yield* Effect.provide(fileTools(env, { project: true }), context)),
          ];
      const mcpUrl = yield* mcp.register(tools.map((t) => audited(t, appId, actorLabel)));
      // Snapshots around the turn: what changed before it (the user, the app's data), and what the agent changed.
      const target = web ? "sites" : appTarget(appId);
      const prompt = request.prompt.trim();
      yield* history.record(target, {
        actor: "rune",
        actorLabel: "Automatic snapshot",
        summary: `Before “${prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt}”`,
      });
      const snapshotAfter = history.record(target, { actor: "agent", actorLabel, summary: prompt });
      yield* audit.record({
        actor: "agent",
        actorLabel,
        tabId: appId,
        action: "agent.turn",
        detail: `${request.prompt.length} characters`,
      });

      let cwd: string;
      let instructions: string;
      if (web) {
        cwd = config.agentDir;
        instructions = buildWebPrompt(combine(s.agent.webInstructions, space?.webInstructions));
      } else {
        cwd = yield* workspace.ensureDir(appId);
        const project = yield* workspace.info(appId);
        instructions = buildAppPrompt({
          instructions: combine(s.agent.instructions, space?.instructions),
          dir: cwd,
          hasProject: !!project,
        });
        yield* projects.editing(appId);
      }
      // The code attached to the tab: the agent works with it through Rune Browser's source tools.
      const attached = yield* sources.list(appId);
      if (attached.length) {
        instructions += `\n\n# Code attached to this tab\nThe user attached this code for you to work with:\n${attached.map((a) => `- ${describeSource(a)}`).join("\n")}\nUse search_source, list_source_files, read_source_file and source_git to find your way in it, for example where a slow function from a trace or a broken style comes from. Change it only with edit_source_file / write_source_file: the user approves every diff. Your own file tools don't reach it.`;
      }

      const driver = providers.driver(choice.provider);
      const input = (resume: string | null): TurnInput => ({
        cwd,
        prompt: withSharedTabs(withPageContext(turnInput.prompt, request.page), shared.text),
        files: turnInput.files,
        instructions,
        model: choice.model,
        effort: choice.effort,
        resume,
        mcp: { name: "rune", url: mcpUrl, headers: {} },
        access: web ? "none" : "workspace",
        env: { PATH: `${process.env.PATH ?? ""}${delimiter}${sandbox.binDir}` },
      });

      let heard = false;
      const run = (resume: string | null) =>
        driver.run(input(resume), s.providers[choice.provider]).pipe(
          Stream.runForEach((event) => {
            heard = heard || event.type !== "session";
            switch (event.type) {
              case "session":
                return apps.setSession(appId, { provider: choice.provider, id: event.id });
              case "delta":
                return emit(appId, { type: "delta", text: event.text });
              case "text":
                return Effect.asVoid(message(appId, "assistant", event.text));
              case "tool":
                return Effect.asVoid(message(appId, "tool", JSON.stringify(event.activity))).pipe(
                  Effect.andThen(
                    audit.record({
                      actor: "agent",
                      actorLabel,
                      tabId: appId,
                      action: "agent.native",
                      target: event.activity.title,
                    }),
                  ),
                );
              case "error":
                return Effect.asVoid(message(appId, "error", event.message));
            }
          }),
        );

      const resume = app.session?.provider === choice.provider ? app.session.id : null;
      yield* run(resume).pipe(
        // A session the provider no longer knows: start a fresh one.
        Effect.catch((err) => (resume && !heard ? run(null) : Effect.fail(err))),
        Effect.catch((err) => Effect.asVoid(message(appId, "error", `${driver.label} failed: ${err.message}`))),
        // Also when stopped halfway.
        Effect.ensuring(snapshotAfter),
      );

      if (!web) yield* projects.edited(appId);
    }).pipe(
      Effect.scoped,
      Effect.onInterrupt(() => Effect.asVoid(message(app.id, "error", "Stopped."))),
      Effect.ensuring(emit(app.id, { type: "done" })),
    );

  const start = (appId: string, request: TurnRequest) =>
    Effect.gen(function* () {
      const app = yield* apps.get(appId);
      if (!app) return yield* new AgentError({ status: 404, message: "Not found" });
      if (yield* FiberMap.has(running, appId)) {
        return yield* new AgentError({ status: 409, message: "The agent is already working on this tab" });
      }
      // Shared tabs are checked before the turn starts: one that may not be shared fails the request.
      const shared = request.shared?.length
        ? yield* Effect.provide(sharedContext(app, request.shared), context).pipe(
            Effect.mapError((message) => new AgentError({ status: 400, message })),
          )
        : { text: "", summaries: [] };
      const s = yield* settings.get();
      // New tabs start with the workspace's default agent, if it has one.
      const defaults = (yield* workspaces.ofApp(appId))?.settings.agent ?? s.agent;
      const choice = resolveChoice(request.agent, app, defaults);
      const status = (yield* providers.list).find((p) => p.id === choice.provider)!;
      if (status.state !== "ready" && status.state !== "checking") {
        return yield* new AgentError({
          status: 400,
          message: `${status.label} can't run: ${status.state === "disabled" ? "it's turned off in Settings" : (status.message ?? status.state)}`,
        });
      }
      yield* apps.setAgent(appId, choice);
      yield* FiberMap.run(running, appId, turn(app, choice, request, shared), { onlyIfMissing: true });
    });

  /**
   * A scheduled prompt: a new chat in its tab (the current one goes to the
   * tab's earlier chats), the turn as if the user had sent it, and its reply
   * as the run's output. Stopped if the run times out.
   */
  const runPrompt = ({ task, opened }: PromptRun) =>
    Effect.gen(function* () {
      const failed = (message: string): Outcome => ({ status: "error", message, output: null });
      let tabId = task.appId ?? null;
      if (!tabId) {
        const space = task.newTab ? yield* workspaces.get(task.newTab.workspaceId) : null;
        if (!space || !task.newTab) return failed("The workspace is gone");
        const app = yield* apps.create(
          space.id,
          task.newTab.kind,
          task.newTab.kind === "web" ? (task.newTab.url ?? null) : null,
        );
        yield* projects.publish(app);
        yield* opened(app.id);
        tabId = app.id;
      }
      const id = tabId;
      if (yield* FiberMap.has(running, id)) return failed("The agent was busy in this tab");
      yield* apps.newChat(id);
      yield* emit(id, { type: "new-chat" });
      const started = yield* start(id, { prompt: task.prompt }).pipe(Effect.result);
      if (started._tag === "Failure") return failed(started.failure.message);
      const fiber = yield* FiberMap.get(running, id);
      if (Option.isSome(fiber))
        yield* Fiber.await(fiber.value).pipe(Effect.onInterrupt(() => FiberMap.remove(running, id)));
      // The chat is the turn: its errors, else the agent's last reply.
      const messages = yield* apps.messages(id);
      const error = messages.findLast((m) => m.role === "error");
      if (error) return { status: "error", message: error.content.slice(0, 500), output: null } satisfies Outcome;
      const reply = messages.findLast((m) => m.role === "assistant")?.content.trim() ?? "";
      return {
        status: "ok",
        message: reply ? reply.split("\n")[0]!.slice(0, 200) : "Done",
        output: reply || null,
      } satisfies Outcome;
    }).pipe(Effect.orDie);
  scheduler.setPromptRunner(runPrompt);

  return {
    isRunning: (appId) => FiberMap.has(running, appId),
    stop: (appId) => FiberMap.remove(running, appId),
    start,
  } satisfies AgentShape;
});

export const layer = Layer.effect(Agent, make);
