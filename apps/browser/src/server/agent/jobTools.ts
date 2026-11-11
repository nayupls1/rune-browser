// The agent's tools for background jobs (Jobs.ts): a script left running in
// the page (start_script_job), checking on jobs and waiting for them
// (job_status), stopping them (cancel_job), and a plain pause (wait). Batches
// of requests are jobs too (batch_requests, batchTools.ts).
//
// A page script runs in the page like run_js does (same page, same rules: its
// result is page data), but without run_js's 30 s limit: it's started in the
// page and Rune Browser checks on it every second, so no call stays open. It
// gets progress(done, total) / progress("note") to report how far it got, and
// an AbortSignal (signal) that fires when the job is stopped. A reload or
// navigation ends the page's scripts, and with them the job.
import { Effect, Schema } from "effect";
import type { JobInfo } from "../../shared/api";
import { Hub } from "../Hub";
import { Jobs, MAX_DURATION_MS, MAX_WAIT_S } from "./Jobs";
import { text, tool } from "./Mcp";
import { MAX_SAVED } from "./output";
import type { ToolEnv } from "./tools";

/** How long tools wait for a job by default: under the 60 s some agents give a tool call. */
export const DEFAULT_WAIT_S = 50;
const MAX_PAUSE_S = 300;
const POLL_MS = 1000;
/** A page that doesn't answer this many checks in a row ends the job. */
const MAX_MISSED = 5;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One job for the agent: what it is, how far it got, where its results are. */
export function describeJob(job: JobInfo) {
  const count =
    job.total !== null
      ? `${job.done ?? 0} of ${job.total} done`
      : job.done !== null
        ? `${job.done} done`
        : job.state === "running"
          ? "running"
          : "";
  const progress = [count, job.note].filter(Boolean).join(", ");
  const head = `Job ${job.id} (${job.title})`;
  const seconds = Math.round(((job.endedAt ? Date.parse(job.endedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000);
  const took = seconds >= 1 ? ` after ${seconds} s` : "";
  switch (job.state) {
    case "running":
      return `${head} is running${progress ? `: ${progress}` : ""} (${seconds} s so far). job_status waits for it, cancel_job stops it.`;
    case "done":
      return `${head} finished${took}${progress ? `: ${progress}` : ""}.${job.file ? ` Results are in ${job.file.name} (${job.file.size} bytes); read_file reads it.` : ""}`;
    case "failed":
      return `${head} failed${took}${progress ? ` (${progress})` : ""}: ${job.error ?? "unknown error"}${job.file ? ` What it had is in ${job.file.name}.` : ""}`;
    case "canceled":
      return `${head} was stopped${took}${progress ? ` (${progress})` : ""}.${job.file ? ` The results so far are in ${job.file.name}.` : ""}`;
  }
}

/** The page side of a script job: starts `code` and keeps its state in a property only Rune Browser knows the name of. */
export const startScript = (key: string, code: string) => `(() => {
  const job = { state: "running", done: null, total: null, note: null, result: null, error: null };
  const controller = new AbortController();
  Object.defineProperty(window, ${JSON.stringify(key)}, { value: { job, controller }, configurable: true, enumerable: false });
  const progress = (a, b) => {
    if (typeof a === "number") { job.done = a; if (typeof b === "number") job.total = b; }
    else if (a != null) job.note = String(a).slice(0, 200);
  };
  const signal = controller.signal;
  (async () => {
${code}
  })().then(
    (r) => {
      let out;
      if (r === undefined) out = "undefined";
      else if (typeof r === "string") out = r;
      else { try { out = JSON.stringify(r, null, 1) ?? String(r); } catch { out = String(r); } }
      job.result = out.slice(0, ${MAX_SAVED});
      job.state = "done";
    },
    (e) => { job.error = String((e && e.message) || e).slice(0, 1000); job.state = "failed"; },
  );
  return true;
})()`;

/** Its state (and, once it ended, its result: then it's forgotten by the page); null if the page doesn't know it (reloaded). */
export const checkScript = (key: string) => `(() => {
  const s = window[${JSON.stringify(key)}];
  if (!s) return null;
  const { state, done, total, note, error, result } = s.job;
  if (state === "running") return { state, done, total, note };
  delete window[${JSON.stringify(key)}];
  return { state, done, total, note, error, result };
})()`;

export const stopScript = (key: string) =>
  `(() => { const s = window[${JSON.stringify(key)}]; if (s) { s.controller.abort(); delete window[${JSON.stringify(key)}]; } return true; })()`;

interface ScriptState {
  state: "running" | "done" | "failed";
  done: number | null;
  total: number | null;
  note: string | null;
  error?: string | null;
  result?: string | null;
}

export const jobTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const jobs = yield* Jobs;
  const evalIn = <T>(code: string) => hub.rpc<T>("page.eval", { tabId: env.tabId, code });
  const where = "the page in the user's tab";

  return [
    tool(
      "start_script_job",
      [
        `Start JavaScript in ${where} as a background job, for work that takes longer than run_js allows (30 s): going through many pages of results, a long series of fetch calls, waiting for something slow.`,
        "`code` is the body of an async function, like run_js: `return` the result (JSON-serializable). It also gets progress(done, total) or progress('a short note') to say how far it got, and signal, an AbortSignal that fires when the job is stopped (check signal.aborted in loops).",
        "It returns right away with the job's id; the job keeps running after your reply until it ends, is stopped, or the chat or tab is closed (a reload or navigation ends it too). job_status checks on it or waits for it, cancel_job stops it. The result goes into a file in the chat's folder (save_as, by default jobs/<job id>.json).",
        "Like run_js, it's for reading and collecting data, not for acting on the site: use click, fill_form and batch_requests for that.",
      ].join(" "),
      Schema.Struct({
        code: Schema.String,
        title: Schema.optionalKey(
          Schema.String.annotate({
            description: "What it does, in a few words, for the user (e.g. 'Collect all reviews')",
          }),
        ),
        save_as: Schema.optionalKey(
          Schema.String.annotate({
            description: "Where the result goes in the chat's folder (default jobs/<job id>.json)",
          }),
        ),
        timeout_minutes: Schema.optionalKey(
          Schema.Finite.annotate({
            description: `Stop it after this long (default 30, at most ${MAX_DURATION_MS / 60_000})`,
          }),
        ),
      }),
      ({ code, title, save_as, timeout_minutes }) =>
        Effect.gen(function* () {
          const key = `__runeJob_${crypto.randomUUID().replaceAll("-", "")}`;
          let result: string | null = null;
          let missed = 0;
          const minutes = Math.min(Math.max(timeout_minutes ?? 30, 1), MAX_DURATION_MS / 60_000);
          const started = yield* jobs
            .start({
              tabId: env.tabId,
              kind: "script",
              title: title?.trim().slice(0, 80) || "Page script",
              saveAs: save_as ?? "jobs/{id}.json",
              maxDurationMs: minutes * 60_000,
              output: () => result,
              run: (job) =>
                Effect.gen(function* () {
                  yield* evalIn(startScript(key, code));
                  while (true) {
                    yield* Effect.sleep(`${POLL_MS} millis`);
                    const state = yield* evalIn<ScriptState | null>(checkScript(key)).pipe(
                      Effect.map((s) => ((missed = 0), s)),
                      Effect.catch((err) =>
                        ++missed >= MAX_MISSED ? Effect.fail(err) : Effect.succeed("missed" as const),
                      ),
                    );
                    if (state === "missed") continue;
                    if (state === null)
                      return yield* Effect.fail(
                        new Error("The page reloaded or went to another page, which ended the script."),
                      );
                    yield* job.progress({
                      ...(state.done !== null ? { done: state.done } : {}),
                      ...(state.total !== null ? { total: state.total } : {}),
                      ...(state.note !== null ? { note: state.note } : {}),
                    });
                    if (state.state === "done") {
                      result = state.result ?? null;
                      return;
                    }
                    if (state.state === "failed") return yield* Effect.fail(new Error(state.error ?? "It failed"));
                  }
                }).pipe(Effect.onInterrupt(() => evalIn(stopScript(key)).pipe(Effect.ignore))),
            })
            .pipe(Effect.mapError((message) => new Error(message)));
          yield* env.log(`Started a page script in the background: ${started.title} (job ${started.id})`);
          // A script that's over in a moment: its result right away.
          yield* jobs.wait(env.tabId, [started.id], 2);
          const info = (yield* jobs.list(env.tabId)).find((j) => j.id === started.id) ?? started;
          return describeJob(info);
        }),
    ),

    tool(
      "job_status",
      `How this chat's background jobs are doing (or one, by id): how far they got, how they ended and where their results are. With wait_seconds, it first waits until they've ended, at most that long (up to ${MAX_WAIT_S}; ${DEFAULT_WAIT_S} or less is safe with every agent), instead of you polling.`,
      Schema.Struct({
        id: Schema.optionalKey(Schema.String.annotate({ description: "A job's id (j1…); without it, all of them" })),
        wait_seconds: Schema.optionalKey(
          Schema.Finite.annotate({ description: "Wait until it has ended, at most this long (default 0)" }),
        ),
      }),
      ({ id, wait_seconds }) =>
        Effect.gen(function* () {
          const before = yield* jobs.list(env.tabId);
          if (id !== undefined && !before.some((j) => j.id === id))
            return text(
              `There's no job ${id} in this chat.${before.length ? "" : " No jobs have been started."}`,
              true,
            );
          if (!before.length) return "No jobs in this chat.";
          const ended = wait_seconds
            ? yield* jobs.wait(env.tabId, id !== undefined ? [id] : undefined, wait_seconds)
            : true;
          const list = (yield* jobs.list(env.tabId)).filter((j) => id === undefined || j.id === id);
          const running = list.filter((j) => j.state === "running").length;
          return [
            ...list.map(describeJob),
            ...(wait_seconds && !ended
              ? [`Still running: ${plural(running, "job")}. job_status again to keep waiting.`]
              : []),
          ].join("\n");
        }),
    ),

    tool(
      "cancel_job",
      "Stop a running background job (or, without id, every running one in this chat). What it did isn't undone; its results so far are saved.",
      Schema.Struct({ id: Schema.optionalKey(Schema.String.annotate({ description: "A job's id (j1…)" })) }),
      ({ id }) =>
        Effect.gen(function* () {
          const stopped = yield* jobs.cancel(env.tabId, id);
          if (!stopped.length) return text(id !== undefined ? `Job ${id} isn't running.` : "No job is running.", true);
          const list = (yield* jobs.list(env.tabId)).filter((j) => stopped.some((s) => s.id === j.id));
          return list.map(describeJob).join("\n");
        }),
    ),

    tool(
      "wait",
      `Pause for a number of seconds (at most ${MAX_PAUSE_S}; ${DEFAULT_WAIT_S} or less is safe with every agent), e.g. between checks on something that takes a while, or to give a page time. To wait for a job, use job_status with wait_seconds: it returns as soon as the job ends.`,
      Schema.Struct({
        seconds: Schema.Finite.annotate({ description: "How long" }),
      }),
      ({ seconds }) =>
        Effect.gen(function* () {
          const s = Math.min(Math.max(seconds, 0), MAX_PAUSE_S);
          yield* Effect.sleep(`${Math.round(s * 1000)} millis`);
          return `Waited ${Math.round(s * 10) / 10} s.`;
        }),
    ),
  ];
});
