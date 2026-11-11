// Background jobs (agent/Jobs.ts) and the agent's tools for them: batches of
// requests against a fake page (a few at a time, errors per item, results in
// the chat's folder, approval and confirmation), page scripts that run longer
// than run_js allows (against a fake page that really runs them), waiting,
// stopping, and jobs ending with their chat.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Context, Effect, Exit, Scope } from "effect";
import type { ChatEvent, ChatMessage, ReplayResult } from "../src/shared/api";
import { batchTools } from "../src/server/agent/batchTools";
import { ChatFiles, type ChatFilesShape } from "../src/server/agent/ChatFiles";
import { Jobs, makeIn } from "../src/server/agent/Jobs";
import { jobTools } from "../src/server/agent/jobTools";
import { Apps } from "../src/server/db/Apps";
import { Network } from "../src/server/db/Network";
import { Hub, type HubShape } from "../src/server/Hub";
import { Permissions, type AskInput } from "../src/server/security/Permissions";

const setup = (options: { answers?: Partial<Record<AskInput["action"], boolean>>; delayMs?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "rune-jobs-"));
  const asked: AskInput[] = [];
  const sent: { url?: string; method?: string }[] = [];
  const logged: string[] = [];
  const chat: { role: string; content: string }[] = [];
  const pushed: ChatEvent[] = [];
  let active = 0;
  let mostActive = 0;
  // The page: scripts run for real, with their own `window`.
  const pageWindow: Record<string, unknown> = {};
  let pageGone = false;
  const evalInPage = (code: string) => {
    if (pageGone) throw new Error("No such tab");
    return new Function("window", `return ${code}`)(pageWindow);
  };
  const hub = {
    publish: (msg: { event: ChatEvent }) => Effect.sync(() => void pushed.push(msg.event)),
    rpc: (method: string, params: any) => {
      if (method === "page.eval") return Effect.try({ try: () => evalInPage(params.code), catch: (e) => e });
      if (method === "network.use")
        return Effect.succeed({ entry: { id: params.id, method: "GET", url: "https://api.test/items/1" } });
      if (method !== "network.replay") return Effect.die(new Error(method));
      const url: string = params.overrides.url ?? "https://api.test/items/1";
      return Effect.gen(function* () {
        active++;
        mostActive = Math.max(mostActive, active);
        sent.push(params.overrides);
        yield* Effect.sleep(`${options.delayMs ?? 20} millis`);
        active--;
        if (url.endsWith("/boom")) return yield* Effect.fail(new Error("Failed to fetch"));
        const n = url.split("/").pop();
        return {
          url,
          status: n === "404" ? 404 : 200,
          statusText: n === "404" ? "Not Found" : "OK",
          mimeType: "application/json",
          headers: {},
          body: JSON.stringify({ id: n, title: `Item ${n}`, secret: "nope" }),
          truncated: false,
          size: 40,
          durationMs: 20,
          redacted: true,
        } satisfies ReplayResult;
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => active--)));
    },
  } as unknown as HubShape;
  const files = {
    dir: () => Effect.succeed(dir),
    resolve: (_tab: string, path: string) => Effect.succeed(join(dir, path)),
    // Names as ChatFiles gives them: relative, with forward slashes on every OS.
    describe: (_dir: string, path: string) =>
      Effect.succeed({
        name: relative(dir, path).split(sep).join("/"),
        path,
        mime: "application/json",
        size: 1,
      } as never),
  } as unknown as ChatFilesShape;
  const apps = {
    get: () => Effect.succeed(null),
    addMessage: (_tab: string, role: ChatMessage["role"], content: string) =>
      Effect.sync(() => (chat.push({ role, content }), { id: chat.length, role, content } as ChatMessage)),
  };
  const permissions = {
    ask: (input: AskInput) =>
      Effect.sync(() => (asked.push(input), options.answers?.[input.action] ?? input.action === "agent.network")),
  };
  const env = {
    tabId: "tab",
    log: (line: string) => Effect.sync(() => void logged.push(line)),
    message: () => Effect.void,
    label: "Website agent",
  };
  const serverScope = Effect.runSync(Scope.make());
  const base = Context.make(Hub, hub).pipe(
    Context.add(ChatFiles, files),
    Context.add(Apps, apps as never),
    Context.add(Network, {} as never),
    Context.add(Permissions, permissions as never),
  );
  const jobs = Effect.runSync(Effect.provide(makeIn(serverScope), base));
  const context = Context.add(base, Jobs, jobs);
  // Each turn has its own tools (and scope); jobs outlive it.
  const turn = () => {
    const tools = Effect.runSync(
      Effect.provide(
        Effect.all([batchTools(env), jobTools(env, { site: true })]).pipe(Effect.map((t) => t.flat())),
        context,
      ),
    );
    return (name: string, args: object = {}) =>
      Effect.runPromise(tools.find((t) => t.name === name)!.run(args)).then((r) => ({
        error: !!r.isError,
        text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      }));
  };
  const run = turn();
  const results = (path: string) => JSON.parse(readFileSync(join(dir, path), "utf8"));
  return {
    asked,
    sent,
    logged,
    chat,
    pushed,
    run,
    turn,
    jobs,
    dir,
    results,
    pageWindow,
    leavePage: () => {
      for (const key of Object.getOwnPropertyNames(pageWindow)) delete pageWindow[key];
    },
    closeTab: () => (pageGone = true),
    endTab: () => Effect.runPromise(jobs.endTab("tab")),
    stopServer: () => Effect.runPromise(Scope.close(serverScope, Exit.void)),
    mostActive: () => mostActive,
  };
};

const urls = (names: (string | number)[]) => names.map((n) => ({ url: `https://api.test/items/${n}` }));
const lastLine = (chat: { content: string }[]) => JSON.parse(chat.at(-1)!.content);

describe("batch_requests", () => {
  test("sends one request per item, a few at a time, with each item's result in a file", async () => {
    const t = setup();
    const result = await t.run("batch_requests", {
      id: "#981",
      items: urls([1, 2, 3, "404", "boom", 6, 7]),
      concurrency: 2,
      fields: ["id", "title"],
    });
    expect(result.error).toBe(false);
    expect(result.text).toContain("Job j1 (request #981 × 7) finished");
    expect(result.text).toContain("7 of 7 done, 5× 200, 1× 404, 1× error");
    expect(result.text).toContain("item 3: HTTP 404 Not Found");
    expect(result.text).toContain("item 4: Failed to fetch");
    expect(result.text).toContain("jobs/j1.json");
    expect(t.mostActive()).toBe(2);
    expect(t.sent).toHaveLength(7);

    const saved = t.results("jobs/j1.json");
    expect(saved.map((r: { item: number }) => r.item)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved[0]).toMatchObject({ method: "GET", status: 200, body: { id: "1", title: "Item 1" } });
    expect(saved[0].body.secret).toBeUndefined();
    expect(saved[4]).toMatchObject({ error: "Failed to fetch" });
    // The site was asked about once; GETs aren't confirmed.
    expect(t.asked.map((a) => [a.action, a.resource])).toEqual([["agent.network", "api.test"]]);
    expect(t.logged).toEqual(["Sending 7 requests to api.test (2 at a time, job j1)"]);
    // Its end is a line in the chat, with the file.
    expect(lastLine(t.chat)).toMatchObject({
      kind: "network",
      title: "Sent 7 of 7 requests, 2 failed (job j1)",
      files: [{ name: "jobs/j1.json" }],
    });
    // The chat got the job as it went, and as it ended.
    const last = t.pushed.filter((e) => e.type === "jobs").at(-1);
    expect(last).toMatchObject({ jobs: [{ id: "j1", state: "done", done: 7, total: 7 }] });
  });

  test("a batch that changes things is confirmed first, and nothing is sent without it", async () => {
    const t = setup({ answers: { "agent.network": true, "agent.confirm": false } });
    const items = urls([1, 2, 3]).map((i) => ({ ...i, method: "delete" }));
    const refused = await t.run("batch_requests", { id: "981", items });
    expect(refused.error).toBe(true);
    expect(t.sent).toEqual([]);
    const confirm = t.asked.find((a) => a.action === "agent.confirm")!;
    expect(confirm.title).toBe("Let the website agent send 3 DELETE requests?");
    expect(confirm.once).toBe(true);

    const blocked = setup({ answers: { "agent.network": false } });
    expect((await blocked.run("batch_requests", { id: "981", items: urls([1]) })).error).toBe(true);
    expect(blocked.sent).toEqual([]);
    expect(await Effect.runPromise(blocked.jobs.list("tab"))).toEqual([]);
  });

  test("job_status waits until the requests are over", async () => {
    const t = setup({ delayMs: 50 });
    const started = await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6]), wait_seconds: 0 });
    expect(started.text).toContain("Job j1 (request #981 × 6) is running: 0 of 6 done");
    const waited = await t.run("job_status", { id: "j1", wait_seconds: 10 });
    expect(waited.text).toContain("finished");
    expect(waited.text).toContain("6 of 6 done, 6× 200");
    expect(t.results("jobs/j1.json")).toHaveLength(6);
    // A wait that runs out says so.
    await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6, 7, 8, 9]), wait_seconds: 0 });
    expect((await t.run("job_status", { wait_seconds: 0.05 })).text).toContain("Still running: 1 job");
    await t.run("job_status", { wait_seconds: 10 });
  });

  test("a batch keeps going after the turn, can be stopped, and ends with its chat, keeping its results so far", async () => {
    const t = setup({ delayMs: 40 });
    await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6, 7, 8]), wait_seconds: 0.1 });
    // The next turn's tools see it.
    const next = t.turn();
    const canceled = await next("cancel_job", { id: "j1" });
    expect(canceled.text).toContain("was stopped");
    const kept = t.results("jobs/j1.json").length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(8);
    expect(lastLine(t.chat).title).toMatch(/^Stopped after \d of 8 requests \(job j1\)$/);
    expect((await next("cancel_job", {})).error).toBe(true);

    await next("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6]), save_as: "out.json", wait_seconds: 0 });
    await t.endTab();
    expect(lastLine(t.chat).title).toMatch(/^Stopped after \d of 6 requests \(job j2\)$/);
    expect(Array.isArray(t.results("out.json"))).toBe(true);
    // The chat's jobs are forgotten with it; ids aren't reused.
    expect(await Effect.runPromise(t.jobs.list("tab"))).toEqual([]);
    await next("batch_requests", { id: "981", items: urls([1]) });
    expect((await Effect.runPromise(t.jobs.list("tab"))).map((j) => j.id)).toEqual(["j3"]);
  });

  test("bad input is an error the agent can read", async () => {
    const t = setup();
    expect((await t.run("batch_requests", { items: urls([1]) })).error).toBe(true);
    expect((await t.run("batch_requests", { id: "1", saved: "s", items: urls([1]) })).error).toBe(true);
    expect((await t.run("batch_requests", { id: "1", items: [] })).error).toBe(true);
    expect((await t.run("batch_requests", { id: "1", items: [{ url: "ftp://x" }] })).error).toBe(true);
    expect((await t.run("job_status", { id: "j9" })).error).toBe(true);
  });
});

describe("start_script_job", () => {
  test("a script runs in the page past run_js's limit, reports progress, and its result goes into a file", async () => {
    const t = setup();
    const started = await t.run("start_script_job", {
      title: "Collect pages",
      code: `const out = [];
        for (let page = 1; page <= 3; page++) {
          progress(page - 1, 3);
          await new Promise((r) => setTimeout(r, 1200));
          out.push({ page });
        }
        progress("all pages read");
        return out;`,
    });
    expect(started.error).toBe(false);
    expect(started.text).toContain("Job j1 (Collect pages) is running");
    expect(t.logged).toEqual(["Started a page script in the background: Collect pages (job j1)"]);
    // Only Rune Browser knows where the page keeps it.
    expect(Object.keys(t.pageWindow)).toEqual([]);
    const done = await t.run("job_status", { id: "j1", wait_seconds: 20 });
    expect(done.text).toContain("Job j1 (Collect pages) finished");
    expect(done.text).toContain("all pages read");
    expect(t.results("jobs/j1.json")).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    expect(lastLine(t.chat)).toMatchObject({ kind: "code", title: "Job j1 finished: Collect pages (2 of 3)" });
    // The page forgets it once it's collected.
    expect(Object.getOwnPropertyNames(t.pageWindow)).toEqual([]);
  }, 30_000);

  test("a quick script's result comes right away; errors and reloads fail the job", async () => {
    const t = setup();
    const quick = await t.run("start_script_job", { code: "return 6 * 7", save_as: "answer.json" });
    expect(quick.text).toContain("finished");
    expect(t.results("answer.json")).toBe(42);

    const failing = await t.run("start_script_job", { code: "throw new Error('no table on this page')" });
    expect(failing.text).toContain("failed");
    expect(failing.text).toContain("no table on this page");
    expect(lastLine(t.chat)).toMatchObject({ failed: true });

    await t.run("start_script_job", { code: "await new Promise((r) => setTimeout(r, 60000))" });
    t.leavePage();
    const left = await t.run("job_status", { id: "j3", wait_seconds: 10 });
    expect(left.text).toContain("The page reloaded or went to another page");
  }, 30_000);

  test("stopping a script aborts its signal in the page", async () => {
    const t = setup();
    await t.run("start_script_job", {
      code: "await new Promise((r) => signal.addEventListener('abort', r)); globalThis.__aborted = true;",
    });
    const key = Object.getOwnPropertyNames(t.pageWindow)[0]!;
    const controller = (t.pageWindow[key] as { controller: AbortController }).controller;
    const stopped = await t.run("cancel_job", { id: "j1" });
    expect(stopped.text).toContain("Job j1 (Page script) was stopped");
    expect(controller.signal.aborted).toBe(true);
    expect(Object.getOwnPropertyNames(t.pageWindow)).toEqual([]);
  });

  test("a tab whose page stops answering ends the job", async () => {
    const t = setup();
    await t.run("start_script_job", { code: "await new Promise(() => {})" });
    t.closeTab();
    const ended = await t.run("job_status", { id: "j1", wait_seconds: 15 });
    expect(ended.text).toContain("failed");
    expect(ended.text).toContain("No such tab");
  }, 20_000);
});

describe("jobs", () => {
  test("a tab runs a few jobs at a time; wait pauses", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) await t.run("start_script_job", { code: "await new Promise(() => {})" });
    const sixth = await t.run("start_script_job", { code: "return 1" });
    expect(sixth.error).toBe(true);
    expect(sixth.text).toContain("5 jobs are already running");
    const status = await t.run("job_status", {});
    expect(status.text.split("\n")).toHaveLength(5);
    await t.endTab();

    const before = Date.now();
    expect((await t.run("wait", { seconds: 0.3 })).text).toBe("Waited 0.3 s.");
    expect(Date.now() - before).toBeGreaterThanOrEqual(280);
  }, 20_000);

  test("a job's results land in the chat's folder even when it's stopped by the server shutting down", async () => {
    const t = setup({ delayMs: 40 });
    await mkdir(join(t.dir, "jobs"), { recursive: true });
    await writeFile(join(t.dir, "jobs", "keep.txt"), "x");
    await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6]), wait_seconds: 0.05 });
    await t.stopServer();
    expect(Array.isArray(t.results("jobs/j1.json"))).toBe(true);
  });
});
