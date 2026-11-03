// Code attached to a tab for its agent (workspace/Sources.ts): folders are
// used in place, paths can't leave them, credential files are never read or
// written, and changes come as diffs for the user.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { core } from "../src/server/services";
import { isSecretPath, Sources, unifiedDiff } from "../src/server/workspace/Sources";
import { sourceTools } from "../src/server/agent/sourceTools";
import type { Tool } from "../src/server/agent/Mcp";
import { Permissions } from "../src/server/security/Permissions";
import { DEFAULT_WORKSPACE } from "../src/shared/api";

const dataDir = mkdtempSync(join(tmpdir(), "rune-sources-"));
const folder = mkdtempSync(join(tmpdir(), "rune-sources-src-"));
const outside = mkdtempSync(join(tmpdir(), "rune-sources-outside-"));
const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
const run = <A, E>(effect: Effect.Effect<A, E, Sources | Apps>) => runtime.runPromise(effect);

afterAll(async () => {
  await runtime.dispose();
  for (const dir of [dataDir, folder, outside]) rmSync(dir, { recursive: true, force: true });
});

mkdirSync(join(folder, "src"), { recursive: true });
mkdirSync(join(folder, "node_modules", "dep"), { recursive: true });
writeFileSync(
  join(folder, "src", "cart.ts"),
  "export function addToCart(item) {\n  layoutThrash();\n  return item;\n}\n",
);
writeFileSync(join(folder, "src", "style.css"), ".banner { height: auto; }\n");
writeFileSync(join(folder, "node_modules", "dep", "index.js"), "addToCart();\n");
writeFileSync(join(folder, ".env"), "API_KEY=sk-live-123\n");
writeFileSync(join(folder, ".env.example"), "API_KEY=\n");
writeFileSync(join(outside, "secret.txt"), "outside");
symlinkSync(outside, join(folder, "escape"));

describe("sources", () => {
  test("a folder is attached once, used in place, and listed without dependencies or credentials", async () => {
    const tab = await run(Effect.flatMap(Apps, (apps) => apps.create(DEFAULT_WORKSPACE, "web", "https://shop.test")));
    const result = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        const source = yield* sources.addFolder(tab.id, folder);
        const again = yield* sources.addFolder(tab.id, folder);
        const files = yield* sources.listFiles(source, {});
        const css = yield* sources.listFiles(source, { pattern: "*.css" });
        const hits = yield* sources.search(source, { query: "addToCart" });
        const read = yield* sources.readText(source, "src/cart.ts");
        const refused = yield* Effect.all(
          [
            "../" + outside.split("/").pop() + "/secret.txt",
            "escape/secret.txt",
            ".env",
            ".git/config",
            "/etc/passwd",
          ].map((p) =>
            sources.readText(source, p).pipe(
              Effect.flip,
              Effect.map((e) => e.message),
            ),
          ),
        );
        return { source, again, files, css, hits, read, refused, list: yield* sources.list(tab.id) };
      }),
    );
    expect(result.again.id).toBe(result.source.id);
    expect(result.list).toHaveLength(1);
    expect(result.source).toMatchObject({ kind: "folder", path: folder, state: "ready" });
    expect(result.files).toEqual([".env.example", "src/cart.ts", "src/style.css"]);
    expect(result.css).toEqual(["src/style.css"]);
    expect(result.hits).toEqual(["src/cart.ts:1: export function addToCart(item) {"]);
    expect(result.read.text).toContain("layoutThrash");
    expect(result.refused[0]).toContain("isn't inside");
    expect(result.refused[1]).toContain("isn't inside");
    expect(result.refused[2]).toContain("credentials");
    expect(result.refused[3]).toContain("git's own data");
    expect(result.refused[4]).toMatch(/isn't inside|doesn't exist/);
  });

  test("Rune Browser's own data, a whole disk or home, and links that aren't repositories are refused", async () => {
    const tab = await run(Effect.flatMap(Apps, (apps) => apps.create(DEFAULT_WORKSPACE, "app", null)));
    const errors = await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        const fail = <A>(e: Effect.Effect<A, { message: string }>) =>
          e.pipe(
            Effect.flip,
            Effect.map((x) => x.message),
          );
        return [
          yield* fail(sources.addFolder(tab.id, dataDir)),
          yield* fail(sources.addFolder(tab.id, "/")),
          yield* fail(sources.addGit(tab.id, "file:///etc")),
        ];
      }),
    );
    expect(errors[0]).toContain("Rune Browser's own data");
    expect(errors[1]).toContain("too much");
    expect(errors[2]).toContain("isn't a link");
  });

  test("writes stay inside, and a change is shown as a diff", async () => {
    const tab = await run(Effect.flatMap(Apps, (apps) => apps.create(DEFAULT_WORKSPACE, "app", null)));
    await run(
      Effect.gen(function* () {
        const sources = yield* Sources;
        const source = yield* sources.addFolder(tab.id, folder);
        yield* sources.writeText(source, "src/new.ts", "export const x = 1;\n");
        const refused = yield* sources.writeText(source, ".env.local", "X=1").pipe(Effect.flip);
        expect(refused.message).toContain("credentials");
      }),
    );
    expect(readFileSync(join(folder, "src/new.ts"), "utf8")).toBe("export const x = 1;\n");
    const diff = unifiedDiff("src/cart.ts", "a\nb\nc\n", "a\nB\nc\n");
    expect(diff).toContain("--- a/src/cart.ts");
    expect(diff).toContain("-b\n+B");
    expect(unifiedDiff("new.ts", null, "x\n")).toContain("--- /dev/null");
  });

  test("the agent's tools read, search and change the code; a change needs the user's OK", async () => {
    const tab = await run(Effect.flatMap(Apps, (apps) => apps.create(DEFAULT_WORKSPACE, "app", null)));
    const logged: string[] = [];
    const env = {
      tabId: tab.id,
      label: "Test agent",
      log: (line: string) => Effect.sync(() => void logged.push(line)),
      message: () => Effect.void,
    };
    const call = (tools: Tool[], name: string, args: object) =>
      Effect.flatMap(Effect.succeed(tools.find((t) => t.name === name)!), (t) => t.run(args)).pipe(
        Effect.map((r) => ({ text: (r.content[0] as { text: string }).text, error: !!r.isError })),
      );
    const answers: boolean[] = [];
    const result = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sources = yield* Sources;
          const permissions = yield* Permissions;
          yield* sources.addFolder(tab.id, folder);
          const tools = yield* sourceTools(env);
          const listed = yield* call(tools, "list_sources", {});
          const found = yield* call(tools, "search_source", { query: "layoutThrash" });
          const read = yield* call(tools, "read_source_file", { path: "src/cart.ts", offset: 2, limit: 1 });
          // The user answers the permission: first no, then yes (with the diff shown).
          const answer = Effect.gen(function* () {
            for (;;) {
              const [request] = yield* permissions.pending;
              if (request) {
                expect(request.action).toBe("agent.source");
                expect(request.diff).toContain("+  requestAnimationFrame(layoutThrash);");
                const allow = answers.length > 0;
                answers.push(allow);
                yield* permissions.answer(request.id, allow, false);
                if (allow) return;
              }
              yield* Effect.sleep(20);
            }
          });
          const edit = {
            path: "src/cart.ts",
            old_string: "  layoutThrash();",
            new_string: "  requestAnimationFrame(layoutThrash);",
          };
          yield* Effect.forkChild(answer);
          const denied = yield* call(tools, "edit_source_file", edit);
          const allowed = yield* call(tools, "edit_source_file", edit);
          const secret = yield* call(tools, "read_source_file", { path: ".env" });
          return { listed, found, read, denied, allowed, secret };
        }),
      ) as Effect.Effect<any, never, never>,
    );
    expect(result.listed.text).toContain(`your folder ${folder}`);
    expect(result.found.text).toBe("src/cart.ts:2: layoutThrash();");
    expect(result.read.text).toContain("    2    layoutThrash();");
    expect(result.denied).toMatchObject({ error: true });
    expect(result.denied.text).toContain("didn't allow");
    expect(result.allowed.text).toBe("Changed src/cart.ts.");
    expect(result.secret).toMatchObject({ error: true });
    expect(readFileSync(join(folder, "src/cart.ts"), "utf8")).toContain("requestAnimationFrame(layoutThrash)");
    expect(logged).toEqual([`Changed src/cart.ts in ${basename(folder)}`]);
  });

  test("credential files", () => {
    for (const p of [
      ".env",
      ".env.local",
      "config/.env.production",
      "certs/server.pem",
      ".ssh/id_ed25519",
      ".npmrc",
      "credentials.json",
      ".git/HEAD",
    ])
      expect(isSecretPath(p)).toBe(true);
    for (const p of [".env.example", "src/env.ts", "README.md", "keys.ts", "public/key.svg"])
      expect(isSecretPath(p)).toBe(false);
  });
});
