// Secrets, permissions and the audit log, against the real server and real
// (sandboxed) app processes. No model is called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { claudeEnv } from "../src/server/providers/Claude";
import { agentEnv } from "../src/server/providers/process";
import { makeVault } from "../src/server/security/Vault";
import type {
  AppSummary,
  AuditEntry,
  PermissionGrant,
  PermissionRequest,
  SecretInfo,
  SecretsOverview,
} from "../src/shared/api";
import type { Settings } from "../src/shared/settings";
import { startServer } from "./lib/server";
import { devScript, writesVariable } from "./lib/apps";

/** Every process's command line on this machine, as one string. */
async function commandLines(): Promise<string> {
  if (process.platform === "linux") {
    return readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .map((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  const command =
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"]
      : ["ps", "-axww", "-o", "command="];
  return new Response(Bun.spawn(command, { stdout: "pipe" }).stdout).text();
}

describe("vault", () => {
  const vault = makeVault(Buffer.alloc(32, 7), "file");
  test("values round-trip and are bound to their secret", async () => {
    const blob = await Effect.runPromise(vault.encrypt("sk-live-123", "secret:global:STRIPE_KEY"));
    expect(blob).not.toContain("sk-live");
    expect(await Effect.runPromise(vault.decrypt(blob, "secret:global:STRIPE_KEY"))).toBe("sk-live-123");
    // Moved to another secret, it doesn't decrypt.
    await expect(Effect.runPromise(vault.decrypt(blob, "secret:global:OTHER"))).rejects.toBeDefined();
    // Two encryptions of the same value differ (random IV).
    expect(await Effect.runPromise(vault.encrypt("sk-live-123", "secret:global:STRIPE_KEY"))).not.toBe(blob);
  });

  test("a locked vault refuses", async () => {
    await expect(Effect.runPromise(makeVault(null, "locked").encrypt("x", "c"))).rejects.toBeDefined();
  });
});

describe("agent processes", () => {
  test("don't get Rune Browser's own variables (the API token)", () => {
    process.env.RUNE_TOKEN = "renderer-token";
    try {
      expect(Object.keys(agentEnv()).filter((k) => k.startsWith("RUNE_"))).toEqual([]);
      expect(Object.keys(claudeEnv()).filter((k) => k.startsWith("RUNE_"))).toEqual([]);
      expect(agentEnv({ EXTRA: "1" }).EXTRA).toBe("1");
    } finally {
      delete process.env.RUNE_TOKEN;
    }
  });
});

const VALUE = "sk_test_9f8e7d6c5b4a";
const GLOBAL_VALUE = "glob_7a6b5c4d3e2f";

describe("secrets, permissions and the audit log", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let app: AppSummary;
  let dir: string;

  const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value !== undefined && value !== false) return value as T;
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(100);
    }
  };
  /** What the app's dev process saw in a step (each step's processes write their own files, so stale ones can't interfere). */
  const seen = (step: string, name: string) => {
    const file = join(dir, `seen-${step}-${name}.txt`);
    return existsSync(file) ? readFileSync(file, "utf8") || undefined : undefined;
  };
  /** From now on, the app's dev "server" reports which secrets it got (for `step`), prints one, and stays up. */
  const report = (step: string) =>
    devScript(
      dir,
      `for (const n of ["MY_KEY", "SHARED_KEY"]) await Bun.write(\`seen-${step}-\${n}.txt\`, process.env[n] || "unset");\nconsole.log("the key is " + process.env.MY_KEY);`,
    );

  beforeAll(async () => {
    server = await startServer();
    app = await server.api<AppSummary>("/api/apps", { method: "POST" });
    await server.api(`/api/apps/${app.id}/project`, { method: "POST", json: { preset: "api" } });
    dir = join(server.dataDir, "apps", app.id);
    report("start");
  });
  afterAll(() => server.stop());

  test("a secret is stored encrypted and never returned", async () => {
    const saved = await server.api<SecretInfo>("/api/secrets", {
      method: "PUT",
      json: { scope: app.id, name: "MY_KEY", value: VALUE },
    });
    expect(saved).toMatchObject({ scope: app.id, name: "MY_KEY" });
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    const overview = await server.api<SecretsOverview>(`/api/secrets?scope=${app.id}`);
    expect(overview.protection).toBe("file");
    expect(overview.secrets.map((s) => s.name)).toEqual(["MY_KEY"]);
    expect(JSON.stringify(overview)).not.toContain(VALUE);
    // Not in plain text in the database (or its WAL).
    for (const file of readdirSync(server.dataDir).filter((f) => f.startsWith("rune.sqlite"))) {
      expect(readFileSync(join(server.dataDir, file)).includes(Buffer.from(VALUE))).toBe(false);
    }
  });

  test("bad names are refused", async () => {
    await expect(
      server.api("/api/secrets", { method: "PUT", json: { scope: app.id, name: "my key", value: "x" } }),
    ).rejects.toThrow("400");
    await expect(
      server.api("/api/secrets", { method: "PUT", json: { scope: app.id, name: "PORT", value: "x" } }),
    ).rejects.toThrow("400");
    await expect(
      server.api("/api/secrets", { method: "PUT", json: { scope: "nope", name: "OK_NAME", value: "x" } }),
    ).rejects.toThrow("404");
  });

  test("the app's process gets it in its environment, masked in its logs, not in any process arguments", async () => {
    report("restart");
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
    expect(await waitFor(() => seen("restart", "MY_KEY"))).toBe(VALUE);
    const logs = await waitFor(async () => {
      const r = await server.api<{ logs: { text: string }[] }>(`/api/apps/${app.id}/runtime`);
      return r.logs.some((l) => l.text.startsWith("the key is")) ? r.logs : undefined;
    });
    expect(logs.find((l) => l.text.startsWith("the key is"))!.text).toBe("the key is ••••••");
    expect(JSON.stringify(logs)).not.toContain(VALUE);
    expect((await commandLines()).includes(VALUE)).toBe(false);
  });

  test("a global secret needs the user's permission per app", async () => {
    await server.api("/api/secrets", {
      method: "PUT",
      json: { scope: "global", name: "SHARED_KEY", value: GLOBAL_VALUE },
    });
    expect(seen("restart", "SHARED_KEY")).toBe("unset");
    // Allowing it restarts the app with it.
    report("allowed");
    await server.api("/api/permissions", {
      method: "PUT",
      json: { subject: app.id, action: "app.secret", resource: "SHARED_KEY", decision: "allow" },
    });
    expect(await waitFor(() => seen("allowed", "SHARED_KEY"))).toBe(GLOBAL_VALUE);
    // Revoking it takes it away again.
    const grant = (await server.api<PermissionGrant[]>("/api/permissions")).find((g) => g.resource === "SHARED_KEY")!;
    expect(grant).toMatchObject({ subject: app.id, subjectName: app.name, decision: "allow" });
    report("revoked");
    await server.api(`/api/permissions/${grant.id}`, { method: "DELETE" });
    expect(await waitFor(() => seen("revoked", "SHARED_KEY"))).toBe("unset");
  });

  test("an app asking for AI waits for the user; the answer can be remembered and revoked", async () => {
    const settings = await server.api<Settings>("/api/settings");
    await server.api("/api/settings", {
      method: "PUT",
      json: { ...settings, apps: { ...settings.apps, ai: { ...settings.apps.ai, enabled: true } } },
    });
    // The app's AI token (its dev process could read it; here we take it from the environment it saw).
    const env = join(dir, "token.txt");
    writesVariable(dir, "RUNE_AI_TOKEN", "token.txt");
    await server.api(`/api/apps/${app.id}/runtime`, { method: "POST", json: { action: "restart" } });
    const token = await waitFor(() => (existsSync(env) && readFileSync(env, "utf8")) || undefined);
    const ask = () =>
      fetch(`${server.url}/ai/v1/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });

    const first = ask();
    const request = await waitFor(async () => (await server.api<PermissionRequest[]>("/api/permissions/pending"))[0]);
    expect(request).toMatchObject({ subject: app.id, action: "app.ai", subjectName: app.name });
    await server.api(`/api/permissions/pending/${request.id}`, {
      method: "POST",
      json: { allow: false, remember: true },
    });
    expect((await first).status).toBe(403);
    // Remembered: no new question.
    expect((await ask()).status).toBe(403);
    expect(await server.api<PermissionRequest[]>("/api/permissions/pending")).toEqual([]);

    const grant = (await server.api<PermissionGrant[]>("/api/permissions")).find((g) => g.action === "app.ai")!;
    expect(grant.decision).toBe("deny");
    await server.api(`/api/permissions/${grant.id}`, { method: "DELETE" });
    const again = ask();
    const next = await waitFor(async () => (await server.api<PermissionRequest[]>("/api/permissions/pending"))[0]);
    await server.api(`/api/permissions/pending/${next.id}`, {
      method: "POST",
      json: { allow: false, remember: false },
    });
    expect((await again).status).toBe(403);
  });

  test("everything is in the audit log, without secret values", async () => {
    const entries = await server.api<AuditEntry[]>(`/api/audit?tab=${app.id}`);
    const actions = entries.map((e) => e.action);
    for (const action of [
      "secret.create",
      "secret.inject",
      "permission.allow",
      "permission.revoke",
      "permission.deny",
      "ai.request",
      "runtime.restart",
    ]) {
      expect(actions).toContain(action);
    }
    expect(entries.find((e) => e.action === "secret.inject")!.target).toContain("MY_KEY");
    const all = JSON.stringify(await server.api<AuditEntry[]>("/api/audit?limit=1000"));
    expect(all).not.toContain(VALUE);
    expect(all).not.toContain(GLOBAL_VALUE);
  });

  test("deleting a secret and the app removes them", async () => {
    const [secret] = (await server.api<SecretsOverview>(`/api/secrets?scope=${app.id}`)).secrets;
    await server.api(`/api/secrets/${secret!.id}`, { method: "DELETE" });
    expect((await server.api<SecretsOverview>(`/api/secrets?scope=${app.id}`)).secrets).toEqual([]);
    await server.api("/api/secrets", { method: "PUT", json: { scope: app.id, name: "LEFTOVER", value: "abcd" } });
    await server.api(`/api/apps/${app.id}`, { method: "DELETE" });
    expect((await server.api<SecretsOverview>(`/api/secrets?scope=${app.id}`)).secrets).toEqual([]);
    expect((await server.api<PermissionGrant[]>("/api/permissions")).filter((g) => g.subject === app.id)).toEqual([]);
  });
});
