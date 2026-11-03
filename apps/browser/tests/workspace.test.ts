// Projects, the sandbox and the runtime: a preset is scaffolded, runs in dev
// mode, is built and started in live mode; sandboxed processes can't see the
// rest of the machine.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { readConfig } from "../src/server/Config";
import { core } from "../src/server/services";
import * as Apps from "../src/server/db/Apps";
import * as SettingsDb from "../src/server/db/Settings";
import * as Runtime from "../src/server/workspace/Runtime";
import * as Sandbox from "../src/server/workspace/Sandbox";
import * as Workspace from "../src/server/workspace/Workspace";
import { presets } from "../src/server/workspace/presets";
import { DEFAULT_WORKSPACE } from "../src/shared/api";

const dataDir = mkdtempSync(join(tmpdir(), "rune-workspace-test-"));
const config = readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" });

const layer = core(config);
const runtime = ManagedRuntime.make(layer);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Runtime.Runtime | Workspace.Workspace | Sandbox.Sandbox | Apps.Apps | SettingsDb.Settings
  >,
) => runtime.runPromise(effect);

afterAll(async () => {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const createApp = () => run(Effect.flatMap(Apps.Apps, (apps) => apps.create(DEFAULT_WORKSPACE, "app", null)));

describe("presets", () => {
  test("every preset has a manifest and a server", () => {
    for (const preset of presets) {
      expect(preset.manifest.dev).toBeTruthy();
      expect(preset.manifest.start).toBeTruthy();
      expect(Object.keys(preset.files)).toContain("src/server.ts");
    }
  });

  test("scaffolding writes the files, rune.json and the design tokens", async () => {
    const app = await createApp();
    const project = await run(Effect.flatMap(Workspace.Workspace, (w) => w.scaffold(app.id, "react", "Plant <Diary>")));
    expect(existsSync(join(project.dir, "src/App.tsx"))).toBe(true);
    expect(JSON.parse(readFileSync(join(project.dir, "rune.json"), "utf8")).dev).toBe("bun run dev");
    expect(readFileSync(join(project.dir, "src/tokens.css"), "utf8")).toContain("--color-accent");
    expect(readFileSync(join(project.dir, "src/index.html"), "utf8")).toContain("Plant &lt;Diary&gt;");
    expect(JSON.parse(readFileSync(join(project.dir, "package.json"), "utf8")).name).toBe("plant-diary");
    // A second scaffold would clobber the agent's work.
    await expect(run(Effect.flatMap(Workspace.Workspace, (w) => w.scaffold(app.id, "vanilla", "x")))).rejects.toThrow(
      "already set up",
    );
  });
});

const hasBwrap = await run(Effect.flatMap(Sandbox.Sandbox, (s) => s.kind)).then((k) => k === "bwrap");

describe.if(hasBwrap)("sandbox", () => {
  test("app processes only see their own project", async () => {
    const app = await createApp();
    const dir = await run(Effect.flatMap(Workspace.Workspace, (w) => w.ensureDir(app.id)));
    process.env.RUNE_TEST_SECRET = "hunter2";
    const exec = (command: string) => run(Effect.flatMap(Runtime.Runtime, (r) => r.exec(app.id, command, 20_000)));

    expect((await exec("echo hi > note.txt && cat note.txt")).output.trim()).toBe("hi");
    expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("hi\n");

    // Only the bun binary is bound from outside; the user's files aren't there.
    const outside = await exec(
      `cat ${JSON.stringify(join(process.cwd(), "package.json"))} 2>&1; ls -A ${JSON.stringify(homedir())}`,
    );
    expect(outside.output).toContain("No such file");
    expect(outside.output).not.toContain("devDependencies");
    const otherApp = await exec(`ls ${JSON.stringify(config.appsDir)} 2>&1`);
    expect(otherApp.output.trim().split("\n")).toEqual([app.id]);
    expect((await exec("touch /usr/x 2>&1; echo code=$?")).output).toContain("code=1");
    expect((await exec("echo ${RUNE_TEST_SECRET:-unset}")).output.trim()).toBe("unset");
    expect((await exec("cat /proc/1/cmdline | tr '\\0' ' '")).output).toContain("bwrap");
    expect((await exec("bun -e 'console.log(6 * 7)'")).output.trim()).toBe("42");
  });

  test("developer tools work: git with an identity, the system's tools, toolchains read-only", async () => {
    const app = await createApp();
    await run(Effect.flatMap(Workspace.Workspace, (w) => w.ensureDir(app.id)));
    const exec = (command: string) => run(Effect.flatMap(Runtime.Runtime, (r) => r.exec(app.id, command, 20_000)));
    const git = await exec(
      "git init -q && echo x > a && git add a && git commit -qm first && git log --format='%an %s'",
    );
    expect(git.output).toBe("Rune Browser first");
    expect(git.code).toBe(0);
    // Credentials and personal files in your home stay hidden.
    const home = homedir();
    expect(
      (
        await exec(
          `ls ${JSON.stringify(join(home, ".ssh"))} ${JSON.stringify(join(home, ".gitconfig"))} 2>&1 | grep -c 'No such file'`,
        )
      ).output,
    ).toBe("2");
    const info = await run(Effect.flatMap(Sandbox.Sandbox, (s) => s.info));
    for (const dir of info.readOnly) {
      expect(dir.startsWith(home)).toBe(true);
      expect(
        (
          await exec(
            `test -d ${JSON.stringify(dir)} && echo yes; touch ${JSON.stringify(join(dir, "x"))} 2>&1 | grep -c 'Read-only'`,
          )
        ).output,
      ).toBe("yes\n1");
    }
  });

  test("commands run in the chosen shell", async () => {
    const app = await createApp();
    await run(Effect.flatMap(Workspace.Workspace, (w) => w.ensureDir(app.id)));
    const exec = (command: string) => run(Effect.flatMap(Runtime.Runtime, (r) => r.exec(app.id, command, 20_000)));
    const useShell = (shell: string) =>
      run(
        Effect.flatMap(SettingsDb.Settings, (s) =>
          Effect.flatMap(s.get(), (current) => s.save({ ...current, apps: { ...current.apps, shell } })),
        ),
      );
    try {
      await useShell("bun");
      // Bun's shell: cross-platform builtins and $VARIABLES, no /bin/sh needed.
      expect((await exec("echo $RUNE_MODE && ls rune.json 2>&1 || echo missing")).output).toContain("dev");
      if (Bun.which("bash")) {
        await useShell("bash");
        expect((await exec("echo $BASH_VERSION")).output).toMatch(/^\d+\./);
      }
      await useShell("/definitely/not/a/shell");
      expect((await exec("echo fallback")).output).toBe("fallback");
    } finally {
      await useShell("auto");
    }
  });
});

describe("runtime", () => {
  test("dev mode serves the app; live mode builds and starts it", async () => {
    const app = await createApp();
    await run(Effect.flatMap(Workspace.Workspace, (w) => w.scaffold(app.id, "vanilla", "Runtime test")));
    const status = await run(
      Effect.gen(function* () {
        const r = yield* Runtime.Runtime;
        yield* r.ensure(app.id);
        return yield* r.settled(app.id, 90_000);
      }),
    );
    if (status.state !== "running") console.log(await run(Effect.map(Runtime.Runtime, (r) => r.logs(app.id))));
    expect(status).toMatchObject({ mode: "dev", state: "running" });
    const dev = await fetch(status.url!).then((r) => r.text());
    expect(dev).toContain("Runtime test");

    const live = await run(
      Effect.gen(function* () {
        const r = yield* Runtime.Runtime;
        yield* r.setMode(app.id, "live");
        return yield* r.settled(app.id, 90_000);
      }),
    );
    expect(live).toMatchObject({ mode: "live", state: "running", port: status.port });
    expect(await fetch(live.url!).then((r) => r.text())).toContain("Runtime test");
    expect(existsSync(join(config.appsDir, app.id, "dist/server.js"))).toBe(true);

    await run(Effect.flatMap(Runtime.Runtime, (r) => r.stop(app.id)));
    const stopped = await run(Effect.flatMap(Runtime.Runtime, (r) => r.status(app.id)));
    expect(stopped.state).toBe("stopped");
    expect(
      await fetch(live.url!).then(
        () => "up",
        () => "down",
      ),
    ).toBe("down");
  }, 180_000);
});
