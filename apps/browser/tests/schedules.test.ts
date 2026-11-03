// The scheduler: cron expressions, checks, and real background runs against
// the server (tools, commands, events, timeouts, overlap, pause). No model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSummary, AuditEntry, Schedule, ScheduleRun, ScheduleSpec, WorkspaceInfo } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { describeCron, nextCron, parseCron, shortestGapMinutes, type Cron } from "../src/shared/cron";
import { scheduleProblem } from "../src/shared/schedule";
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
  });

  test("gaps and words", () => {
    expect(shortestGapMinutes(cron("*/5 * * * *"))).toBe(5);
    expect(shortestGapMinutes(cron("0 8,9 * * *"))).toBe(60);
    expect(describeCron("0 8 * * *")).toBe("Every day at 08:00");
    expect(describeCron("30 7 * * 1-5")).toBe("Weekdays at 07:30");
    expect(describeCron("*/10 * * * *")).toBe("Every 10 minutes");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeCron("5 4 3 2 1")).toBe("5 4 3 2 1");
  });
});

describe("checks", () => {
  const spec: ScheduleSpec = {
    name: "Sync",
    trigger: { type: "cron", cron: "0 * * * *" },
    task: { type: "command", appId: "a", command: "true" },
    notify: "failure",
    timeoutSec: 60,
  };
  test("limits and fields", () => {
    expect(scheduleProblem(spec)).toBeNull();
    expect(scheduleProblem({ ...spec, trigger: { type: "cron", cron: "* * * * *" } })).toContain(
      "at most every 5 minutes",
    );
    expect(scheduleProblem({ ...spec, trigger: { type: "once", at: "2020-01-01T00:00:00Z" } })).toBe(
      "That time has passed",
    );
    expect(scheduleProblem({ ...spec, trigger: { type: "event", event: "app:abc:done" } })).toBeNull();
    expect(scheduleProblem({ ...spec, trigger: { type: "event", event: "whenever" } })).toContain("Events are");
    expect(scheduleProblem({ ...spec, timeoutSec: 99_999 })).toContain("timeout");
    expect(scheduleProblem({ ...spec, task: { type: "tool", appId: "a", tool: "" } })).toBe("Which tool?");
  });

  test("prompts: in a tab, or in a new one", () => {
    expect(scheduleProblem({ ...spec, task: { type: "prompt", prompt: "Summarize the news", appId: "a" } })).toBeNull();
    expect(
      scheduleProblem({ ...spec, task: { type: "prompt", prompt: "Hi", newTab: { kind: "app", workspaceId: "w" } } }),
    ).toBeNull();
    expect(scheduleProblem({ ...spec, task: { type: "prompt", prompt: " ", appId: "a" } })).toBe(
      "What should the agent do?",
    );
    expect(scheduleProblem({ ...spec, task: { type: "prompt", prompt: "Hi" } })).toBe("Which tab?");
    expect(
      scheduleProblem({
        ...spec,
        task: { type: "prompt", prompt: "Hi", newTab: { kind: "web", workspaceId: "w", url: "example.com" } },
      }),
    ).toContain("http(s)");
  });
});

describe("scheduler", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let app: AppSummary;
  let token: string;
  const dir = () => join(server.dataDir, "apps", app.id);
  const base = (fields: Partial<ScheduleSpec>): ScheduleSpec => ({
    name: "Job",
    trigger: { type: "cron", cron: "0 3 * * *" },
    task: { type: "command", appId: app.id, command: "echo hello" },
    notify: "failure",
    timeoutSec: 60,
    ...fields,
  });
  const create = (fields: Partial<ScheduleSpec>) =>
    server.api<Schedule>("/api/schedules", { method: "POST", json: base(fields) });
  const runsOf = (id: string) => server.api<ScheduleRun[]>(`/api/schedules/runs?schedule=${id}`);
  const finished = async (id: string, count = 1, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const runs = (await runsOf(id)).filter((r) => r.status !== "running");
      if (runs.length >= count) return runs;
      if (Date.now() > deadline) throw new Error(`no finished run of ${id}: ${JSON.stringify(await runsOf(id))}`);
      await Bun.sleep(100);
    }
  };

  beforeAll(async () => {
    server = await startServer();
    app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "stop" } });
    writeFileSync(
      join(dir(), "action.ts"),
      `await Bun.write("token.txt", process.env.RUNE_API_TOKEN ?? "");
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname === "/api/digest") return Response.json({ message: "Sent the digest", sent: 3 });
    return new Response("ok");
  },
});`,
    );
    writeFileSync(
      join(dir(), "rune.json"),
      JSON.stringify({
        install: "true",
        dev: "bun action.ts",
        start: "bun action.ts",
        actions: [{ id: "digest", title: "Send digest", endpoint: "/api/digest" }],
      }),
    );
  });
  afterAll(() => server.stop());

  test("a one-off schedule runs at its time, without a tab, using an app's tool", async () => {
    const schedule = await create({
      name: "Digest",
      trigger: { type: "once", at: new Date(Date.now() + 1500).toISOString() },
      task: { type: "tool", appId: app.id, tool: "digest" },
    });
    expect(schedule.nextRunAt).not.toBeNull();
    const [run] = await finished(schedule.id, 1, 60_000);
    expect(run).toMatchObject({ status: "ok", trigger: "time", message: "Sent the digest", scheduleName: "Digest" });
    expect(JSON.parse(run!.output!)).toMatchObject({ sent: 3 });
    const after = (await server.api<Schedule[]>("/api/schedules")).find((s) => s.id === schedule.id)!;
    expect(after.nextRunAt).toBeNull();
    expect(after.lastRun?.id).toBe(run!.id);
    const file = join(dir(), "token.txt");
    token = existsSync(file) ? readFileSync(file, "utf8") : "";
  }, 90_000);

  test("commands run in the app's sandbox; failures and timeouts are results too", async () => {
    const ok = await create({
      name: "Hello",
      task: { type: "command", appId: app.id, command: "echo hello from $RUNE_MODE" },
    });
    expect(ok.nextRunAt).not.toBeNull();
    await server.api(`/api/schedules/${ok.id}/run`, { method: "POST" });
    const [done] = await finished(ok.id);
    expect(done).toMatchObject({ status: "ok", trigger: "manual", message: "Done" });
    expect(done!.output).toContain("hello from");

    const failing = await create({
      name: "Broken",
      task: { type: "command", appId: app.id, command: "echo nope 1>&2; exit 3" },
    });
    await server.api(`/api/schedules/${failing.id}/run`, { method: "POST" });
    expect((await finished(failing.id))[0]).toMatchObject({ status: "error", message: "Exited with code 3" });

    const slow = await create({
      name: "Slow",
      timeoutSec: 5,
      task: { type: "command", appId: app.id, command: 'bun -e "await Bun.sleep(30000)"' },
    });
    await server.api(`/api/schedules/${slow.id}/run`, { method: "POST" });
    // It never runs twice at once.
    const second = await server.api<ScheduleRun>(`/api/schedules/${slow.id}/run`, { method: "POST" });
    expect(second).toMatchObject({ status: "skipped", message: "The previous run was still going" });
    const runs = await finished(slow.id, 2, 15_000);
    expect(runs.map((r) => r.status).sort()).toEqual(["skipped", "timeout"]);

    const audit = await server.api<AuditEntry[]>(`/api/audit?tab=${app.id}`);
    expect(audit.filter((e) => e.action === "schedule.run").map((e) => [e.target, e.outcome])).toContainEqual([
      "Broken",
      "error",
    ]);
  }, 90_000);

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
    expect((await server.api<Schedule[]>("/api/schedules")).some((s) => s.id === schedule.id)).toBe(false);
  });

  test("events: one the app sends, and the app starting", async () => {
    const onPing = await create({ name: "On ping", trigger: { type: "event", event: `app:${app.id}:ping` } });
    expect(onPing.nextRunAt).toBeNull();
    expect(token).toMatch(/^nai_/);
    const res = await fetch(`${server.url}/app-api/v1/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ping" }),
    });
    expect(res.status).toBe(200);
    expect((await finished(onPing.id))[0]).toMatchObject({ status: "ok", trigger: "event" });

    const onStart = await create({ name: "On start", trigger: { type: "event", event: `app.started:${app.id}` } });
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
    expect((await finished(onStart.id, 1, 60_000))[0]).toMatchObject({ status: "ok", trigger: "event" });
  }, 90_000);

  test("unknown apps and tools are refused; a deleted app's schedules go with it", async () => {
    await expect(create({ task: { type: "tool", appId: app.id, tool: "nope" } })).rejects.toThrow("404");
    await expect(create({ task: { type: "command", appId: "nope", command: "true" } })).rejects.toThrow("404");
    await server.api(`/api/apps/${app.id}`, { method: "DELETE" });
    expect(await server.api<Schedule[]>("/api/schedules")).toEqual([]);
  });
});

describe("scheduled prompts", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
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

  test("a new tab is opened on the first run and kept", async () => {
    const [space] = await server.api<WorkspaceInfo[]>("/api/workspaces");
    const before = (await server.api<AppSummary[]>("/api/apps")).length;
    const schedule = await server.api<Schedule>("/api/schedules", {
      method: "POST",
      json: {
        name: "Morning",
        trigger: { type: "cron", cron: "0 8 * * *" },
        task: { type: "prompt", prompt: "Summarize", newTab: { kind: "app", workspaceId: space!.id } },
        notify: "never",
        timeoutSec: 60,
      },
    });
    expect(schedule.workspaceId).toBe(space!.id);
    const runOnce = async () => {
      const run = await server.api<ScheduleRun>(`/api/schedules/${schedule.id}/run`, { method: "POST" });
      for (let i = 0; i < 100; i++) {
        const runs = await server.api<ScheduleRun[]>(`/api/schedules/runs?schedule=${schedule.id}`);
        const done = runs.find((r) => r.id === run.id && r.status !== "running");
        if (done) return done;
        await Bun.sleep(100);
      }
      throw new Error("the run didn't finish");
    };
    const first = await runOnce();
    expect(first.status).toBe("error");
    expect(first.message).toContain("turned off in Settings");
    const tabs = await server.api<AppSummary[]>("/api/apps");
    expect(tabs.length).toBe(before + 1);
    const updated = (await server.api<Schedule[]>("/api/schedules")).find((s) => s.id === schedule.id)!;
    expect(updated.task).toEqual({ type: "prompt", prompt: "Summarize", appId: tabs.at(-1)!.id });

    // The next run uses that tab.
    await runOnce();
    expect((await server.api<AppSummary[]>("/api/apps")).length).toBe(before + 1);
  });

  test("a prompt for a tab that doesn't exist is refused", async () => {
    await expect(
      server.api("/api/schedules", {
        method: "POST",
        json: {
          name: "X",
          trigger: { type: "cron", cron: "0 8 * * *" },
          task: { type: "prompt", prompt: "Hi", appId: "nope" },
          notify: "never",
          timeoutSec: 60,
        },
      }),
    ).rejects.toThrow("404");
  });
});
