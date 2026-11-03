// AI for apps: only an app's server, with its own token, may ask; browsers
// and the renderer's token can't. (No model is called here.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { instructionsFor, promptFor } from "../src/server/ai/Ai";
import type { AppSummary } from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";
import { writesVariable } from "./lib/apps";

describe("requests", () => {
  test("a conversation becomes one prompt", () => {
    expect(promptFor([{ role: "user", content: "hi" }])).toBe("hi");
    const prompt = promptFor([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(prompt).toContain("<assistant>\nb\n</assistant>");
    expect(prompt.endsWith("Reply to the last user message, as the assistant.")).toBe(true);
  });

  test("instructions say there are no tools and add the app's own", () => {
    const text = instructionsFor("Recipes", { system: "Be terse.", json: true });
    expect(text).toContain('"Recipes"');
    expect(text).toContain("You have no tools.");
    expect(text).toContain("single valid JSON value");
    expect(text).toContain("Be terse.");
  });
});

describe("gateway", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let token = "";
  beforeAll(async () => {
    server = await startServer();
    const app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    // A dev command that hands us the environment Rune Browser gives the app.
    const dir = join(server.dataDir, "apps", app.id);
    writesVariable(dir, "RUNE_AI_TOKEN", "token.txt");
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
    const file = join(dir, "token.txt");
    for (let i = 0; i < 100 && !(existsSync(file) && readFileSync(file, "utf8")); i++) await Bun.sleep(100);
    token = readFileSync(file, "utf8");
  });
  afterAll(() => server.stop());

  const ai = (path: string, init: { token?: string; origin?: string; body?: unknown } = {}) =>
    fetch(`${server.url}/ai/v1${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.origin ? { Origin: init.origin } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  test("apps get a token in their environment", () => {
    expect(token).toMatch(/^nai_[0-9a-f]{64}$/);
  });

  test("the app's token works; others don't", async () => {
    const info = await ai("/models", { token });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ usage: { today: 0, limit: 200 } });
    expect((await ai("/models")).status).toBe(401);
    expect((await ai("/models", { token: "nai_nope" })).status).toBe(401);
    // The renderer's API token isn't an app token.
    expect((await ai("/models", { token: server.token })).status).toBe(401);
  });

  test("browsers can't call it, even with the token", async () => {
    const res = await ai("/chat", { token, origin: "http://127.0.0.1:5555", body: { prompt: "hi" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("server");
  });

  test("the user can turn it off", async () => {
    const settings = await server.api<Settings>("/api/settings");
    await server.api("/api/settings", {
      method: "PUT",
      json: { ...settings, apps: { ...settings.apps, ai: { ...settings.apps.ai, enabled: false } } },
    });
    const res = await ai("/chat", { token, body: { prompt: "hi" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("turned off");
  });

  test("the app's token is no key to the rest of the API", async () => {
    const res = await fetch(`${server.url}/api/apps`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});
