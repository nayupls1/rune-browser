// Rune Browser's MCP endpoint: what agents see when they connect (the provider CLIs
// validate tool schemas strictly and drop the whole server if one is off).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, ManagedRuntime, Schema, Scope } from "effect";
import { make, tool, type Tool } from "../src/server/agent/Mcp";
import { browseTools } from "../src/server/agent/browseTools";
import { fileTools } from "../src/server/agent/fileTools";
import { appTools, pageTools, registryTools, scheduleTools, siteTools, tabTools } from "../src/server/agent/tools";
import { readConfig } from "../src/server/Config";
import { core } from "../src/server/services";

const dataDir = mkdtempSync(join(tmpdir(), "rune-mcp-test-"));
const config = readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" });
const runtime = ManagedRuntime.make(core(config));

afterAll(async () => {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Test agent" };

async function session(tools: Tool[]) {
  const mcp = await Effect.runPromise(make("http://rune"));
  const scope = await Effect.runPromise(Scope.make());
  const url = await Effect.runPromise(mcp.register(tools).pipe(Scope.provide(scope)));
  const token = url.split("/").pop()!;
  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    Effect.runPromise(mcp.handle(token, { jsonrpc: "2.0", id: ++id, method, params })) as Promise<any>;
  return { mcp, url, token, rpc, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

describe("mcp", () => {
  test("handshake, listing and calls", async () => {
    const s = await session([
      tool("echo", "Echo", Schema.Struct({ text: Schema.String }), ({ text }) => Effect.succeed(text)),
      tool("boom", "Fails", Schema.Struct({}), () => Effect.fail(new Error("kaputt"))),
    ]);
    expect(s.url).toStartWith("http://rune/mcp/");
    const init = await s.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect(
      await Effect.runPromise(s.mcp.handle(s.token, { jsonrpc: "2.0", method: "notifications/initialized" })),
    ).toBeNull();

    const list = await s.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom"]);
    expect(list.result.tools[1].inputSchema).toEqual({ type: "object", properties: {} });

    expect((await s.rpc("tools/call", { name: "echo", arguments: { text: "hi" } })).result).toEqual({
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
    expect((await s.rpc("tools/call", { name: "echo", arguments: {} })).result.isError).toBe(true);
    expect((await s.rpc("tools/call", { name: "boom", arguments: {} })).result).toMatchObject({
      content: [{ text: "kaputt" }],
      isError: true,
    });
    expect((await s.rpc("tools/call", { name: "nope" })).error.code).toBe(-32602);
    expect((await s.rpc("resources/list")).error.code).toBe(-32601);

    await s.close();
    await expect(
      Effect.runPromise(s.mcp.handle(s.token, { jsonrpc: "2.0", id: 1, method: "ping" })),
    ).rejects.toBeDefined();
  });

  test("every Rune Browser tool has an object input schema", async () => {
    const tools = await runtime.runPromise(
      Effect.gen(function* () {
        return [
          ...(yield* pageTools(env, { site: true })),
          ...(yield* browseTools(env)),
          ...(yield* siteTools(env)),
          ...(yield* appTools(env)),
          ...(yield* registryTools(env)),
          ...(yield* scheduleTools(env)),
          ...(yield* tabTools(env)),
          ...(yield* fileTools(env)),
        ];
      }),
    );
    const s = await session(tools);
    const list = await s.rpc("tools/list");
    expect(list.result.tools.length).toBe(tools.length);
    for (const t of list.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      // Numbers are plain numbers (not "number or the string NaN").
      for (const prop of Object.values(t.inputSchema.properties ?? {}) as { anyOf?: unknown }[])
        expect(prop.anyOf).toBeUndefined();
    }
    await s.close();
  });
});
