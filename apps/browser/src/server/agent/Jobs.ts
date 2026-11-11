// Background jobs: long-running work an agent starts and checks on later,
// instead of holding one tool call open (run_js stops after 30 s, wait_for
// after 60 s). A job is a request for each item in a list (batchTools.ts) or a
// script left running in the page (jobTools.ts). Jobs outlive the agent's
// turn but belong to the chat they were started in: they end when that chat
// is closed (a new chat, another chat opened, the chat cleared) or its tab is,
// and the user sees them above the composer and can stop them. What a job
// produced (its results so far, also when it fails or is stopped) goes into a
// file in the chat's folder, and its end is a line in the chat with that file.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Fiber, Layer, Scope } from "effect";
import type { ChatEvent, ChatFile, JobInfo, ToolKind } from "../../shared/api";
import { topics } from "../../shared/hub";
import { Apps } from "../db/Apps";
import { Hub } from "../Hub";
import { ChatFiles } from "./ChatFiles";

/** At most this many jobs run at the same time in a tab. */
export const MAX_RUNNING = 5;
/** A job that runs longer than this is stopped. */
export const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
/** How long job_status / batch_requests wait at most. */
export const MAX_WAIT_S = 600;
/** Progress is pushed to the chat at most this often (a job's start and end always). */
const PUSH_EVERY_MS = 300;

export interface JobControl {
  readonly id: string;
  /** How far it got: items done (and the total, if it changed), or a short note. */
  readonly progress: (p: { done?: number; total?: number; note?: string }) => Effect.Effect<void>;
}

export interface JobSpec {
  readonly tabId: string;
  readonly kind: JobInfo["kind"];
  readonly title: string;
  readonly total?: number;
  /** Where its results go in the chat's folder; `{id}` is replaced with the job's id. */
  readonly saveAs: string;
  /** The work. A failure fails the job; it's interrupted when the job is stopped. */
  readonly run: (job: JobControl) => Effect.Effect<void, unknown>;
  /** What's saved when it ends (also after a failure or a stop): the results so far, or null for nothing. */
  readonly output: () => string | null;
  /** The line the chat shows when it ends; by default "<title> finished / failed / was stopped". */
  readonly summary?: (info: JobInfo) => string;
  /** Stopped after this long (at most MAX_DURATION_MS). */
  readonly maxDurationMs?: number;
}

export interface JobsShape {
  /** Starts a job in the background; fails (with a message for the agent) if the tab runs too many. */
  readonly start: (spec: JobSpec) => Effect.Effect<JobInfo, string>;
  /** The tab's jobs in its current chat, oldest first. */
  readonly list: (tabId: string) => Effect.Effect<JobInfo[]>;
  /** Waits until the jobs (all running ones without ids) have ended, at most `seconds`; true if they all did. */
  readonly wait: (tabId: string, ids: readonly string[] | undefined, seconds: number) => Effect.Effect<boolean>;
  /** Stops a running job (every running one without id); returns the ones it stopped, as they ended. */
  readonly cancel: (tabId: string, id?: string) => Effect.Effect<JobInfo[]>;
  /** The chat or the tab is closing: stops its running jobs (their results are saved first) and forgets them all. */
  readonly endTab: (tabId: string) => Effect.Effect<void>;
}

export class Jobs extends Context.Service<Jobs, JobsShape>()("rune/Jobs") {}

interface Job {
  info: JobInfo;
  fiber: Fiber.Fiber<void> | null;
}

const kindOf: Record<JobInfo["kind"], ToolKind> = { requests: "network", script: "code" };

export const defaultSummary = (info: JobInfo) => {
  const counted = info.total !== null ? ` (${info.done ?? 0} of ${info.total})` : "";
  switch (info.state) {
    case "done":
      return `Job ${info.id} finished: ${info.title}${counted}`;
    case "failed":
      return `Job ${info.id} failed: ${info.title}${counted}${info.error ? ` · ${info.error.slice(0, 200)}` : ""}`;
    case "canceled":
      return `Job ${info.id} was stopped: ${info.title}${counted}`;
    case "running":
      return `Job ${info.id} is running: ${info.title}${counted}`;
  }
};

const message = (err: unknown) =>
  err instanceof Error
    ? err.message
    : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);

export const make = Effect.gen(function* () {
  const hub = yield* Hub;
  const apps = yield* Apps;
  const files = yield* ChatFiles;
  const scope = yield* Effect.scope;
  const tabs = new Map<string, { seq: number; jobs: Map<string, Job>; pushedAt: number }>();

  const tabOf = (tabId: string) => {
    let tab = tabs.get(tabId);
    if (!tab) tabs.set(tabId, (tab = { seq: 0, jobs: new Map(), pushedAt: 0 }));
    return tab;
  };
  const snapshot = (tabId: string) => [...(tabs.get(tabId)?.jobs.values() ?? [])].map((j) => ({ ...j.info }));
  const emit = (tabId: string, event: ChatEvent) =>
    hub.publish({ type: "chat", topic: topics.app(tabId), appId: tabId, event });
  const push = (tabId: string) =>
    Effect.suspend(() => {
      tabOf(tabId).pushedAt = Date.now();
      return emit(tabId, { type: "jobs", jobs: snapshot(tabId) });
    });

  /** Writes the job's output into the chat's folder. */
  const save = (tabId: string, path: string, data: string) =>
    Effect.gen(function* () {
      const target = yield* files.resolve(tabId, path);
      yield* Effect.promise(async () => {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
      });
      return yield* files.describe(yield* files.dir(tabId), target);
    }).pipe(Effect.orElseSucceed((): ChatFile | null => null));

  const running = (tabId: string) => [...(tabs.get(tabId)?.jobs.values() ?? [])].filter((j) => j.fiber);

  const start = (spec: JobSpec) =>
    Effect.gen(function* () {
      const tab = tabOf(spec.tabId);
      if (running(spec.tabId).length >= MAX_RUNNING)
        return yield* Effect.fail(
          `${MAX_RUNNING} jobs are already running in this chat: wait for one to end (job_status) or stop one (cancel_job).`,
        );
      const id = `j${++tab.seq}`;
      const job: Job = {
        info: {
          id,
          kind: spec.kind,
          title: spec.title,
          state: "running",
          done: spec.total !== undefined ? 0 : null,
          total: spec.total ?? null,
          note: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
          file: null,
          error: null,
        },
        fiber: null,
      };
      tab.jobs.set(id, job);
      const control: JobControl = {
        id,
        progress: ({ done, total, note }) =>
          Effect.suspend(() => {
            if (job.info.state !== "running") return Effect.void;
            if (done !== undefined && Number.isFinite(done)) job.info.done = Math.max(0, Math.floor(done));
            if (total !== undefined && Number.isFinite(total)) job.info.total = Math.max(0, Math.floor(total));
            if (note !== undefined) job.info.note = note.slice(0, 200) || null;
            return Date.now() - tab.pushedAt >= PUSH_EVERY_MS ? push(spec.tabId) : Effect.void;
          }),
      };
      const limit = Math.min(spec.maxDurationMs ?? MAX_DURATION_MS, MAX_DURATION_MS);
      const finish = (state: JobInfo["state"], error: string | null) =>
        Effect.gen(function* () {
          if (job.info.state !== "running") return;
          job.info.state = state;
          job.info.error = error?.slice(0, 1000) ?? null;
          job.info.endedAt = new Date().toISOString();
          const output = spec.output();
          if (output !== null) job.info.file = yield* save(spec.tabId, spec.saveAs.replaceAll("{id}", id), output);
          job.fiber = null;
          const line = (spec.summary ?? defaultSummary)({ ...job.info });
          const chat = yield* apps.addMessage(
            spec.tabId,
            "tool",
            JSON.stringify({
              kind: kindOf[spec.kind],
              title: line,
              ...(state === "failed" ? { failed: true } : {}),
              ...(job.info.file ? { files: [job.info.file] } : {}),
            }),
          );
          yield* emit(spec.tabId, { type: "message", message: chat });
          yield* push(spec.tabId);
        }).pipe(Effect.ignore);

      job.fiber = yield* spec.run(control).pipe(
        Effect.timeoutOption(`${limit} millis`),
        Effect.matchCauseEffect({
          onSuccess: (finished) =>
            finished._tag === "Some"
              ? finish("done", null)
              : finish("failed", `It ran longer than ${Math.round(limit / 60_000)} minutes, so it was stopped.`),
          onFailure: (cause) => {
            const failure = cause.reasons.find((r) => r._tag === "Fail" || r._tag === "Die");
            return failure
              ? finish("failed", message(failure._tag === "Fail" ? failure.error : failure.defect))
              : Effect.void;
          },
        }),
        // Interrupted (stopped by the user or the agent, or the chat closed).
        Effect.onInterrupt(() => finish("canceled", null)),
        Effect.forkIn(scope),
      );
      yield* push(spec.tabId);
      return { ...job.info };
    });

  const cancel = (tabId: string, id?: string) =>
    Effect.gen(function* () {
      const list = running(tabId).filter((j) => id === undefined || j.info.id === id);
      yield* Effect.forEach(list, (j) => (j.fiber ? Fiber.interrupt(j.fiber) : Effect.void), {
        concurrency: "unbounded",
        discard: true,
      });
      return list.map((j) => ({ ...j.info }));
    });

  return {
    start,
    cancel,
    list: (tabId) => Effect.sync(() => snapshot(tabId)),

    wait: (tabId, ids, seconds) =>
      Effect.gen(function* () {
        const list = running(tabId).filter((j) => ids === undefined || ids.includes(j.info.id));
        const ended = yield* Effect.forEach(list, (j) => (j.fiber ? Fiber.await(j.fiber) : Effect.void), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.timeoutOption(`${Math.min(Math.max(seconds, 0), MAX_WAIT_S) * 1000} millis`));
        return ended._tag === "Some";
      }),

    endTab: (tabId) =>
      Effect.gen(function* () {
        if (!tabs.has(tabId)) return;
        const hadJobs = (tabs.get(tabId)?.jobs.size ?? 0) > 0;
        yield* cancel(tabId);
        // The sequence stays, so ids aren't reused for the tab's next chat.
        tabs.get(tabId)?.jobs.clear();
        if (hadJobs) yield* push(tabId);
      }),
  } satisfies JobsShape;
});

export const layer = Layer.effect(Jobs, make);

/** For tests: a Jobs service on its own scope. */
export const makeIn = (scope: Scope.Scope) => make.pipe(Effect.provideService(Scope.Scope, scope));
