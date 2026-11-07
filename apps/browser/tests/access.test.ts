// Full access (Settings → Agent): an agent's requests are allowed without
// asking, and logged; apps' requests still ask.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { decodeSettings } from "../src/shared/settings";
import { readConfig } from "../src/server/Config";
import { Settings } from "../src/server/db/Settings";
import { Audit } from "../src/server/security/Audit";
import { Permissions } from "../src/server/security/Permissions";
import { core } from "../src/server/services";

const dataDir = mkdtempSync(join(tmpdir(), "rune-access-"));
const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
afterAll(async () => {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const ask = (agentTab?: string) =>
  Effect.gen(function* () {
    return yield* (yield* Permissions).ask({
      ...(agentTab ? { agentTab } : {}),
      subject: "website-agent",
      action: "agent.browse",
      resource: "shop.example",
      title: "Let the website agent use shop.example for you?",
      detail: "",
      timeoutMs: 200,
    });
  });

test("asks by default; with full access an agent's request is allowed and logged, an app's still asks", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const settings = yield* Settings;
      const asking = yield* ask("tab-1");
      yield* settings.save(decodeSettings({ agent: { permissions: "full" } }));
      const agent = yield* ask("tab-1");
      const app = yield* ask();
      const entries = yield* (yield* Audit).list({ limit: 20 });
      return {
        asking,
        agent,
        app,
        auto: entries.filter((e) => e.action === "permission.auto").map((e) => [e.tabId, e.target]),
      };
    }),
  );
  // Nobody answers in these tests: asking means a no after the timeout.
  expect(result).toEqual({ asking: false, agent: true, app: false, auto: [["tab-1", "agent.browse shop.example"]] });
});
