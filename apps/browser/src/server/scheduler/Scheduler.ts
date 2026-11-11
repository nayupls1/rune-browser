// The scheduler: sends scheduled prompts to agents in the background (a new
// chat in the task's tab each run; the agent runs it as if the user had sent
// it, see setPromptRunner), once at a time, on a cron expression, or when
// Rune Browser starts. Tasks belong to the user, not to a tab: one whose tab
// is closed opens a new tab on its next run.
//
// Limits: recurring schedules run at most every few minutes, two runs at a
// time (the rest wait), a schedule never overlaps itself, every run has a
// timeout, event runs at most every 30 seconds per schedule, and the output
// kept is capped. A run missed while Rune Browser wasn't running happens once when
// it starts. Finished runs are published on the hub (the UI notifies) and
// recorded in the audit log.
import { Cause, Context, Data, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import type { AppSummary, Schedule, ScheduleRun, ScheduleSpec } from "../../shared/api";
import { topics } from "../../shared/hub";
import { nextRun, scheduleProblem, targetWithoutTab } from "../../shared/schedule";
import { Apps } from "../db/Apps";
import { Workspaces } from "../db/Workspaces";
import { Hub } from "../Hub";
import { Audit } from "../security/Audit";

export class ScheduleError extends Data.TaggedError("ScheduleError")<{
  readonly status: 400 | 404 | 409;
  readonly message: string;
}> {}

/** How a run went. */
export interface Outcome {
  readonly status: ScheduleRun["status"];
  readonly message: string;
  readonly output: string | null;
}

/**
 * A scheduled prompt to run: in its tab, or in a new one. `inTab` is told
 * which before the chat starts (the run links to it, and the task keeps a
 * tab it opened).
 */
export interface PromptRun {
  readonly spec: ScheduleSpec;
  readonly inTab: (tabId: string, opened: boolean) => Effect.Effect<void>;
}

export interface SchedulerShape {
  readonly list: (filter?: { workspaceId?: string }) => Effect.Effect<Schedule[]>;
  readonly get: (id: string) => Effect.Effect<Schedule | null>;
  readonly create: (spec: ScheduleSpec) => Effect.Effect<Schedule, ScheduleError>;
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
  /**
   * A tab was closed (`tab`: what it was, read before it went). Its tasks
   * stay: they open a new tab at its address on their next run
   * (shared/schedule.ts: targetWithoutTab).
   */
  readonly forgetTab: (tabId: string, tab: Pick<AppSummary, "workspaceId" | "url"> | null) => Effect.Effect<void>;
  /**
   * A workspace is being deleted, with these tabs: its tasks move to another
   * workspace, paused (its logins aren't that one's, so the user says when
   * they run again), before the tabs go.
   */
  readonly forgetWorkspace: (workspaceId: string, appIds: readonly string[]) => Effect.Effect<void>;
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
  tab_id: string | null;
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
  tabId: r.tab_id,
});

const clip = (text: string) => (text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const apps = yield* Apps;
  const workspaces = yield* Workspaces;
  const hub = yield* Hub;
  const audit = yield* Audit;
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
        const tab = spec.target.tabId ? yield* apps.get(spec.target.tabId) : null;
        out.push({
          ...spec,
          id: r.id,
          workspaceId: tab?.workspaceId ?? spec.target.workspaceId,
          paused: r.paused === 1,
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
  const dropSchedules = (ids: string[]) =>
    ids.length
      ? Effect.gen(function* () {
          yield* sql`DELETE FROM schedules WHERE id IN ${sql.in(ids)}`;
          yield* sql`DELETE FROM schedule_runs WHERE schedule_id IN ${sql.in(ids)}`;
          yield* changed;
        })
      : Effect.void;

  const check = (spec: ScheduleSpec) =>
    Effect.gen(function* () {
      const problem = scheduleProblem(spec);
      if (problem) return yield* new ScheduleError({ status: 400, message: problem });
      if (!(yield* workspaces.get(spec.target.workspaceId)))
        return yield* new ScheduleError({ status: 404, message: "No such workspace" });
      if (spec.target.tabId) {
        // Any tab can be asked, but private ones leave nothing behind.
        const tab = yield* apps.get(spec.target.tabId);
        if (!tab) return yield* new ScheduleError({ status: 404, message: "No such tab" });
        if (tab.private)
          return yield* new ScheduleError({ status: 400, message: "Private tabs can't have scheduled tasks" });
      }
    });

  // --- Running --------------------------------------------------------------------------

  const perform = (row: ScheduleRow, spec: ScheduleSpec, runId: number): Effect.Effect<Outcome> => {
    if (!promptRunner)
      return Effect.succeed<Outcome>({ status: "error", message: "Agents aren't available", output: null });
    const inTab = (tabId: string, opened: boolean) =>
      Effect.gen(function* () {
        yield* sql`UPDATE schedule_runs SET tab_id = ${tabId} WHERE id = ${runId}`;
        if (!opened) return;
        // A new tab: the task runs in it from now on.
        const current = yield* rowOf(row.id);
        if (!current) return;
        const now = JSON.parse(current.spec) as ScheduleSpec;
        // Not if the tab is gone already (deleted before it was recorded here), checked in the same statement.
        yield* sql`UPDATE schedules SET spec = ${JSON.stringify({ ...now, target: { ...now.target, tabId } })},
          updated_at = ${new Date().toISOString()}
          WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM apps WHERE id = ${tabId})`;
        yield* changed;
      }).pipe(Effect.orDie);
    return promptRunner({ spec, inTab });
  };

  const insertRun = (row: ScheduleRow, spec: ScheduleSpec, trigger: ScheduleRun["trigger"], outcome?: Outcome) =>
    Effect.gen(function* () {
      const at = new Date().toISOString();
      const [inserted] = yield* sql<RunRow>`
        INSERT INTO schedule_runs (schedule_id, schedule_name, trigger, status, started_at, finished_at, message, output, tab_id)
        VALUES (${row.id}, ${spec.name}, ${trigger}, ${outcome?.status ?? "running"}, ${at}, ${outcome ? at : null}, ${outcome?.message ?? ""}, ${outcome?.output ?? null}, ${null})
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
      // The task as it is when the run starts: its tab may have changed while it waited for a slot (a deleted
      // tab's task opens a new one), and so may its other fields.
      let now = spec;
      const finish = (outcome: Outcome) =>
        Effect.gen(function* () {
          running.delete(row.id);
          const [done] = yield* sql<RunRow>`
            UPDATE schedule_runs SET status = ${outcome.status}, message = ${outcome.message.slice(0, 2000)}, output = ${outcome.output && clip(outcome.output)},
              finished_at = ${new Date().toISOString()}
            WHERE id = ${run.id} RETURNING *`;
          // Deleted with its schedule meanwhile.
          if (!done) return;
          const finished = toRun(done);
          const notify = now.notify === "always" || (now.notify === "failure" && finished.status !== "ok");
          yield* hub.publish({ type: "schedule-run", topic: topics.schedules, run: finished, notify });
          yield* audit.record({
            actor: "rune",
            actorLabel: "Scheduler",
            tabId: finished.tabId ?? undefined,
            action: "schedule.run",
            target: now.name,
            outcome: finished.status === "ok" ? "ok" : "error",
            detail: `${trigger}: ${finished.message.slice(0, 200)}`,
          });
          // Only the latest runs are kept.
          yield* sql`DELETE FROM schedule_runs WHERE schedule_id = ${row.id} AND id NOT IN
            (SELECT id FROM schedule_runs WHERE schedule_id = ${row.id} ORDER BY id DESC LIMIT ${KEEP_RUNS})`;
        }).pipe(Effect.orDie);
      // Started in the background: the caller (the clock, an event, "Run now") doesn't wait. Its time limit starts
      // when it gets a slot.
      yield* Effect.forkDetach(
        slots
          .withPermits(1)(
            rowOf(row.id).pipe(
              Effect.orDie,
              Effect.flatMap((current) => {
                if (!current)
                  return Effect.succeed<Outcome>({
                    status: "skipped",
                    message: "The schedule was deleted",
                    output: null,
                  });
                now = JSON.parse(current.spec) as ScheduleSpec;
                return perform(current, now, run.id).pipe(
                  Effect.timeoutOrElse({
                    duration: now.timeoutSec * 1000,
                    orElse: () =>
                      Effect.succeed<Outcome>({
                        status: "timeout",
                        message: `Stopped after ${now.timeoutSec} s`,
                        output: null,
                      }),
                  }),
                );
              }),
            ),
          )
          .pipe(
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
      yield* sql`UPDATE schedules SET next_run_at = ${nextRun(spec.trigger, now, true)} WHERE id = ${row.id}`;
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

  // Once everything is up.
  yield* Effect.forkScoped(Effect.andThen(Effect.sleep("2 seconds"), emit("rune.started")));

  return {
    list: (filter = {}) =>
      sql<ScheduleRow>`SELECT * FROM schedules ORDER BY created_at, id`.pipe(
        Effect.flatMap(toSchedules),
        Effect.map((list) => list.filter((s) => !filter.workspaceId || s.workspaceId === filter.workspaceId)),
        Effect.orDie,
      ),
    get: (id) => get(id).pipe(Effect.orDie),

    create: (spec) =>
      Effect.gen(function* () {
        yield* check(spec);
        const [{ n }] = (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM schedules`) as [{ n: number }];
        if (n >= MAX_SCHEDULES)
          return yield* new ScheduleError({ status: 409, message: `There are already ${MAX_SCHEDULES} schedules` });
        const id = crypto.randomUUID().slice(0, 8);
        yield* sql`INSERT INTO schedules (id, spec, created_by, next_run_at)
          VALUES (${id}, ${JSON.stringify(spec)}, 'user', ${nextRun(spec.trigger, new Date())})`;
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
        const next = fields.spec || (row.paused === 1 && !paused) ? nextRun(spec.trigger, new Date()) : row.next_run_at;
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
            const next = nextRun(s.trigger, at);
            if (!next) break;
            out.push({ scheduleId: s.id, name: s.name, at: next });
            at = new Date(next);
          }
        }
        return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
      }).pipe(Effect.orDie),

    setPromptRunner: (runner) => {
      promptRunner = runner;
    },

    forgetTab: (tabId, tab) =>
      Effect.gen(function* () {
        let kept = false;
        for (const row of yield* sql<ScheduleRow>`SELECT * FROM schedules`) {
          const spec = JSON.parse(row.spec) as ScheduleSpec;
          if (spec.target.tabId !== tabId) continue;
          const next: ScheduleSpec = { ...spec, target: targetWithoutTab(spec.target, tab) };
          yield* sql`UPDATE schedules SET spec = ${JSON.stringify(next)}, updated_at = ${new Date().toISOString()}
            WHERE id = ${row.id}`;
          kept = true;
        }
        if (kept) yield* changed;
      }).pipe(Effect.orDie),
    forgetWorkspace: (workspaceId, appIds) =>
      Effect.gen(function* () {
        const elsewhere = (yield* workspaces.list()).find((w) => w.id !== workspaceId);
        let moved = false;
        for (const row of yield* sql<ScheduleRow>`SELECT * FROM schedules`) {
          const spec = JSON.parse(row.spec) as ScheduleSpec;
          const tabId = spec.target.tabId;
          const inIt = tabId ? appIds.includes(tabId) : spec.target.workspaceId === workspaceId;
          if (!inIt) continue;
          if (!elsewhere) {
            yield* dropSchedules([row.id]);
            continue;
          }
          const tab = tabId ? yield* apps.get(tabId) : null;
          const target = { ...targetWithoutTab(spec.target, tab), workspaceId: elsewhere.id };
          yield* sql`UPDATE schedules SET spec = ${JSON.stringify({ ...spec, target })}, paused = 1, next_run_at = NULL,
            updated_at = ${new Date().toISOString()} WHERE id = ${row.id}`;
          moved = true;
        }
        if (moved) yield* changed;
      }).pipe(Effect.orDie),
  } satisfies SchedulerShape;
});

export const layer = Layer.effect(Scheduler, make);
