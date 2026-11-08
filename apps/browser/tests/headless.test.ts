// The website agent's headless tabs (agent/headlessTools.ts) against a fake
// window: they close when the turn ends, at most a few are open at once, logins
// need the user's OK per site, and only websites load.
import { describe, expect, test } from "bun:test";
import { Context, Effect, Exit, Scope } from "effect";
import { headlessTools, MAX_PER_TURN } from "../src/server/agent/headlessTools";
import { ChatFiles, type ChatFilesShape } from "../src/server/agent/ChatFiles";
import { Apps } from "../src/server/db/Apps";
import { Hub, type HubShape } from "../src/server/Hub";
import { Permissions, type AskInput, type PermissionsShape } from "../src/server/security/Permissions";
import { headlessUrlProblem } from "../src/shared/web";

const setup = (answers: Partial<Record<AskInput["action"], boolean>> = {}) => {
  const asked: AskInput[] = [];
  const calls: { method: string; params: any }[] = [];
  const open = new Set<string>();
  let next = 0;
  const hub = {
    rpc: (method: string, params: any) =>
      Effect.suspend((): Effect.Effect<unknown, Error> => {
        calls.push({ method, params });
        if (method === "headless.open" || method === "headless.navigate") {
          const id = method === "headless.open" ? `h${++next}` : params.id;
          if (!open.has(id) && method === "headless.navigate")
            return Effect.fail(new Error("This headless tab is closed"));
          open.add(id);
          return Effect.succeed({ id, url: params.url, title: "A page" });
        }
        if (method === "headless.eval") {
          if (!open.has(params.id)) return Effect.fail(new Error("This headless tab is closed"));
          return Effect.succeed(params.code.includes("innerText") ? { text: "Hello from the page" } : true);
        }
        if (method === "headless.close") return Effect.succeed(open.delete(params.id));
        return Effect.die(new Error(method));
      }),
  } as unknown as HubShape;
  const permissions = {
    ask: (input: AskInput) => Effect.sync(() => (asked.push(input), answers[input.action] ?? false)),
  } as unknown as PermissionsShape;
  const apps = { get: () => Effect.succeed({ id: "tab", workspaceId: "ws" }) } as unknown as Context.Service.Shape<
    typeof Apps
  >;
  const context = Context.make(Hub, hub).pipe(
    Context.add(Permissions, permissions),
    Context.add(Apps, apps),
    Context.add(ChatFiles, {} as unknown as ChatFilesShape),
  );
  const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Website agent" };
  // The turn's scope: closing it is the turn ending.
  const scope = Effect.runSync(Scope.make());
  const tools = Effect.runSync(Effect.provide(headlessTools(env), context).pipe(Scope.provide(scope)));
  const run = async (name: string, args: object) => {
    const result = await Effect.runPromise(tools.find((t) => t.name === name)!.run(args));
    return { error: !!result.isError, text: result.content.map((c) => ("text" in c ? c.text : "")).join("") };
  };
  const endTurn = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return { asked, calls, open, run, endTurn, tools };
};

describe("headless tabs", () => {
  test("open without logins: no question, the page's text comes back, and the turn's end closes it", async () => {
    const { asked, calls, open, run, endTurn } = setup();
    const opened = await run("open_headless_tab", { url: "https://news.example/" });
    expect(opened.error).toBe(false);
    expect(opened.text).toContain("Headless tab h1: https://news.example/");
    expect(opened.text).toContain("Hello from the page");
    expect(asked).toEqual([]);
    expect(calls[0]).toMatchObject({
      method: "headless.open",
      params: { tabId: "tab", workspaceId: "ws", logins: false, hosts: [] },
    });
    expect([...open]).toEqual(["h1"]);
    await endTurn();
    expect([...open]).toEqual([]);
  });

  test("closing one frees its place; more than the limit at once is refused", async () => {
    const { open, run, endTurn } = setup();
    for (let i = 0; i < MAX_PER_TURN; i++)
      expect((await run("open_headless_tab", { url: `https://site${i}.example/` })).error).toBe(false);
    const refused = await run("open_headless_tab", { url: "https://one-more.example/" });
    expect(refused.error).toBe(true);
    expect(open.size).toBe(MAX_PER_TURN);
    expect((await run("close_headless_tab", { id: "h1" })).text).toContain("Closed");
    expect(open.has("h1")).toBe(false);
    expect((await run("open_headless_tab", { url: "https://one-more.example/" })).error).toBe(false);
    await endTurn();
    expect(open.size).toBe(0);
  });

  test("logins ask the user for the site, and nothing opens without their OK", async () => {
    const no = setup({ "agent.headless": false });
    expect((await no.run("open_headless_tab", { url: "https://mail.example/inbox", logins: true })).error).toBe(true);
    expect(no.asked.map((a) => [a.action, a.resource])).toEqual([["agent.headless", "mail.example"]]);
    expect(no.calls.filter((c) => c.method === "headless.open")).toEqual([]);

    const yes = setup({ "agent.headless": true });
    expect((await yes.run("open_headless_tab", { url: "https://mail.example/inbox", logins: true })).error).toBe(false);
    expect(yes.calls[0]!.params).toMatchObject({ logins: true, hosts: ["mail.example"] });
    // Another site with logins asks again, for that site.
    await yes.run("navigate_headless_tab", { id: "h1", url: "https://docs.example/" });
    expect(yes.asked.map((a) => a.resource)).toEqual(["mail.example", "docs.example"]);
    expect(yes.calls.find((c) => c.method === "headless.navigate")!.params).toMatchObject({
      hosts: ["docs.example"],
    });
    await yes.endTurn();
  });

  test("only this turn's tabs, only websites", async () => {
    const { run, open, endTurn } = setup();
    expect((await run("read_headless_tab", { id: "someone-elses" })).error).toBe(true);
    expect((await run("open_headless_tab", { url: "file:///etc/passwd" })).error).toBe(true);
    expect((await run("open_headless_tab", { url: "javascript:alert(1)" })).error).toBe(true);
    expect(open.size).toBe(0);
    await endTurn();
  });

  test("a tab the user closed is forgotten", async () => {
    const { run, open, endTurn } = setup();
    await run("open_headless_tab", { url: "https://a.example/" });
    open.delete("h1");
    expect((await run("read_headless_tab", { id: "h1" })).error).toBe(true);
    expect((await run("read_headless_tab", { id: "h1" })).text).toContain("no headless tab h1");
    await endTurn();
  });

  test("the tools' inputs are object schemas", () => {
    const { tools, endTurn } = setup();
    for (const t of tools) expect((t.input as { fields?: unknown }).fields).toBeDefined();
    void endTurn();
  });
});

describe("what a headless tab may load", () => {
  test("websites, not this computer or the local network", () => {
    expect(headlessUrlProblem("https://example.com/")).toBeNull();
    expect(headlessUrlProblem("http://example.com/")).toBeNull();
    for (const url of [
      "file:///etc/passwd",
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://192.168.1.1/",
      "http://10.0.0.2/admin",
      "http://[::1]/",
      "http://router.local/",
      "http://intranet/",
      "chrome://settings",
      "not a url",
    ])
      expect(headlessUrlProblem(url)).not.toBeNull();
  });
});
