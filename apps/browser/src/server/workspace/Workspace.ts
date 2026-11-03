// App projects: one folder per app (the app's disk), with rune.json saying how
// to install, develop, build and start it. Rune Browser keeps its runtime state in
// .rune/ inside the folder (a home directory); the app's data is elsewhere
// (AppData.ts).
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { AppAction, Manifest, ProjectInfo, ToolParam } from "../../shared/api";
import { tokensCss } from "../../shared/theme";
import { ServerConfig } from "../Config";
import { Settings } from "../db/Settings";
import { cancelGit, clone, cloneError, parseGitSource, type GitProgress } from "./git";

export { parseGitProgress, parseGitSource } from "./git";
import { findPreset, presets, render } from "./presets";
import { removeDir } from "./removeDir";

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ readonly message: string }> {}

const ManifestSchema = Schema.Struct({
  preset: Schema.optionalKey(Schema.String),
  install: Schema.optionalKey(Schema.String),
  dev: Schema.String,
  build: Schema.optionalKey(Schema.String),
  start: Schema.String,
});

export const MANIFEST = "rune.json";

export interface WorkspaceShape {
  readonly dir: (appId: string) => string;
  /** Rune Browser's runtime folder inside the project (database, home). */
  readonly stateDir: (appId: string) => string;
  /** Creates the project folder if needed and returns it. */
  readonly ensureDir: (appId: string) => Effect.Effect<string>;
  /** The project's rune.json; null when there is none yet, an error when it's invalid. */
  readonly manifest: (appId: string) => Effect.Effect<Manifest | null, WorkspaceError>;
  readonly info: (appId: string) => Effect.Effect<ProjectInfo | null>;
  /** Sets up a new project from a preset. */
  readonly scaffold: (appId: string, presetId: string, name: string) => Effect.Effect<ProjectInfo, WorkspaceError>;
  /** Copies a project (without dependencies, builds and Rune Browser's runtime state). */
  readonly duplicate: (fromId: string, toId: string) => Effect.Effect<void>;
  /**
   * Brings in an existing project: cloned from a Git repository (https) or
   * copied from a folder. If it has no rune.json, one is written when
   * package.json says how to run it. Fails if the app already has a project.
   */
  readonly importFrom: (
    appId: string,
    source: ImportSource,
    onProgress?: (progress: GitProgress) => void,
  ) => Effect.Effect<{ project: ProjectInfo | null; name: string }, WorkspaceError>;
  readonly remove: (appId: string) => Effect.Effect<void>;
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("rune/Workspace") {}

/** Where an imported app comes from. */
export type ImportSource =
  | { readonly kind: "git"; readonly url: string; readonly branch?: string }
  | { readonly kind: "folder"; readonly path: string };

/** How cloning or copying is going (shown in the new app tab). */
export type ImportProgress = GitProgress;

/** Kills the clone of an app's import (Cancel in the new app tab). */
export const cancelImport = (appId: string) => cancelGit(appId);

/**
 * rune.json for a project that doesn't have one, from its package.json
 * scripts (dev, start, build); null when they don't say how to run it. Dev
 * servers that don't read $PORT themselves (Vite and what's built on it,
 * Astro, Angular) are told the port.
 */
export function inferManifest(packageJson: unknown): Manifest | null {
  const pkg = packageJson as {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } | null;
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const script = (name: string) => (typeof scripts[name] === "string" ? (scripts[name] as string) : null);
  if (script("dev") === null && script("start") === null) return null;
  /** Arguments that make the script's server listen on Rune Browser's port, by what it runs. */
  const portArgs = (command: string | null) => {
    if (!command) return "";
    if (/\b(vite|astro)\b/.test(command)) return " --port $PORT --strictPort --host 127.0.0.1";
    if (/\bng (serve|dev)\b/.test(command)) return " --port $PORT --host 127.0.0.1";
    return "";
  };
  const run = (name: string) => `bun run ${name}${portArgs(script(name))}`;
  const dev = script("dev") !== null ? run("dev") : run("start");
  /** `vite`, `vite dev`, `astro dev`: a dev server, not a way to serve the build. */
  const devServer = (command: string | null) =>
    !!command && /\b(vite|astro)\b/.test(command) && !/\b(preview|build)\b/.test(command);
  const start =
    script("start") !== null && !devServer(script("start"))
      ? run("start")
      : script("preview") !== null
        ? run("preview")
        : devServer(script("dev")) && /\bvite\b/.test(script("dev")!) && script("build") !== null
          ? `bunx vite preview${portArgs("vite")}`
          : dev;
  return { dev, ...(script("build") !== null ? { build: "bun run build" } : {}), start };
}

const decodeManifest = Schema.decodeUnknownSync(ManifestSchema);

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const route = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 500
    ? value
    : undefined;

/** The command bar actions in rune.json. Invalid ones are left out rather than failing the whole manifest. */
export function parseActions(value: unknown): AppAction[] {
  if (!Array.isArray(value)) return [];
  const actions = new Map<string, AppAction>();
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== "object") continue;
    const { id, title, description, path, endpoint, input, params } = item as Record<string, unknown>;
    if (typeof id !== "string" || !ACTION_ID.test(id) || typeof title !== "string" || !title.trim() || actions.has(id))
      continue;
    const opens = route(path);
    const calls = route(endpoint);
    // Exactly one of the two.
    if (!opens === !calls) continue;
    actions.set(id, {
      id,
      title: title.trim().slice(0, 80),
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim().slice(0, 200) }
        : {}),
      ...(opens ? { path: opens } : { endpoint: calls }),
      ...(typeof input === "string" && input.trim() ? { input: input.trim().slice(0, 80) } : {}),
      ...(calls && Object.keys(parseParams(params)).length ? { params: parseParams(params) } : {}),
    });
  }
  return [...actions.values()];
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PARAM_TYPES = new Set<ToolParam["type"]>(["string", "number", "integer", "boolean", "object"]);

/** An action's `params`: { name: { type, description?, required? } }, invalid ones left out. */
export function parseParams(value: unknown): Record<string, ToolParam> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ToolParam> = {};
  for (const [name, spec] of Object.entries(value).slice(0, 30)) {
    if (!PARAM_NAME.test(name) || !spec || typeof spec !== "object") continue;
    const { type, description, required } = spec as Record<string, unknown>;
    if (!PARAM_TYPES.has(type as ToolParam["type"])) continue;
    out[name] = {
      type: type as ToolParam["type"],
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim().slice(0, 200) }
        : {}),
      ...(required === true ? { required: true } : {}),
    };
  }
  return out;
}

const parseDataTools = (value: unknown): Manifest["dataTools"] =>
  value === "read" || value === "none" || value === "all" ? value : undefined;

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* Settings;
  const dir = (appId: string) => join(config.appsDir, appId);
  const stateDir = (appId: string) => join(dir(appId), ".rune");

  const manifest = (appId: string) =>
    Effect.gen(function* () {
      const text = yield* Effect.promise(() => readFile(join(dir(appId), MANIFEST), "utf8").catch(() => null));
      if (text === null) return null;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        return yield* new WorkspaceError({ message: `${MANIFEST} isn't valid JSON: ${(err as Error).message}` });
      }
      try {
        const actions = parseActions((json as { actions?: unknown } | null)?.actions);
        const dataTools = parseDataTools((json as { dataTools?: unknown } | null)?.dataTools);
        return {
          ...(decodeManifest(json) as Manifest),
          ...(actions.length ? { actions } : {}),
          ...(dataTools ? { dataTools } : {}),
        };
      } catch (err) {
        return yield* new WorkspaceError({ message: `${MANIFEST} is invalid: ${(err as Error).message}` });
      }
    });

  const ensureDir = (appId: string) =>
    Effect.promise(() => mkdir(dir(appId), { recursive: true }).then(() => dir(appId)));

  return {
    dir,
    stateDir,
    ensureDir,
    manifest,
    info: (appId) =>
      manifest(appId).pipe(
        Effect.map((m) => (m ? { dir: dir(appId), manifest: m } : null)),
        Effect.orElseSucceed(() => null),
      ),

    scaffold: (appId, presetId, name) =>
      Effect.gen(function* () {
        const preset = findPreset(presetId);
        if (!preset) {
          return yield* new WorkspaceError({
            message: `Unknown preset "${presetId}". Presets: ${presets.map((p) => p.id).join(", ")}`,
          });
        }
        const existing = yield* manifest(appId).pipe(Effect.orElseSucceed(() => ({}) as Manifest));
        if (existing)
          return yield* new WorkspaceError({
            message: `The project is already set up (it has a ${MANIFEST}). Change its files instead.`,
          });
        const root = yield* ensureDir(appId);
        const theme = (yield* settings.get()).theme;
        const files: Record<string, string> = {
          ...Object.fromEntries(
            Object.entries(preset.files).map(([path, content]) => [path, render(content, { name })]),
          ),
          [MANIFEST]: `${JSON.stringify(preset.manifest, null, 2)}\n`,
        };
        if (preset.files["src/styles.css"]) files["src/tokens.css"] = tokensCss(theme);
        yield* Effect.promise(async () => {
          for (const [path, content] of Object.entries(files)) {
            const target = join(root, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content);
          }
        });
        return { dir: root, manifest: preset.manifest };
      }),

    duplicate: (fromId, toId) =>
      Effect.promise(async () => {
        const skip = new Set(["node_modules", "dist", ".rune"].map((name) => join(dir(fromId), name)));
        await cp(dir(fromId), dir(toId), { recursive: true, filter: (src) => !skip.has(src) }).catch(() => {});
      }),

    importFrom: (appId, source, onProgress = () => {}) =>
      Effect.gen(function* () {
        const target = dir(appId);
        if (
          existsSync(join(target, MANIFEST)) ||
          (existsSync(target) && readdirSync(target).some((f) => f !== ".rune"))
        ) {
          return yield* new WorkspaceError({ message: "The app already has a project." });
        }
        let name: string;
        if (source.kind === "git") {
          const git = parseGitSource(source.url, source.branch);
          if (!git) {
            return yield* new WorkspaceError({
              message:
                "That isn't a link to a repository. Clone from an https link (like https://github.com/owner/repo), an SSH link or owner/repo.",
            });
          }
          if (!Bun.which("git"))
            return yield* new WorkspaceError({ message: "Git isn't installed (or not on Rune Browser's PATH)." });
          name = git.name;
          onProgress({ phase: `Cloning ${git.url}${git.branch ? ` (${git.branch})` : ""}`, percent: null });
          yield* Effect.promise(() => rm(target, { recursive: true, force: true }));
          yield* Effect.promise(() => mkdir(dirname(target), { recursive: true }));
          const result = yield* clone({
            url: git.url,
            branch: git.branch,
            target,
            noHooks: join(config.cacheDir, "no-git-hooks"),
            onProgress,
            cancelKey: appId,
          });
          if (result.code !== 0) {
            yield* Effect.promise(() => rm(target, { recursive: true, force: true }));
            if (result.cancelled) return yield* new WorkspaceError({ message: "Cloning was cancelled." });
            return yield* new WorkspaceError({
              message: `Cloning failed: ${cloneError(result.err) || `git exited with ${result.code}`}`,
            });
          }
        } else {
          const from = resolve(source.path);
          const info = yield* Effect.promise(() => stat(from).catch(() => null));
          if (!info?.isDirectory()) return yield* new WorkspaceError({ message: `${source.path} isn't a folder.` });
          if (
            from === config.dataDir ||
            from.startsWith(config.dataDir + sep) ||
            config.dataDir.startsWith(from + sep)
          ) {
            return yield* new WorkspaceError({ message: "That folder is Rune Browser's own data." });
          }
          name = basename(from);
          onProgress({ phase: `Copying ${from}`, percent: null });
          // Not its dependencies, builds or Rune Browser state: they're made again here.
          const skip = new Set(["node_modules", ".rune"]);
          yield* Effect.promise(() =>
            cp(from, target, { recursive: true, filter: (src) => !skip.has(basename(src)) || src === from }),
          );
        }
        if (!existsSync(join(target, MANIFEST))) {
          const pkg = yield* Effect.promise(() =>
            readFile(join(target, "package.json"), "utf8")
              .then(JSON.parse)
              .catch(() => null),
          );
          const inferred = inferManifest(pkg);
          if (inferred)
            yield* Effect.promise(() => writeFile(join(target, MANIFEST), `${JSON.stringify(inferred, null, 2)}\n`));
        }
        const project = yield* manifest(appId).pipe(Effect.orElseSucceed(() => null));
        return { project: project ? { dir: target, manifest: project } : null, name };
      }),

    remove: (appId) => Effect.promise(() => removeDir(dir(appId))),
  } satisfies WorkspaceShape;
});

export const layer = Layer.effect(Workspace, make);
