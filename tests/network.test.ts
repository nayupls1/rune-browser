// The network layer: redaction, rule patterns and the bounded traffic log
// (pure), and the server's rules and saved requests. Capturing, replaying and
// blocking run in Electron's main process and are covered by the e2e checks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { NetworkRule, PermissionGrant, SavedRequest, WorkspaceInfo } from "../src/shared/api";
import {
  BodyBudget,
  isSensitiveName,
  isStructured,
  redactBody,
  redactHeaders,
  redactUrl,
  REDACTED,
  TrafficLog,
  urlMatcher,
  type Captured,
} from "../src/shared/network";
import { startServer } from "./lib/server";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("redaction", () => {
  test("knows credential names, not lookalikes", () => {
    for (const name of [
      "Authorization",
      "Cookie",
      "x-csrf-token",
      "X-API-Key",
      "accessToken",
      "refresh_token",
      "password",
      "client_secret",
      "sessionId",
      "sig",
    ]) {
      expect(isSensitiveName(name)).toBe(true);
    }
    for (const name of ["author", "content-type", "accept", "user-agent", "title", "key", "monkey", "visits_count"]) {
      expect(isSensitiveName(name)).toBe(false);
    }
    // A bare "key" is a credential in URLs, not in JSON data.
    expect(isSensitiveName("key", true)).toBe(true);
  });

  test("headers, URLs and bodies", () => {
    expect(
      redactHeaders({ Authorization: "Bearer abc", Accept: "application/json", "X-Debug": `token ${JWT}` }),
    ).toEqual({
      Authorization: REDACTED,
      Accept: "application/json",
      "X-Debug": `token ${REDACTED}`,
    });
    expect(redactUrl("https://api.example.com/v1/items?page=2&api_key=s3cret&key=abc&q=key")).toBe(
      `https://api.example.com/v1/items?page=2&api_key=${REDACTED}&key=${REDACTED}&q=key`,
    );
    expect(redactUrl("https://user:pw@example.com/")).toBe("https://user:redacted@example.com/");
    expect(redactUrl("https://example.com/plain?a=1")).toBe("https://example.com/plain?a=1");

    expect(
      JSON.parse(
        redactBody(
          JSON.stringify({
            user: { name: "Ada", password: "hunter2", key: "item-1" },
            accessToken: "t",
            items: [{ sessionToken: 5 }],
            note: JWT,
          }),
        ),
      ),
    ).toEqual({
      user: { name: "Ada", password: REDACTED, key: "item-1" },
      accessToken: REDACTED,
      items: [{ sessionToken: REDACTED }],
      note: REDACTED,
    });
    expect(redactBody("username=ada&password=hunter2&remember=1", "application/x-www-form-urlencoded")).toBe(
      `username=ada&password=${REDACTED}&remember=1`,
    );
    expect(redactBody(`Authorization: Bearer abcdefghijkl\nplain`)).toBe(`Authorization: Bearer ${REDACTED}\nplain`);
    expect(redactBody("<p>nothing secret</p>", "text/html")).toBe("<p>nothing secret</p>");
  });
});

describe("rules", () => {
  test("wildcards match the whole URL; plain text anywhere in it", () => {
    const tracker = urlMatcher("*://*.tracker.example/*");
    expect(tracker("https://cdn.tracker.example/pixel.gif")).toBe(true);
    expect(tracker("https://tracker.example.evil.com/")).toBe(false);
    const contains = urlMatcher("/api/ads");
    expect(contains("https://site.com/api/ads?x=1")).toBe(true);
    expect(contains("https://site.com/api/feed")).toBe(false);
    expect(urlMatcher("https://site.com/a.b?*")("https://site.com/aXb?1")).toBe(false);
    expect(urlMatcher("  ")("https://site.com/")).toBe(false);
  });
});

describe("the traffic log", () => {
  const entry = (n: number, overrides: Partial<Captured> = {}): Omit<Captured, "id"> => ({
    method: "GET",
    url: `https://site.com/api/${n}?token=t${n}`,
    type: "Fetch",
    status: 200,
    mimeType: "application/json",
    size: 10,
    startedAt: n,
    startTs: n,
    durationMs: 5,
    error: null,
    rule: null,
    override: null,
    requestHeaders: { Authorization: `Bearer secret-${n}`, Accept: "*/*" },
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    bodyNote: null,
    ...overrides,
  });

  test("keeps the newest requests, filtered, redacted unless revealed", () => {
    const log = new TrafficLog(new BodyBudget(), { entries: 3, changes: 1, kept: 2, body: 100, tabBodies: 1000 });
    for (let n = 1; n <= 5; n++) log.add(entry(n, n === 4 ? { type: "Image", mimeType: "image/png" } : {}));
    expect(log.size).toBe(3);
    expect(log.list().map((e) => e.url)).toEqual([3, 4, 5].map((n) => `https://site.com/api/${n}?token=${REDACTED}`));
    expect(log.list({ kind: "data" }).map((e) => e.id)).toEqual(["3", "5"]);
    expect(log.list({ query: "api/5" }).map((e) => e.id)).toEqual(["5"]);
    expect(log.detail("1")).toBeNull();
    expect(log.detail("5")!.requestHeaders.Authorization).toBe(REDACTED);
    expect(log.detail("5", false)!.requestHeaders.Authorization).toBe("Bearer secret-5");
    expect(log.detail("5", false)!.url).toContain("token=t5");
  });

  test("requests an agent uses and requests that change things outlast a burst of traffic", () => {
    const log = new TrafficLog(new BodyBudget(), { entries: 4, changes: 1, kept: 2, body: 100, tabBodies: 1000 });
    log.add(entry(1)); // #1: the agent looks at it
    log.add(entry(2, { method: "DELETE" })); // #2: a change
    log.add(entry(3));
    log.keep(["1"], "chat-a");
    // A reload: lots of GETs. #1 is kept for the agent, #2 outlasts the ordinary ones.
    for (let n = 4; n <= 20; n++) log.add(entry(n));
    expect(log.detail("1")).not.toBeNull();
    expect(log.detail("2")!.method).toBe("DELETE");
    expect(log.detail("3")).toBeNull();
    expect(log.size).toBe(5); // 4, plus the one that's kept
    expect(log.whyGone("3")).toContain("pushed out by newer traffic");
    expect(log.whyGone("99")).toContain("go up to #20");

    // Past `changes`, the oldest change goes like any other request.
    log.add(entry(21, { method: "POST" }));
    log.add(entry(22));
    expect(log.detail("2")).toBeNull();
    expect(log.whyGone("2")).toContain("requests that change things");
    expect(log.detail("21")).not.toBeNull();

    // Kept until the chat ends: a new chat's requests replace the earlier chat's.
    log.keep(["22"], "chat-b");
    expect([log.isKept("1"), log.isKept("22")]).toEqual([false, true]);
    for (let n = 23; n <= 30; n++) log.add(entry(n));
    expect(log.detail("1")).toBeNull();
    expect(log.detail("22")).not.toBeNull();
    // Past `kept`, the longest-kept go back to normal.
    log.keep(["30", "29"], "chat-b");
    expect([log.isKept("22"), log.isKept("29"), log.isKept("30")]).toEqual([false, true, true]);

    log.clear("The user cleared the log.");
    expect(log.whyGone("30")).toBe("The user cleared the log.");
  });

  test("bodies stay within the tab's and the shared budget, oldest dropped first", () => {
    const budget = new BodyBudget(250);
    const a = new TrafficLog(budget, { entries: 100, changes: 10, kept: 10, body: 100, tabBodies: 200 });
    const b = new TrafficLog(budget, { entries: 100, changes: 10, kept: 10, body: 100, tabBodies: 200 });
    const [a1, a2, a3] = [1, 2, 3].map((n) => a.add(entry(n)));
    expect(a.setBody(a1!, "x".repeat(101))).toBe(false);
    expect(a1!.bodyNote).toBe("Too large to keep");
    a.setBody(a1!, "x".repeat(80));
    a.setBody(a2!, "x".repeat(80));
    a.setBody(a3!, "x".repeat(80)); // over the tab's 200: a1's goes
    expect([a1, a2, a3].map((e) => e!.responseBody?.length ?? null)).toEqual([null, 80, 80]);
    expect(a1!.bodyNote).toBe("Dropped to save memory");
    const b1 = b.add(entry(10));
    b.setBody(b1, "y".repeat(100)); // 260 in all: the oldest anywhere (a2) goes
    expect(a2!.responseBody).toBeNull();
    expect(budget.used).toBe(180);
    a.dispose();
    expect(budget.used).toBe(100);
    expect(budget.logs.size).toBe(1);
  });

  test("structured data is what's worth keeping", () => {
    expect(isStructured("application/json", "Fetch")).toBe(true);
    expect(isStructured("application/vnd.api+json", "Document")).toBe(true);
    expect(isStructured("text/plain", "XHR")).toBe(true);
    expect(isStructured("text/html", "Document")).toBe(false);
    expect(isStructured("text/css", "Fetch")).toBe(false);
    expect(isStructured("image/svg+xml", "Image")).toBe(false);
  });
});

describe("network rules and saved requests (server)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("rules are validated, saved, changed and removed", async () => {
    const rule = await server.api<NetworkRule>("/api/network/rules", {
      method: "POST",
      json: { workspaceId: null, pattern: " *://*.ads.example/* ", action: "block" },
    });
    expect(rule).toMatchObject({
      pattern: "*://*.ads.example/*",
      action: "block",
      enabled: true,
      workspaceId: null,
      requestHeaders: {},
    });
    const modify = await server.api<NetworkRule>("/api/network/rules", {
      method: "POST",
      json: {
        workspaceId: "default",
        pattern: "example.com",
        action: "modify",
        requestHeaders: { DNT: "1", Referer: null },
      },
    });
    expect(modify.requestHeaders).toEqual({ DNT: "1", Referer: null });
    await expect(
      server.api("/api/network/rules", {
        method: "POST",
        json: { workspaceId: null, pattern: "x", action: "modify", requestHeaders: { "Bad Name": "1" } },
      }),
    ).rejects.toThrow("400");
    await expect(
      server.api("/api/network/rules", {
        method: "POST",
        json: { workspaceId: null, pattern: "x", action: "modify", requestHeaders: { X: "a\r\nb" } },
      }),
    ).rejects.toThrow("400");
    await expect(
      server.api("/api/network/rules", {
        method: "POST",
        json: { workspaceId: "nope", pattern: "x", action: "block" },
      }),
    ).rejects.toThrow("404");
    await expect(
      server.api("/api/network/rules", { method: "POST", json: { workspaceId: null, pattern: "  ", action: "block" } }),
    ).rejects.toThrow("400");

    const off = await server.api<NetworkRule>(`/api/network/rules/${rule.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(off).toMatchObject({ enabled: false, pattern: "*://*.ads.example/*" });
    await server.api(`/api/network/rules/${rule.id}`, { method: "DELETE" });
    expect((await server.api<NetworkRule[]>("/api/network/rules")).map((r) => r.id)).toEqual([modify.id]);
  });

  test("saved requests never give their sealed credentials back", async () => {
    const saved = await server.api<SavedRequest>("/api/network/requests", {
      method: "POST",
      json: {
        workspaceId: "default",
        name: "Unread",
        draft: {
          method: "get",
          url: "https://example.com/api/unread?key=[redacted]",
          headers: { Accept: "application/json" },
          body: null,
          sealed: "c2VhbGVk",
        },
      },
    });
    expect(saved).toMatchObject({ method: "GET", hasCredentials: true, workspaceId: "default" });
    const list = await server.api<SavedRequest[]>("/api/network/requests?workspace=default");
    expect(list.map((r) => r.name)).toEqual(["Unread"]);
    expect(JSON.stringify(list)).not.toContain("c2VhbGVk");
    await expect(
      server.api("/api/network/requests", {
        method: "POST",
        json: {
          workspaceId: "default",
          name: "x",
          draft: { method: "GET", url: "file:///etc/passwd", headers: {}, body: null, sealed: null },
        },
      }),
    ).rejects.toThrow("400");
    // Sending goes through the Rune Browser window, which isn't there in this test.
    await expect(server.api(`/api/network/requests/${saved.id}/send`, { method: "POST", json: {} })).rejects.toThrow(
      "502",
    );
  });

  test("a deleted workspace takes its rules and saved requests along", async () => {
    const space = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Temp" } });
    await server.api("/api/network/rules", {
      method: "POST",
      json: { workspaceId: space.id, pattern: "x", action: "block" },
    });
    await server.api("/api/network/requests", {
      method: "POST",
      json: {
        workspaceId: space.id,
        name: "Temp",
        draft: { method: "GET", url: "https://example.com/", headers: {}, body: null, sealed: null },
      },
    });
    await server.api(`/api/workspaces/${space.id}`, { method: "DELETE" });
    expect((await server.api<NetworkRule[]>("/api/network/rules")).some((r) => r.workspaceId === space.id)).toBe(false);
    expect(await server.api<SavedRequest[]>(`/api/network/requests?workspace=${space.id}`)).toEqual([]);
  });

  test("the website agent's permission to send requests is labeled", async () => {
    await server.api("/api/permissions", {
      method: "PUT",
      json: { subject: "website-agent", action: "agent.network", resource: "example.com", decision: "allow" },
    });
    const grant = (await server.api<PermissionGrant[]>("/api/permissions")).find((g) => g.action === "agent.network");
    expect(grant).toMatchObject({ resource: "example.com", decision: "allow" });
  });
});
