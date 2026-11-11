// History: snapshots of everything agents and the user change, so any change
// can be looked at and undone. A snapshot is a tree of files (path → content
// hash); contents live once in a content-addressed store under
// <dataDir>/history/objects (gzipped), so unchanged files cost nothing.
//
// Targets:
// - sites: the site customizations (<host>/style.css, script.js, site.json) and
//   page changes (@changes/<id>.json).
// - settings: Rune Browser's settings and each workspace's (settings.json,
//   workspaces/<id>.json).
//
// Restoring or undoing first takes a snapshot of the current state, so it can
// be undone in turn. Old snapshots are pruned per target.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Data, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
  type AuditEntry,
  type HistoryDetail,
  type HistoryEntry,
  type HistoryFile,
  type HistoryTarget,
  type PageChange,
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

export class HistoryError extends Data.TaggedError("HistoryError")<{
  readonly status: 400 | 404 | 409;
  readonly message: string;
}> {}

/** path → content hash */
type Tree = Record<string, string>;

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
  at: string;
  actor: AuditEntry["actor"];
  actor_label: string;
  summary: string;
  tree: string;
  changes: string;
}

interface Changes {
  added: string[];
  modified: string[];
  removed: string[];
  first: boolean;
}

/** Snapshots kept per target. */
const KEEP = 200;
/** Bigger files are listed without a line diff. */
const MAX_DIFF_BYTES = 512 * 1024;
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

function compare(previous: Tree | null, current: Tree): Changes {
  const before = previous ?? {};
  const added = Object.keys(current).filter((p) => !(p in before));
  const removed = Object.keys(before).filter((p) => !(p in current));
  const modified = Object.keys(current).filter((p) => p in before && before[p] !== current[p]);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort(), first: !previous };
}

export interface HistoryShape {
  /** Takes a snapshot if anything changed since the last one (null if nothing did, or there's nothing to snapshot yet). */
  readonly record: (target: HistoryTarget, by: By) => Effect.Effect<HistoryEntry | null>;
  /** Newest first. */
  readonly list: (filter: { target?: string; before?: number; limit?: number }) => Effect.Effect<HistoryEntry[]>;
  readonly entry: (id: number) => Effect.Effect<HistoryEntry, HistoryError>;
  /** The entry with its files and their line diffs. */
  readonly detail: (id: number) => Effect.Effect<HistoryDetail, HistoryError>;
  /** The paths a snapshot holds. */
  readonly paths: (id: number) => Effect.Effect<string[], HistoryError>;
  /** One file of a snapshot as text (null if it isn't there or is binary). */
  readonly fileAt: (id: number, path: string) => Effect.Effect<string | null, HistoryError>;
  /** Puts the target back the way it was in the snapshot. */
  readonly restore: (id: number) => Effect.Effect<void, HistoryError>;
  /** Reverts just this snapshot's change. Fails if those files changed again since. */
  readonly undo: (id: number) => Effect.Effect<{ note: string | null }, HistoryError>;
  /**
   * Puts Rune Browser back the way it was when snapshot `at` was taken: the
   * settings and the site customizations, each as one restore (undoable).
   * Returns what changed.
   */
  readonly restoreAll: (at: number) => Effect.Effect<{ restored: HistoryTarget[] }, HistoryError>;
}

export class History extends Context.Service<History, HistoryShape>()("rune/History") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Hub;
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

  const captureFiles = (files: Record<string, Uint8Array>) =>
    Effect.gen(function* () {
      const tree: Tree = {};
      for (const [path, bytes] of Object.entries(files)) tree[path] = yield* put(bytes);
      return tree;
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

  const capture = (target: HistoryTarget): Effect.Effect<Tree> => (target === "sites" ? captureSites : captureSettings);

  // --- Applying a tree ----------------------------------------------------------------

  const read = (tree: Tree, path: string) =>
    tree[path] ? get(tree[path]).pipe(Effect.map((b) => decoder.decode(b))) : Effect.succeed(null);

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

  const apply = (target: HistoryTarget, desired: Tree) =>
    target === "sites" ? applySites(desired) : applySettings(desired);

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
      at: r.at,
      actor: r.actor,
      actorLabel: r.actor_label,
      summary: r.summary,
      added: changes.added,
      modified: changes.modified,
      removed: changes.removed,
      first: changes.first,
    };
  };
  const stored = (r: SnapshotRow) => JSON.parse(r.tree) as Tree;

  const publish = (row: SnapshotRow | null) =>
    row ? hub.publish({ type: "snapshot", topic: topics.history, entry: toEntry(row) }) : Effect.void;
  const changed = (target: string) => hub.publish({ type: "history-changed", topic: topics.history, target });

  const insert = (target: HistoryTarget, captured: Tree, by: By) =>
    Effect.gen(function* () {
      const last = yield* latest(target);
      // No site customizations yet is worth a snapshot too: it's what undoing the first one goes back to.
      if (last && sameTree(stored(last), captured)) return null;
      const summary = by.summary.slice(0, 500);

      if (
        last &&
        by.coalesceMs &&
        last.actor === by.actor &&
        last.summary === summary &&
        Date.parse(last.at) > Date.now() - by.coalesceMs
      ) {
        const parent = yield* parentOf(last);
        if (parent && sameTree(stored(parent), captured)) {
          // Changed back to how it was: nothing left to remember.
          yield* sql`DELETE FROM snapshots WHERE id = ${last.id}`.pipe(Effect.orDie);
          yield* changed(target);
          return null;
        }
        const changes = compare(parent ? stored(parent) : null, captured);
        const rows = yield* sql<SnapshotRow>`
          UPDATE snapshots SET tree = ${JSON.stringify(captured)}, changes = ${JSON.stringify(changes)}, at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ${last.id} RETURNING *`.pipe(Effect.orDie);
        yield* publish(rows[0] ?? null);
        return rows[0] ? toEntry(rows[0]) : null;
      }

      const changes = compare(last ? stored(last) : null, captured);
      const rows = yield* sql<SnapshotRow>`
        INSERT INTO snapshots (target, actor, actor_label, summary, tree, changes)
        VALUES (${target}, ${by.actor}, ${by.actorLabel.slice(0, 200)}, ${summary},
                ${JSON.stringify(captured)}, ${JSON.stringify(changes)})
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
        return yield* insert(target, yield* capture(target), by);
      }),
    );

  const fail = (status: 400 | 404 | 409, message: string) => Effect.fail(new HistoryError({ status, message }));

  const requireRow = (id: number) =>
    Effect.flatMap(byId(id), (row) => (row ? Effect.succeed(row) : fail(404, "No such snapshot")));

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

  const restore = (id: number) =>
    Effect.gen(function* () {
      const row = yield* requireRow(id);
      yield* locked(row.target)(
        Effect.gen(function* () {
          const current = yield* capture(row.target);
          yield* insert(row.target, current, {
            actor: "rune",
            actorLabel: "Rune Browser",
            summary: "Before restoring an earlier version",
          });
          yield* apply(row.target, stored(row));
          const when = new Date(row.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
          yield* insert(row.target, yield* capture(row.target), {
            actor: "user",
            actorLabel: "You",
            summary: `Restored the version from ${when}`,
          });
        }),
      );
      yield* changed(row.target);
    });

  return {
    record: (target, by) =>
      record(target, by).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Taking a snapshot failed", cause).pipe(Effect.as(null))),
      ),

    list: ({ target, before, limit = 100 }) =>
      sql<SnapshotRow>`
        SELECT * FROM snapshots
        WHERE ${target ? sql`target = ${target}` : sql`1 = 1`}
          AND ${before ? sql`id < ${before}` : sql`1 = 1`}
        ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`.pipe(
        Effect.map((rows) => rows.map(toEntry)),
        Effect.orDie,
      ),

    entry: (id) => Effect.map(requireRow(id), toEntry),

    paths: (id) => Effect.map(requireRow(id), (row) => Object.keys(stored(row)).sort()),

    fileAt: (id, path) =>
      Effect.gen(function* () {
        const tree = stored(yield* requireRow(id));
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
        const before: Tree = parent ? stored(parent) : {};
        const files: HistoryFile[] = [];
        const paths: [string, HistoryFile["status"]][] = [
          ...entry.added.map((p) => [p, "added"] as [string, HistoryFile["status"]]),
          ...entry.modified.map((p) => [p, "modified"] as [string, HistoryFile["status"]]),
          ...entry.removed.map((p) => [p, "removed"] as [string, HistoryFile["status"]]),
        ].sort(([a], [b]) => a.localeCompare(b));
        for (const [path, status] of paths) {
          // Only the first 200 files get line diffs.
          if (files.length >= 200) {
            files.push({ path, status, kind: "large" });
            continue;
          }
          const load = (hash: string | undefined) => (hash ? get(hash) : Effect.succeed(new Uint8Array()));
          const old = yield* load(before[path]);
          const now = yield* load(after[path]);
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

    restoreAll: (at) =>
      Effect.gen(function* () {
        const point = yield* requireRow(at);
        const restored: HistoryTarget[] = [];
        for (const target of ["settings", "sites"] as const) {
          // Its last snapshot by then; nothing before means it had none yet, and it stays.
          const then =
            (yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE target = ${target} AND id <= ${point.id} ORDER BY id DESC LIMIT 1`.pipe(
              Effect.orDie,
            ))[0];
          if (!then || sameTree(stored(then), yield* capture(target))) continue;
          yield* restore(then.id);
          restored.push(target);
        }
        return { restored };
      }),

    undo: (id) =>
      Effect.gen(function* () {
        const row = yield* requireRow(id);
        const parent = yield* parentOf(row);
        if (!parent) return yield* fail(400, "This is the first snapshot: there's nothing before it to go back to");
        const note = yield* locked(row.target)(
          Effect.gen(function* () {
            const current = yield* capture(row.target);
            const before = stored(parent);
            const after = stored(row);
            const desired: Tree = { ...current };
            const conflicts: string[] = [];
            for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
              if (before[path] === after[path]) continue;
              if (current[path] !== after[path]) {
                conflicts.push(path);
                continue;
              }
              if (before[path]) desired[path] = before[path]!;
              else delete desired[path];
            }
            if (conflicts.length) {
              const list =
                conflicts.slice(0, 5).join(", ") + (conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "");
              return yield* fail(409, `Changed again since then: ${list}. Restore an earlier version instead.`);
            }
            if (sameTree(desired, current)) return "Nothing left to undo.";
            yield* insert(row.target, current, {
              actor: "rune",
              actorLabel: "Rune Browser",
              summary: "Before undoing a change",
            });
            yield* apply(row.target, desired);
            yield* insert(row.target, yield* capture(row.target), {
              actor: "user",
              actorLabel: "You",
              summary: `Undid: ${row.summary}`,
            });
            return null;
          }),
        );
        yield* changed(row.target);
        return { note };
      }),
  } satisfies HistoryShape;
});

export const layer = Layer.effect(History, make);
