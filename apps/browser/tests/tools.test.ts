// The tool registry: tools derived from an app's data, its own actions
// (extending or replacing them), and calls from the user and from other apps,
// with permissions and the audit log. Real server, real sandboxed apps; no model.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSummary, AppTool, AppToolsInfo, AuditEntry, PermissionRequest, ToolResult } from "../src/shared/api";
import { checkParams, dataTools } from "../src/server/workspace/AppTools";
import { startServer } from "./lib/server";
import { writesVariable } from "./lib/apps";

const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
};

describe("derived tools", () => {
  const table = {
    name: "Expense items",
    columns: [
      { name: "id", type: "INTEGER", primaryKey: true, required: false },
      { name: "label", type: "TEXT", primaryKey: false, required: true },
      { name: "amount", type: "REAL", primaryKey: false, required: false },
    ],
    key: ["id"],
  };

  test("a table gets list, get, add, update and delete", () => {
    const tools = dataTools(table, "all");
    expect(tools.map((t) => [t.id, t.readOnly])).toEqual([
      ["list-expense-items", true],
      ["get-expense-items", true],
      ["add-expense-items", false],
      ["update-expense-items", false],
      ["delete-expense-items", false],
    ]);
    const add = tools.find((t) => t.op === "add")!;
    expect(add.params).toEqual({
      label: { type: "string", description: "TEXT", required: true },
      amount: { type: "number", description: "REAL" },
    });
    expect(tools.find((t) => t.op === "update")!.params.id).toMatchObject({ type: "integer", required: true });
    expect(dataTools(table, "read").map((t) => t.op)).toEqual(["list", "get"]);
    expect(dataTools({ ...table, name: "_migrations" }, "all")).toEqual([]);
  });

  test("arguments are checked against the params", () => {
    const add = dataTools(table, "all").find((t) => t.op === "add")!;
    expect(checkParams(add, { label: "Lunch", amount: 12.5 })).toBeNull();
    expect(checkParams(add, { amount: 1 })).toBe("Missing label");
    expect(checkParams(add, { label: "x", amount: "lots" })).toBe("amount should be a number");
    expect(checkParams(add, { label: "x", colour: "red" })).toContain("has no colour");
  });
});

describe("tool registry", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let budget: AppSummary;
  let other: AppSummary;
  let otherToken: string;
  const projectOf = (app: AppSummary) => join(server.dataDir, "apps", app.id);
  const call = (app: AppSummary, tool: string, params?: Record<string, unknown>) =>
    server.api<ToolResult>(`/api/apps/${app.id}/tools/${tool}`, { method: "POST", json: params ? { params } : {} });
  const fromOther = (app: AppSummary, tool: string, params: Record<string, unknown> = {}) =>
    fetch(`${server.url}/app-api/v1/tools/${app.id}/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ params }),
    });
  const answer = async (allow: boolean, remember = false) => {
    const request = await waitFor(async () => (await server.api<PermissionRequest[]>("/api/permissions/pending"))[0]);
    await server.api(`/api/permissions/pending/${request.id}`, { method: "POST", json: { allow, remember } });
    return request;
  };

  beforeAll(async () => {
    server = await startServer();
    budget = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${budget.id}/project`, { method: "POST", json: { preset: "api" } });
    await server.api(`/api/apps/${budget.id}/runtime`, { method: "POST", json: { action: "stop" } });
    writeFileSync(
      join(projectOf(budget), "action.ts"),
      `Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/api/total") {
      const { params } = await req.json();
      return Response.json({ message: "Total for " + params.month, total: 42, caller: req.headers.get("x-rune-caller") });
    }
    if (req.method === "POST" && path === "/api/delete") return Response.json({ message: "Deleting is done by the app itself" });
    return new Response("ok");
  },
});`,
    );
    writeFileSync(
      join(projectOf(budget), "rune.json"),
      JSON.stringify({
        install: "true",
        dev: "bun action.ts",
        start: "bun action.ts",
        actions: [
          {
            id: "total",
            title: "Monthly total",
            endpoint: "/api/total",
            params: { month: { type: "string", required: true, description: "YYYY-MM" } },
          },
          // Replaces the derived delete-expenses.
          {
            id: "delete-expenses",
            title: "Delete an expense",
            endpoint: "/api/delete",
            params: { id: { type: "integer", required: true } },
          },
          { id: "report", title: "Report", path: "/report" },
        ],
      }),
    );
    const dataDir = join(server.dataDir, "appdata", budget.id);
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(join(dataDir, "data.sqlite"));
    db.run("CREATE TABLE expenses (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount REAL)");
    db.run("CREATE TABLE _migrations (version INTEGER)");
    db.run("INSERT INTO expenses (label, amount) VALUES ('Lunch', 12.5), ('Train', 4.2)");
    db.close();

    other = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${other.id}/project`, { method: "POST", json: { preset: "api" } });
    writesVariable(projectOf(other), "RUNE_API_TOKEN", "token.txt");
    await server.api(`/api/apps/${other.id}/runtime`, { method: "POST", json: { action: "restart" } });
    const file = join(projectOf(other), "token.txt");
    otherToken = await waitFor(() => (existsSync(file) && readFileSync(file, "utf8")) || undefined);
  });
  afterAll(() => server.stop());

  test("an app's tools: its actions first, then the ones from its data, which actions can replace", async () => {
    const tools = await server.api<AppTool[]>(`/api/apps/${budget.id}/tools`);
    expect(tools.map((t) => `${t.source}:${t.id}`)).toEqual([
      "action:total",
      "action:delete-expenses",
      "action:report",
      "data:list-expenses",
      "data:get-expenses",
      "data:add-expenses",
      "data:update-expenses",
    ]);
  });

  test("the user runs data tools: add, list, get, update", async () => {
    const added = await call(budget, "add-expenses", { label: "Books", amount: "31" });
    expect(added).toMatchObject({
      ok: true,
      message: "Added a row to expenses",
      data: { id: 3, label: "Books", amount: 31 },
    });
    expect(await call(budget, "list-expenses", { search: "rai" })).toMatchObject({
      ok: true,
      data: { total: 1, rows: [{ label: "Train" }] },
    });
    expect(await call(budget, "get-expenses", { id: 1 })).toMatchObject({ data: { label: "Lunch" } });
    expect(await call(budget, "update-expenses", { id: 1, amount: 13 })).toMatchObject({
      data: { label: "Lunch", amount: 13 },
    });
    expect(await call(budget, "get-expenses", { id: 99 })).toMatchObject({ ok: false, status: 404 });
    await expect(call(budget, "add-expenses", { amount: 1 })).rejects.toThrow("400 ");
    await expect(call(budget, "list-expenses", { colour: "red" })).rejects.toThrow("400 ");
    await expect(call(budget, "report")).rejects.toThrow("400 ");
    await expect(call(budget, "nope")).rejects.toThrow("404 ");
  });

  test("an action gets the params and who's calling; its JSON comes back", async () => {
    const result = await call(budget, "total", { month: "2026-10" });
    expect(result).toEqual({
      ok: true,
      status: 200,
      message: "Total for 2026-10",
      data: { message: "Total for 2026-10", total: 42, caller: "user" },
    });
    expect(await call(budget, "delete-expenses", { id: 1 })).toMatchObject({
      message: "Deleting is done by the app itself",
    });
  });

  test("another app discovers the workspace's tools and uses them only after the user allows it", async () => {
    const catalog = (await (
      await fetch(`${server.url}/app-api/v1/tools`, { headers: { Authorization: `Bearer ${otherToken}` } })
    ).json()) as (AppToolsInfo & {
      self: boolean;
    })[];
    const entry = catalog.find((c) => c.appId === budget.id)!;
    expect(entry.self).toBe(false);
    // Opening pages is for the user.
    expect(entry.tools.some((t) => t.id === "report")).toBe(false);

    // Reading data: the same permission as the data API.
    const read = fromOther(budget, "list-expenses");
    expect(await answer(true, true)).toMatchObject({ subject: other.id, action: "app.data", resource: budget.id });
    expect(((await (await read).json()) as ToolResult).data).toMatchObject({ total: 3 });

    // Changing data: per tool.
    const write = fromOther(budget, "add-expenses", { label: "Sneaky" });
    expect(await answer(false)).toMatchObject({ action: "app.tool", resource: `${budget.id}/add-expenses` });
    expect((await write).status).toBe(403);
    expect(((await call(budget, "list-expenses", { search: "Sneaky" })).data as { total: number }).total).toBe(0);

    const action = fromOther(budget, "total", { month: "2026-09" });
    await answer(true);
    expect(((await (await action).json()) as ToolResult).data).toMatchObject({ caller: `app:${other.id}` });

    const audit = await server.api<AuditEntry[]>(`/api/audit?tab=${other.id}`);
    const calls = audit.filter((e) => e.action === "app.action").map((e) => [e.actor, e.target, e.outcome]);
    expect(calls).toContainEqual(["app", `${budget.name} · List expenses`, "ok"]);
    expect(calls).toContainEqual(["app", `${budget.name} · Add to expenses`, "denied"]);
    expect(calls).toContainEqual(["app", `${budget.name} · Monthly total`, "ok"]);
  });

  test("dataTools in rune.json turns the derived ones down", async () => {
    const manifest = JSON.parse(readFileSync(join(projectOf(budget), "rune.json"), "utf8"));
    writeFileSync(join(projectOf(budget), "rune.json"), JSON.stringify({ ...manifest, dataTools: "read" }));
    expect(
      (await server.api<AppTool[]>(`/api/apps/${budget.id}/tools`)).filter((t) => t.source === "data").map((t) => t.id),
    ).toEqual(["list-expenses", "get-expenses"]);
    writeFileSync(join(projectOf(budget), "rune.json"), JSON.stringify({ ...manifest, dataTools: "none" }));
    expect((await server.api<AppTool[]>(`/api/apps/${budget.id}/tools`)).filter((t) => t.source === "data")).toEqual(
      [],
    );
  });
});
