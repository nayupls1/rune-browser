// Code attached to a tab for its agent: folders of the user's (used in place)
// and Git repositories (cloned by Rune Browser into <data>/sources/<id>, pulled
// again on request). The agent reads and searches them with Rune Browser's tools
// (agent/sourceTools.ts) and changes them only with the user's OK, one diff at
// a time. Files that hold credentials (.env, keys, .npmrc…) and .git's
// internals are never read or written, whatever the agent asks.
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { ContextSource } from "../../shared/api";
import { diffLines, toHunks } from "../../shared/diff";
import { topics } from "../../shared/hub";
import { ServerConfig } from "../Config";
import { now, orDieAll } from "../db/Db";
import { Hub } from "../Hub";
import { cancelGit, clone, cloneError, parseGitSource, runGit } from "./git";

export class SourceError extends Data.TaggedError("SourceError")<{ readonly message: string }> {}

interface Row {
  id: string;
  tab_id: string;
  kind: string;
  name: string;
  path: string;
  url: string | null;
  branch: string | null;
  state: string;
  error: string | null;
  added_at: string;
  updated_at: string;
}

const toSource = (r: Row): ContextSource => ({
  id: r.id,
  tabId: r.tab_id,
  kind: r.kind === "git" ? "git" : "folder",
  name: r.name,
  path: r.path,
  url: r.url,
  branch: r.branch,
  state: (["cloning", "pulling", "ready", "error"] as const).find((s) => s === r.state) ?? "ready",
  error: r.error,
  addedAt: r.added_at,
  updatedAt: r.updated_at,
});

/** Never read or written: files that hold credentials (examples of them are fine), and git's own folder. */
const SECRET_FILE =
  /^(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.htpasswd)$/i;
/** Not worth listing or searching. */
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  ".rune",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
]);
export const isSecretPath = (rel: string) =>
  rel.split(/[\\/]/).some((part, i, all) => part === ".git" || (i === all.length - 1 && SECRET_FILE.test(part)));

const MAX_FILE = 2 * 1024 * 1024;

/** A unified diff of a file's change, for the user to approve. */
export function unifiedDiff(path: string, before: string | null, after: string) {
  const a = before === null ? [] : before.split("\n");
  const b = after.split("\n");
  const lines = diffLines(a, b);
  const head = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  if (!lines) return [...head, `(too large to show: ${a.length} → ${b.length} lines)`].join("\n");
  const hunks = toHunks(lines);
  const body = hunks.flatMap((h) => {
    const removed = h.lines.filter((l) => l.type !== "+").length;
    const added = h.lines.filter((l) => l.type !== "-").length;
    return [`@@ -${h.oldStart},${removed} +${h.newStart},${added} @@`, ...h.lines.map((l) => `${l.type}${l.text}`)];
  });
  const text = [...head, ...body].join("\n");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (more)` : text;
}

/** A file's text, or null when it looks binary. */
const isText = (buffer: Buffer) => !buffer.subarray(0, 8000).includes(0);

export interface SourcesShape {
  readonly list: (tabId: string) => Effect.Effect<ContextSource[]>;
  readonly get: (id: string) => Effect.Effect<ContextSource | null>;
  readonly addFolder: (tabId: string, path: string) => Effect.Effect<ContextSource, SourceError>;
  /** Starts cloning in the background; the source is "cloning" until it's done. */
  readonly addGit: (tabId: string, url: string, branch?: string) => Effect.Effect<ContextSource, SourceError>;
  readonly remove: (id: string) => Effect.Effect<boolean>;
  /** Pulls a repository again (in the background). */
  readonly pull: (id: string) => Effect.Effect<ContextSource, SourceError>;
  /** The tab was deleted: its clones go too. */
  readonly forgetTab: (tabId: string) => Effect.Effect<void>;
  /** A path inside the source, checked: no escaping it (symlinks too), no credential files. */
  readonly resolvePath: (
    source: ContextSource,
    path: string,
  ) => Effect.Effect<{ abs: string; rel: string }, SourceError>;
  readonly listFiles: (
    source: ContextSource,
    options: { dir?: string; pattern?: string; limit?: number },
  ) => Effect.Effect<string[], SourceError>;
  readonly readText: (
    source: ContextSource,
    path: string,
  ) => Effect.Effect<{ rel: string; text: string | null }, SourceError>;
  readonly search: (
    source: ContextSource,
    options: { query: string; regex?: boolean; glob?: string; limit?: number },
  ) => Effect.Effect<string[], SourceError>;
  readonly git: (source: ContextSource, args: string[]) => Effect.Effect<string, SourceError>;
  readonly writeText: (source: ContextSource, rel: string, text: string) => Effect.Effect<void, SourceError>;
}

export class Sources extends Context.Service<Sources, SourcesShape>()("rune/Sources") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const hub = yield* Hub;
  const clonesDir = join(config.dataDir, "sources");
  const noHooks = join(config.cacheDir, "no-git-hooks");

  const db = orDieAll({
    list: (tabId: string) =>
      sql<Row>`SELECT * FROM sources WHERE tab_id = ${tabId} ORDER BY added_at, id`.pipe(
        Effect.map((rows) => rows.map(toSource)),
      ),
    get: (id: string) =>
      sql<Row>`SELECT * FROM sources WHERE id = ${id}`.pipe(Effect.map((rows) => (rows[0] ? toSource(rows[0]) : null))),
    insert: (s: Omit<ContextSource, "addedAt" | "updatedAt" | "error">) =>
      sql`INSERT INTO sources (id, tab_id, kind, name, path, url, branch, state) VALUES (${s.id}, ${s.tabId}, ${s.kind}, ${s.name}, ${s.path}, ${s.url}, ${s.branch}, ${s.state})`,
    setState: (id: string, state: ContextSource["state"], error: string | null) =>
      sql`UPDATE sources SET state = ${state}, error = ${error}, updated_at = ${sql.literal(now)} WHERE id = ${id}`,
    remove: (id: string) => sql`DELETE FROM sources WHERE id = ${id}`,
    ofTab: (tabId: string) => sql<{ id: string; kind: string }>`SELECT id, kind FROM sources WHERE tab_id = ${tabId}`,
  });

  const publish = (tabId: string) =>
    Effect.flatMap(db.list(tabId), (sources) =>
      hub.publish({ type: "sources", topic: topics.app(tabId), appId: tabId, sources }),
    );
  const progress = (tabId: string, sourceId: string) => (p: { phase: string; percent: number | null }) =>
    hub.publishUnsafe({
      type: "source-progress",
      topic: topics.app(tabId),
      appId: tabId,
      sourceId,
      phase: p.phase,
      percent: p.percent,
    });

  const fail = (message: string) => Effect.fail(new SourceError({ message }));

  const resolvePath = (source: ContextSource, path: string) =>
    Effect.gen(function* () {
      if (source.state === "cloning") return yield* fail(`${source.name} is still being cloned.`);
      const root = yield* Effect.try({
        try: () => realpathSync(source.path),
        catch: () => new SourceError({ message: `${source.path} doesn't exist anymore.` }),
      });
      const wanted = resolve(root, path.replace(/^[\\/]+/, "") || ".");
      // The path itself may not exist yet (a new file): check its nearest existing parent after symlinks.
      let existing = wanted;
      while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
      const real = join(realpathSync(existing), relative(existing, wanted));
      // With forward slashes on every OS, like the listings.
      const rel = relative(root, real).split(sep).join("/");
      if (rel.startsWith("..") || isAbsolute(rel)) return yield* fail(`${path} isn't inside ${source.name}.`);
      if (isSecretPath(rel))
        return yield* fail(`${rel} may hold credentials or is git's own data: it's never read or changed.`);
      return { abs: real, rel: rel || "." };
    });

  /** Every file under a folder, relative to the source, skipping what's never worth reading. */
  const walk = async (root: string, from: string, limit: number) => {
    const out: string[] = [];
    const visit = async (dir: string) => {
      if (out.length >= limit) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= limit) return;
        const abs = join(dir, e.name);
        const rel = relative(root, abs);
        if (e.isDirectory()) {
          if (!SKIPPED_DIRS.has(e.name)) await visit(abs);
        } else if (e.isFile() && !isSecretPath(rel)) out.push(rel.split(sep).join("/"));
      }
    };
    await visit(from);
    return out;
  };

  const startClone = (source: ContextSource, url: string, branch: string | null) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(source.path, { recursive: true, force: true }));
      yield* Effect.promise(() => mkdir(clonesDir, { recursive: true }));
      const result = yield* clone({
        url,
        branch,
        target: source.path,
        noHooks,
        onProgress: progress(source.tabId, source.id),
        cancelKey: `source:${source.id}`,
      });
      if (!(yield* db.get(source.id))) return; // removed meanwhile
      if (result.code === 0) yield* db.setState(source.id, "ready", null);
      else
        yield* db.setState(
          source.id,
          "error",
          result.cancelled ? "Cancelled" : cloneError(result.err) || `git exited with ${result.code}`,
        );
      yield* publish(source.tabId);
    });

  return {
    list: db.list,
    get: db.get,

    addFolder: (tabId, path) =>
      Effect.gen(function* () {
        const abs = resolve(path);
        const info = yield* Effect.sync(() => (existsSync(abs) ? statSync(abs) : null));
        if (!info?.isDirectory()) return yield* fail(`${path} isn't a folder.`);
        if (abs === sep || abs === homedir() || /^[A-Za-z]:\\?$/.test(abs))
          return yield* fail("That's too much: pick a project folder, not your whole disk or home folder.");
        if (under(config.dataDir, abs) || under(abs, config.dataDir))
          return yield* fail("That folder is Rune Browser's own data.");
        const existing = (yield* db.list(tabId)).find((s) => s.path === abs);
        if (existing) return existing;
        const id = crypto.randomUUID().slice(0, 8);
        yield* db.insert({
          id,
          tabId,
          kind: "folder",
          name: basename(abs),
          path: abs,
          url: null,
          branch: null,
          state: "ready",
        });
        yield* publish(tabId);
        return (yield* db.get(id))!;
      }),

    addGit: (tabId, url, branch) =>
      Effect.gen(function* () {
        const git = parseGitSource(url, branch);
        if (!git) return yield* fail("That isn't a link to a repository (https, SSH or owner/repo).");
        const existing = (yield* db.list(tabId)).find((s) => s.url === git.url && s.branch === git.branch);
        if (existing) return existing;
        const id = crypto.randomUUID().slice(0, 8);
        const source: ContextSource = {
          id,
          tabId,
          kind: "git",
          name: git.branch ? `${git.name} (${git.branch})` : git.name,
          path: join(clonesDir, id),
          url: git.url,
          branch: git.branch,
          state: "cloning",
          error: null,
          addedAt: "",
          updatedAt: "",
        };
        yield* db.insert(source);
        yield* publish(tabId);
        yield* Effect.forkDetach(startClone(source, git.url, git.branch));
        return (yield* db.get(id))!;
      }),

    remove: (id) =>
      Effect.gen(function* () {
        const source = yield* db.get(id);
        if (!source) return false;
        cancelGit(`source:${id}`);
        yield* db.remove(id);
        // Rune Browser's clone goes; the user's own folder is theirs.
        if (source.kind === "git" && under(source.path, clonesDir))
          yield* Effect.promise(() => rm(source.path, { recursive: true, force: true }));
        yield* publish(source.tabId);
        return true;
      }),

    pull: (id) =>
      Effect.gen(function* () {
        const source = yield* db.get(id);
        if (!source) return yield* fail("No such source.");
        if (source.state === "cloning" || source.state === "pulling") return source;
        // A clone that failed is cloned again.
        if (source.kind === "git" && (source.state === "error" || !existsSync(join(source.path, ".git")))) {
          yield* db.setState(id, "cloning", null);
          yield* publish(source.tabId);
          yield* Effect.forkDetach(startClone(source, source.url!, source.branch));
          return (yield* db.get(id))!;
        }
        if (!existsSync(join(source.path, ".git"))) return yield* fail(`${source.name} isn't a Git repository.`);
        yield* db.setState(id, "pulling", null);
        yield* publish(source.tabId);
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const result = yield* runGit(["pull", "--progress", "--ff-only"], {
              cwd: source.path,
              noHooks,
              onProgress: progress(source.tabId, id),
              cancelKey: `source:${id}`,
            });
            if (!(yield* db.get(id))) return;
            yield* db.setState(
              id,
              result.code === 0 ? "ready" : "error",
              result.code === 0 ? null : cloneError(result.err) || `git exited with ${result.code}`,
            );
            yield* publish(source.tabId);
          }),
        );
        return (yield* db.get(id))!;
      }),

    forgetTab: (tabId) =>
      Effect.gen(function* () {
        for (const row of yield* db.ofTab(tabId)) {
          cancelGit(`source:${row.id}`);
          if (row.kind === "git")
            yield* Effect.promise(() => rm(join(clonesDir, row.id), { recursive: true, force: true }));
        }
      }),

    resolvePath,

    listFiles: (source, { dir, pattern, limit = 300 }) =>
      Effect.gen(function* () {
        const { abs } = yield* resolvePath(source, dir ?? ".");
        const root = realpathSync(source.path);
        const files = yield* Effect.promise(() => walk(root, abs, pattern ? 50_000 : Math.min(limit, 2000)));
        if (!pattern) return files;
        const glob = new Bun.Glob(pattern.includes("/") ? pattern : `**/${pattern}`);
        return files.filter((f) => glob.match(f)).slice(0, Math.min(limit, 2000));
      }),

    readText: (source, path) =>
      Effect.gen(function* () {
        const { abs, rel } = yield* resolvePath(source, path);
        const info = yield* Effect.sync(() => (existsSync(abs) ? statSync(abs) : null));
        if (!info) return yield* fail(`${rel} doesn't exist in ${source.name}.`);
        if (info.isDirectory()) return yield* fail(`${rel} is a folder: list it with list_source_files.`);
        if (info.size > MAX_FILE)
          return yield* fail(`${rel} is too large to read (${Math.round(info.size / 1024)} kB).`);
        const buffer = yield* Effect.promise(() => readFile(abs));
        return { rel, text: isText(buffer) ? buffer.toString("utf8") : null };
      }),

    search: (source, { query, regex, glob, limit = 100 }) =>
      Effect.gen(function* () {
        const { abs: root } = yield* resolvePath(source, ".");
        let matcher: RegExp;
        try {
          matcher = regex ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch (err) {
          return yield* fail(`Not a valid regular expression: ${(err as Error).message}`);
        }
        const files = yield* Effect.promise(() => walk(root, root, 50_000));
        const only = glob ? new Bun.Glob(glob.includes("/") ? glob : `**/${glob}`) : null;
        const out: string[] = [];
        yield* Effect.promise(async () => {
          for (const file of files) {
            if (out.length >= limit) break;
            if (only && !only.match(file)) continue;
            const abs = join(root, file);
            try {
              if (statSync(abs).size > MAX_FILE) continue;
              const buffer = await readFile(abs);
              if (!isText(buffer)) continue;
              const lines = buffer.toString("utf8").split("\n");
              for (let i = 0; i < lines.length && out.length < limit; i++) {
                if (matcher.test(lines[i]!)) out.push(`${file}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
              }
            } catch {
              // unreadable: skip
            }
          }
        });
        return out;
      }),

    git: (source, args) =>
      Effect.gen(function* () {
        const { abs } = yield* resolvePath(source, ".");
        if (!existsSync(join(abs, ".git"))) return yield* fail(`${source.name} isn't a Git repository.`);
        const result = yield* runGit(["--no-pager", ...args], { cwd: abs, noHooks, timeoutMs: 30_000 });
        if (result.code !== 0) return yield* fail(result.err || `git exited with ${result.code}`);
        return result.out.length > 40_000 ? `${result.out.slice(0, 40_000)}\n… (more)` : result.out;
      }),

    writeText: (source, rel, text) =>
      Effect.gen(function* () {
        const { abs } = yield* resolvePath(source, rel);
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, text);
          },
          catch: (err) => new SourceError({ message: `Couldn't write ${rel}: ${(err as Error).message}` }),
        });
      }),
  } satisfies SourcesShape;
});

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export const layer = Layer.effect(Sources, make);
