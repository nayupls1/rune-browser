// Agent processes' environment, and permissions with the audit log: asking,
// remembering, revoking. No model is called.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, ManagedRuntime } from "effect";
import { DEFAULT_WORKSPACE } from "../src/shared/api";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { claudeEnv } from "../src/server/providers/Claude";
import { agentEnv } from "../src/server/providers/process";
import { Audit } from "../src/server/security/Audit";
import { Permissions } from "../src/server/security/Permissions";
import { core } from "../src/server/services";
import { Tabs } from "../src/server/Tabs";

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

  test("Claude Code never gets an API key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      expect(claudeEnv().ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("permissions and the audit log", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-permissions-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a request waits for the user; the answer can be remembered, revoked, and goes with its tab", async () => {
    const out = await runtime.runPromise(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const permissions = yield* Permissions;
        const tab = yield* apps.create(DEFAULT_WORKSPACE, "https://example.com/");
        const ask = () =>
          permissions.ask({
            subject: tab.id,
            action: "agent.tab",
            resource: "other",
            title: "Read the other tab?",
            detail: "…",
            timeoutMs: 10_000,
          });
        const waitForRequest = Effect.gen(function* () {
          for (;;) {
            const [request] = yield* permissions.pending;
            if (request) return request;
            yield* Effect.sleep("10 millis");
          }
        });

        const first = yield* Effect.forkChild(ask());
        const request = yield* waitForRequest;
        yield* permissions.answer(request.id, false, "subject");
        const denied = yield* Fiber.join(first);
        // Remembered: no new question.
        const again = yield* ask();
        const pendingAfter = (yield* permissions.pending).length;
        const grant = (yield* permissions.list).find((g) => g.subject === tab.id)!;
        yield* permissions.revoke(grant.id);

        const second = yield* Effect.forkChild(ask());
        const next = yield* waitForRequest;
        yield* permissions.answer(next.id, true, "workspace");
        const allowed = yield* Fiber.join(second);
        const forWorkspace = (yield* permissions.list).find((g) => g.subject === `workspace:${DEFAULT_WORKSPACE}`);

        const audit = (yield* (yield* Audit).list({ tabId: tab.id })).map((e) => e.action);
        yield* (yield* Tabs).remove(tab.id);
        const left = (yield* permissions.list).filter((g) => g.subject === tab.id);
        return { request, denied, again, pendingAfter, grant, allowed, forWorkspace, audit, left };
      }),
    );
    expect(out.request).toMatchObject({ action: "agent.tab", subjectName: expect.any(String) });
    expect(out.request.workspace?.id).toBe(DEFAULT_WORKSPACE);
    expect(out.denied).toBe(false);
    expect(out.again).toBe(false);
    expect(out.pendingAfter).toBe(0);
    expect(out.grant).toMatchObject({ action: "agent.tab", resource: "other", decision: "deny" });
    expect(out.allowed).toBe(true);
    expect(out.forWorkspace).toMatchObject({ decision: "allow", subjectName: "Tabs in Personal" });
    expect(out.audit).toEqual(expect.arrayContaining(["permission.deny", "permission.allow"]));
    expect(out.left).toEqual([]);
  });
});
