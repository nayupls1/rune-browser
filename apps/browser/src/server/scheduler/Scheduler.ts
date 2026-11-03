// The scheduler: runs things in the background, without a tab open. A
// schedule uses one of an app's tools (the tool registry, so permissions and
// the audit log apply as for any call), runs a command in the app's sandbox,
// or asks a tab's agent something (a new chat in the tab each run; the agent
// runs it as if the user had sent it, see setPromptRunner), once at a time, on a cron expression, or on an event (Rune Browser started, an
// app started or crashed, or an event an app sends through the app API).
//
// Limits: recurring schedules run at most every few minutes, two runs at a
// time (the rest wait), a schedule never overlaps itself, every run has a
// timeout, event runs at most every 30 seconds per schedule, and the output
// kept is capped. A run missed while Rune Browser wasn't running happens once when
// it starts. Finished runs are published on the hub (the UI notifies) and
// recorded in the audit log.
import { Cause, Context, Data, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import type { Schedule, ScheduleRun, ScheduleSpec, ScheduleTask, ToolResult } from "../../shared/api";
import { nextCron, parseCron } from "../../shared/cron";
import { topics } from "../../shared/hub";
import { scheduleProblem, taskTab } from "../../shared/schedule";
import { Apps } from "../db/Apps";
import { Workspaces } from "../db/Workspaces";
import { Hub } from "../Hub";
import { Audit } from "../security/Audit";
import { AppTools, type ToolCaller } from "../workspace/AppTools";
import { Runtime } from "../workspace/Runtime";

export class ScheduleError extends Data.TaggedError("ScheduleError")<{
  readonly status: 400 | 404 | 409;
  readonly message: string;
}> {}

export interface ScheduleCreator {
  readonly by: "user" | "agent";
  /** The tab whose agent made it (its tool calls are made as that agent). */
  readonly tabId?: string;
}

/** How a run went. */
export interface Outcome {
  readonly status: ScheduleRun["status"];
  readonly message: string;
  readonly output: string | null;
}

/** A scheduled prompt to run: in its tab, or in a new one (`opened` is told which, so the schedule keeps it). */
export interface PromptRun {
  readonly scheduleName: string;
  readonly task: Extract<ScheduleTask, { type: "prompt" }>;
  readonly opened: (tabId: string) => Effect.Effect<void>;
}

export interface SchedulerShape {
  readonly list: (filter?: { workspaceId?: string; appId?: string }) => Effect.Effect<Schedule[]>;
  readonly get: (id: string) => Effect.Effect<Schedule | null>;
  readonly create: (spec: ScheduleSpec, creator: ScheduleCreator) => Effect.Effect<Schedule, ScheduleError>;
  readonly update: (
    id: string,
    fields: { spec?: ScheduleSpec; paused?: boolean },
  ) => Effect.Effect<Schedule, ScheduleError>;
  readonly remove: (id: string) => Effect.Effect<void>;
  /** Starts a run now (in the background) and returns it. */
  readonly runNow: (id: string) => Effect.Effect<ScheduleRun, ScheduleError>;
  /** Newest first. */
  readonly runs: (filter: {
    scheduleId?: string;
    workspaceId?: string;
    before?: number;
    limit?: number;
  }) => Effect.Effect<ScheduleRun[]>;
  /** The next runs of the time-based schedules, soonest first. */
  readonly upcoming: (filter: {
    workspaceId?: string;
    limit?: number;
  }) => Effect.Effect<{ scheduleId: string; name: string; at: string }[]>;
  /** Something happened: runs the schedules waiting for it. */
  readonly emit: (event: string) => Effect.Effect<void>;
  /** The app was deleted: its schedules go too. */
  readonly forgetApp: (appId: string) => Effect.Effect<void>;
  /** Runs scheduled prompts (the agents sit above the scheduler, so they register it: Agent.make). Interrupted on timeout. */
  readonly setPromptRunner: (runner: (run: PromptRun) => Effect.Effect<Outcome>) => void;
}

export class Scheduler extends Context.Service<Scheduler, SchedulerShape>()("rune/Scheduler") {}

const CONCURRENT_RUNS = 2;
const MAX_OUTPUT = 20_000;
const KEEP_RUNS = 50;
const EVENT_GAP_MS = 30_000;
const MAX_SCHEDULES = 200;

interface ScheduleRow {
  id: string;
  spec: string;
  paused: number;
  created_by: "user" | "agent";
  creator_tab: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  schedule_id: string;
  schedule_name: string;
  trigger: ScheduleRun["trigger"];
  status: ScheduleRun["status"];
  started_at: string;
  finished_at: string | null;
  message: string;
  output: string | null;
}

const toRun = (r: RunRow): ScheduleRun => ({
  id: r.id,
  scheduleId: r.schedule_id,
  scheduleName: r.schedule_name,
  trigger: r.trigger,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  message: r.message,
  output: r.output,
});

/** When a schedule runs next, after `from` (null: on events only, or a one-off that's due no more). */
export function nextRun(spec: ScheduleSpec, from: Date, ran = false): string | null {
  if (spec.trigger.type === "once")
    return ran || Date.parse(spec.trigger.at) < from.getTime() - 60_000
      ? null
      : new Date(spec.trigger.at).toISOString();
  if (spec.trigger.type === "cron") {
    const cron = parseCron(spec.trigger.cron);
    return typeof cron === "string" ? null : (nextCron(cron, from)?.toISOString() ?? null);
  }
  return null;
}

const clip = (text: string) => (text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const apps = yield* Apps;
  const workspaces = yield* Workspaces;
  const hub = yield* Hub;
  const audit = yield* Audit;
  const appTools = yield* AppTools;
  const runtime = yield* Runtime;
  const slots = yield* Semaphore.make(CONCURRENT_RUNS);
  const running = new Set<string>();
  const lastEventRun = new Map<string, number>();
  let promptRunner: ((run: PromptRun) => Effect.Effect<Outcome>) | null = null;

  // Runs that were going when Rune Browser stopped.
  yield* sql`UPDATE schedule_runs SET status = 'error', message = 'Rune Browser stopped during the run', finished_at = ${new Date().toISOString()}
    WHERE status = 'running'`.pipe(Effect.orDie);

  const lastRuns = (ids: string[]) =>
    ids.length
      ? sql<RunRow>`SELECT * FROM schedule_runs WHERE id IN (SELECT MAX(id) FROM schedule_runs WHERE schedule_id IN ${sql.in(ids)} GROUP BY schedule_id)`.pipe(
          Effect.map((rows) => new Map(rows.map((r) => [r.schedule_id, toRun(r)]))),
        )
      : Effect.succeed(new Map<string, ScheduleRun>());

  const toSchedules = (rows: readonly ScheduleRow[]) =>
    Effect.gen(function* () {
      const last = yield* lastRuns(rows.map((r) => r.id));
      const out: Schedule[] = [];
      for (const r of rows) {
        const spec = JSON.parse(r.spec) as ScheduleSpec;
        const tab = taskTab(spec.task);
        const app = tab ? yield* apps.get(tab) : null;
        out.push({
          ...spec,
          id: r.id,
          workspaceId:
            app?.workspaceId ?? (spec.task.type === "prompt" && spec.task.newTab ? spec.task.newTab.workspaceId : ""),
          paused: r.paused === 1,
          createdBy: r.created_by,
          nextRunAt: r.paused ? null : r.next_run_at,
          running: running.has(r.id),
          lastRun: last.get(r.id) ?? null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        });
      }
      return out;
    });

  const rowOf = (id: string) =>
    sql<ScheduleRow>`SELECT * FROM schedules WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0] ?? null));
  const get = (id: string) =>
    rowOf(id).pipe(
      Effect.flatMap((row) => (row ? toSchedules([row]) : Effect.succeed([]))),
      Effect.map((list) => list[0] ?? null),
    );
  const changed = hub.publish({ type: "schedules-changed", topic: topics.schedules });

  const check = (spec: ScheduleSpec) =>
    Effect.gen(function* () {
      const problem = scheduleProblem(spec);
      if (problem) return yield* new ScheduleError({ status: 400, message: problem });
      if (spec.task.type === "prompt") {
        // Any tab can be asked (app or web).
        if (spec.task.appId && !(yield* apps.get(spec.task.appId)))
          return yield* new ScheduleError({ status: 404, message: "No such tab" });
        if (spec.task.newTab && !(yield* workspaces.get(spec.task.newTab.workspaceId)))
          return yield* new ScheduleError({ status: 404, message: "No such workspace" });
        return null;
      }
      const app = yield* apps.get(spec.task.appId);
      if (!app || app.kind !== "app") return yield* new ScheduleError({ status: 404, message: "No such app" });
      if (spec.task.type === "tool") {
        const tool = (yield* appTools.list(app.id)).find((t) => spec.task.type === "tool" && t.id === spec.task.tool);
        if (!tool)
          return yield* new ScheduleError({ status: 404, message: `${app.name} has no tool "${spec.task.tool}"` });
        if (tool.path)
          return yield* new ScheduleError({
            status: 400,
            message: `"${tool.title}" opens a page; it can't run in the background`,
          });
      }
      return app;
    });

  // --- Running --------------------------------------------------------------------------

  const perform = (row: ScheduleRow, spec: ScheduleSpec): Effect.Effect<Outcome> => {
    const task = spec.task;
    if (task.type === "prompt") {
      if (!promptRunner)
        return Effect.succeed<Outcome>({ status: "error", message: "Agents aren't available", output: null });
      // A new tab is opened once; the schedule then runs in it.
      const opened = (tabId: string) =>
        Effect.gen(function* () {
          const current = yield* rowOf(row.id);
          if (!current) return;
          const now = JSON.parse(current.spec) as ScheduleSpec;
          if (now.task.type !== "prompt") return;
          const { newTab: _, ...rest } = now.task;
          yield* sql`UPDATE schedules SET spec = ${JSON.stringify({ ...now, task: { ...rest, appId: tabId } })} WHERE id = ${row.id}`;
          yield* changed;
        }).pipe(Effect.orDie);
      return promptRunner({ scheduleName: spec.name, task, opened });
    }
    if (task.type === "command") {
      return runtime.exec(task.appId, task.command, spec.timeoutSec * 1000).pipe(
        Effect.map(({ code, output, timedOut }) => ({
          status: timedOut ? "timeout" : code === 0 ? "ok" : "error",
          message: timedOut ? `Stopped after ${spec.timeoutSec} s` : code === 0 ? "Done" : `Exited with code ${code}`,
          output: output.trim() ? clip(output) : null,
        })),
      );
    }
    const caller: ToolCaller =
      row.created_by === "agent" && row.creator_tab
        ? { kind: "agent", tabId: row.creator_tab, label: `Schedule “${spec.name}”` }
        : { kind: "user" };
    return appTools.call(caller, task.appId, task.tool, { params: task.params, input: task.input }).pipe(
      Effect.map((result: ToolResult): Outcome => ({
        status: result.ok ? "ok" : "error",
        message: result.message || (result.ok ? "Done" : `Failed (${result.status})`),
        output: result.data === undefined ? null : clip(JSON.stringify(result.data, null, 1)),
      })),
      Effect.catchTag("AppToolError", (e) =>
        Effect.succeed<Outcome>({ status: "error", message: e.message, output: null }),
      ),
    );
  };

  const insertRun = (row: ScheduleRow, spec: ScheduleSpec, trigger: ScheduleRun["trigger"], outcome?: Outcome) =>
    Effect.gen(function* () {
      const at = new Date().toISOString();
      const [inserted] = yield* sql<RunRow>`
        INSERT INTO schedule_runs (schedule_id, schedule_name, trigger, status, started_at, finished_at, message, output)
        VALUES (${row.id}, ${spec.name}, ${trigger}, ${outcome?.status ?? "running"}, ${at}, ${outcome ? at : null}, ${outcome?.message ?? ""}, ${outcome?.output ?? null})
        RETURNING *`;
      return toRun(inserted!);
    });

  const execute = (row: ScheduleRow, trigger: ScheduleRun["trigger"]) =>
    Effect.gen(function* () {
      const spec = JSON.parse(row.spec) as ScheduleSpec;
      if (running.has(row.id)) {
        if (trigger === "event") return null;
        const skipped = yield* insertRun(row, spec, trigger, {
          status: "skipped",
          message: "The previous run was still going",
          output: null,
        });
        yield* hub.publish({ type: "schedule-run", topic: topics.schedules, run: skipped, notify: false });
        return skipped;
      }
      running.add(row.id);
      const run = yield* insertRun(row, spec, trigger);
      yield* hub.publish({ type: "schedule-run", topic: topics.schedules, run, notify: false });
      const finish = (outcome: Outcome) =>
        Effect.gen(function* () {
          running.delete(row.id);
          const [done] = yield* sql<RunRow>`
            UPDATE schedule_runs SET status = ${outcome.status}, message = ${outcome.message.slice(0, 2000)}, output = ${outcome.output},
              finished_at = ${new Date().toISOString()}
            WHERE id = ${run.id} RETURNING *`;
          const finished = toRun(done!);
          const notify = spec.notify === "always" || (spec.notify === "failure" && finished.status !== "ok");
          yield* hub.publish({ type: "schedule-run", topic: topics.schedules, run: finished, notify });
          yield* audit.record({
            actor: "rune",
            actorLabel: "Scheduler",
            tabId: taskTab(spec.task) ?? undefined,
            action: "schedule.run",
            target: spec.name,
            outcome: finished.status === "ok" ? "ok" : "error",
            detail: `${trigger}: ${finished.message.slice(0, 200)}`,
          });
          // Only the latest runs are kept.
          yield* sql`DELETE FROM schedule_runs WHERE schedule_id = ${row.id} AND id NOT IN
            (SELECT id FROM schedule_runs WHERE schedule_id = ${row.id} ORDER BY id DESC LIMIT ${KEEP_RUNS})`;
        }).pipe(Effect.orDie);
      // Started in the background: the caller (the clock, an event, "Run now") doesn't wait.
      yield* Effect.forkDetach(
        slots
          .withPermits(1)(perform(row, spec))
          .pipe(
            Effect.timeoutOrElse({
              duration: spec.timeoutSec * 1000,
              orElse: () =>
                Effect.succeed<Outcome>({
                  status: "timeout",
                  message: `Stopped after ${spec.timeoutSec} s`,
                  output: null,
                }),
            }),
            Effect.catchCause((cause) =>
              Effect.succeed<Outcome>({
                status: "error",
                message: Cause.pretty(cause).split("\n")[0]!.slice(0, 500),
                output: null,
              }),
            ),
            Effect.flatMap(finish),
          ),
      );
      return run;
    }).pipe(Effect.orDie);

  // The clock: due schedules run, and get their next time first so they don't run twice.
  const tick = Effect.gen(function* () {
    const now = new Date();
    const due =
      yield* sql<ScheduleRow>`SELECT * FROM schedules WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ${now.toISOString()}`;
    for (const row of due) {
      const spec = JSON.parse(row.spec) as ScheduleSpec;
      yield* sql`UPDATE schedules SET next_run_at = ${nextRun(spec, now, true)} WHERE id = ${row.id}`;
      yield* execute(row, "time");
    }
    if (due.length) yield* changed;
  }).pipe(
    Effect.catchCause((cause) => Effect.sync(() => console.error("scheduler tick failed:", Cause.pretty(cause)))),
  );
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(tick, Effect.sleep("1 second"))));

  const emit = (event: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<ScheduleRow>`SELECT * FROM schedules WHERE paused = 0`;
      for (const row of rows) {
        const spec = JSON.parse(row.spec) as ScheduleSpec;
        if (spec.trigger.type !== "event" || spec.trigger.event !== event) continue;
        const last = lastEventRun.get(row.id) ?? 0;
        if (Date.now() - last < EVENT_GAP_MS) continue;
        lastEventRun.set(row.id, Date.now());
        yield* execute(row, "event");
      }
    }).pipe(Effect.orDie);

  // Apps starting and crashing are events too.
  const context = yield* Effect.context<never>();
  const states = new Map<string, string>();
  const unlisten = hub.listen((msg) => {
    if (msg.type !== "runtime") return;
    const previous = states.get(msg.appId);
    const state = msg.status.state;
    states.set(msg.appId, state);
    if (state === previous) return;
    if (state === "running") Effect.runForkWith(context)(emit(`app.started:${msg.appId}`));
    else if (state === "crashed") Effect.runForkWith(context)(emit(`app.crashed:${msg.appId}`));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unlisten));
  // Once everything is up.
  yield* Effect.forkScoped(Effect.andThen(Effect.sleep("2 seconds"), emit("rune.started")));

  return {
    list: (filter = {}) =>
      sql<ScheduleRow>`SELECT * FROM schedules ORDER BY created_at, id`.pipe(
        Effect.flatMap(toSchedules),
        Effect.map((list) =>
          list.filter(
            (s) =>
              (!filter.workspaceId || s.workspaceId === filter.workspaceId) &&
              (!filter.appId || s.task.appId === filter.appId),
          ),
        ),
        Effect.orDie,
      ),
    get: (id) => get(id).pipe(Effect.orDie),

    create: (spec, creator) =>
      Effect.gen(function* () {
        yield* check(spec);
        const [{ n }] = (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM schedules`) as [{ n: number }];
        if (n >= MAX_SCHEDULES)
          return yield* new ScheduleError({ status: 409, message: `There are already ${MAX_SCHEDULES} schedules` });
        const id = crypto.randomUUID().slice(0, 8);
        yield* sql`INSERT INTO schedules (id, spec, created_by, creator_tab, next_run_at)
          VALUES (${id}, ${JSON.stringify(spec)}, ${creator.by}, ${creator.tabId ?? null}, ${nextRun(spec, new Date())})`;
        yield* changed;
        return (yield* get(id))!;
      }).pipe(Effect.catchTag("SqlError", Effect.die)),

    update: (id, fields) =>
      Effect.gen(function* () {
        const row = yield* rowOf(id);
        if (!row) return yield* new ScheduleError({ status: 404, message: "Not found" });
        const spec = fields.spec ?? (JSON.parse(row.spec) as ScheduleSpec);
        if (fields.spec) yield* check(spec);
        const paused = fields.paused ?? row.paused === 1;
        // A new trigger, or resuming: the next time counts from now.
        const next = fields.spec || (row.paused === 1 && !paused) ? nextRun(spec, new Date()) : row.next_run_at;
        yield* sql`UPDATE schedules SET spec = ${JSON.stringify(spec)}, paused = ${paused ? 1 : 0}, next_run_at = ${next},
          updated_at = ${new Date().toISOString()} WHERE id = ${id}`;
        yield* changed;
        return (yield* get(id))!;
      }).pipe(Effect.catchTag("SqlError", Effect.die)),

    remove: (id) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM schedules WHERE id = ${id}`;
        yield* sql`DELETE FROM schedule_runs WHERE schedule_id = ${id}`;
        yield* changed;
      }).pipe(Effect.orDie),

    runNow: (id) =>
      Effect.gen(function* () {
        const row = yield* rowOf(id).pipe(Effect.orDie);
        if (!row) return yield* new ScheduleError({ status: 404, message: "Not found" });
        const run = yield* execute(row, "manual");
        yield* changed;
        return run!;
      }),

    runs: ({ scheduleId, workspaceId, before, limit = 100 }) =>
      Effect.gen(function* () {
        const rows = yield* sql<RunRow>`SELECT * FROM schedule_runs
          WHERE ${scheduleId ? sql`schedule_id = ${scheduleId}` : sql`1 = 1`} AND ${before ? sql`id < ${before}` : sql`1 = 1`}
          ORDER BY id DESC LIMIT ${Math.min(limit, 500) * (workspaceId ? 4 : 1)}`;
        let runs = rows.map(toRun);
        if (workspaceId) {
          const inWorkspace = new Set(
            (yield* toSchedules(yield* sql<ScheduleRow>`SELECT * FROM schedules`))
              .filter((s) => s.workspaceId === workspaceId)
              .map((s) => s.id),
          );
          runs = runs.filter((r) => inWorkspace.has(r.scheduleId));
        }
        return runs.slice(0, Math.min(limit, 500));
      }).pipe(Effect.orDie),

    upcoming: ({ workspaceId, limit = 20 }) =>
      Effect.gen(function* () {
        const schedules = (yield* toSchedules(
          yield* sql<ScheduleRow>`SELECT * FROM schedules WHERE paused = 0`,
        )).filter((s) => !workspaceId || s.workspaceId === workspaceId);
        const out: { scheduleId: string; name: string; at: string }[] = [];
        for (const s of schedules) {
          if (!s.nextRunAt) continue;
          out.push({ scheduleId: s.id, name: s.name, at: s.nextRunAt });
          // A few more of a recurring one.
          let at = new Date(s.nextRunAt);
          for (let i = 0; i < 4 && s.trigger.type === "cron"; i++) {
            const next = nextRun(s, at);
            if (!next) break;
            out.push({ scheduleId: s.id, name: s.name, at: next });
            at = new Date(next);
          }
        }
        return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
      }).pipe(Effect.orDie),

    emit,

    setPromptRunner: (runner) => {
      promptRunner = runner;
    },

    forgetApp: (appId) =>
      Effect.gen(function* () {
        const rows = yield* sql<ScheduleRow>`SELECT * FROM schedules`;
        const gone = rows.filter((r) => (JSON.parse(r.spec) as ScheduleSpec).task.appId === appId).map((r) => r.id);
        if (!gone.length) return;
        yield* sql`DELETE FROM schedules WHERE id IN ${sql.in(gone)}`;
        yield* sql`DELETE FROM schedule_runs WHERE schedule_id IN ${sql.in(gone)}`;
        yield* changed;
      }).pipe(Effect.orDie),
  } satisfies SchedulerShape;
});

export const layer = Layer.effect(Scheduler, make);
