// Sending a request once for each item in a list, a few at a time: the website
// agent's batch of requests. It goes through the same path as replay_request
// (the user's session, per-site approval, redacted responses); a batch that
// changes things is confirmed first. The results go into a file in the chat's
// folder, one per item with its status or error, and the agent waits for the
// batch to finish (batch_requests waits a while, wait_for_batch waits longer)
// instead of polling. Batches belong to the agent's turn: stopping the agent or
// ending the turn stops them.
import { Effect, Fiber, Option, Schema } from "effect";
import type { NetworkEntry, ReplayOverrides, ReplayResult, RequestDraft } from "../../shared/api";
import { hostOf } from "../../shared/web";
import { Apps } from "../db/Apps";
import { Network } from "../db/Network";
import { Hub } from "../Hub";
import { Permissions, WEBSITE_AGENT } from "../security/Permissions";
import { ChatFiles } from "./ChatFiles";
import { saveOutput } from "./fileTools";
import { text, tool } from "./Mcp";
import { Changes, contactPermission, refused, toOverrides, usedRequest } from "./networkTools";
import { MAX_SAVED, pickFields } from "./output";
import type { ToolEnv } from "./tools";

const MAX_ITEMS = 1000;
const MAX_CONCURRENCY = 10;
/** How long batch_requests and wait_for_batch wait by default (under the 60 s some agents give a tool call). */
const DEFAULT_WAIT_S = 50;
const MAX_WAIT_S = 600;

interface ItemResult {
  readonly item: number;
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly durationMs?: number;
  readonly size?: number;
  readonly body?: unknown;
  readonly error?: string;
}

interface Batch {
  readonly id: string;
  readonly what: string;
  readonly total: number;
  readonly concurrency: number;
  readonly results: ItemResult[];
  readonly path: string;
  state: "running" | "done" | "canceled";
  file: string | null;
  fiber: Fiber.Fiber<void> | null;
}

const isChange = (method: string) => !/^(GET|HEAD|OPTIONS)$/i.test(method);
const failed = (r: ItemResult) => r.error !== undefined || (r.status ?? 0) >= 400;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const batchTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const files = yield* ChatFiles;
  const network = yield* Network;
  const apps = yield* Apps;
  const permissions = yield* Permissions;
  // Batches run in the turn's scope: when the turn ends (or the user stops the agent), they stop.
  const scope = yield* Effect.scope;
  const mayContact = contactPermission(permissions, env);
  const batches = new Map<string, Batch>();
  let seq = 0;

  const describe = (b: Batch) => {
    const done = b.results.length;
    const bad = b.results.filter(failed);
    const statuses = new Map<string, number>();
    for (const r of b.results) {
      const key = r.error !== undefined ? "error" : String(r.status);
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
    }
    const counts = [...statuses].map(([k, n]) => `${n}× ${k}`).join(", ");
    const head =
      b.state === "running"
        ? `Batch ${b.id} (${b.what}) is running: ${done} of ${b.total} done${counts ? ` (${counts})` : ""}. wait_for_batch waits for it, cancel_batch stops it.`
        : `Batch ${b.id} (${b.what}) ${b.state === "done" ? "finished" : "was canceled"}: ${done} of ${plural(b.total, "request")} sent${
            counts ? ` (${counts})` : ""
          }, ${bad.length} failed.`;
    const failures = bad
      .slice(0, 10)
      .map(
        (r) => `  item ${r.item}: ${r.error ?? `HTTP ${r.status} ${r.statusText ?? ""}`.trim()} · ${r.method} ${r.url}`,
      );
    return [
      head,
      ...(b.state !== "running" && failures.length
        ? [
            `Failed:\n${failures.join("\n")}${bad.length > failures.length ? `\n  … ${bad.length - failures.length} more` : ""}`,
          ]
        : []),
      ...(b.file ? [`Results (one per item, with its status and body) are in ${b.file}. read_file reads it.`] : []),
    ].join("\n");
  };

  /** Writes what the batch has so far, in item order. */
  const save = (b: Batch) =>
    Effect.gen(function* () {
      const ordered = [...b.results].sort((x, y) => x.item - y.item);
      let json = JSON.stringify(ordered, null, 1);
      if (json.length > MAX_SAVED) json = JSON.stringify(ordered);
      const file = yield* saveOutput(files, env, b.path, json.slice(0, MAX_SAVED));
      b.file = file.name;
    }).pipe(Effect.ignore);

  /** Waits for batches to finish, at most `seconds`. */
  const waitFor = (list: Batch[], seconds: number) =>
    Effect.forEach(list, (b) => (b.fiber ? Fiber.await(b.fiber).pipe(Effect.asVoid) : Effect.void), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.timeoutOption(`${Math.min(Math.max(seconds, 0), MAX_WAIT_S)} seconds`));

  return [
    tool(
      "batch_requests",
      [
        "Send a captured request (id) or a saved one (saved) once for each item in a list of changes (another URL, method, headers or body per item), a few at a time, with the user's session, e.g. 'replay request #981 for each of these 39 URLs'. Use it instead of scripting fetch calls with run_js.",
        "Results go into a file in the chat's folder (save_as, by default batches/<id>.json): for each item its status and body, or its error; one failing item doesn't stop the others. fields picks parts of each JSON body.",
        "It waits for the batch to finish (up to wait_seconds) and returns a summary; if it's still running, wait_for_batch waits for the rest. The user is asked the first time for each site, and confirms a batch that changes things (POST, PUT, DELETE…). Batches stop when your turn ends: wait for them before replying.",
      ].join(" "),
      Schema.Struct({
        id: Schema.optionalKey(
          Schema.String.annotate({ description: "A captured request (#id from network_requests)" }),
        ),
        saved: Schema.optionalKey(Schema.String.annotate({ description: "A saved request (from saved_requests)" })),
        items: Schema.Array(Schema.Struct(Changes)).annotate({
          description: "One entry per request to send: what to change for it (e.g. {url}); {} sends it unchanged",
        }),
        concurrency: Schema.optionalKey(
          Schema.Finite.annotate({ description: `How many at the same time (default 3, at most ${MAX_CONCURRENCY})` }),
        ),
        fields: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "Keep only these parts of each JSON body, e.g. ['data.id', 'data.title']",
          }),
        ),
        save_as: Schema.optionalKey(
          Schema.String.annotate({
            description: "Where the results go in the chat's folder (default batches/<id>.json)",
          }),
        ),
        wait_seconds: Schema.optionalKey(
          Schema.Finite.annotate({
            description: `How long to wait for it to finish before returning (default ${DEFAULT_WAIT_S}; 0: return right away)`,
          }),
        ),
      }),
      (args) =>
        Effect.gen(function* () {
          if ((args.id === undefined) === (args.saved === undefined))
            return text("Give either id (a captured request) or saved (a saved request).", true);
          if (!args.items.length) return text("items is empty: nothing to send.", true);
          if (args.items.length > MAX_ITEMS)
            return text(`That's ${args.items.length} items; a batch sends at most ${MAX_ITEMS}.`, true);

          // What's sent: a captured request of this tab, or a saved one of its workspace.
          let base: { method: string; url: string; name: string };
          let send: (overrides: ReplayOverrides) => Effect.Effect<ReplayResult, unknown>;
          if (args.id !== undefined) {
            const entry: NetworkEntry | ReturnType<typeof text> = yield* usedRequest(env, args.id).pipe(
              Effect.provideService(Hub, hub),
              Effect.provideService(ChatFiles, files),
            );
            if ("content" in entry) return entry;
            base = { method: entry.method, url: entry.url, name: `request #${entry.id}` };
            send = (overrides) =>
              hub.rpc<ReplayResult>("network.replay", { tabId: env.tabId, id: entry.id, overrides }, 45_000);
          } else {
            const workspaceId = (yield* apps.get(env.tabId))?.workspaceId;
            const saved = yield* network.draftOf(args.saved!);
            if (!saved || saved.request.workspaceId !== workspaceId)
              return text(`No saved request ${args.saved} in this workspace.`, true);
            const draft: RequestDraft = saved.draft;
            base = { method: saved.request.method, url: saved.request.url, name: `“${saved.request.name}”` };
            send = (overrides) =>
              hub.rpc<ReplayResult>(
                "network.replay",
                { workspaceId: saved.request.workspaceId, draft, overrides },
                45_000,
              );
          }

          const planned = args.items.map((item) => ({
            overrides: toOverrides(item),
            method: (item.method ?? base.method).toUpperCase(),
            url: item.url ?? base.url,
          }));
          if (planned.some((p) => !/^https?:\/\//i.test(p.url) || !hostOf(p.url)))
            return text("Every item's URL has to be an http(s) address.", true);
          const hosts = [...new Set(planned.map((p) => hostOf(p.url)))];
          for (const host of hosts) {
            const { allowed } = yield* mayContact(`https://${host}/`);
            if (!allowed) return refused(host);
          }
          const changes = planned.filter((p) => isChange(p.method));
          if (changes.length) {
            const methods = [...new Set(changes.map((p) => p.method))].join("/");
            const confirmed = yield* permissions.ask({
              agentTab: env.tabId,
              subject: WEBSITE_AGENT,
              action: "agent.confirm",
              resource: hosts.join(", "),
              title: `Let the website agent send ${plural(changes.length, `${methods} request`)}?`,
              detail: `To ${hosts.join(", ")}, with your session (based on ${base.name}), e.g. ${changes[0]!.method} ${changes[0]!.url.slice(0, 200)}. They can change things on the site, so Rune Browser asks every time.`,
              timeoutMs: 180_000,
              once: true,
            });
            if (!confirmed)
              return text(
                `The user didn't confirm sending ${plural(changes.length, "request")}. Nothing was sent.`,
                true,
              );
          }

          const id = `b${++seq}`;
          const concurrency = Math.min(Math.max(Math.floor(args.concurrency ?? 3), 1), MAX_CONCURRENCY);
          const batch: Batch = {
            id,
            what: `${base.name} × ${planned.length}`,
            total: planned.length,
            concurrency,
            results: [],
            path: args.save_as ?? `batches/${id}.json`,
            state: "running",
            file: null,
            fiber: null,
          };
          batches.set(id, batch);
          const one = (p: (typeof planned)[number], index: number) =>
            send(p.overrides).pipe(
              Effect.map((r): ItemResult => {
                let body: unknown = r.body;
                if (r.body !== null) {
                  try {
                    body = JSON.parse(r.body);
                    if (args.fields?.length) body = pickFields(body, args.fields);
                  } catch {
                    // not JSON: kept as text
                  }
                }
                return {
                  item: index,
                  method: p.method,
                  url: r.url,
                  status: r.status,
                  statusText: r.statusText,
                  durationMs: r.durationMs,
                  size: r.size,
                  body,
                };
              }),
              Effect.catch((err) =>
                Effect.succeed<ItemResult>({
                  item: index,
                  method: p.method,
                  url: p.url,
                  error: err instanceof Error ? err.message : String(err),
                }),
              ),
              Effect.tap((r) => Effect.sync(() => batch.results.push(r))),
            );
          yield* env.log(
            `Sending ${plural(planned.length, "request")} to ${hosts.join(", ")} (${concurrency} at a time)`,
          );
          batch.fiber = yield* Effect.forEach(planned, one, { concurrency, discard: true }).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                batch.state = exit._tag === "Success" ? "done" : "canceled";
                yield* save(batch);
                const bad = batch.results.filter(failed).length;
                yield* env.log(
                  `${batch.state === "done" ? "Sent" : "Stopped after"} ${batch.results.length} of ${plural(batch.total, "request")}${
                    bad ? `, ${bad} failed` : ""
                  }`,
                );
              }),
            ),
            Effect.forkIn(scope),
          );
          yield* waitFor([batch], args.wait_seconds ?? DEFAULT_WAIT_S);
          return describe(batch);
        }),
    ),

    tool(
      "wait_for_batch",
      `Wait until a batch (or, without id, every running batch) has finished, at most \`seconds\` (default ${DEFAULT_WAIT_S}, up to ${MAX_WAIT_S}), then get its summary and where its results are. seconds: 0 just shows how far the batches of this turn got.`,
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        seconds: Schema.optionalKey(Schema.Finite),
      }),
      ({ id, seconds }) =>
        Effect.gen(function* () {
          const list = id !== undefined ? [batches.get(id)].filter((b) => b !== undefined) : [...batches.values()];
          if (!list.length)
            return text(id !== undefined ? `No batch ${id} in this turn.` : "No batches in this turn.", true);
          const running = list.filter((b) => b.state === "running");
          const finished = Option.isSome(yield* waitFor(running, seconds ?? DEFAULT_WAIT_S));
          return `${list.map(describe).join("\n\n")}${finished ? "" : "\n\nStill running: wait_for_batch again to keep waiting."}`;
        }),
    ),

    tool(
      "cancel_batch",
      "Stop a running batch (or, without id, every running one). Requests already sent aren't undone; the results so far are saved.",
      Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
      ({ id }) =>
        Effect.gen(function* () {
          const list = [...batches.values()].filter((b) => b.state === "running" && (id === undefined || b.id === id));
          if (!list.length) return text(id !== undefined ? `Batch ${id} isn't running.` : "No batch is running.", true);
          for (const b of list) if (b.fiber) yield* Fiber.interrupt(b.fiber);
          return list.map(describe).join("\n\n");
        }),
    ),
  ];
});
