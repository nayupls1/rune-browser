import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  collapsed,
  describeEndpoint,
  formatShape,
  merge,
  observe,
  pathTemplate,
  shapeOf,
  templateMatches,
  type CapturedRequest,
  type Endpoint,
  type EndpointHost,
  type Observation,
} from "../src/shared/endpoints";
import { startServer } from "./lib/server";

const request = (over: Partial<CapturedRequest> = {}): CapturedRequest => ({
  method: "GET",
  url: "https://api.example.com/v1/users/123/posts?page=2&q=cats&api_key=key-secret-1",
  pageUrl: "https://example.com/feed",
  requestHeaders: {
    Accept: "application/json",
    Authorization: "Bearer bearer-secret-2",
    "X-Client-Version": "4.2.0",
    Cookie: "sid=cookie-secret-3",
  },
  requestBody: null,
  status: 200,
  mimeType: "application/json",
  responseBody: JSON.stringify({
    items: [{ id: 1, title: "First", author: { email: "ada@example.com" }, createdAt: "2026-10-01T10:00:00Z" }],
    next: null,
    sessionToken: "resp-secret-4",
  }),
  ...over,
});

describe("shapes", () => {
  test("paths become templates", () => {
    expect(pathTemplate("/v1/users/123/posts")).toBe("/v1/users/{id}/posts");
    expect(pathTemplate("/items/3f2b8c9e-1d2a-4b5c-8d9e-0f1a2b3c4d5e")).toBe("/items/{uuid}");
    expect(pathTemplate("/u/ada%40example.com/")).toBe("/u/{email}");
    expect(pathTemplate("/days/2026-10-30")).toBe("/days/{date}");
    expect(pathTemplate("/blob/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3")).toBe("/blob/{hash}");
    expect(pathTemplate("/p/Xk29aLq0Zz")).toBe("/p/{id}");
    expect(pathTemplate("/api/search")).toBe("/api/search");
    expect(pathTemplate("/")).toBe("/");
  });

  test("templates match paths, and paths differing in one place collapse", () => {
    expect(templateMatches("/users/{id}", "/users/42")).toBe(true);
    expect(templateMatches("/users/{param}/repos", "/users/ada/repos")).toBe(true);
    expect(templateMatches("/users/{id}", "/users/42/x")).toBe(false);
    expect(collapsed(["/users/ada", "/users/bob", "/users/cy"])).toBeNull();
    expect(collapsed(["/users/ada", "/users/bob", "/users/cy", "/users/dee"])).toBe("/users/{param}");
    expect(collapsed(["/users/ada", "/teams/bob", "/users/cy", "/users/dee"])).toBeNull();
  });

  test("values become kinds; data-keyed objects become maps", () => {
    expect(shapeOf({ id: 1, ratio: 0.5, ok: true, name: "x", when: "2026-01-01", tags: ["a"] })).toEqual({
      t: "object",
      samples: 1,
      fields: {
        id: { shape: { t: "number", int: true }, seen: 1 },
        ratio: { shape: { t: "number" }, seen: 1 },
        ok: { shape: { t: "boolean" }, seen: 1 },
        name: { shape: { t: "string" }, seen: 1 },
        when: { shape: { t: "string", format: "date" }, seen: 1 },
        tags: { shape: { t: "array", items: { t: "string" } }, seen: 1 },
      },
    });
    expect(shapeOf({ "ada@example.com": { n: 1 }, "bob@example.com": { n: 2 } }).t).toBe("map");
    expect(shapeOf({ "123": 1, "456": 2 }).t).toBe("map");
  });

  test("merging marks fields optional and kinds as alternatives", () => {
    const merged = merge(shapeOf({ id: 1, name: "a" }), shapeOf({ id: 2, name: null, extra: true }))!;
    expect(formatShape(merged)).toBe("{\n  id: integer;\n  name: string | null;\n  extra?: boolean;\n}");
  });
});

describe("observations keep no values", () => {
  test("query, headers and bodies as names and kinds; credentials by name only", () => {
    const o = observe(request())!;
    expect(o.host).toBe("api.example.com");
    expect(o.site).toBe("example.com");
    expect(o.path).toBe("/v1/users/{id}/posts");
    expect(o.query.page).toEqual({ shape: { t: "number", int: true }, seen: 1 });
    expect(o.query.api_key?.secret).toBe(true);
    expect(Object.keys(o.headers).sort()).toEqual(["Authorization", "X-Client-Version"]);
    expect(o.headers.Authorization?.secret).toBe(true);
    const json = JSON.stringify(o);
    for (const secret of [
      "key-secret-1",
      "bearer-secret-2",
      "cookie-secret-3",
      "resp-secret-4",
      "ada@example.com",
      "cats",
      "First",
      "4.2.0",
    ])
      expect(json).not.toContain(secret);
    expect(formatShape(o.responseBody)).toContain("email: string (email)");
    expect(formatShape(o.responseBody)).toContain("sessionToken: string (credential)");
  });

  test("forms and GraphQL operations", () => {
    const form = observe(
      request({
        method: "POST",
        url: "https://example.com/login",
        requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
        requestBody: "user=ada&password=hunter2&remember=true",
        responseBody: null,
        mimeType: "text/html",
      }),
    )!;
    expect(formatShape(form.requestBody)).toBe(
      "{\n  user: string;\n  password: string (credential);\n  remember: boolean;\n}",
    );
    expect(JSON.stringify(form)).not.toContain("hunter2");

    const gql = observe(
      request({
        method: "POST",
        url: "https://example.com/graphql",
        requestHeaders: { "content-type": "application/json" },
        requestBody: JSON.stringify({
          operationName: "Viewer",
          query: "query Viewer { me { name } }",
          variables: { first: 10 },
        }),
      }),
    )!;
    expect(gql.operation).toBe("Viewer");
    expect(JSON.stringify(gql)).not.toContain("me { name }");
    expect(formatShape(gql.requestBody)).toContain("first: integer");
  });

  test("not an API call: nothing", () => {
    expect(observe(request({ url: "data:text/plain,hi" }))).toBeNull();
  });
});

describe("the map over HTTP", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (res.status === 204 ? null : await res.json()) as T;
  };

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("observations merge into endpoints per host", async () => {
    const workspace = (await call<{ id: string }[]>("/api/workspaces"))[0]!.id;
    const send = (observations: Observation[]) =>
      call("/api/endpoints/observe", { method: "POST", body: { workspaceId: workspace, observations } });
    await send([
      observe(request())!,
      observe(request({ url: "https://api.example.com/v1/users/456/posts?page=3" }))!,
      observe(
        request({ url: "https://api.example.com/v1/users/7/posts", status: 404, responseBody: '{"error":"x"}' }),
      )!,
    ]);
    // Profiles by name: separate at first, one template once enough were seen.
    for (const name of ["ada", "bob", "cy", "dee"])
      await send([observe(request({ url: `https://api.example.com/v1/profiles/${name}` }))!]);

    const hosts = await call<EndpointHost[]>(`/api/endpoints?workspace=${workspace}`);
    expect(hosts.map((h) => [h.host, h.endpoints, h.requests])).toEqual([["api.example.com", 2, 7]]);
    const endpoints = await call<Endpoint[]>(`/api/endpoints/hosts/api.example.com?workspace=${workspace}`);
    expect(endpoints.map((e) => `${e.method} ${e.path} ${e.seen}`)).toEqual([
      "GET /v1/profiles/{param} 4",
      "GET /v1/users/{id}/posts 3",
    ]);
    const posts = endpoints[1]!;
    expect(posts.responses.map((r) => [r.status, r.seen])).toEqual([
      [200, 2],
      [404, 1],
    ]);
    // api_key and q only came with one of three requests.
    expect(describeEndpoint(posts)).toContain("query: page?: integer, q?: string, api_key?: credential");
    const stored = JSON.stringify(endpoints);
    for (const secret of ["key-secret-1", "bearer-secret-2", "resp-secret-4", "ada@example.com", "/ada"])
      expect(stored).not.toContain(secret);

    await call(`/api/endpoints/hosts/api.example.com?workspace=${workspace}`, { method: "DELETE" });
    expect(await call<EndpointHost[]>(`/api/endpoints?workspace=${workspace}`)).toEqual([]);
  });

  test("turned off in Settings, or for a site: nothing is kept", async () => {
    const workspace = (await call<{ id: string }[]>("/api/workspaces"))[0]!.id;
    const settings = await call<{ web: Record<string, unknown> }>("/api/settings");
    await call("/api/settings", {
      method: "PUT",
      body: { ...settings, web: { ...settings.web, apiMapOff: ["example.com"] } },
    });
    await call("/api/endpoints/observe", {
      method: "POST",
      body: { workspaceId: workspace, observations: [observe(request())!] },
    });
    expect(await call<EndpointHost[]>(`/api/endpoints?workspace=${workspace}`)).toEqual([]);
    await call("/api/settings", { method: "PUT", body: { ...settings, web: { ...settings.web, apiMap: false } } });
    await call("/api/endpoints/observe", {
      method: "POST",
      body: { workspaceId: workspace, observations: [observe(request({ url: "https://other.test/x" }))!] },
    });
    expect(await call<EndpointHost[]>(`/api/endpoints?workspace=${workspace}`)).toEqual([]);
  });
});
