// Response overrides: checking, matching and describing them and the headers
// of an answer (pure), the website agent's tools that make them, and the API
// the user removes them with (audited, with cleanup). Answering real requests
// runs in Electron's main process and is covered by e2e.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import {
  DEFAULT_WORKSPACE,
  type AppSummary,
  type AuditEntry,
  type ResponseOverride,
  type ResponseOverrideSpec,
  type WorkspaceInfo,
} from "../src/shared/api";
import type { Tool } from "../src/server/agent/Mcp";
import { overrideTools } from "../src/server/agent/networkTools";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { ResponseOverrides } from "../src/server/db/ResponseOverrides";
import { Hub } from "../src/server/Hub";
import { Permissions, WEBSITE_AGENT } from "../src/server/security/Permissions";
import { core } from "../src/server/services";
import {
  answerHeaders,
  answersAlone,
  describeOverride,
  isLive,
  overrideProblem,
  overrideSpec,
  preflightHeaders,
  requestMatches,
  scopeCovers,
} from "../src/shared/overrides";
import { startServer } from "./lib/server";

describe("specs", () => {
  test("defaults fill in what's left out", () => {
    expect(overrideSpec({ pattern: " /api/feed ", status: 500, method: "get" })).toEqual({
      title: "/api/feed",
      scope: { type: "workspace" },
      pattern: "/api/feed",
      method: "GET",
      kind: "respond",
      status: 500,
      headers: {},
      body: null,
      failure: "Failed",
      delayMs: 0,
      expiresAt: null,
    });
  });

  test("problems are named", () => {
    const ok = overrideSpec({ pattern: "/api", body: "[]" });
    expect(overrideProblem(ok)).toBeNull();
    expect(overrideProblem({ ...ok, pattern: " " })).toContain("pattern");
    expect(overrideProblem({ ...ok, status: 99 })).toContain("200 and 599");
    expect(overrideProblem({ ...ok, status: 200.5 })).toContain("200 and 599");
    expect(overrideProblem({ ...ok, delayMs: 200_000 })).toContain("delay");
    expect(overrideProblem({ ...ok, headers: { "Bad Name": "x" } })).toContain("Invalid header name");
    expect(overrideProblem({ ...ok, headers: { "X-A": "a\r\nSet-Cookie: x" } })).toContain("line breaks");
    expect(overrideProblem({ ...ok, scope: { type: "site", host: "https://x.com/" } })).toBe("Invalid site");
    expect(overrideProblem({ ...ok, method: "G E T" })).toBe("Invalid method");
    expect(overrideProblem({ ...ok, expiresAt: "soon" })).toBe("Invalid expiry");
    // A respond that changes nothing is a mistake; fail and hang need nothing else.
    expect(overrideProblem(overrideSpec({ pattern: "/api" }))).toContain("changes nothing");
    expect(overrideProblem(overrideSpec({ pattern: "/api", kind: "hang" }))).toBeNull();
    expect(overrideProblem(overrideSpec({ pattern: "/api", delayMs: 2000 }))).toBeNull();
  });

  test("live: not expired", () => {
    expect(isLive({ expiresAt: null })).toBe(true);
    expect(isLive({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(isLive({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
  });

  test("descriptions", () => {
    expect(describeOverride(overrideSpec({ pattern: "x", status: 500, body: "{}", delayMs: 2500 }))).toBe(
      "Status 500 · Body replaced · 2.5 s late",
    );
    expect(describeOverride(overrideSpec({ pattern: "x", body: "" }))).toBe("Empty body");
    expect(describeOverride(overrideSpec({ pattern: "x", kind: "fail", failure: "TimedOut" }))).toBe(
      "Fails: Timed out",
    );
    expect(describeOverride(overrideSpec({ pattern: "x", kind: "hang" }))).toContain("Never answers");
  });
});

describe("matching", () => {
  test("requests by method and pattern (text in the URL, or * over all of it)", () => {
    const feed = { pattern: "/api/feed", method: null };
    expect(requestMatches(feed, "GET", "https://a.com/api/feed?page=1")).toBe(true);
    expect(requestMatches(feed, "POST", "https://a.com/API/FEED")).toBe(true);
    expect(requestMatches(feed, "GET", "https://a.com/api/other")).toBe(false);
    expect(requestMatches({ ...feed, method: "POST" }, "get", "https://a.com/api/feed")).toBe(false);
    expect(requestMatches({ ...feed, method: "POST" }, "post", "https://a.com/api/feed")).toBe(true);
    const wild = { pattern: "*://api.a.com/v1/*", method: null };
    expect(requestMatches(wild, "GET", "https://api.a.com/v1/users")).toBe(true);
    expect(requestMatches(wild, "GET", "https://api.a.com/v2/users")).toBe(false);
  });

  test("scopes: a tab, the page's site (wherever the request goes), the workspace", () => {
    const inTab = (id: string) => id === "tab-1";
    expect(scopeCovers({ type: "tab", tabId: "tab-1" }, "https://a.com/", inTab)).toBe(true);
    expect(scopeCovers({ type: "tab", tabId: "tab-2" }, "https://a.com/", inTab)).toBe(false);
    expect(scopeCovers({ type: "site", host: "a.com" }, "https://a.com/inbox", inTab)).toBe(true);
    expect(scopeCovers({ type: "site", host: "a.com" }, "https://b.com/", inTab)).toBe(false);
    expect(scopeCovers({ type: "workspace" }, "https://b.com/", inTab)).toBe(true);
  });

  test("answered without the site only when there's nothing to take from it", () => {
    expect(answersAlone(overrideSpec({ pattern: "x", status: 200, body: "[]" }))).toBe(true);
    expect(answersAlone(overrideSpec({ pattern: "x", status: 500 }))).toBe(false);
    expect(answersAlone(overrideSpec({ pattern: "x", body: "[]" }))).toBe(false);
    expect(answersAlone(overrideSpec({ pattern: "x", kind: "fail" }))).toBe(true);
    expect(answersAlone(overrideSpec({ pattern: "x", kind: "hang" }))).toBe(true);
  });
});

describe("answers", () => {
  const names = (list: { name: string; value: string }[]) => Object.fromEntries(list.map((h) => [h.name, h.value]));

  test("a new body drops what described the old one and says what it is", () => {
    const site = [
      { name: "Content-Length", value: "512" },
      { name: "Content-Encoding", value: "gzip" },
      { name: "Content-Type", value: "application/json" },
      { name: "X-Request-Id", value: "abc" },
    ];
    expect(names(answerHeaders({ headers: {}, body: "[]" }, site, { url: "https://a.com/x", origin: null }))).toEqual({
      "Content-Type": "application/json",
      "X-Request-Id": "abc",
    });
    // The site's headers stay as they are when only the status changes; set and removed ones apply.
    expect(
      names(
        answerHeaders({ headers: { "x-request-id": null, "X-Total": "0" }, body: null }, site, {
          url: "https://a.com/x",
          origin: null,
        }),
      ),
    ).toEqual({
      "Content-Length": "512",
      "Content-Encoding": "gzip",
      "Content-Type": "application/json",
      "X-Total": "0",
    });
  });

  test("a made-up answer: a content type, no caching, and readable from another origin", () => {
    const same = names(
      answerHeaders({ headers: {}, body: '{"a":1}' }, null, { url: "https://a.com/x", origin: "https://a.com" }),
    );
    expect(same).toEqual({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    const cross = names(
      answerHeaders({ headers: {}, body: "hi" }, null, { url: "https://api.a.com/x", origin: "https://a.com" }),
    );
    expect(cross["access-control-allow-origin"]).toBe("https://a.com");
    expect(cross["access-control-allow-credentials"]).toBe("true");
    expect(cross["content-type"]).toBe("text/plain; charset=utf-8");
    expect(names(preflightHeaders("https://a.com", "POST", "content-type"))).toMatchObject({
      "access-control-allow-origin": "https://a.com",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    });
  });
});

describe("the website agent's tools", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-override-tools-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("override, list and remove, after the user's OK for the site; tabs get the list first", async () => {
    const out = await runtime.runPromise(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const hub = yield* Hub;
        const permissions = yield* Permissions;
        const overrides = yield* ResponseOverrides;
        const tab = yield* apps.create(DEFAULT_WORKSPACE, "web", "https://a.test/feed");
        const other = yield* apps.create(DEFAULT_WORKSPACE, "web", "https://b.test/");
        const synced: string[] = [];
        const fakeHub = {
          ...hub,
          rpc: (method: string, params: { tabId?: string }) => {
            if (method === "network.syncOverrides") synced.push(method);
            return method === "page.info"
              ? Effect.succeed({ url: params.tabId === other.id ? "https://b.test/" : "https://a.test/feed" })
              : Effect.succeed(true);
          },
        } as unknown as typeof hub;
        const toolsOf = (tabId: string) =>
          overrideTools({ tabId, label: "Website agent", log: () => Effect.void, message: () => Effect.void }).pipe(
            Effect.provideService(Hub, fakeHub),
          );
        const call = (tools: Tool[], name: string, args: object) =>
          Effect.map(tools.find((t) => t.name === name)!.run(args), (r) => ({
            text: (r.content[0] as { text: string }).text,
            error: !!r.isError,
          }));
        const tools = yield* toolsOf(tab.id);
        const names = tools.map((t) => t.name);

        yield* permissions.set(WEBSITE_AGENT, "agent.override", "a.test", "allow");
        const empty = yield* call(tools, "override_response", {
          title: "Empty feed",
          pattern: "/api/feed",
          status: 200,
          body: "[]",
        });
        const slow = yield* call(tools, "override_response", {
          title: "Slow everywhere",
          pattern: "/api/",
          delayMs: 3000,
          scope: "site",
          minutes: 0,
        });
        const bad = yield* call(tools, "override_response", { title: "Nothing", pattern: "/api/feed" });
        const afterAdding = yield* overrides.list();
        const listed = yield* call(tools, "response_overrides", {});

        // Another site the user said no to.
        yield* permissions.set(WEBSITE_AGENT, "agent.override", "b.test", "deny");
        const refused = yield* call(yield* toolsOf(other.id), "override_response", {
          title: "Fail",
          pattern: "/x",
          kind: "fail",
        });

        const removedOne = yield* call(tools, "remove_response_override", { id: afterAdding[0]!.id });
        const removedAll = yield* call(tools, "remove_response_override", { all: true });
        return {
          names,
          empty,
          slow,
          bad,
          afterAdding,
          listed,
          refused,
          removedOne,
          removedAll,
          left: yield* overrides.list(),
          synced,
          tabId: tab.id,
        };
      }),
    );
    expect(out.names).toEqual(["override_response", "response_overrides", "remove_response_override"]);
    expect(out.empty.error).toBe(false);
    expect(out.bad).toMatchObject({ error: true });
    expect(out.bad.text).toContain("changes nothing");
    const [empty, slow] = out.afterAdding;
    // The agent's are tab-scoped and expire unless it asks otherwise.
    expect(empty).toMatchObject({ scope: { type: "tab", tabId: out.tabId }, status: 200, body: "[]" });
    expect(Date.parse(empty!.expiresAt!) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(slow).toMatchObject({ scope: { type: "site", host: "a.test" }, delayMs: 3000, expiresAt: null });
    expect(out.listed.text).toContain("Empty feed");
    expect(out.listed.text).toContain("pages of a.test");
    expect(out.refused).toMatchObject({ error: true });
    expect(out.refused.text).toContain("didn't allow");
    expect(out.removedOne.text).toContain("Empty feed");
    expect(out.removedAll.text).toContain("Slow everywhere");
    expect(out.left).toEqual([]);
    // Every change reached the tabs before the tool returned.
    expect(out.synced.length).toBe(4);
  });
});

describe("removing them (server)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let workspace: WorkspaceInfo;
  let tab: AppSummary;
  beforeAll(async () => {
    server = await startServer();
    workspace = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Testing" } });
    tab = await server.api<AppSummary>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com/", workspaceId: workspace.id },
    });
  });
  afterAll(() => server.stop());

  /** As the website agent's tool stores one (there's no API to make them). */
  const add = (spec: Partial<ResponseOverrideSpec>, workspaceId = workspace.id) => {
    const id = crypto.randomUUID().slice(0, 8);
    const db = new Database(join(server.dataDir, "rune.sqlite"));
    db.run("INSERT INTO response_overrides (id, workspace_id, spec) VALUES (?, ?, ?)", [
      id,
      workspaceId,
      JSON.stringify(overrideSpec({ pattern: "/api/feed", kind: "hang", ...spec })),
    ]);
    db.close();
    return id;
  };
  const list = () => server.api<ResponseOverride[]>("/api/response-overrides");

  test("listed and removed, in the activity log; nothing can be made or changed", async () => {
    const id = add({
      title: "Empty feed",
      scope: { type: "site", host: "example.com" },
      status: 200,
      body: "[]",
      kind: "respond",
    });
    expect(await list()).toMatchObject([{ id, title: "Empty feed", workspaceId: workspace.id, status: 200 }]);
    await expect(
      server.api("/api/response-overrides", { method: "POST", json: { scope: { type: "workspace" }, pattern: "/x" } }),
    ).rejects.toThrow("404");
    await expect(server.api(`/api/response-overrides/${id}`, { method: "PATCH", json: {} })).rejects.toThrow("404");
    await server.api(`/api/response-overrides/${id}`, { method: "DELETE" });
    expect(await list()).toEqual([]);
    await expect(server.api(`/api/response-overrides/${id}`, { method: "DELETE" })).rejects.toThrow("404");
    const audit = await server.api<AuditEntry[]>("/api/audit?limit=50");
    expect(audit.find((e) => e.action === "network.override.delete")).toMatchObject({
      workspaceId: workspace.id,
      target: "Empty feed (/api/feed)",
    });
  });

  test("expired ones go away; a tab's go with it, a workspace's with it", async () => {
    add({ pattern: "/a", expiresAt: new Date(Date.now() + 300).toISOString() });
    const kept = add({ pattern: "/kept" });
    add({ pattern: "/tab", scope: { type: "tab", tabId: tab.id } });
    expect((await list()).length).toBe(3);
    await Bun.sleep(400);
    expect((await list()).map((o) => o.pattern).sort()).toEqual(["/kept", "/tab"]);
    await server.api(`/api/apps/${tab.id}`, { method: "DELETE" });
    expect((await list()).map((o) => o.id)).toEqual([kept]);
    await server.api(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
    expect(await list()).toEqual([]);
  });
});
