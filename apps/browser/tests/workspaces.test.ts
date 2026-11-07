// Workspaces: tabs, secrets, permissions and the audit log scoped to them,
// against the real server and real (sandboxed) app processes. No model is called.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE,
  type AppSummary,
  type AuditEntry,
  type PermissionGrant,
  type WorkspaceInfo,
} from "../src/shared/api";
import { startServer } from "./lib/server";
import { devScript } from "./lib/apps";

const waitFor = async <T>(fn: () => T | undefined, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
};

describe("workspaces", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let client: WorkspaceInfo;
  let inClient: AppSummary;
  let inPersonal: AppSummary;

  const dirOf = (app: AppSummary) => join(server.dataDir, "apps", app.id);
  const seen = (app: AppSummary, step: string) => {
    const file = join(dirOf(app), `seen-${step}.txt`);
    return existsSync(file) ? readFileSync(file, "utf8") || undefined : undefined;
  };
  /** From now on, the app's dev "server" writes the secrets it got (for `step`) and stays up. */
  const report = (app: AppSummary, step: string) =>
    devScript(
      dirOf(app),
      `await Bun.write("seen-${step}.txt", [process.env.SHARED || "unset", process.env.GLOBAL_KEY || "unset"].join(" "));`,
    );
  /**
   * What the app's dev process reports for `step`, once it's `expected`, or the last thing it reported. A restart
   * from an earlier step can land late (slow process starts on Windows) and report first with what it was given then.
   */
  const reported = async (app: AppSummary, step: string, expected: string) => {
    await waitFor(() => (seen(app, step) === expected ? true : undefined)).catch(() => {});
    return seen(app, step);
  };
  const restart = (app: AppSummary) =>
    server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
  const newApp = async (workspaceId?: string) => {
    const app = await server.api<AppSummary>("/api/apps", { method: "POST", json: workspaceId ? { workspaceId } : {} });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    return app;
  };

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());

  test("there's always one to start with, where tabs go by default", async () => {
    const list = await server.api<WorkspaceInfo[]>("/api/workspaces");
    expect(list.map((w) => [w.id, w.name])).toEqual([[DEFAULT_WORKSPACE, "Personal"]]);
    expect(list[0]!.settings).toEqual({ agent: null, instructions: "", webInstructions: "" });
    inPersonal = await newApp();
    expect(inPersonal.workspaceId).toBe(DEFAULT_WORKSPACE);
  });

  test("tabs are created in a workspace", async () => {
    client = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "  Client  " } });
    expect(client.name).toBe("Client");
    inClient = await newApp(client.id);
    expect(inClient.workspaceId).toBe(client.id);
    const apps = await server.api<AppSummary[]>("/api/apps");
    expect(apps.find((a) => a.id === inClient.id)?.workspaceId).toBe(client.id);
    await expect(server.api("/api/apps", { method: "POST", json: { workspaceId: "nope" } })).rejects.toThrow("404");
    await expect(server.api("/api/workspaces", { method: "POST", json: { name: "   " } })).rejects.toThrow("400");
  });

  test("its own settings are saved and validated", async () => {
    const settings = {
      agent: { provider: "codex" as const, model: null, effort: "low" },
      instructions: "Use Acme's colors.",
      webInstructions: "",
    };
    const saved = await server.api<WorkspaceInfo>(`/api/workspaces/${client.id}`, {
      method: "PATCH",
      json: { settings },
    });
    expect(saved.settings).toEqual(settings);
    await expect(
      server.api(`/api/workspaces/${client.id}`, {
        method: "PATCH",
        json: { settings: { ...settings, agent: { provider: "nope" } } },
      }),
    ).rejects.toThrow("400");
  });

  test("workspace secrets go to its apps only; an app's own secret wins", async () => {
    await server.api("/api/secrets", {
      method: "PUT",
      json: { scope: `workspace:${client.id}`, name: "SHARED", value: "from-workspace" },
    });
    report(inClient, "shared");
    report(inPersonal, "shared");
    await Promise.all([restart(inClient), restart(inPersonal)]);
    expect(await reported(inClient, "shared", "from-workspace unset")).toBe("from-workspace unset");
    expect(await reported(inPersonal, "shared", "unset unset")).toBe("unset unset");

    await server.api("/api/secrets", { method: "PUT", json: { scope: inClient.id, name: "SHARED", value: "own" } });
    report(inClient, "own");
    await restart(inClient);
    expect(await reported(inClient, "own", "own unset")).toBe("own unset");
    const own = (await server.api<{ secrets: { id: string }[] }>(`/api/secrets?scope=${inClient.id}`)).secrets[0]!;
    await server.api(`/api/secrets/${own.id}`, { method: "DELETE" });

    await expect(
      server.api("/api/secrets", { method: "PUT", json: { scope: "workspace:nope", name: "X", value: "x" } }),
    ).rejects.toThrow("404");
  });

  test("a permission can be remembered for every app in a workspace; the app's own choice wins", async () => {
    await server.api("/api/secrets", { method: "PUT", json: { scope: "global", name: "GLOBAL_KEY", value: "glob" } });
    report(inClient, "granted");
    report(inPersonal, "granted");
    // Granting restarts the workspace's running apps.
    await server.api("/api/permissions", {
      method: "PUT",
      json: { subject: `workspace:${client.id}`, action: "app.secret", resource: "GLOBAL_KEY", decision: "allow" },
    });
    expect(await reported(inClient, "granted", "from-workspace glob")).toBe("from-workspace glob");
    await restart(inPersonal);
    expect(await reported(inPersonal, "granted", "unset unset")).toBe("unset unset");

    const grant = (await server.api<PermissionGrant[]>("/api/permissions")).find(
      (g) => g.subject === `workspace:${client.id}`,
    )!;
    expect(grant).toMatchObject({ subjectName: "Apps in Client", workspaceId: client.id });

    report(inClient, "denied");
    await server.api("/api/permissions", {
      method: "PUT",
      json: { subject: inClient.id, action: "app.secret", resource: "GLOBAL_KEY", decision: "deny" },
    });
    expect(await reported(inClient, "denied", "from-workspace unset")).toBe("from-workspace unset");
    const own = (await server.api<PermissionGrant[]>("/api/permissions")).find((g) => g.subject === inClient.id)!;
    await server.api(`/api/permissions/${own.id}`, { method: "DELETE" });
  });

  test("a moved tab gets its new workspace's secrets and restarts", async () => {
    report(inClient, "moved");
    const moved = await server.api<AppSummary>(`/api/apps/${inClient.id}/move`, {
      method: "POST",
      json: { workspaceId: DEFAULT_WORKSPACE },
    });
    expect(moved.workspaceId).toBe(DEFAULT_WORKSPACE);
    expect(await reported(inClient, "moved", "unset unset")).toBe("unset unset");
    report(inClient, "back");
    await server.api(`/api/apps/${inClient.id}/move`, { method: "POST", json: { workspaceId: client.id } });
    expect(await reported(inClient, "back", "from-workspace glob")).toBe("from-workspace glob");
  });

  test("the audit log is filtered by workspace", async () => {
    const entries = await server.api<AuditEntry[]>(`/api/audit?workspace=${client.id}`);
    expect(entries.some((e) => e.tabId === inClient.id && e.workspaceId === client.id)).toBe(true);
    expect(
      entries.some(
        (e) => e.action === "secret.create" && e.target === "workspace SHARED" && e.workspaceId === client.id,
      ),
    ).toBe(true);
    // Nothing from the other workspace's tabs, but what belongs to none (the global secret) is there.
    expect(entries.some((e) => e.tabId === inPersonal.id)).toBe(false);
    expect(entries.some((e) => e.target === "global GLOBAL_KEY" && e.workspaceId === null)).toBe(true);
  });

  test("tabs keep the order they're put in; new and moved ones go last", async () => {
    const space = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Ordered" } });
    const web = () =>
      server.api<AppSummary>("/api/apps", {
        method: "POST",
        json: { kind: "web", url: "https://example.com/", workspaceId: space.id },
      });
    const [a, b, c, d] = [await web(), await web(), await web(), await web()];
    const order = async () =>
      (await server.api<AppSummary[]>("/api/apps")).filter((t) => t.workspaceId === space.id).map((t) => t.id);
    expect(await order()).toEqual([a.id, b.id, c.id, d.id]);
    // Tabs left out follow in their old order; other workspaces' and unknown ids are ignored.
    const result = await server.api<AppSummary[]>(`/api/workspaces/${space.id}/order`, {
      method: "PUT",
      json: { ids: [d.id, "nope", inPersonal.id, b.id] },
    });
    expect(result.map((t) => t.id)).toEqual([d.id, b.id, a.id, c.id]);
    expect(await order()).toEqual([d.id, b.id, a.id, c.id]);
    expect((await server.api<AppSummary[]>("/api/apps")).find((t) => t.id === inPersonal.id)?.workspaceId).toBe(
      DEFAULT_WORKSPACE,
    );
    const e = await web();
    expect((await order()).at(-1)).toBe(e.id);
    await server.api(`/api/apps/${d.id}/move`, { method: "POST", json: { workspaceId: DEFAULT_WORKSPACE } });
    await server.api(`/api/apps/${d.id}/move`, { method: "POST", json: { workspaceId: space.id } });
    expect(await order()).toEqual([b.id, a.id, c.id, e.id, d.id]);
    await expect(server.api(`/api/workspaces/nope/order`, { method: "PUT", json: { ids: [] } })).rejects.toThrow("404");
    await server.api(`/api/workspaces/${space.id}`, { method: "DELETE" });
  });

  test("split views are saved consistent with the tabs, and lose tabs that leave", async () => {
    const space = await server.api<WorkspaceInfo>("/api/workspaces", { method: "POST", json: { name: "Splits" } });
    expect(space.splits).toEqual([]);
    const web = () =>
      server.api<AppSummary>("/api/apps", {
        method: "POST",
        json: { kind: "web", url: "https://example.com/", workspaceId: space.id },
      });
    const [a, b, c, d] = [await web(), await web(), await web(), await web()];
    const put = (splits: unknown) =>
      server.api<WorkspaceInfo>(`/api/workspaces/${space.id}/splits`, { method: "PUT", json: { splits } });
    const saved = await put([
      // Other workspaces' tabs and repeats are dropped; sizes are made to add up to 1.
      { id: "one", direction: "row", tabs: [a.id, inPersonal.id, b.id, a.id], sizes: [2, 1, 2, 1] },
      // c is in one split only; this one keeps a single tab and goes.
      { id: "two", direction: "column", tabs: [b.id, c.id], sizes: [1, 1] },
      { id: "three", direction: "column", tabs: [c.id, d.id], sizes: [0.7] },
    ]);
    expect(saved.splits).toEqual([
      { id: "one", direction: "row", tabs: [a.id, b.id], sizes: [0.5, 0.5] },
      { id: "three", direction: "column", tabs: [c.id, d.id], sizes: [0.5, 0.5] },
    ]);
    expect((await server.api<WorkspaceInfo[]>("/api/workspaces")).find((w) => w.id === space.id)?.splits).toEqual(
      saved.splits,
    );
    await expect(put([{ id: "x", direction: "diagonal", tabs: [], sizes: [] }])).rejects.toThrow("400");
    await expect(server.api(`/api/workspaces/nope/splits`, { method: "PUT", json: { splits: [] } })).rejects.toThrow(
      "404",
    );

    // A deleted tab leaves its split (which goes when one tab is left); so does a moved one.
    await server.api(`/api/apps/${b.id}`, { method: "DELETE" });
    const e = await web();
    await put([...saved.splits.slice(1), { id: "four", direction: "row", tabs: [a.id, e.id], sizes: [0.25, 0.75] }]);
    await server.api(`/api/apps/${d.id}/move`, { method: "POST", json: { workspaceId: DEFAULT_WORKSPACE } });
    const after = (await server.api<WorkspaceInfo[]>("/api/workspaces")).find((w) => w.id === space.id)!;
    expect(after.splits).toEqual([{ id: "four", direction: "row", tabs: [a.id, e.id], sizes: [0.25, 0.75] }]);
    await server.api(`/api/apps/${d.id}`, { method: "DELETE" });
    await server.api(`/api/workspaces/${space.id}`, { method: "DELETE" });
  });

  test("deleting a workspace deletes its tabs, data, secrets and permissions; the last one stays", async () => {
    await server.api(`/api/workspaces/${client.id}`, { method: "DELETE" });
    expect((await server.api<WorkspaceInfo[]>("/api/workspaces")).map((w) => w.id)).toEqual([DEFAULT_WORKSPACE]);
    expect((await server.api<AppSummary[]>("/api/apps")).map((a) => a.id)).toEqual([inPersonal.id]);
    expect(existsSync(dirOf(inClient))).toBe(false);
    expect((await server.api<{ secrets: unknown[] }>(`/api/secrets?scope=workspace:${client.id}`)).secrets).toEqual([]);
    expect(
      (await server.api<PermissionGrant[]>("/api/permissions")).filter((g) => g.workspaceId === client.id),
    ).toEqual([]);
    await expect(server.api(`/api/workspaces/${DEFAULT_WORKSPACE}`, { method: "DELETE" })).rejects.toThrow("400");
  });
});

describe("a database from before workspaces", () => {
  test("gets one workspace with all its tabs and audit entries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rune-old-db-"));
    const db = new Database(join(dataDir, "rune.sqlite"));
    db.run(
      `CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x')`,
    );
    db.run(`CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT 'x', actor TEXT NOT NULL, actor_label TEXT NOT NULL,
      tab_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, outcome TEXT NOT NULL DEFAULT 'ok')`);
    db.run(`INSERT INTO apps (id, name) VALUES ('old-tab', 'Old tab')`);
    db.run(`INSERT INTO audit (actor, actor_label, tab_id, action) VALUES ('user', 'You', 'old-tab', 'runtime.start')`);
    db.close();

    const server = await startServer({ dataDir });
    try {
      expect((await server.api<WorkspaceInfo[]>("/api/workspaces")).map((w) => w.name)).toEqual(["Personal"]);
      expect((await server.api<AppSummary[]>("/api/apps")).map((a) => [a.id, a.workspaceId])).toEqual([
        ["old-tab", DEFAULT_WORKSPACE],
      ]);
      const [entry] = await server.api<AuditEntry[]>(`/api/audit?workspace=${DEFAULT_WORKSPACE}`);
      expect(entry).toMatchObject({ tabId: "old-tab", workspaceId: DEFAULT_WORKSPACE });
    } finally {
      await server.stop();
    }
  });
});
