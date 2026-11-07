// The website agent's browse tools (agent/browseTools.ts) against a fake page:
// what needs the user's OK per site, what is confirmed every time, and that
// passwords are never typed.
import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { browseTools, needsConfirmation, type Target } from "../src/server/agent/browseTools";
import { pageTools } from "../src/server/agent/tools";
import { ChatFiles, type ChatFilesShape } from "../src/server/agent/ChatFiles";
import { Hub, type HubShape } from "../src/server/Hub";
import { Permissions, type AskInput, type PermissionsShape } from "../src/server/security/Permissions";

const target = (fields: Partial<Target> = {}): Target => ({
  x: 10,
  y: 20,
  tag: "button",
  type: "submit",
  label: "Next",
  name: "",
  autocomplete: "",
  href: "",
  form: null,
  url: "https://shop.example/cart",
  ...fields,
});

describe("what needs a confirmation every time", () => {
  test("buying, paying, sending, posting and deleting", () => {
    for (const label of [
      "Place order",
      "Buy now",
      "Pay 34 €",
      "Send",
      "Post",
      "Delete account",
      "Checkout",
      "Confirm purchase",
      "Subscribe",
    ]) {
      expect(needsConfirmation(target({ label }), "click")).toContain(label);
    }
  });
  test("ordinary clicks and typing don't", () => {
    for (const label of ["Next", "Search", "Show more", "Sign in", "Sort by price", "Add filter"])
      expect(needsConfirmation(target({ label }), "click")).toBeNull();
    expect(needsConfirmation(target({ tag: "input", type: "text", name: "q" }), "type")).toBeNull();
  });
  test("card details and forms that take them", () => {
    expect(needsConfirmation(target({ tag: "input", type: "text", autocomplete: "cc-number" }), "type")).toContain(
      "payment details",
    );
    expect(needsConfirmation(target({ tag: "input", type: "text", name: "card_cvc" }), "type")).toContain(
      "payment details",
    );
    expect(
      needsConfirmation(
        target({ label: "Continue", form: { action: "/pay", label: "Continue", payment: true } }),
        "click",
      ),
    ).toContain("payment details");
    expect(
      needsConfirmation(
        target({ tag: "input", type: "search", form: { action: "/search", label: "Search", payment: false } }),
        "submit",
      ),
    ).toBeNull();
    expect(
      needsConfirmation(
        target({
          tag: "textarea",
          type: "textarea",
          form: { action: "/messages/send", label: "Send", payment: false },
        }),
        "submit",
      ),
    ).toContain("submit the form");
  });
});

describe("browse tools", () => {
  /** Tools against a fake page: `page` answers page.target, `answers` the user's replies by action. */
  const setup = (page: Target | { error: string }, answers: Partial<Record<AskInput["action"], boolean>>) => {
    const asked: AskInput[] = [];
    const acted: unknown[] = [];
    const hub = {
      rpc: (method: string, params: any) =>
        Effect.sync(() => {
          if (method === "page.target") return page;
          if (method === "page.act") return (acted.push(params), true);
          if (method === "page.settle" || method === "page.info")
            return { url: "https://shop.example/next", title: "Next page" };
          throw new Error(method);
        }),
    } as unknown as HubShape;
    const permissions = {
      ask: (input: AskInput) => Effect.sync(() => (asked.push(input), answers[input.action] ?? false)),
    } as unknown as PermissionsShape;
    const context = Context.make(Hub, hub).pipe(
      Context.add(Permissions, permissions),
      Context.add(ChatFiles, {} as unknown as ChatFilesShape),
    );
    const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Website agent" };
    const tools = Effect.runSync(Effect.provide(browseTools(env), context));
    const run = async (name: string, args: object) => {
      const result = await Effect.runPromise(tools.find((t) => t.name === name)!.run(args));
      return { error: result.isError, text: result.content.map((c) => ("text" in c ? c.text : "")).join("") };
    };
    return { asked, acted, run };
  };

  test("an ordinary click asks once for the site, then acts", async () => {
    const { asked, acted, run } = setup(target(), { "agent.browse": true });
    const result = await run("click", { text: "Next" });
    expect(result.error).toBe(false);
    expect(result.text).toContain("Now at https://shop.example/next");
    expect(asked.map((a) => [a.action, a.resource, !!a.once])).toEqual([["agent.browse", "shop.example", false]]);
    expect(acted).toEqual([{ tabId: "tab", kind: "click", x: 10, y: 20 }]);
  });

  test("without the site's OK nothing happens", async () => {
    const { acted, run } = setup(target(), {});
    expect((await run("click", { selector: "button" })).error).toBe(true);
    expect(acted).toEqual([]);
  });

  test("placing an order is confirmed every time, and refused if the user says no", async () => {
    const order = target({ label: "Place order" });
    const no = setup(order, { "agent.browse": true, "agent.confirm": false });
    expect((await no.run("click", { text: "Place order" })).text).toContain("didn't confirm");
    expect(no.asked.map((a) => [a.action, !!a.once])).toEqual([
      ["agent.browse", false],
      ["agent.confirm", true],
    ]);
    expect(no.acted).toEqual([]);
    const yes = setup(order, { "agent.browse": true, "agent.confirm": true });
    expect((await yes.run("click", { text: "Place order" })).error).toBe(false);
    expect(yes.acted).toHaveLength(1);
  });

  test("passwords are never typed", async () => {
    const { asked, acted, run } = setup(target({ tag: "input", type: "password", name: "pw" }), {
      "agent.browse": true,
    });
    const result = await run("type_text", { selector: "#pw", value: "hunter2" });
    expect(result.error).toBe(true);
    expect(result.text).toContain("sign in themselves");
    expect(asked).toEqual([]);
    expect(acted).toEqual([]);
  });

  test("Enter in a search form needs no confirmation; a missing element is an error for the agent", async () => {
    const search = setup(
      target({ tag: "input", type: "search", form: { action: "/search", label: "Search", payment: false } }),
      { "agent.browse": true },
    );
    expect((await search.run("type_text", { selector: "input", value: "socks", submit: true })).text).toContain(
      "pressed Enter",
    );
    expect(search.acted).toEqual([
      { tabId: "tab", kind: "type", x: 10, y: 20, value: "socks", clear: false },
      { tabId: "tab", kind: "key", key: "Enter" },
    ]);
    const missing = setup({ error: "Nothing matches #nope" }, { "agent.browse": true });
    expect(await missing.run("click", { selector: "#nope" })).toEqual({ error: true, text: "Nothing matches #nope" });
  });
});

describe("the website agent's navigate", () => {
  test("opens websites, never local files or the browser's own pages", async () => {
    const opened: string[] = [];
    const hub = {
      rpc: (method: string, params: any) =>
        Effect.sync(() => {
          if (method !== "page.navigate") throw new Error(method);
          opened.push(params.url);
          return { url: params.url, title: "Page" };
        }),
    } as unknown as HubShape;
    const context = Context.make(Hub, hub).pipe(Context.add(ChatFiles, {} as unknown as ChatFilesShape));
    const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Website agent" };
    const tools = Effect.runSync(Effect.provide(pageTools(env, { site: true }), context));
    const navigate = (url: string) =>
      Effect.runPromise(tools.find((t) => t.name === "navigate")!.run({ url })).then((r) => !r.isError);
    for (const url of ["https://example.com", "example.com/docs", "localhost:5173", "about:blank"])
      expect(await navigate(url)).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "FILE:///home",
      "javascript:alert(1)",
      "chrome://settings",
      "view-source:x",
    ])
      expect(await navigate(url)).toBe(false);
    expect(opened).toEqual(["https://example.com", "example.com/docs", "localhost:5173", "about:blank"]);
  });
});

describe("upload_file", () => {
  const setup = (answers: Partial<Record<AskInput["action"], boolean>>) => {
    const asked: AskInput[] = [];
    const uploads: unknown[] = [];
    const hub = {
      rpc: (method: string, params: any) =>
        Effect.sync(() => {
          if (method === "page.info") return { url: "https://forum.example/new", title: "New post" };
          if (method === "devtools") return (uploads.push(params.params), { count: 1 });
          throw new Error(method);
        }),
    } as unknown as HubShape;
    const permissions = {
      ask: (input: AskInput) => Effect.sync(() => (asked.push(input), answers[input.action] ?? false)),
    } as unknown as PermissionsShape;
    // The chat's folder: only "shot.jpg" is in it.
    const files = {
      dir: () => Effect.succeed("/chat"),
      resolve: (_tab: string, path: string) => Effect.succeed(`/chat/${path}`),
      describe: (_dir: string, path: string) => Effect.succeed(path === "/chat/shot.jpg" ? ({} as never) : null),
    } as unknown as ChatFilesShape;
    const context = Context.make(Hub, hub).pipe(Context.add(Permissions, permissions), Context.add(ChatFiles, files));
    const env = { tabId: "tab", log: () => Effect.void, message: () => Effect.void, label: "Website agent" };
    const tool = Effect.runSync(Effect.provide(browseTools(env), context)).find((t) => t.name === "upload_file")!;
    const run = (args: object) => Effect.runPromise(tool.run(args)).then((r) => !r.isError);
    return { asked, uploads, run };
  };

  test("the user's files go to a site only once the user confirms that upload", async () => {
    const refused = setup({ "agent.browse": true });
    expect(await refused.run({ paths: ["shot.jpg"] })).toBe(false);
    expect(refused.asked.map((a) => [a.action, !!a.once])).toEqual([
      ["agent.browse", false],
      ["agent.confirm", true],
    ]);
    expect(refused.uploads).toEqual([]);

    const allowed = setup({ "agent.browse": true, "agent.confirm": true });
    expect(await allowed.run({ paths: ["shot.jpg"], selector: "#file" })).toBe(true);
    expect(allowed.uploads).toEqual([{ selector: "#file", index: undefined, files: ["/chat/shot.jpg"] }]);
    // Files that aren't in the chat's folder never get that far.
    expect(await allowed.run({ paths: ["missing.png"] })).toBe(false);
    expect(allowed.uploads).toHaveLength(1);
  });
});
