// Scheduled tasks: repeats in words and as cron expressions, checks, where a
// task runs once its tab is gone, and real background runs against the server
// (times, events, pause, the model, tabs closed and deleted, workspaces
// deleted). No model: the providers are turned off, so a run fails at the
// agent, after everything around it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import type { AppSummary, Schedule, ScheduleRun, ScheduleSpec, WorkspaceInfo } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import {
  cronToRepeat,
  describeCron,
  nextCron,
  parseCron,
  repeatToCron,
  shortestGapMinutes,
  type Cron,
  type Repeat,
} from "../src/shared/cron";
import { nextRun, scheduleProblem, targetWithoutTab } from "../src/shared/schedule";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { Workspaces } from "../src/server/db/Workspaces";
import { Scheduler } from "../src/server/scheduler/Scheduler";
import { core } from "../src/server/services";
import { startServer } from "./lib/server";

const cron = (text: string) => parseCron(text) as Cron;

describe("cron", () => {
  test("reads the five fields and says what's wrong", () => {
    expect(typeof parseCron("*/15 8-18 * * 1-5")).toBe("object");
    expect(parseCron("0 8 * *")).toContain("five parts");
    expect(parseCron("61 * * * *")).toContain("minute must be between 0 and 59");
    expect(parseCron("0 8 * * mon")).toContain("day of week");
  });

  test("finds the next time", () => {
    const at = (s: string) => new Date(s);
    // Friday 2026-10-23 09:30 local → next weekday 08:00 is Monday.
    expect(nextCron(cron("0 8 * * 1-5"), at("2026-10-23T09:30:00"))).toEqual(at("2026-10-26T08:00:00"));
    expect(nextCron(cron("*/15 * * * *"), at("2026-10-23T09:31:10"))).toEqual(at("2026-10-23T09:45:00"));
    expect(nextCron(cron("0 0 29 2 *"), at("2026-03-01T00:00:00"))).toEqual(at("2028-02-29T00:00:00"));
    // Day of month or day of week, as in cron.
    expect(nextCron(cron("0 12 1 * 0"), at("2026-10-23T00:00:00"))).toEqual(at("2026-10-25T12:00:00"));
    expect(nextCron(cron("0 9 * * 7"), at("2026-10-23T00:00:00"))).toEqual(at("2026-10-25T09:00:00"));
    expect(shortestGapMinutes(cron("*/5 * * * *"))).toBe(5);
    expect(shortestGapMinutes(cron("0 8,9 * * *"))).toBe(60);
  });

  test("schedules read back in plain words", () => {
    expect(describeCron("0 8 * * *")).toBe("Every day at 8:00");
    expect(describeCron("30 7 * * 1-5")).toBe("Every weekday at 7:30");
    expect(describeCron("0 9 * * 1,2,3,4,5")).toBe("Every weekday at 9:00");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 9:00");
    expect(describeCron("0 9 * * 5,1,3")).toBe("Every Monday, Wednesday and Friday at 9:00");
    expect(describeCron("0 10 * * 0,6")).toBe("Every Saturday and Sunday at 10:00");
    expect(describeCron("0 9 * * 7")).toBe("Every Sunday at 9:00");
    expect(describeCron("*/10 * * * *")).toBe("Every 10 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(describeCron("30 18 1 * *")).toBe("Every month on the 1st at 18:30");
    expect(describeCron("0 8 22 * *")).toBe("Every month on the 22nd at 8:00");
    expect(describeCron("0 8 13 * *")).toBe("Every month on the 13th at 8:00");
    // Anything the picker doesn't offer, as it is.
    expect(describeCron("5 4 3 2 1")).toBe("5 4 3 2 1");
    expect(describeCron("0 */5 * * *")).toBe("0 */5 * * *");
  });

  test("the picker's repeats are cron expressions and back", () => {
    const repeats: Repeat[] = [
      { every: "minutes", n: 15 },
      { every: "hours", n: 1, minute: 0 },
      { every: "hours", n: 6, minute: 30 },
      { every: "day", time: "9:00" },
      { every: "weekdays", time: "7:45" },
      { every: "week", days: [1, 3, 5], time: "18:00" },
      { every: "week", days: [0], time: "10:00" },
      { every: "month", day: 15, time: "8:05" },
    ];
    for (const repeat of repeats) {
      expect(typeof parseCron(repeatToCron(repeat))).toBe("object");
      expect(cronToRepeat(repeatToCron(repeat))).toEqual(repeat);
    }
    expect(repeatToCron({ every: "weekdays", time: "9:00" })).toBe("0 9 * * 1-5");
    expect(repeatToCron({ every: "week", days: [5, 1, 1], time: "9:30" })).toBe("30 9 * * 1,5");
    // Every day of the week is every day; Monday to Friday, weekdays.
    expect(cronToRepeat("0 9 * * 0-6")).toEqual({ every: "day", time: "9:00" });
    expect(cronToRepeat("0 9 * * 1,2,3,4,5")).toEqual({ every: "weekdays", time: "9:00" });
    expect(cronToRepeat("0 9 1 1 *")).toBeNull();
  });

  test("the next run", () => {
    const from = new Date("2026-11-11T10:00:00");
    expect(nextRun({ type: "cron", cron: "0 9 * * 1-5" }, from)).toBe(new Date("2026-11-12T09:00:00").toISOString());
    expect(nextRun({ type: "once", at: "2026-11-11T12:00:00Z" }, from, true)).toBeNull();
    expect(nextRun({ type: "event", event: "rune.started" }, from)).toBeNull();
  });
});

describe("checks", () => {
  const spec: ScheduleSpec = {
    name: "News",
    trigger: { type: "cron", cron: "0 * * * *" },
    prompt: "Summarize the news",
    target: { workspaceId: "w", tabId: null, kind: "web", url: null },
    agent: null,
    notify: "failure",
    timeoutSec: 60,
  };
  test("limits and fields", () => {
    expect(scheduleProblem(spec)).toBeNull();
    expect(scheduleProblem({ ...spec, prompt: " " })).toBe("What should the agent do?");
    expect(scheduleProblem({ ...spec, trigger: { type: "cron", cron: "* * * * *" } })).toContain(
      "at most every 5 minutes",
    );
    expect(scheduleProblem({ ...spec, trigger: { type: "once", at: "2020-01-01T00:00:00Z" } })).toBe(
      "That time has passed",
    );
    expect(scheduleProblem({ ...spec, trigger: { type: "event", event: "app:abc:done" } })).toBeNull();
    expect(scheduleProblem({ ...spec, trigger: { type: "event", event: "whenever" } })).toContain("Events are");
    expect(scheduleProblem({ ...spec, timeoutSec: 99_999 })).toContain("time limit");
  });

  test("where: a tab, or a new (web or app) tab, at a website or not", () => {
    expect(scheduleProblem({ ...spec, target: { ...spec.target, tabId: "a" } })).toBeNull();
    expect(scheduleProblem({ ...spec, target: { ...spec.target, kind: "app" } })).toBeNull();
    expect(scheduleProblem({ ...spec, target: { ...spec.target, url: "https://example.com" } })).toBeNull();
    expect(scheduleProblem({ ...spec, target: { ...spec.target, url: "example.com" } })).toContain("http(s)");
    expect(scheduleProblem({ ...spec, target: { ...spec.target, kind: "app", url: "https://a.example" } })).toContain(
      "http(s)",
    );
    expect(scheduleProblem({ ...spec, target: { ...spec.target, workspaceId: "" } })).toBe("Which workspace?");
  });

  test("the model and effort, or the default", () => {
    expect(scheduleProblem({ ...spec, agent: { provider: "codex", model: "gpt-5", effort: "high" } })).toBeNull();
    expect(scheduleProblem({ ...spec, agent: { provider: "claude", model: null, effort: null } })).toBeNull();
    expect(
      scheduleProblem({ ...spec, agent: { provider: "gemini" as "claude", model: null, effort: null } }),
    ).toContain("agent.provider");
    expect(scheduleProblem({ ...spec, agent: { provider: "claude", model: "", effort: null } })).toBe("Which model?");
  });

  test("a task outlives its tab: the next run opens a new one like it", () => {
    const inTab = { workspaceId: "w", tabId: "a", kind: "web", url: null } as const;
    const web = { kind: "web", workspaceId: "w", url: "https://news.example/today" } as const;
    expect(targetWithoutTab(inTab, web)).toEqual({
      workspaceId: "w",
      tabId: null,
      kind: "web",
      url: "https://news.example/today",
    });
    // An app tab: a new app tab. A web tab that wasn't on a website: an empty one (or the address it had).
    expect(targetWithoutTab(inTab, { kind: "app", workspaceId: "w", url: null })).toEqual({
      workspaceId: "w",
      tabId: null,
      kind: "app",
      url: null,
    });
    expect(targetWithoutTab(inTab, { ...web, url: "file:///home/me/notes.html" }).url).toBeNull();
    expect(targetWithoutTab({ ...inTab, url: "https://kept.example" }, { ...web, url: "rune://settings" }).url).toBe(
      "https://kept.example",
    );
    // It moved to another workspace meanwhile: there.
    expect(targetWithoutTab(inTab, { ...web, workspaceId: "v" }).workspaceId).toBe("v");
    expect(targetWithoutTab(inTab, null)).toEqual({ ...inTab, tabId: null });
  });
});

describe("tasks from before they were prompts only", () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-schedules-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = <A>(effect: Effect.Effect<A, unknown, Apps | Workspaces | Scheduler>) => {
    const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dir, PORT: "1" })));
    return runtime.runPromise(effect as Effect.Effect<A>).finally(() => runtime.dispose());
  };

  test("tab-bound and new-tab prompts keep working; tools and commands go", async () => {
    const { tab, workspace } = await run(
      Effect.gen(function* () {
        const workspace = (yield* (yield* Workspaces).first()).id;
        const tab = yield* (yield* Apps).create(workspace, "web", "https://example.com/");
        return { tab: tab.id, workspace };
      }),
    );
    const db = new Database(join(dir, "rune.sqlite"));
    db.run("ALTER TABLE schedule_runs DROP COLUMN tab_id");
    const old = (id: string, task: object) =>
      db.run("INSERT INTO schedules (id, spec, created_by) VALUES (?, ?, 'user')", [
        id,
        JSON.stringify({
          name: id,
          trigger: { type: "cron", cron: "0 8 * * *" },
          task,
          notify: "never",
          timeoutSec: 60,
        }),
      ]);
    old("in-tab", { type: "prompt", prompt: "Summarize", appId: tab });
    old("new-tab", {
      type: "prompt",
      prompt: "Hi",
      newTab: { kind: "web", workspaceId: workspace, url: "https://a.example" },
    });
    old("tool", { type: "tool", appId: tab, tool: "digest" });
    old("command", { type: "command", appId: tab, command: "true" });
    db.close();

    const list = await run(
      Effect.gen(function* () {
        return yield* (yield* Scheduler).list();
      }),
    );
    expect(list.map((s) => [s.id, s.prompt, s.target, s.agent])).toEqual([
      ["in-tab", "Summarize", { workspaceId: workspace, tabId: tab, kind: "web", url: null }, null],
      ["new-tab", "Hi", { workspaceId: workspace, tabId: null, kind: "web", url: "https://a.example" }, null],
    ]);
  }, 30_000);
});

describe("scheduler", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let space: WorkspaceInfo;
  const base = (fields: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
    name: "Job",
    trigger: { type: "cron", cron: "0 3 * * *" },
    prompt: "Summarize the news",
    target: { workspaceId: space.id, tabId: null, kind: "web", url: null },
    agent: null,
    notify: "never",
    timeoutSec: 60,
    ...fields,
  });
  const create = (fields: Partial<ScheduleSpec> = {}) =>
    server.api<Schedule>("/api/schedules", { method: "POST", json: base(fields) });
  const runsOf = (id: string) => server.api<ScheduleRun[]>(`/api/schedules/runs?schedule=${id}`);
  const scheduleOf = async (id: string) => (await server.api<Schedule[]>("/api/schedules")).find((s) => s.id === id);
  const finished = async (id: string, count = 1, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const runs = (await runsOf(id)).filter((r) => r.status !== "running");
      if (runs.length >= count) return runs;
      if (Date.now() > deadline) throw new Error(`no finished run of ${id}: ${JSON.stringify(await runsOf(id))}`);
      await Bun.sleep(100);
    }
  };
  const runNow = async (id: string) => {
    const run = await server.api<ScheduleRun>(`/api/schedules/${id}/run`, { method: "POST" });
    for (let i = 0; i < 200; i++) {
      const done = (await runsOf(id)).find((r) => r.id === run.id && r.status !== "running");
      if (done) return done;
      await Bun.sleep(100);
    }
    throw new Error(`the run of ${id} didn't finish`);
  };
  const tabs = () => server.api<AppSummary[]>("/api/apps");

  beforeAll(async () => {
    server = await startServer();
    [space] = (await server.api<WorkspaceInfo[]>("/api/workspaces")) as [WorkspaceInfo];
    // No provider can run: the run fails at the agent, after everything around it.
    const settings = await server.api<Settings>("/api/settings");
    const off = { enabled: false };
    await server.api("/api/settings", {
      method: "PUT",
      json: {
        ...settings,
        providers: {
          claude: { ...settings.providers.claude, ...off },
          codex: { ...settings.providers.codex, ...off },
          opencode: { ...settings.providers.opencode, ...off },
        },
      },
    });
    // A refresh joins the startup check if it's still going: again until they're off.
    for (let i = 0; i < 20; i++) {
      const providers = await server.api<{ state: string }[]>("/api/providers/refresh", { method: "POST", json: {} });
      if (providers.every((p) => p.state === "disabled")) break;
    }
  }, 60_000);
  afterAll(() => server.stop());

  test("a one-off task runs at its time, in a new tab it opens and keeps, with the default agent", async () => {
    const before = (await tabs()).length;
    const schedule = await create({
      name: "Morning",
      trigger: { type: "once", at: new Date(Date.now() + 1500).toISOString() },
    });
    expect(schedule.nextRunAt).not.toBeNull();
    expect(schedule.workspaceId).toBe(space.id);
    const [run] = await finished(schedule.id, 1, 30_000);
    // The workspace's default agent (Claude Code), turned off here.
    expect(run).toMatchObject({ status: "error", trigger: "time", scheduleName: "Morning" });
    expect(run!.message).toContain("Claude Code can't run");
    const opened = await tabs();
    expect(opened.length).toBe(before + 1);
    const tab = opened.at(-1)!;
    expect(tab.kind).toBe("web");
    // The run links to its chat's tab, and the task keeps that tab.
    expect(run!.tabId).toBe(tab.id);
    const after = (await scheduleOf(schedule.id))!;
    expect(after.target).toEqual({ workspaceId: space.id, tabId: tab.id, kind: "web", url: null });
    expect(after.nextRunAt).toBeNull();
    expect(after.lastRun?.id).toBe(run!.id);
    await server.api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
  }, 60_000);

  test("a task's model is used on every run", async () => {
    const schedule = await create({ name: "With Codex", agent: { provider: "codex", model: null, effort: "high" } });
    expect(schedule.agent).toEqual({ provider: "codex", model: null, effort: "high" });
    const first = await runNow(schedule.id);
    expect(first.message).toContain("Codex can't run");
    expect((await runNow(schedule.id)).message).toContain("Codex can't run");
    // Back to the default.
    await server.api(`/api/schedules/${schedule.id}`, { method: "PATCH", json: { spec: base({ name: "Default" }) } });
    expect((await runNow(schedule.id)).message).toContain("Claude Code can't run");
    await expect(create({ agent: { provider: "gemini" as "claude", model: null, effort: null } })).rejects.toThrow(
      "400",
    );
  }, 60_000);

  test("pause, resume, edit and delete", async () => {
    const schedule = await create({ name: "Nightly" });
    const paused = await server.api<Schedule>(`/api/schedules/${schedule.id}`, {
      method: "PATCH",
      json: { paused: true },
    });
    expect(paused).toMatchObject({ paused: true, nextRunAt: null });
    const resumed = await server.api<Schedule>(`/api/schedules/${schedule.id}`, {
      method: "PATCH",
      json: { paused: false },
    });
    expect(resumed.nextRunAt).toBe(schedule.nextRunAt);
    const edited = await server.api<Schedule>(`/api/schedules/${schedule.id}`, {
      method: "PATCH",
      json: { spec: base({ name: "Hourly", trigger: { type: "cron", cron: "0 * * * *" } }) },
    });
    expect(edited.name).toBe("Hourly");
    expect(new Date(edited.nextRunAt!).getMinutes()).toBe(0);
    await expect(
      server.api(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        json: { spec: base({ trigger: { type: "cron", cron: "* * * * *" } }) },
      }),
    ).rejects.toThrow("400");
    const upcoming = await server.api<{ scheduleId: string; at: string }[]>("/api/schedules/upcoming");
    expect(upcoming.filter((u) => u.scheduleId === schedule.id).length).toBeGreaterThan(1);
    await server.api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
    expect(await scheduleOf(schedule.id)).toBeUndefined();
  });

  test("closing its web tab keeps the task: it opens a new tab at that address, and its runs stay", async () => {
    const news = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "News" } });
    const tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com/news", workspaceId: news.id },
    });
    const task = await create({
      name: "News",
      target: { workspaceId: news.id, tabId: tab.id, kind: "web", url: null },
    });
    const first = await runNow(task.id);
    expect(first.tabId).toBe(tab.id);

    // Closing a web tab deletes it.
    await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
    const kept = await scheduleOf(task.id);
    expect(kept?.target).toEqual({ workspaceId: news.id, tabId: null, kind: "web", url: "https://example.com/news" });
    expect(kept?.workspaceId).toBe(news.id);
    expect((await runsOf(task.id)).map((r) => r.id)).toEqual([first.id]);

    // The next run opens the new tab, and the task keeps it.
    const second = await runNow(task.id);
    const opened = (await tabs()).filter((t) => t.workspaceId === news.id && t.url === "https://example.com/news");
    expect(opened.length).toBe(1);
    expect(second.tabId).toBe(opened[0]!.id);
    expect((await scheduleOf(task.id))?.target.tabId).toBe(opened[0]!.id);
    await server.api(`/api/schedules/${task.id}`, { method: "DELETE" });
    await server.api(`/api/workspaces/${news.id}`, { method: "DELETE" });
  }, 60_000);

  test("deleting an app keeps its tasks (they open a new app tab); deleting a workspace moves them, paused", async () => {
    const scratch = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Scratch" } });
    const app = await server.api<AppSummary>("/api/apps", { method: "POST", json: { workspaceId: scratch.id } });
    const web = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com/", workspaceId: scratch.id },
    });
    const inApp = await create({
      name: "In the app",
      target: { workspaceId: scratch.id, tabId: app.id, kind: "app", url: null },
    });
    await server.api(`/api/apps/${app.id}`, { method: "DELETE" });
    expect((await scheduleOf(inApp.id))?.target).toEqual({
      workspaceId: scratch.id,
      tabId: null,
      kind: "app",
      url: null,
    });

    const inWeb = await create({
      name: "In the web tab",
      target: { workspaceId: scratch.id, tabId: web.id, kind: "web", url: null },
    });
    const before = (await tabs()).length;
    await server.api(`/api/workspaces/${scratch.id}`, { method: "DELETE" });
    expect((await tabs()).length).toBe(before - 1);
    for (const [id, target] of [
      [inApp.id, { workspaceId: space.id, tabId: null, kind: "app", url: null }],
      [inWeb.id, { workspaceId: space.id, tabId: null, kind: "web", url: "https://example.com/" }],
    ] as const) {
      const moved = await scheduleOf(id);
      expect(moved).toMatchObject({ target, workspaceId: space.id, paused: true, nextRunAt: null });
      await server.api(`/api/schedules/${id}`, { method: "DELETE" });
    }
  });

  test("a tab or workspace that doesn't exist is refused", async () => {
    await expect(create({ target: { workspaceId: space.id, tabId: "nope", kind: "web", url: null } })).rejects.toThrow(
      "404",
    );
    await expect(create({ target: { workspaceId: "nope", tabId: null, kind: "web", url: null } })).rejects.toThrow(
      "404",
    );
  });

  test("events: one an app sends, and the app starting", async () => {
    const app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    const dir = join(server.dataDir, "apps", app.id);
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "stop" } });
    writeFileSync(
      join(dir, "server.ts"),
      `await Bun.write("token.txt", process.env.RUNE_API_TOKEN ?? "");
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("ok") });`,
    );
    writeFileSync(
      join(dir, "rune.json"),
      JSON.stringify({ install: "true", dev: "bun server.ts", start: "bun server.ts" }),
    );
    const target = { workspaceId: app.workspaceId, tabId: app.id, kind: "app", url: null } as const;
    const onStart = await create({
      name: "On start",
      target,
      trigger: { type: "event", event: `app.started:${app.id}` },
    });
    expect(onStart.nextRunAt).toBeNull();
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
    expect((await finished(onStart.id, 1, 60_000))[0]).toMatchObject({ trigger: "event", tabId: app.id });

    const onPing = await create({ name: "On ping", target, trigger: { type: "event", event: `app:${app.id}:ping` } });
    const file = join(dir, "token.txt");
    for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(100);
    const token = readFileSync(file, "utf8");
    expect(token).toMatch(/^nai_/);
    const res = await fetch(`${server.url}/app-api/v1/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ping" }),
    });
    expect(res.status).toBe(200);
    expect((await finished(onPing.id))[0]).toMatchObject({ trigger: "event" });
  }, 90_000);
});
