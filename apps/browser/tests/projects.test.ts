// The app lifecycle (workspace/Projects.ts): an app set up by the user or the
// agent, or copied from another, goes through the same steps; moving and
// deleting a tab take care of everything that belongs to it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { appTarget, DEFAULT_WORKSPACE } from "../src/shared/api";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { Workspaces } from "../src/server/db/Workspaces";
import { History } from "../src/server/history/History";
import { Secrets } from "../src/server/security/Secrets";
import { core } from "../src/server/services";
import { AppData } from "../src/server/workspace/AppData";
import { Projects } from "../src/server/workspace/Projects";
import { Runtime } from "../src/server/workspace/Runtime";
import { inferManifest, parseGitProgress, parseGitSource, Workspace } from "../src/server/workspace/Workspace";

describe("repository links", () => {
  test("links, shorthands and branch pages become a clone URL, a branch and a name", () => {
    expect(parseGitSource("https://github.com/owner/repo")).toEqual({
      url: "https://github.com/owner/repo",
      branch: null,
      name: "repo",
    });
    expect(parseGitSource("https://github.com/owner/repo.git/")).toEqual({
      url: "https://github.com/owner/repo.git",
      branch: null,
      name: "repo",
    });
    expect(parseGitSource("owner/repo")).toEqual({ url: "https://github.com/owner/repo", branch: null, name: "repo" });
    expect(parseGitSource("github.com/owner/repo")).toEqual({
      url: "https://github.com/owner/repo",
      branch: null,
      name: "repo",
    });
    expect(parseGitSource("https://github.com/owner/repo/tree/next?tab=readme#x")).toEqual({
      url: "https://github.com/owner/repo",
      branch: "next",
      name: "repo",
    });
    expect(parseGitSource("https://gitlab.com/group/proj/-/tree/dev")).toEqual({
      url: "https://gitlab.com/group/proj",
      branch: "dev",
      name: "proj",
    });
    expect(parseGitSource("https://github.com/owner/repo", "release/1.x")?.branch).toBe("release/1.x");
    expect(parseGitSource("git@github.com:owner/repo.git")).toEqual({
      url: "git@github.com:owner/repo.git",
      branch: null,
      name: "repo",
    });
    expect(parseGitSource("ssh://git@host.example:2222/team/app.git")?.name).toBe("app");
    for (const bad of [
      "file:///etc",
      "/home/me/project",
      "http://example.com/x/y",
      "not a link",
      "../x",
      "https://github.com/owner/repo",
      "",
    ]) {
      if (bad === "https://github.com/owner/repo") expect(parseGitSource(bad, "bad branch; rm")).toBeNull();
      else expect(parseGitSource(bad)).toBeNull();
    }
  });

  test("git's progress lines", () => {
    expect(parseGitProgress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s")).toEqual({
      phase: "Receiving objects (1.20 MiB · 2.00 MiB/s)",
      percent: 45,
    });
    expect(parseGitProgress("Resolving deltas: 100% (20/20), done.")).toEqual({
      phase: "Resolving deltas",
      percent: 100,
    });
    expect(parseGitProgress("remote: Counting objects:  12% (3/25)")).toEqual({
      phase: "Counting objects",
      percent: 12,
    });
    expect(parseGitProgress("Cloning into '/tmp/x'...")).toBeNull();
  });
});

describe("projects", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-projects-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(effect as Effect.Effect<A>);

  /** A new app tab with a project from a preset, set up by `actor`; stopped right after. */
  const createApp = (actor: "user" | "agent") =>
    Effect.gen(function* () {
      const apps = yield* Apps;
      const projects = yield* Projects;
      const app = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
      yield* projects.create(app.id, "api", {
        name: `By ${actor}`,
        by: { actor, actorLabel: actor === "user" ? "You" : "App builder" },
      });
      yield* (yield* Runtime).stop(app.id);
      return (yield* apps.get(app.id))!;
    });

  test("the user's template and the agent's create_project are the same steps", async () => {
    const result = await run(
      Effect.gen(function* () {
        const history = yield* History;
        const workspace = yield* Workspace;
        const out = [];
        for (const actor of ["user", "agent"] as const) {
          const app = yield* createApp(actor);
          const [first] = yield* history.list({ target: appTarget(app.id) });
          out.push({
            name: app.name,
            mode: app.mode,
            manifest: !!(yield* workspace.info(app.id)),
            first: first && { actor: first.actor, summary: first.summary },
          });
        }
        return out;
      }),
    );
    expect(result).toEqual([
      {
        name: "By user",
        mode: "dev",
        manifest: true,
        first: { actor: "user", summary: "Started from the api template" },
      },
      {
        name: "By agent",
        mode: "dev",
        manifest: true,
        first: { actor: "agent", summary: "Started from the api template" },
      },
    ]);
  });

  test("a copy gets the project as its first snapshot, without dependencies, data or secrets", async () => {
    const result = await run(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const appData = yield* AppData;
        const secrets = yield* Secrets;
        const history = yield* History;
        const app = yield* createApp("user");
        mkdirSync(join(workspace.dir(app.id), "node_modules", "dep"), { recursive: true });
        const data = yield* appData.ensure(app.id);
        writeFileSync(join(data.files, "upload.txt"), "mine");
        yield* secrets.set(app.id, "API_KEY", "secret-value-1");
        const copy = (yield* (yield* Projects).copy(app.id))!;
        const [first] = yield* history.list({ target: appTarget(copy.id) });
        return {
          name: copy.name,
          server: existsSync(join(workspace.dir(copy.id), "src", "server.ts")),
          deps: existsSync(join(workspace.dir(copy.id), "node_modules")),
          files: existsSync(join(appData.dir(copy.id), "files", "upload.txt")),
          secrets: (yield* secrets.available(copy.id)).own,
          first: first?.summary,
        };
      }),
    );
    expect(result).toEqual({
      name: "By user copy",
      server: true,
      deps: false,
      files: false,
      secrets: [],
      first: "Copied from By user",
    });
  });

  test("moving a tab takes it out of its split; deleting it removes everything it had", async () => {
    const result = await run(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const projects = yield* Projects;
        const workspace = yield* Workspace;
        const appData = yield* AppData;
        const history = yield* History;
        const a = yield* createApp("user");
        const b = yield* apps.create(DEFAULT_WORKSPACE, "web", "https://example.com/");
        yield* workspaces.setSplits(DEFAULT_WORKSPACE, [
          { id: "s", direction: "row", tabs: [a.id, b.id], sizes: [0.5, 0.5] },
        ]);
        const other = yield* workspaces.create("Other", null);
        const moved = yield* projects.move(b.id, other.id);
        const splits = (yield* workspaces.get(DEFAULT_WORKSPACE))!.splits;
        yield* appData.ensure(a.id);
        yield* projects.remove(a.id);
        return {
          moved: moved?.workspaceId === other.id,
          splits,
          tab: yield* apps.get(a.id),
          project: existsSync(workspace.dir(a.id)),
          data: existsSync(appData.dir(a.id)),
          history: (yield* history.list({ target: appTarget(a.id) })).length,
        };
      }),
    );
    expect(result).toEqual({ moved: true, splits: [], tab: null, project: false, data: false, history: 0 });
  });
});

describe("importing an existing project", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-import-"));
  const source = mkdtempSync(join(tmpdir(), "rune-import-src-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });
  const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(effect as Effect.Effect<A>);

  test("rune.json from package.json's scripts", () => {
    const port = " --port $PORT --strictPort --host 127.0.0.1";
    expect(inferManifest({ scripts: { dev: "vite", build: "vite build", start: "node server.js" } })).toEqual({
      dev: `bun run dev${port}`,
      build: "bun run build",
      start: "bun run start",
    });
    // Vite sites: the dev server gets Rune Browser's port; the build is served with vite preview.
    expect(inferManifest({ scripts: { dev: "vite", build: "tsc && vite build" } })).toEqual({
      dev: `bun run dev${port}`,
      build: "bun run build",
      start: `bunx vite preview${port}`,
    });
    expect(
      inferManifest({ scripts: { dev: "vite dev", build: "vite build", preview: "vite preview", start: "vite" } }),
    ).toEqual({
      dev: `bun run dev${port}`,
      build: "bun run build",
      start: `bun run preview${port}`,
    });
    // Next.js and the like read $PORT themselves.
    expect(inferManifest({ scripts: { dev: "next dev", build: "next build", start: "next start" } })).toEqual({
      dev: "bun run dev",
      build: "bun run build",
      start: "bun run start",
    });
    expect(inferManifest({ scripts: { start: "node server.js" } })).toEqual({
      dev: "bun run start",
      start: "bun run start",
    });
    expect(inferManifest({ scripts: { test: "jest" } })).toBeNull();
    expect(inferManifest(null)).toBeNull();
  });

  test("a folder becomes the app's project, named after it, like any other app", async () => {
    const folder = join(source, "budget-tool");
    mkdirSync(join(folder, "node_modules", "dep"), { recursive: true });
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ name: "budget-tool", scripts: { dev: "bun --hot server.ts", start: "bun server.ts" } }),
    );
    writeFileSync(
      join(folder, "server.ts"),
      "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('hi') });",
    );
    const plain = join(source, "notes");
    mkdirSync(plain);
    writeFileSync(join(plain, "README.md"), "Just notes");
    const result = await run(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const projects = yield* Projects;
        const workspace = yield* Workspace;
        const history = yield* History;
        const a = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
        const project = yield* projects.importApp(a.id, { kind: "folder", path: folder });
        yield* (yield* Runtime).stop(a.id);
        const again = yield* projects.importApp(a.id, { kind: "folder", path: plain }).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );
        const b = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
        const none = yield* projects.importApp(b.id, { kind: "folder", path: plain });
        const c = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
        const notFolder = yield* projects.importApp(c.id, { kind: "folder", path: join(source, "missing") }).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );
        const own = yield* projects.importApp(c.id, { kind: "folder", path: dataDir }).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );
        const git = yield* projects.importApp(c.id, { kind: "git", url: "file:///etc" }).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );
        return {
          manifest: project?.manifest,
          name: (yield* apps.get(a.id))!.name,
          // The folder's dependencies aren't copied (the app's own install may already have made node_modules).
          deps: existsSync(join(workspace.dir(a.id), "node_modules", "dep")),
          first: (yield* history.list({ target: appTarget(a.id) })).at(-1)?.summary,
          note: (yield* apps.messages(a.id))[0]?.content,
          again,
          none,
          noneNote: (yield* apps.messages(b.id))[0]?.content,
          notFolder,
          own,
          git,
        };
      }),
    );
    expect(result.manifest).toEqual({ dev: "bun run dev", start: "bun run start" });
    expect(result.name).toBe("budget-tool");
    expect(result.deps).toBe(false);
    expect(result.first).toBe(`Imported from ${folder}`);
    expect(result.note).toContain("bun run dev");
    expect(result.again).toBe("The app already has a project.");
    expect(result.none).toBeNull();
    expect(result.noneNote).toContain("ask the agent to set it up");
    expect(result.notFolder).toContain("isn't a folder");
    expect(result.own).toBe("That folder is Rune Browser's own data.");
    expect(result.git).toContain("https link");
  });
});
