// AI for apps: an app's server can ask a model through Rune Browser, which answers
// with one of the user's providers (their own subscription; no API keys in
// the app). Apps authenticate with their token (AiTokens); requests run
// without any tools, count against a daily limit per app and show up in the
// app's logs.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { defaultAppModel, type ProviderId, type ProviderStatus } from "../../shared/api";
import { ServerConfig } from "../Config";
import { Apps } from "../db/Apps";
import { Settings } from "../db/Settings";
import { Providers } from "../providers/Providers";
import { Audit } from "../security/Audit";
import { Permissions } from "../security/Permissions";
import { Runtime } from "../workspace/Runtime";

// --- Requests --------------------------------------------------------------------------

export interface AiMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AiRequest {
  readonly messages: readonly AiMessage[];
  /** Instructions for the model (the app's system prompt). */
  readonly system?: string;
  /** A model id from GET /models; default: the one chosen in Rune Browser's Settings. */
  readonly model?: string;
  readonly effort?: string;
  /** Ask for a single JSON value (parsed into `json` when it is one). */
  readonly json?: boolean;
}

export type AiEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "done"; readonly text: string; readonly provider: ProviderId; readonly model: string | null };

export class AiError extends Data.TaggedError("AiError")<{
  readonly status: 400 | 403 | 429 | 503 | 504;
  readonly message: string;
}> {}

export interface AiInfo {
  readonly enabled: boolean;
  readonly provider: ProviderId;
  readonly model: string | null;
  readonly models: readonly { id: string; name: string }[];
  readonly usage: { readonly today: number; readonly limit: number };
}

export interface AiShape {
  readonly info: (appId: string) => Effect.Effect<AiInfo>;
  /** Runs a request. Fails before streaming when it isn't allowed. */
  readonly chat: (appId: string, request: AiRequest) => Effect.Effect<Stream.Stream<AiEvent, AiError>, AiError>;
}

export class Ai extends Context.Service<Ai, AiShape>()("rune/Ai") {}

const TIMEOUT_MS = 180_000;
const CONCURRENT_PER_APP = 2;
const MAX_INPUT_CHARS = 200_000;

const today = () => new Date().toISOString().slice(0, 10);

/** One prompt from a conversation (the providers take a single message per turn). */
export function promptFor(messages: readonly AiMessage[]): string {
  if (messages.length === 1) return messages[0]!.content;
  const turns = messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n");
  return `<conversation>\n${turns}\n</conversation>\n\nReply to the last user message, as the assistant.`;
}

export function instructionsFor(appName: string, request: Pick<AiRequest, "system" | "json">): string {
  return [
    `You are a language model answering a request from the server of "${appName}", an app the user built in Rune Browser. Your reply goes back to the app's code, not to a chat: reply with the answer only, no preamble. You have no tools.`,
    request.json ? "Reply with a single valid JSON value and nothing else: no code fences, no explanations." : "",
    request.system?.trim() ? `# Instructions from the app\n${request.system.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* Settings;
  const providers = yield* Providers;
  const runtime = yield* Runtime;
  const apps = yield* Apps;
  const permissions = yield* Permissions;
  const audit = yield* Audit;
  const sql = yield* SqlClient.SqlClient;
  const cwd = join(config.dataDir, "ai");
  mkdirSync(cwd, { recursive: true });
  const slots = new Map<string, Semaphore.Semaphore>();
  const slot = (appId: string) => {
    let s = slots.get(appId);
    if (!s) slots.set(appId, (s = Semaphore.makeUnsafe(CONCURRENT_PER_APP)));
    return s;
  };

  const usage = (appId: string) =>
    sql<{ requests: number }>`SELECT requests FROM ai_usage WHERE app_id = ${appId} AND day = ${today()}`.pipe(
      Effect.map((rows) => rows[0]?.requests ?? 0),
      Effect.orDie,
    );

  /** Counts a request; false when the app is over its limit. */
  const take = (appId: string, limit: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ requests: number }>`
        INSERT INTO ai_usage (app_id, day, requests) VALUES (${appId}, ${today()}, 1)
        ON CONFLICT (app_id, day) DO UPDATE SET requests = requests + 1
        RETURNING requests`;
      return (rows[0]?.requests ?? 0) <= limit;
    }).pipe(Effect.orDie);

  const choice = Effect.gen(function* () {
    const s = (yield* settings.get()).apps.ai;
    let status = (yield* providers.list).find((p) => p.id === s.provider)!;
    // Right after startup the provider may still be checked: wait for it.
    if (status.state === "checking") status = (yield* providers.refresh(s.provider)).find((p) => p.id === s.provider)!;
    return { s, status };
  });

  return {
    info: (appId) =>
      Effect.gen(function* () {
        const { s, status } = yield* choice;
        return {
          enabled: s.enabled && status.state === "ready",
          provider: s.provider,
          model: s.model ?? defaultAppModel(status),
          models: status.models.map((m) => ({ id: m.id, name: m.name })),
          usage: { today: yield* usage(appId), limit: s.dailyLimit },
        };
      }),

    chat: (appId, request) =>
      Effect.gen(function* () {
        const s = (yield* settings.get()).apps.ai;
        if (!s.enabled)
          return yield* new AiError({ status: 403, message: "AI for apps is turned off in Rune Browser's Settings." });
        if (!request.messages.length || request.messages.at(-1)!.role !== "user") {
          return yield* new AiError({ status: 400, message: "messages must end with a user message" });
        }
        const size = request.messages.reduce((n, m) => n + m.content.length, request.system?.length ?? 0);
        if (size > MAX_INPUT_CHARS)
          return yield* new AiError({
            status: 400,
            message: `The request is too long (${size} > ${MAX_INPUT_CHARS} characters)`,
          });

        const app = yield* apps.get(appId);
        const appName = app?.name ?? "An app";
        const labelOf = (status: ProviderStatus) => {
          const model = request.model ?? s.model ?? defaultAppModel(status);
          return `${status.label}${model ? ` / ${model}` : ""}`;
        };
        const record = (label: string, outcome: "ok" | "denied" | "error", detail: string) =>
          audit.record({
            actor: "app",
            actorLabel: appName,
            tabId: appId,
            action: "ai.request",
            target: label,
            detail,
            outcome,
          });

        // The first time, the user decides whether this app may use AI at all.
        const known = (yield* providers.list).find((p) => p.id === s.provider)!;
        const allowed = yield* permissions.ask({
          subject: appId,
          action: "app.ai",
          resource: "",
          title: `Let "${appName}" use AI?`,
          detail: `Its server wants to send requests to ${labelOf(known)} on your subscription (at most ${s.dailyLimit} a day). The model gets no tools: it can't see your files.`,
          timeoutMs: 60_000,
        });
        if (!allowed) {
          runtime.note(appId, "AI: not allowed by the user");
          yield* record(labelOf(known), "denied", "Not allowed");
          return yield* new AiError({
            status: 403,
            message:
              "The user didn't allow this app to use AI. It can be allowed in Rune Browser's Settings → Permissions.",
          });
        }

        const { status } = yield* choice;
        if (status.state !== "ready") {
          return yield* new AiError({
            status: 503,
            message: `${status.label} isn't available: ${status.message ?? status.state}`,
          });
        }
        if (request.model && !status.models.some((m) => m.id === request.model)) {
          return yield* new AiError({
            status: 400,
            message: `Unknown model "${request.model}". Models: ${status.models.map((m) => m.id).join(", ")}`,
          });
        }
        const label = labelOf(status);
        if (!(yield* take(appId, s.dailyLimit))) {
          runtime.note(appId, `AI: daily limit of ${s.dailyLimit} requests reached`);
          yield* record(label, "denied", `Daily limit of ${s.dailyLimit} reached`);
          return yield* new AiError({
            status: 429,
            message: `This app reached its daily AI limit (${s.dailyLimit} requests). It can be changed in Rune Browser's Settings.`,
          });
        }
        const model = request.model ?? s.model ?? defaultAppModel(status);
        const effort = request.effort ?? (request.model ? null : s.effort);
        const driver = providers.driver(s.provider);
        const started = Date.now();
        let answer = "";

        const run = driver
          .run(
            {
              cwd,
              prompt: promptFor(request.messages),
              instructions: instructionsFor(appName, request),
              model,
              effort,
              resume: null,
              mcp: null,
              access: "none",
              ephemeral: true,
              env: {},
            },
            (yield* settings.get()).providers[s.provider],
          )
          .pipe(
            Stream.mapError((err) => new AiError({ status: 503, message: `${status.label} failed: ${err.message}` })),
            Stream.flatMap((event): Stream.Stream<AiEvent, AiError> => {
              switch (event.type) {
                case "delta":
                  return Stream.make({ type: "delta", text: event.text });
                case "text":
                  answer = answer ? `${answer}\n\n${event.text}` : event.text;
                  return Stream.empty;
                case "error":
                  return Stream.fail(new AiError({ status: 503, message: event.message }));
                case "tool":
                  // There are no tools; if a provider reports one anyway, say so in the logs.
                  runtime.note(appId, `AI: unexpected tool use: ${event.activity.title}`);
                  return Stream.empty;
                default:
                  return Stream.empty;
              }
            }),
            Stream.concat(
              Stream.suspend(() =>
                Stream.make({ type: "done", text: answer.trim(), provider: s.provider, model } as AiEvent),
              ),
            ),
            Stream.timeoutOrElse({
              duration: TIMEOUT_MS,
              orElse: () => Stream.fail(new AiError({ status: 504, message: "The model took too long" })),
            }),
            Stream.tap((event) => {
              if (event.type !== "done") return Effect.void;
              const summary = `${size.toLocaleString()} → ${event.text.length.toLocaleString()} chars · ${((Date.now() - started) / 1000).toFixed(1)}s`;
              runtime.note(appId, `AI: ${label} · ${summary}`);
              return record(label, "ok", summary);
            }),
            Stream.tapError((err) =>
              Effect.sync(() => runtime.note(appId, `AI: ${label} failed: ${err.message}`)).pipe(
                Effect.andThen(record(label, "error", err.message)),
              ),
            ),
          );

        // At most a few requests per app at a time; the permit is held while the response streams.
        const permits = slot(appId);
        return Stream.unwrap(Effect.as(permits.take(1), run)).pipe(Stream.ensuring(permits.release(1)));
      }),
  } satisfies AiShape;
});

export const layer = Layer.effect(Ai, make);
