// What data tools give back: picking fields out of JSON, saving whole results
// to the chat's folder, and the same save_as / fields on the network tools.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { Context, Effect } from "effect";
import { ChatFiles, type ChatFilesShape } from "../src/server/agent/ChatFiles";
import { networkReadTools } from "../src/server/agent/networkTools";
import { MAX_RESULT, parsePath, pickFields } from "../src/server/agent/output";
import { Hub, type HubShape } from "../src/server/Hub";

describe("fields", () => {
  const issues = {
    total: 2,
    results: [
      { issue: { number: 1, title: "One", body: "long" }, score: 3 },
      { issue: { number: 2, title: "Two", body: "longer" }, score: 5 },
    ],
  };

  test("paths go into objects, every item of a list, or one item", () => {
    expect(parsePath("results[].issue.number")).toEqual([
      { key: "results" },
      { each: true },
      { key: "issue" },
      { key: "number" },
    ]);
    expect(parsePath("$.items[0].id")).toEqual([{ key: "items" }, { index: 0 }, { key: "id" }]);
    expect(() => parsePath("a..b")).toThrow();
    expect(() => parsePath("")).toThrow();
  });

  test("the picked parts keep their shape", () => {
    expect(pickFields(issues, ["results[].issue.number"])).toEqual({
      results: [{ issue: { number: 1 } }, { issue: { number: 2 } }],
    });
    expect(pickFields(issues, ["total", "results[].issue.number", "results[].issue.title"])).toEqual({
      total: 2,
      results: [{ issue: { number: 1, title: "One" } }, { issue: { number: 2, title: "Two" } }],
    });
    // A field of a list means that field of each item, with or without [].
    expect(pickFields(issues.results, ["score"])).toEqual([{ score: 3 }, { score: 5 }]);
    expect(pickFields(issues.results, ["[].score"])).toEqual([{ score: 3 }, { score: 5 }]);
    expect(pickFields(issues, ["results[1].issue.title"])).toEqual({ results: [{ issue: { title: "Two" } }] });
    // Missing fields are left out; a whole value stays whole.
    expect(pickFields(issues, ["nope", "results[].issue.nope"])).toEqual({ results: [{ issue: {} }, { issue: {} }] });
    expect(pickFields(issues, ["results", "results[].score"])).toEqual({ results: issues.results });
  });
});

describe("save_as and fields on data tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-output-"));
  const body = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `Item ${i}` })) });
  const hub = {
    rpc: (method: string) =>
      Effect.sync(() => {
        if (method === "network.get")
          return {
            id: "7",
            method: "GET",
            url: "https://api.example/items",
            type: "Fetch",
            status: 200,
            mimeType: "application/json",
            size: body.length,
            durationMs: 12,
            error: null,
            rule: null,
            override: null,
            requestHeaders: { accept: "application/json" },
            responseHeaders: { "content-type": "application/json" },
            requestBody: null,
            responseBody: body,
            bodyNote: null,
          };
        if (method === "network.list")
          return [
            { id: "7", method: "GET", url: "https://api.example/items", type: "Fetch", status: 200 },
            { id: "8", method: "POST", url: "https://api.example/items", type: "Fetch", status: 201 },
          ];
        throw new Error(method);
      }),
  } as unknown as HubShape;
  const files = {
    dir: () => Effect.succeed(dir),
    resolve: (_tab: string, path: string) => Effect.succeed(join(dir, path)),
    // Names as ChatFiles gives them: relative, with forward slashes on every OS.
    describe: (_dir: string, path: string) =>
      Effect.succeed({ name: relative(dir, path).split(sep).join("/") } as never),
  } as unknown as ChatFilesShape;
  const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Website agent" };
  const tools = Effect.runSync(
    Effect.provide(networkReadTools(env), Context.make(Hub, hub).pipe(Context.add(ChatFiles, files))),
  );
  const run = (name: string, args: object) =>
    Effect.runPromise(tools.find((t) => t.name === name)!.run(args)).then((r) => ({
      error: !!r.isError,
      text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    }));

  test("a big response is cut off in the context, and saved whole", async () => {
    const shown = await run("network_request", { id: "#7" });
    expect(shown.text).toContain("Response headers:");
    expect(shown.text).toContain("more characters; save_as saves all of it");
    expect(shown.text.length).toBeLessThan(MAX_RESULT + 1000);

    const saved = await run("network_request", { id: "7", save_as: "data/items.json" });
    expect(saved.text).toContain(`Saved the result in data/items.json (${body.length} characters)`);
    expect(saved.text).toContain("Response headers:");
    expect(readFileSync(join(dir, "data/items.json"), "utf8")).toBe(body);
  });

  test("fields pick from the body, returned or saved", async () => {
    const picked = await run("network_request", { id: "7", fields: ["items[2].name"] });
    expect(picked.text.endsWith(JSON.stringify({ items: [{ name: "Item 2" }] }, null, 1))).toBe(true);

    const saved = await run("network_request", { id: "7", fields: ["items[].id"], save_as: "ids.json" });
    expect(saved.text).toContain("Saved the fields in ids.json");
    expect(JSON.parse(readFileSync(join(dir, "ids.json"), "utf8")).items).toHaveLength(2000);

    // A list of requests is data too.
    const list = await run("network_requests", { fields: ["[].method"] });
    expect(JSON.parse(list.text)).toEqual([{ method: "GET" }, { method: "POST" }]);
    expect((await run("network_requests", {})).text).toContain("#8 POST 201");
  });

  test("a field the agent can't write is an error it can read", async () => {
    const hubText = {
      rpc: () => Effect.succeed([{ id: "1", method: "GET", url: "x", type: "Fetch", status: 200 }]),
    } as unknown as HubShape;
    const [list] = Effect.runSync(
      Effect.provide(networkReadTools(env), Context.make(Hub, hubText).pipe(Context.add(ChatFiles, files))),
    );
    const bad = await Effect.runPromise(list!.run({ fields: ["a..b"] }));
    expect(bad.isError).toBe(true);
  });
});
