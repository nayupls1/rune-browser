// History: snapshots of everything agents and the user change, so any change
// can be looked at and undone. A snapshot is a tree of files (path → content
// hash); contents live once in a content-addressed store under
// <dataDir>/history/objects (gzipped), so unchanged files cost nothing.
//
// Targets:
// - app:<id>: the project folder (without dependencies and builds) and its
//   data (workspace/AppData.ts), under "@data/". SQLite databases are copied
//   consistently (sqlite3_serialize), even while the app runs, with their
//   tables' row counts for the timeline.
// - sites: the site customizations (<host>/style.css, script.js, site.json) and
//   page changes (@changes/<id>.json).
// - settings: Rune Browser's settings and each workspace's (settings.json,
//   workspaces/<id>.json).
//
// Restoring or undoing first takes a snapshot of the current state, so it can
// be undone in turn. Old snapshots are pruned per target.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Data, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
  appOfTarget,
  type AuditEntry,
  type HistoryDetail,
  type HistoryEntry,
  type HistoryFile,
  type HistoryTarget,
  type PageChange,
  type TableChanges,
} from "../../shared/api";
import { diffLines, toHunks } from "../../shared/diff";
import { topics } from "../../shared/hub";
import { decodeSettings, decodeWorkspaceSettings } from "../../shared/settings";
import { ServerConfig } from "../Config";
import { Settings } from "../db/Settings";
import { PageChanges } from "../db/PageChanges";
import { Sites } from "../db/Sites";
import { Workspaces } from "../db/Workspaces";
import { Hub } from "../Hub";
import { AppData, DATA_PREFIX } from "../workspace/AppData";
import { Runtime } from "../workspace/Runtime";
import { Workspace } from "../workspace/Workspace";

export class HistoryError extends Data.TaggedError("HistoryError")<{
  readonly status: 400 | 404 | 409;
  readonly message: string;
}> {}

/** path → content hash */
type Tree = Record<string, string>;
/** database path → table → rows */
type DataStats = Record<string, Record<string, number>>;

interface Captured {
  tree: Tree;
  data: DataStats;
}

export interface By {
  readonly actor: AuditEntry["actor"];
  readonly actorLabel: string;
  readonly summary: string;
  /** Fold into the previous snapshot if it's by the same actor with the same summary and this recent (settings typed in a row). */
  readonly coalesceMs?: number;
}

interface SnapshotRow {
  id: number;
  target: HistoryTarget;
  tab_id: string | null;
  workspace_id: string | null;
  at: string;
  actor: AuditEntry["actor"];
  actor_label: string;
  summary: string;
  tree: string;
  data: string;
  changes: string;
}

interface Changes {
  added: string[];
  modified: string[];
  removed: string[];
  data: Record<string, TableChanges>;
  first: boolean;
}

/** Snapshots kept per target. */
const KEEP = 200;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20_000;
/** Bigger files are listed without a line diff. */
const MAX_DIFF_BYTES = 512 * 1024;
/** Never part of an app's snapshot: dependencies, builds, caches, version control. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".svelte-kit",
  "coverage",
  ".output",
  ".vercel",
]);
const SKIP_FILES = /(-wal|-shm|-journal)$|\.log$|^\.DS_Store$/;
const SQLITE_NAME = /\.(sqlite3?|db)$/i;
const SQLITE_HEADER = "SQLite format 3\0";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

const sameTree = (a: Tree, b: Tree) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** Where page changes are in the sites target (not a host name). */
const CHANGES_PREFIX = "@changes/";

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A consistent copy of a SQLite database (committed WAL content included) and its tables' row counts. */
function readDatabase(file: string): { bytes: Uint8Array; tables: Record<string, number> } | null {
  let db: Database | undefined;
  try {
    db = new Database(file);
    db.run("PRAGMA busy_timeout = 2000");
    const tables: Record<string, number> = {};
    for (const { name } of db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      tables[name] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get()!.n;
    }
    return { bytes: db.serialize(), tables };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const tableChanges = (
  before: Record<string, number> | undefined,
  after: Record<string, number> | undefined,
): TableChanges => {
  const changes: TableChanges = {};
  for (const table of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const a = before?.[table] ?? null;
    const b = after?.[table] ?? null;
    if (a !== b) changes[table] = [a, b];
  }
  return changes;
};

function compare(previous: { tree: Tree; data: DataStats } | null, current: Captured): Changes {
  const before = previous?.tree ?? {};
  const after = current.tree;
  const added = Object.keys(after).filter((p) => !(p in before));
  const removed = Object.keys(before).filter((p) => !(p in after));
  const modified = Object.keys(after).filter((p) => p in before && before[p] !== after[p]);
  const data: Record<string, TableChanges> = {};
  for (const path of [...added, ...removed, ...modified]) {
    if (path in current.data || (previous && path in previous.data))
      data[path] = tableChanges(previous?.data[path], current.data[path]);
  }
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort(), data, first: !previous };
}

export interface HistoryShape {
  /** Takes a snapshot if anything changed since the last one (null if nothing did, or there's nothing to snapshot yet). */
  readonly record: (target: HistoryTarget, by: By) => Effect.Effect<HistoryEntry | null>;
  /** Newest first. A workspace filter includes the targets that belong to none (sites, settings). */
  readonly list: (filter: {
    target?: string;
    workspaceId?: string;
    before?: number;
    limit?: number;
  }) => Effect.Effect<HistoryEntry[]>;
  readonly entry: (id: number) => Effect.Effect<HistoryEntry, HistoryError>;
  /** The entry with its files and their line diffs. */
  readonly detail: (id: number) => Effect.Effect<HistoryDetail, HistoryError>;
  /** Puts the target back the way it was in the snapshot. Apps: `data: false` keeps the current data. */
  /** The paths a snapshot holds. */
  readonly paths: (id: number) => Effect.Effect<string[], HistoryError>;
  /** One file of a snapshot as text (null if it isn't there or is binary). */
  readonly fileAt: (id: number, path: string) => Effect.Effect<string | null, HistoryError>;
  readonly restore: (id: number, options: { data: boolean }) => Effect.Effect<void, HistoryError>;
  /**
   * Reverts just this snapshot's change. Fails if those files changed again
   * since. Databases only with `data: true`, and only if they didn't change
   * again since (else they're kept, see note).
   */
  readonly undo: (id: number, options: { data: boolean }) => Effect.Effect<{ note: string | null }, HistoryError>;
  /**
   * Puts Rune Browser back the way it was when snapshot `at` was taken: the settings,
   * the site customizations and every app (of the workspace, if given) that had
   * a snapshot by then, each as one restore (undoable). Returns what changed.
   */
  readonly restoreAll: (
    at: number,
    options: { data: boolean; workspaceId?: string },
  ) => Effect.Effect<{ restored: HistoryTarget[] }, HistoryError>;
  /** Deletes a target's history (its app was deleted). */
  readonly forget: (target: HistoryTarget) => Effect.Effect<void>;
}

export class History extends Context.Service<History, HistoryShape>()("rune/History") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Hub;
  const workspace = yield* Workspace;
  const runtime = yield* Runtime;
  const appData = yield* AppData;
  const settings = yield* Settings;
  const sites = yield* Sites;
  const pageChanges = yield* PageChanges;
  const workspaces = yield* Workspaces;

  // --- Content store ------------------------------------------------------------------

  const objectsDir = join(config.dataDir, "history", "objects");
  const objectPath = (hash: string) => join(objectsDir, hash.slice(0, 2), hash.slice(2));

  const put = (content: Uint8Array) =>
    Effect.promise(async () => {
      const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      const file = objectPath(hash);
      if (existsSync(file)) {
        // Fresh again, so garbage collection running right now leaves it alone.
        const now = new Date();
        await utimes(file, now, now).catch(() => {});
      } else {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, Bun.gzipSync(content as Uint8Array<ArrayBuffer>));
        await rename(tmp, file);
      }
      return hash;
    });

  const get = (hash: string) =>
    Effect.promise(async () => Bun.gunzipSync(new Uint8Array(await readFile(objectPath(hash)))));

  /** Deletes contents no snapshot refers to (older than an hour, so ones being saved right now stay). */
  const collectGarbage = Effect.gen(function* () {
    const rows = yield* sql<{ tree: string }>`SELECT tree FROM snapshots`.pipe(Effect.orDie);
    const used = new Set<string>();
    for (const row of rows) for (const hash of Object.values(JSON.parse(row.tree) as Tree)) used.add(hash);
    yield* Effect.promise(async () => {
      if (!existsSync(objectsDir)) return;
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const prefix of await readdir(objectsDir)) {
        for (const name of await readdir(join(objectsDir, prefix))) {
          const file = join(objectsDir, prefix, name);
          if (used.has(prefix + name)) continue;
          if ((await stat(file)).mtimeMs < cutoff) await unlink(file).catch(() => {});
        }
      }
    });
  });

  // --- Capturing ----------------------------------------------------------------------

  /** Where a snapshot path of an app is on disk: its project, or its managed data for "@data/…". */
  const appPath = (appId: string, path: string) =>
    path.startsWith(DATA_PREFIX)
      ? join(appData.dir(appId), path.slice(DATA_PREFIX.length))
      : join(workspace.dir(appId), path);

  /** An app's files and data; null if it has no project folder yet. */
  const captureApp = (appId: string) =>
    Effect.gen(function* () {
      const root = workspace.dir(appId);
      if (!existsSync(root)) return null;
      yield* appData.ensure(appId);
      const tree: Tree = {};
      const data: DataStats = {};
      const files: string[] = [];
      yield* Effect.promise(async () => {
        const walk = async (dir: string, rel: string, skipDirs: boolean) => {
          for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const path = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              // Rune Browser's state folder (dependency stamp, home) isn't the app's.
              if (path !== ".rune" && !(skipDirs && SKIP_DIRS.has(entry.name)))
                await walk(join(dir, entry.name), path, skipDirs);
            } else if (entry.isFile() && !SKIP_FILES.test(entry.name) && files.length < MAX_FILES) files.push(path);
          }
        };
        await walk(root, "", true);
        // The app's data: its database and every file it stored.
        await walk(appData.dir(appId), DATA_PREFIX.slice(0, -1), false);
      });
      // The previous snapshot's contents stand in for files that can't be read right now.
      const last = yield* latest(`app:${appId}`);
      const { tree: previous, data: previousData } = last ? stored(last) : { tree: {} as Tree, data: {} as DataStats };
      for (const path of files) {
        const file = appPath(appId, path);
        const size = yield* Effect.promise(() =>
          stat(file).then(
            (s) => s.size,
            () => -1,
          ),
        );
        if (size < 0 || size > MAX_FILE_BYTES) continue;
        const head = yield* Effect.promise(() =>
          Bun.file(file)
            .slice(0, 16)
            .text()
            .catch(() => ""),
        );
        if (SQLITE_NAME.test(path) && head === SQLITE_HEADER) {
          const db = readDatabase(file);
          if (db) {
            tree[path] = yield* put(db.bytes);
            data[path] = db.tables;
          } else if (previous[path]) {
            tree[path] = previous[path];
            data[path] = previousData[path] ?? {};
          }
          continue;
        }
        const bytes = yield* Effect.promise(() =>
          readFile(file).then(
            (b) => new Uint8Array(b),
            () => null,
          ),
        );
        if (bytes) tree[path] = yield* put(bytes);
      }
      return { tree, data } satisfies Captured;
    });

  const captureFiles = (files: Record<string, Uint8Array>) =>
    Effect.gen(function* () {
      const tree: Tree = {};
      for (const [path, bytes] of Object.entries(files)) tree[path] = yield* put(bytes);
      return { tree, data: {} } satisfies Captured;
    });

  const captureSites = Effect.gen(function* () {
    const files: Record<string, Uint8Array> = {};
    for (const site of yield* sites.list()) {
      files[`${site.host}/site.json`] = json({ enabled: site.enabled });
      if (site.css) files[`${site.host}/style.css`] = encoder.encode(site.css);
      if (site.js) files[`${site.host}/script.js`] = encoder.encode(site.js);
    }
    for (const change of yield* pageChanges.list()) files[`${CHANGES_PREFIX}${change.id}.json`] = json(change);
    return yield* captureFiles(files);
  });

  const captureSettings = Effect.gen(function* () {
    const files: Record<string, Uint8Array> = { "settings.json": json(yield* settings.get()) };
    for (const w of yield* workspaces.list())
      files[`workspaces/${w.id}.json`] = json({ name: w.name, icon: w.icon, settings: w.settings });
    return yield* captureFiles(files);
  });

  const capture = (target: HistoryTarget): Effect.Effect<Captured | null> => {
    const appId = appOfTarget(target);
    if (appId) return captureApp(appId);
    return target === "sites" ? captureSites : captureSettings;
  };

  // --- Applying a tree ----------------------------------------------------------------

  const read = (tree: Tree, path: string) =>
    tree[path] ? get(tree[path]).pipe(Effect.map((b) => decoder.decode(b))) : Effect.succeed(null);

  const applyApp = (appId: string, desired: Tree, current: Tree) =>
    Effect.gen(function* () {
      const status = yield* runtime.status(appId);
      yield* runtime.stop(appId);
      for (const path of Object.keys(current)) {
        if (path in desired) continue;
        const root = path.startsWith(DATA_PREFIX) ? appData.dir(appId) : workspace.dir(appId);
        yield* Effect.promise(async () => {
          await rm(appPath(appId, path), { force: true });
          // Folders left empty go too.
          for (let dir = dirname(appPath(appId, path)); dir.startsWith(root) && dir !== root; dir = dirname(dir)) {
            if ((await readdir(dir).catch(() => ["?"])).length) break;
            await rmdir(dir).catch(() => {});
          }
        });
      }
      for (const [path, hash] of Object.entries(desired)) {
        if (current[path] === hash) continue;
        const bytes = yield* get(hash);
        yield* Effect.promise(async () => {
          const file = appPath(appId, path);
          await mkdir(dirname(file), { recursive: true });
          // A database replaced as a whole: its journal belongs to the old one.
          if (SQLITE_NAME.test(path))
            for (const suffix of ["-wal", "-shm", "-journal"]) await rm(file + suffix, { force: true });
          await writeFile(file, bytes);
        });
      }
      // Restarted if it was running (or had crashed: likely why it's being restored).
      if (status.state !== "stopped") yield* Effect.forkDetach(runtime.restart(appId));
    });

  const applySites = (desired: Tree) =>
    Effect.gen(function* () {
      yield* applyPageChanges(desired);
      const hosts = new Set(
        Object.keys(desired)
          .filter((p) => !p.startsWith(CHANGES_PREFIX))
          .map((p) => p.split("/")[0]!),
      );
      const changed = new Set<string>();
      for (const site of yield* sites.list()) {
        if (!hosts.has(site.host)) {
          yield* sites.remove(site.host);
          changed.add(site.host);
        }
      }
      for (const host of hosts) {
        const meta = JSON.parse((yield* read(desired, `${host}/site.json`)) ?? "{}") as { enabled?: boolean };
        const css = (yield* read(desired, `${host}/style.css`)) ?? "";
        const js = (yield* read(desired, `${host}/script.js`)) ?? "";
        const current = yield* sites.get(host);
        if (current && current.css === css && current.js === js && current.enabled === (meta.enabled ?? true)) continue;
        yield* sites.save(host, { css, js, enabled: meta.enabled ?? true });
        changed.add(host);
      }
      for (const host of changed) yield* hub.publish({ type: "site", topic: topics.sites, host });
    });

  const applyPageChanges = (desired: Tree) =>
    Effect.gen(function* () {
      let changed = false;
      const wanted = new Set<string>();
      for (const path of Object.keys(desired)) {
        if (!path.startsWith(CHANGES_PREFIX)) continue;
        const change = JSON.parse((yield* read(desired, path))!) as PageChange;
        wanted.add(change.id);
        const current = yield* pageChanges.get(change.id);
        if (current && JSON.stringify(current) === JSON.stringify(change)) continue;
        yield* pageChanges.put(change);
        changed = true;
      }
      for (const change of yield* pageChanges.list()) {
        if (wanted.has(change.id)) continue;
        yield* pageChanges.remove(change.id);
        changed = true;
      }
      if (changed) yield* hub.publish({ type: "page-changes", topic: topics.sites });
    });

  const applySettings = (desired: Tree) =>
    Effect.gen(function* () {
      const text = yield* read(desired, "settings.json");
      if (text) {
        const next = decodeSettings(JSON.parse(text));
        yield* settings.save(next);
        yield* hub.publish({ type: "settings", topic: topics.settings, settings: next });
      }
      // Workspaces that still exist get their name and settings back.
      for (const w of yield* workspaces.list()) {
        const saved = yield* read(desired, `workspaces/${w.id}.json`);
        if (!saved) continue;
        const value = JSON.parse(saved) as { name: string; icon: string | null; settings: unknown };
        const updated = yield* workspaces.update(w.id, {
          name: value.name,
          icon: value.icon,
          settings: decodeWorkspaceSettings(value.settings),
        });
        if (updated) yield* hub.publish({ type: "workspace", topic: topics.workspaces, workspace: updated });
      }
    });

  const apply = (target: HistoryTarget, desired: Tree, current: Tree) => {
    const appId = appOfTarget(target);
    if (appId) return applyApp(appId, desired, current);
    return target === "sites" ? applySites(desired) : applySettings(desired);
  };

  // --- Rows ---------------------------------------------------------------------------

  const latest = (target: string) =>
    sql<SnapshotRow>`SELECT * FROM snapshots WHERE target = ${target} ORDER BY id DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );
  const byId = (id: number) =>
    sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );
  const parentOf = (row: SnapshotRow) =>
    sql<SnapshotRow>`SELECT * FROM snapshots WHERE target = ${row.target} AND id < ${row.id} ORDER BY id DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );

  const toEntry = (r: SnapshotRow): HistoryEntry => {
    const changes = JSON.parse(r.changes) as Changes;
    return {
      id: r.id,
      target: r.target,
      tabId: r.tab_id,
      workspaceId: r.workspace_id,
      at: r.at,
      actor: r.actor,
      actorLabel: r.actor_label,
      summary: r.summary,
      added: changes.added,
      modified: changes.modified,
      removed: changes.removed,
      data: changes.data,
      first: changes.first,
    };
  };
  const stored = (r: SnapshotRow) => ({ tree: JSON.parse(r.tree) as Tree, data: JSON.parse(r.data) as DataStats });

  const publish = (row: SnapshotRow | null) =>
    row ? hub.publish({ type: "snapshot", topic: topics.history, entry: toEntry(row) }) : Effect.void;
  const changed = (target: string) => hub.publish({ type: "history-changed", topic: topics.history, target });

  const insert = (target: HistoryTarget, captured: Captured, by: By) =>
    Effect.gen(function* () {
      const last = yield* latest(target);
      // An app's empty folder isn't worth a snapshot; no site customizations yet is (it's what undoing the first one goes back to).
      const empty = !Object.keys(captured.tree).length && !!appOfTarget(target);
      if (last ? sameTree(stored(last).tree, captured.tree) : empty) return null;
      const summary = by.summary.slice(0, 500);

      if (
        last &&
        by.coalesceMs &&
        last.actor === by.actor &&
        last.summary === summary &&
        Date.parse(last.at) > Date.now() - by.coalesceMs
      ) {
        const parent = yield* parentOf(last);
        if (parent && sameTree(stored(parent).tree, captured.tree)) {
          // Changed back to how it was: nothing left to remember.
          yield* sql`DELETE FROM snapshots WHERE id = ${last.id}`.pipe(Effect.orDie);
          yield* changed(target);
          return null;
        }
        const changes = compare(parent ? stored(parent) : null, captured);
        const rows = yield* sql<SnapshotRow>`
          UPDATE snapshots SET tree = ${JSON.stringify(captured.tree)}, data = ${JSON.stringify(captured.data)},
            changes = ${JSON.stringify(changes)}, at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ${last.id} RETURNING *`.pipe(Effect.orDie);
        yield* publish(rows[0] ?? null);
        return rows[0] ? toEntry(rows[0]) : null;
      }

      const changes = compare(last ? stored(last) : null, captured);
      const appId = appOfTarget(target);
      const rows = yield* sql<SnapshotRow>`
        INSERT INTO snapshots (target, tab_id, workspace_id, actor, actor_label, summary, tree, data, changes)
        VALUES (${target}, ${appId}, (SELECT workspace_id FROM apps WHERE id = ${appId}), ${by.actor}, ${by.actorLabel.slice(0, 200)}, ${summary},
                ${JSON.stringify(captured.tree)}, ${JSON.stringify(captured.data)}, ${JSON.stringify(changes)})
        RETURNING *`.pipe(Effect.orDie);
      yield* sql`DELETE FROM snapshots WHERE target = ${target} AND id NOT IN (
        SELECT id FROM snapshots WHERE target = ${target} ORDER BY id DESC LIMIT ${KEEP})`.pipe(Effect.orDie);
      yield* publish(rows[0] ?? null);
      return rows[0] ? toEntry(rows[0]) : null;
    });

  // One operation per target at a time.
  const locks = new Map<string, Semaphore.Semaphore>();
  const locked = (target: string) => {
    let lock = locks.get(target);
    if (!lock) locks.set(target, (lock = Semaphore.makeUnsafe(1)));
    return lock.withPermits(1);
  };

  const record = (target: HistoryTarget, by: By) =>
    locked(target)(
      Effect.gen(function* () {
        const captured = yield* capture(target);
        return captured ? yield* insert(target, captured, by) : null;
      }),
    );

  const fail = (status: 400 | 404 | 409, message: string) => Effect.fail(new HistoryError({ status, message }));

  const requireRow = (id: number) =>
    Effect.flatMap(byId(id), (row) => (row ? Effect.succeed(row) : fail(404, "No such snapshot")));

  /** A deleted app's snapshots can't be restored (they're about to go anyway). */
  const ensureExists = (target: HistoryTarget) =>
    Effect.gen(function* () {
      const appId = appOfTarget(target);
      if (appId && !existsSync(workspace.dir(appId))) return yield* fail(404, "The app no longer exists");
    });

  const isDatabase = (path: string, ...stats: DataStats[]) =>
    stats.some((s) => path in s) || (SQLITE_NAME.test(path) && path.startsWith(DATA_PREFIX));
  /** The app's data (kept as it is unless restoring "with its data"): its managed folder and any database in the project. */
  const isData = (path: string, ...stats: DataStats[]) => path.startsWith(DATA_PREFIX) || isDatabase(path, ...stats);

  // Where undoing the first change of settings or sites goes back to (also catches changes made while Rune Browser wasn't running).
  for (const target of ["settings", "sites"] as const) {
    yield* record(target, {
      actor: "rune",
      actorLabel: "Rune Browser",
      summary: "As it was when Rune Browser started",
    }).pipe(Effect.ignoreCause);
  }

  // Clean up after deleted snapshots, a while after startup.
  yield* Effect.forkDetach(Effect.sleep("1 minute").pipe(Effect.andThen(collectGarbage), Effect.ignoreCause));

  const restore = (id: number, options: { data: boolean }) =>
    Effect.gen(function* () {
      const row = yield* requireRow(id);
      yield* ensureExists(row.target);
      yield* locked(row.target)(
        Effect.gen(function* () {
          const current = yield* capture(row.target);
          if (!current) return yield* fail(404, "Nothing to restore into");
          yield* insert(row.target, current, {
            actor: "rune",
            actorLabel: "Rune Browser",
            summary: "Before restoring an earlier version",
          });
          const target = stored(row);
          const desired: Tree = { ...target.tree };
          if (!options.data) {
            // Databases stay as they are now.
            for (const path of Object.keys(desired)) if (isData(path, target.data, current.data)) delete desired[path];
            for (const path of Object.keys(current.tree))
              if (isData(path, target.data, current.data)) desired[path] = current.tree[path]!;
          }
          yield* apply(row.target, desired, current.tree);
          const after = yield* capture(row.target);
          const when = new Date(row.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
          if (after) {
            yield* insert(row.target, after, {
              actor: "user",
              actorLabel: "You",
              summary: `Restored the version from ${when}${options.data ? "" : " (kept the current data)"}`,
            });
          }
        }),
      );
      yield* changed(row.target);
    });

  return {
    record: (target, by) =>
      record(target, by).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Taking a snapshot failed", cause).pipe(Effect.as(null))),
      ),

    list: ({ target, workspaceId, before, limit = 100 }) =>
      sql<SnapshotRow>`
        SELECT * FROM snapshots
        WHERE ${target ? sql`target = ${target}` : sql`1 = 1`}
          AND ${workspaceId ? sql`(workspace_id = ${workspaceId} OR workspace_id IS NULL)` : sql`1 = 1`}
          AND ${before ? sql`id < ${before}` : sql`1 = 1`}
        ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`.pipe(
        Effect.map((rows) => rows.map(toEntry)),
        Effect.orDie,
      ),

    entry: (id) => Effect.map(requireRow(id), toEntry),

    paths: (id) => Effect.map(requireRow(id), (row) => Object.keys(stored(row).tree).sort()),

    fileAt: (id, path) =>
      Effect.gen(function* () {
        const { tree } = stored(yield* requireRow(id));
        if (!tree[path]) return null;
        const bytes = yield* get(tree[path]);
        return isBinary(bytes) ? null : decoder.decode(bytes);
      }),

    detail: (id) =>
      Effect.gen(function* () {
        const row = yield* requireRow(id);
        const entry = toEntry(row);
        const parent = yield* parentOf(row);
        const after = stored(row);
        const before = parent ? stored(parent) : { tree: {}, data: {} };
        const files: HistoryFile[] = [];
        const paths: [string, HistoryFile["status"]][] = [
          ...entry.added.map((p) => [p, "added"] as [string, HistoryFile["status"]]),
          ...entry.modified.map((p) => [p, "modified"] as [string, HistoryFile["status"]]),
          ...entry.removed.map((p) => [p, "removed"] as [string, HistoryFile["status"]]),
        ].sort(([a], [b]) => a.localeCompare(b));
        for (const [path, status] of paths) {
          if (path in entry.data || isDatabase(path, after.data, before.data)) {
            files.push({ path, status, kind: "data", tables: entry.data[path] ?? {} });
            continue;
          }
          // Only the first 200 files get line diffs.
          if (files.length >= 200) {
            files.push({ path, status, kind: "large" });
            continue;
          }
          const load = (hash: string | undefined) => (hash ? get(hash) : Effect.succeed(new Uint8Array()));
          const old = yield* load(before.tree[path]);
          const now = yield* load(after.tree[path]);
          if (old.length > MAX_DIFF_BYTES || now.length > MAX_DIFF_BYTES) files.push({ path, status, kind: "large" });
          else if (isBinary(old) || isBinary(now)) files.push({ path, status, kind: "binary" });
          else {
            const lines = (bytes: Uint8Array) =>
              bytes.length ? decoder.decode(bytes).replace(/\n$/, "").split("\n") : [];
            const diff = diffLines(lines(old), lines(now));
            if (!diff) files.push({ path, status, kind: "large" });
            else {
              files.push({
                path,
                status,
                kind: "text",
                hunks: toHunks(diff),
                linesAdded: diff.filter((l) => l.type === "+").length,
                linesRemoved: diff.filter((l) => l.type === "-").length,
              });
            }
          }
        }
        return { entry, files } satisfies HistoryDetail;
      }),

    restore,

    restoreAll: (at, options) =>
      Effect.gen(function* () {
        const point = yield* requireRow(at);
        const targets: HistoryTarget[] = ["settings", "sites"];
        const appRows = yield* sql<{
          id: string;
        }>`SELECT id FROM apps WHERE kind = 'app' ${options.workspaceId ? sql`AND workspace_id = ${options.workspaceId}` : sql``} ORDER BY position`.pipe(
          Effect.orDie,
        );
        for (const app of appRows) targets.push(`app:${app.id}`);
        const restored: HistoryTarget[] = [];
        for (const target of targets) {
          // Its last snapshot by then; nothing before means it didn't exist yet, and it stays.
          const then =
            (yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE target = ${target} AND id <= ${point.id} ORDER BY id DESC LIMIT 1`.pipe(
              Effect.orDie,
            ))[0];
          if (!then) continue;
          const current = yield* capture(target);
          if (!current) continue;
          const before = stored(then);
          const differs = (path: string) =>
            before.tree[path] !== current.tree[path] && (options.data || !isData(path, before.data, current.data));
          if (![...new Set([...Object.keys(before.tree), ...Object.keys(current.tree)])].some(differs)) continue;
          yield* restore(then.id, { data: options.data });
          restored.push(target);
        }
        return { restored };
      }),

    undo: (id, options) =>
      Effect.gen(function* () {
        const row = yield* requireRow(id);
        yield* ensureExists(row.target);
        const parent = yield* parentOf(row);
        if (!parent) return yield* fail(400, "This is the first snapshot: there's nothing before it to go back to");
        const note = yield* locked(row.target)(
          Effect.gen(function* () {
            const current = yield* capture(row.target);
            if (!current) return yield* fail(404, "Nothing to undo in");
            const before = stored(parent);
            const after = stored(row);
            const desired: Tree = { ...current.tree };
            const conflicts: string[] = [];
            const keptData: string[] = [];
            let skippedData = false;
            for (const path of new Set([...Object.keys(before.tree), ...Object.keys(after.tree)])) {
              if (before.tree[path] === after.tree[path]) continue;
              const database = isData(path, before.data, after.data, current.data);
              if (database && !options.data) {
                skippedData = true;
                continue;
              }
              if (current.tree[path] !== after.tree[path]) {
                if (database) keptData.push(path);
                else conflicts.push(path);
                continue;
              }
              if (before.tree[path]) desired[path] = before.tree[path]!;
              else delete desired[path];
            }
            if (conflicts.length) {
              const list =
                conflicts.slice(0, 5).join(", ") + (conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "");
              return yield* fail(409, `Changed again since then: ${list}. Restore an earlier version instead.`);
            }
            if (sameTree(desired, current.tree)) {
              if (keptData.length)
                return "Only the data changed, and it has changed again since, so nothing was undone.";
              return skippedData
                ? "Only the data changed in this step; undo it with its data to take that back."
                : "Nothing left to undo.";
            }
            yield* insert(row.target, current, {
              actor: "rune",
              actorLabel: "Rune Browser",
              summary: "Before undoing a change",
            });
            yield* apply(row.target, desired, current.tree);
            const now = yield* capture(row.target);
            if (now)
              yield* insert(row.target, now, { actor: "user", actorLabel: "You", summary: `Undid: ${row.summary}` });
            return keptData.length ? "The app's data has changed since, so it was kept as it is." : null;
          }),
        );
        yield* changed(row.target);
        return { note };
      }),

    forget: (target) =>
      sql`DELETE FROM snapshots WHERE target = ${target}`.pipe(
        Effect.orDie,
        Effect.andThen(changed(target)),
        Effect.andThen(Effect.forkDetach(collectGarbage.pipe(Effect.ignoreCause))),
        Effect.asVoid,
      ),
  } satisfies HistoryShape;
});

export const layer = Layer.effect(History, make);
