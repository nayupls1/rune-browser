// The website agent's network tools against a fake page: requests it uses are
// kept for its chat, it's told why one is gone, and it can cancel the page's
// pending requests. Capturing itself runs in Electron (e2e).
import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import type { NetworkEntrySummary } from "../src/shared/api";
import { ChatFiles, type ChatFilesShape } from "../src/server/agent/ChatFiles";
import { networkTools } from "../src/server/agent/networkTools";
import { Apps } from "../src/server/db/Apps";
import { Network } from "../src/server/db/Network";
import { ResponseOverrides } from "../src/server/db/ResponseOverrides";
import { Hub, type HubShape } from "../src/server/Hub";
import { Permissions } from "../src/server/security/Permissions";

const summary = (id: string, overrides: Partial<NetworkEntrySummary> = {}) =>
  ({
    id,
    method: "GET",
    url: `https://site.test/api/${id}`,
    type: "Fetch",
    status: 200,
    mimeType: "application/json",
    size: 10,
    durationMs: 5,
    error: null,
    rule: null,
    override: null,
    ...overrides,
  }) as NetworkEntrySummary;

const setup = () => {
  const calls: { method: string; params: any }[] = [];
  let stopped = false;
  const hub = {
    rpc: (method: string, params: any) =>
      Effect.sync(() => {
        calls.push({ method, params });
        if (method === "network.use") return { gone: "It was pushed out by newer traffic." };
        if (method === "page.eval") return (stopped = true);
        if (method === "network.list")
          return stopped
            ? [summary("1"), summary("2", { status: null, error: "Canceled" }), summary("3", { status: null })]
            : [summary("1"), summary("2", { status: null }), summary("3", { status: null })];
        throw new Error(method);
      }),
  } as unknown as HubShape;
  const files = { dir: () => Effect.succeed("/chats/tab/1234-chat") } as unknown as ChatFilesShape;
  const context = Context.make(Hub, hub).pipe(
    Context.add(ChatFiles, files),
    Context.add(Apps, { get: () => Effect.succeed(null) } as never),
    Context.add(Network, {} as never),
    Context.add(ResponseOverrides, {} as never),
    Context.add(Permissions, {} as never),
  );
  const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Website agent" };
  const tools = Effect.runSync(Effect.provide(networkTools(env), context));
  const run = (name: string, args: object = {}) =>
    Effect.runPromise(tools.find((t) => t.name === name)!.run(args)).then((r) => ({
      error: !!r.isError,
      text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    }));
  return { calls, run };
};

describe("network tools", () => {
  test("a request the agent uses is kept for its chat, and it's told why one is gone", async () => {
    const { calls, run } = setup();
    for (const name of ["network_request", "replay_request"]) {
      const result = await run(name, { id: "#42" });
      expect(result.error).toBe(true);
      expect(result.text).toBe("Request #42 isn't in the log. It was pushed out by newer traffic.");
    }
    expect(calls.map((c) => [c.method, c.params.id, c.params.chat])).toEqual([
      ["network.use", "42", "1234-chat"],
      ["network.use", "42", "1234-chat"],
    ]);
  });

  test("cancel_requests stops the page's pending requests without reloading", async () => {
    const { calls, run } = setup();
    const result = await run("cancel_requests");
    expect(calls.some((c) => c.method === "page.eval" && c.params.code.includes("window.stop()"))).toBe(true);
    expect(calls.some((c) => c.method === "page.reload")).toBe(false);
    expect(result.text).toContain("Canceled:\n#2 GET failed");
    expect(result.text).toContain("Still open");
    expect(result.text).toContain("#3 GET pending");
  });
});
