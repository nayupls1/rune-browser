// Command bar actions declared in rune.json: parsing, listing, and running
// an endpoint action against a real (sandboxed) app server. No model is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppActionInfo, AppActionResult, AppSummary, AuditEntry } from "../src/shared/api";
import { parseActions } from "../src/server/workspace/Workspace";
import { startServer } from "./lib/server";

describe("parseActions", () => {
  test("keeps valid actions and drops the rest", () => {
    expect(
      parseActions([
        { id: "add-expense", title: " Add expense ", endpoint: "/api/expenses", input: "What and how much" },
        { id: "open-report", title: "Monthly report", description: "This month's spending", path: "/report" },
        { id: "both", title: "Both", path: "/a", endpoint: "/b" },
        { id: "neither", title: "Neither" },
        { id: "Bad Id", title: "Bad", path: "/x" },
        { id: "elsewhere", title: "Elsewhere", path: "//evil.example/x" },
        { id: "absolute", title: "Absolute", endpoint: "https://evil.example/x" },
        { id: "add-expense", title: "Duplicate", path: "/dup" },
        { id: "untitled", title: "  ", path: "/x" },
        "nonsense",
      ]),
    ).toEqual([
      { id: "add-expense", title: "Add expense", endpoint: "/api/expenses", input: "What and how much" },
      { id: "open-report", title: "Monthly report", description: "This month's spending", path: "/report" },
    ]);
    expect(parseActions(undefined)).toEqual([]);
    expect(parseActions({ id: "x" })).toEqual([]);
  });
});

describe("app actions", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let app: AppSummary;

  beforeAll(async () => {
    server = await startServer();
    app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "stop" } });
    const dir = join(server.dataDir, "apps", app.id);
    writeFileSync(
      join(dir, "action.ts"),
      `Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/api/add") {
      const { input } = await req.json();
      return Response.json({ message: "Added " + input });
    }
    if (path === "/api/fail") return Response.json({ error: "No budget set" }, { status: 400 });
    return new Response("ok");
  },
});`,
    );
    writeFileSync(
      join(dir, "rune.json"),
      JSON.stringify({
        install: "true",
        dev: "bun action.ts",
        start: "bun action.ts",
        actions: [
          { id: "add", title: "Add expense", endpoint: "/api/add", input: "What and how much" },
          { id: "fail", title: "Check budget", endpoint: "/api/fail" },
          { id: "report", title: "Monthly report", path: "/report" },
          { id: "broken", title: "Broken" },
        ],
      }),
    );
  });
  afterAll(() => server.stop());

  test("are listed with their app", async () => {
    const list = await server.api<AppActionInfo[]>("/api/actions");
    expect(list.map((a) => [a.appId, a.action.id])).toEqual([
      [app.id, "add"],
      [app.id, "fail"],
      [app.id, "report"],
    ]);
    expect(list[0]).toMatchObject({ workspaceId: "default", appName: app.name });
  });

  test("an endpoint action starts the app, posts the input and shows its message", async () => {
    const result = await server.api<AppActionResult>(`/api/apps/${app.id}/actions/add`, {
      method: "POST",
      json: { input: "lunch 12" },
    });
    expect(result).toEqual({ ok: true, status: 200, message: "Added lunch 12" });
    const failed = await server.api<AppActionResult>(`/api/apps/${app.id}/actions/fail`, { method: "POST", json: {} });
    expect(failed).toEqual({ ok: false, status: 400, message: "No budget set" });
    const audit = await server.api<AuditEntry[]>(`/api/audit?tab=${app.id}`);
    expect(audit.filter((e) => e.action === "app.action").map((e) => [e.target, e.outcome])).toEqual([
      ["Check budget", "error"],
      ["Add expense", "ok"],
    ]);
  });

  test("path actions open the app instead; unknown ones are not found", async () => {
    await expect(server.api(`/api/apps/${app.id}/actions/report`, { method: "POST", json: {} })).rejects.toThrow("400");
    await expect(server.api(`/api/apps/${app.id}/actions/nope`, { method: "POST", json: {} })).rejects.toThrow("404");
  });
});
