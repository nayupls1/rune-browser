// Sending a request once for each item in a list, a few at a time: the website
// agent's batch of requests. It goes through the same path as replay_request
// (the user's session, per-site approval, redacted responses); a batch that
// changes things is confirmed first. A batch is a background job (Jobs.ts):
// it keeps going after the agent's turn, until it's done, stopped or its chat
// or tab is closed. Its results go into a file in the chat's folder, one per
// item with its status or error. batch_requests waits a while for it to
// finish; job_status waits longer and cancel_job stops it (jobTools.ts).
import { Effect, Schema } from "effect";
import type { JobInfo, NetworkEntry, ReplayOverrides, ReplayResult, RequestDraft } from "../../shared/api";
import { hostOf } from "../../shared/web";
import { Apps } from "../db/Apps";
import { Network } from "../db/Network";
import { Hub } from "../Hub";
import { Permissions, WEBSITE_AGENT } from "../security/Permissions";
import { ChatFiles } from "./ChatFiles";
import { Jobs } from "./Jobs";
import { describeJob, DEFAULT_WAIT_S } from "./jobTools";
import { text, tool } from "./Mcp";
import { Changes, contactPermission, refused, toOverrides, usedRequest } from "./networkTools";
import { MAX_SAVED, pickFields } from "./output";
import type { ToolEnv } from "./tools";

const MAX_ITEMS = 1000;
const MAX_CONCURRENCY = 10;

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

const isChange = (method: string) => !/^(GET|HEAD|OPTIONS)$/i.test(method);
const failed = (r: ItemResult) => r.error !== undefined || (r.status ?? 0) >= 400;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "5× 200, 1× 404, 1× error". */
const countStatuses = (results: readonly ItemResult[]) => {
  const statuses = new Map<string, number>();
  for (const r of results) {
    const key = r.error !== undefined ? "error" : String(r.status);
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }
  return [...statuses].map(([k, n]) => `${n}× ${k}`).join(", ");
};

/** The first failed items, one per line. */
const failures = (results: readonly ItemResult[]) => {
  const bad = results.filter(failed).sort((x, y) => x.item - y.item);
  const lines = bad
    .slice(0, 10)
    .map(
      (r) => `  item ${r.item}: ${r.error ?? `HTTP ${r.status} ${r.statusText ?? ""}`.trim()} · ${r.method} ${r.url}`,
    );
  return lines.length
    ? `Failed:\n${lines.join("\n")}${bad.length > lines.length ? `\n  … ${bad.length - lines.length} more` : ""}`
    : "";
};

export const batchTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const files = yield* ChatFiles;
  const network = yield* Network;
  const apps = yield* Apps;
  const permissions = yield* Permissions;
  const jobs = yield* Jobs;
  const mayContact = contactPermission(permissions, env);

  return [
    tool(
      "batch_requests",
      [
        "Send a captured request (id) or a saved one (saved) once for each item in a list of changes (another URL, method, headers or body per item), a few at a time, with the user's session, e.g. 'replay request #981 for each of these 39 URLs'. Use it instead of scripting fetch calls with run_js.",
        "It runs as a background job: results go into a file in the chat's folder (save_as, by default jobs/<job id>.json): for each item its status and body, or its error; one failing item doesn't stop the others. fields picks parts of each JSON body.",
        "It waits for the batch to finish (up to wait_seconds) and returns a summary; if it's still running, it keeps going after your reply: job_status waits for it or checks on it later, cancel_job stops it. The user is asked the first time for each site, and confirms a batch that changes things (POST, PUT, DELETE…).",
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
            description: "Where the results go in the chat's folder (default jobs/<job id>.json)",
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
          if (args.save_as !== undefined) yield* files.resolve(env.tabId, args.save_as);

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

          const concurrency = Math.min(Math.max(Math.floor(args.concurrency ?? 3), 1), MAX_CONCURRENCY);
          const results: ItemResult[] = [];
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
              Effect.tap((r) => Effect.sync(() => results.push(r))),
            );
          const summary = (info: JobInfo) => {
            const bad = results.filter(failed).length;
            const verb = info.state === "done" ? "Sent" : info.state === "canceled" ? "Stopped after" : "Failed after";
            return `${verb} ${results.length} of ${plural(planned.length, "request")}${bad ? `, ${bad} failed` : ""} (job ${info.id})`;
          };
          const started = yield* jobs
            .start({
              tabId: env.tabId,
              kind: "requests",
              title: `${base.name} × ${planned.length}`,
              total: planned.length,
              saveAs: args.save_as ?? "jobs/{id}.json",
              summary,
              run: (job) =>
                Effect.forEach(
                  planned,
                  (p, i) =>
                    one(p, i).pipe(
                      Effect.andThen(
                        Effect.suspend(() => job.progress({ done: results.length, note: countStatuses(results) })),
                      ),
                    ),
                  { concurrency, discard: true },
                ),
              output: () => {
                const ordered = [...results].sort((x, y) => x.item - y.item);
                const json = JSON.stringify(ordered, null, 1);
                return (json.length > MAX_SAVED ? JSON.stringify(ordered) : json).slice(0, MAX_SAVED);
              },
            })
            .pipe(Effect.mapError((message) => new Error(message)));
          yield* env.log(
            `Sending ${plural(planned.length, "request")} to ${hosts.join(", ")} (${concurrency} at a time, job ${started.id})`,
          );
          yield* jobs.wait(env.tabId, [started.id], args.wait_seconds ?? DEFAULT_WAIT_S);
          const info = (yield* jobs.list(env.tabId)).find((j) => j.id === started.id) ?? started;
          return [describeJob(info), ...(info.state !== "running" ? [failures(results)] : [])]
            .filter(Boolean)
            .join("\n");
        }),
    ),
  ];
});
