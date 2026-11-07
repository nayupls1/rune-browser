// Snapshots for agents (agent/historyTools.ts): the website agent lists and
// views the site customizations' snapshots and restores one for the site it's
// on, leaving other sites alone. There's no tool to delete a snapshot.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { historyTools } from "../src/server/agent/historyTools";
import { readConfig } from "../src/server/Config";
import { PageChanges } from "../src/server/db/PageChanges";
import { Sites } from "../src/server/db/Sites";
import { History } from "../src/server/history/History";
import { Hub } from "../src/server/Hub";
import { core } from "../src/server/services";

const dataDir = mkdtempSync(join(tmpdir(), "rune-history-tools-"));
const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
afterAll(async () => {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("snapshot tools", () => {
  test("restoring a snapshot brings back this site's changes and leaves other sites alone", async () => {
    const out = await runtime.runPromise(
      Effect.gen(function* () {
        const changes = yield* PageChanges;
        const history = yield* History;
        const sites = yield* Sites;
        const hub = yield* Hub;
        const by = { actor: "user" as const, actorLabel: "You" };
        const banner = yield* changes.create(
          { title: "Hide the banner", scope: { type: "site", value: "a.test" }, action: "hide", selector: ".banner" },
          "agent",
        );
        const other = yield* changes.create(
          {
            title: "Bigger text",
            scope: { type: "site", value: "b.test" },
            action: "style",
            selector: "p",
            value: "font-size: 20px",
          },
          "agent",
        );
        yield* sites.save("a.test", { css: "body { color: red }", js: "", enabled: true });
        const first = (yield* history.record("sites", { ...by, summary: "Before" }))!;
        // Then things change on both sites.
        yield* changes.remove(banner.id);
        yield* changes.create(
          { title: "Hide the footer", scope: { type: "page", value: "a.test/x" }, action: "hide", selector: "footer" },
          "agent",
        );
        yield* changes.update(other.id, { spec: { ...other, value: "font-size: 30px" } });
        yield* sites.remove("a.test");
        yield* history.record("sites", { ...by, summary: "After" });

        // The website agent on a.test, with a fake window.
        const fakeHub = {
          ...hub,
          rpc: (method: string) =>
            method === "page.info" ? Effect.succeed({ url: "https://a.test/x" }) : Effect.succeed({}),
        } as typeof hub;
        const logged: string[] = [];
        const env = {
          tabId: "tab",
          label: "Website agent",
          log: (l: string) => Effect.sync(() => void logged.push(l)),
          message: () => Effect.void,
        };
        const tools = yield* historyTools(env, { site: true }).pipe(Effect.provideService(Hub, fakeHub));
        const call = (name: string, args: object) =>
          Effect.map(tools.find((t) => t.name === name)!.run(args), (r) => ({
            text: (r.content[0] as { text: string }).text,
            error: !!r.isError,
          }));
        const listed = yield* call("list_snapshots", {});
        const viewed = yield* call("view_snapshot", { id: first.id, path: "a.test/style.css" });
        const restored = yield* call("restore_snapshot", { id: first.id });
        const after = yield* changes.list();
        return {
          names: tools.map((t) => t.name),
          listed,
          viewed,
          restored,
          after,
          site: yield* sites.get("a.test"),
          logged,
          otherId: other.id,
        };
      }),
    );
    expect(out.names).toEqual(["list_snapshots", "view_snapshot", "restore_snapshot"]);
    expect(out.listed.text).toContain("Before");
    expect(out.viewed.text).toBe("body { color: red }");
    expect(out.restored.error).toBe(false);
    expect(out.after.filter((c) => c.scope.value.startsWith("a.test")).map((c) => c.title)).toEqual([
      "Hide the banner",
    ]);
    // b.test keeps its later change.
    expect(out.after.find((c) => c.id === out.otherId)?.value).toBe("font-size: 30px");
    expect(out.site?.css).toBe("body { color: red }");
    expect(out.logged[0]).toContain("Restored a.test");
  });
});
