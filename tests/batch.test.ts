// Batches of requests against a fake page: a few at a time, errors per item,
// results in the chat's folder, approval and confirmation, waiting for a batch
// and stopping it (also when the turn ends).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Context, Effect, Exit, Scope } from "effect";
import type { ReplayResult } from "../src/shared/api";
import { batchTools } from "../src/server/agent/batchTools";
import { ChatFiles, type ChatFilesShape } from "../src/server/agent/ChatFiles";
import { Apps } from "../src/server/db/Apps";
import { Network } from "../src/server/db/Network";
import { Hub, type HubShape } from "../src/server/Hub";
import { Permissions, type AskInput } from "../src/server/security/Permissions";

const setup = (options: { answers?: Partial<Record<AskInput["action"], boolean>>; delayMs?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "rune-batch-"));
  const asked: AskInput[] = [];
  const sent: { url?: string; method?: string }[] = [];
  const logged: string[] = [];
  let active = 0;
  let mostActive = 0;
  const hub = {
    rpc: (method: string, params: any) => {
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
      Effect.succeed({ name: relative(dir, path).split(sep).join("/") } as never),
  } as unknown as ChatFilesShape;
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
  const scope = Effect.runSync(Scope.make());
  const context = Context.make(Hub, hub).pipe(
    Context.add(ChatFiles, files),
    Context.add(Apps, { get: () => Effect.succeed(null) } as never),
    Context.add(Network, {} as never),
    Context.add(Permissions, permissions as never),
    Context.add(Scope.Scope, scope),
  );
  const tools = Effect.runSync(Effect.provide(batchTools(env), context));
  const run = (name: string, args: object = {}) =>
    Effect.runPromise(tools.find((t) => t.name === name)!.run(args)).then((r) => ({
      error: !!r.isError,
      text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    }));
  const results = (path: string) => JSON.parse(readFileSync(join(dir, path), "utf8"));
  const endTurn = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return { asked, sent, logged, run, results, endTurn, mostActive: () => mostActive };
};

const urls = (names: (string | number)[]) => names.map((n) => ({ url: `https://api.test/items/${n}` }));

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
    expect(result.text).toContain("Batch b1 (request #981 × 7) finished: 7 of 7 requests sent");
    expect(result.text).toContain("5× 200, 1× 404, 1× error");
    expect(result.text).toContain("item 3: HTTP 404 Not Found");
    expect(result.text).toContain("item 4: Failed to fetch");
    expect(result.text).toContain("batches/b1.json");
    expect(t.mostActive()).toBe(2);
    expect(t.sent).toHaveLength(7);

    const saved = t.results("batches/b1.json");
    expect(saved.map((r: { item: number }) => r.item)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved[0]).toMatchObject({ method: "GET", status: 200, body: { id: "1", title: "Item 1" } });
    expect(saved[0].body.secret).toBeUndefined();
    expect(saved[4]).toMatchObject({ error: "Failed to fetch" });
    // The site was asked about once; GETs aren't confirmed.
    expect(t.asked.map((a) => [a.action, a.resource])).toEqual([["agent.network", "api.test"]]);
    expect(t.logged).toEqual(["Sending 7 requests to api.test (2 at a time)", "Sent 7 of 7 requests, 2 failed"]);
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
  });

  test("wait_for_batch waits until the requests are over", async () => {
    const t = setup({ delayMs: 50 });
    const started = await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6]), wait_seconds: 0 });
    expect(started.text).toContain("is running: 0 of 6 done");
    const waited = await t.run("wait_for_batch", { id: "b1" });
    expect(waited.text).toContain("finished: 6 of 6 requests sent (6× 200), 0 failed");
    expect(t.results("batches/b1.json")).toHaveLength(6);
    // A wait that runs out says so.
    await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6, 7, 8, 9]), wait_seconds: 0 });
    expect((await t.run("wait_for_batch", { seconds: 0.05 })).text).toContain("Still running");
    await t.run("wait_for_batch", {});
  });

  test("a batch can be canceled, and stops when the turn ends, keeping its results so far", async () => {
    const t = setup({ delayMs: 40 });
    await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6, 7, 8]), wait_seconds: 0.1 });
    const canceled = await t.run("cancel_batch", { id: "b1" });
    expect(canceled.text).toContain("was canceled");
    const kept = t.results("batches/b1.json").length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(8);
    expect((await t.run("cancel_batch", {})).error).toBe(true);

    await t.run("batch_requests", { id: "981", items: urls([1, 2, 3, 4, 5, 6]), save_as: "out.json", wait_seconds: 0 });
    await t.endTurn();
    expect(t.logged.at(-1)).toMatch(/^Stopped after \d of 6 requests$/);
    expect(Array.isArray(t.results("out.json"))).toBe(true);
  });

  test("bad input is an error the agent can read", async () => {
    const t = setup();
    expect((await t.run("batch_requests", { items: urls([1]) })).error).toBe(true);
    expect((await t.run("batch_requests", { id: "1", saved: "s", items: urls([1]) })).error).toBe(true);
    expect((await t.run("batch_requests", { id: "1", items: [] })).error).toBe(true);
    expect((await t.run("batch_requests", { id: "1", items: [{ url: "ftp://x" }] })).error).toBe(true);
    expect((await t.run("wait_for_batch", { id: "b9" })).error).toBe(true);
  });
});
