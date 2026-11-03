// Bookmarks: Chrome's tree of folders and pages (shared/bookmarks.ts), one for
// all workspaces, like a browser profile's. You change it from the bookmarks
// page, the star in the address bar and the bookmarks bar; extensions with the
// "bookmarks" permission through chrome.bookmarks (main/extensions/apis.ts).
// Every change goes out on the hub, which is where extensions' events come from.
import { Context, Data, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
  BAR_ID,
  bookmarkUrl,
  bookmarksHtml,
  findNode,
  OTHER_ID,
  ROOT_FOLDERS,
  ROOT_ID,
  type BookmarkChange,
  type BookmarkImportResult,
  type BookmarkNode,
  type ImportedBookmark,
  type ImportedBookmarks,
} from "../../shared/bookmarks";
import { topics } from "../../shared/hub";
import { Hub } from "../Hub";

export class BookmarkError extends Data.TaggedError("BookmarkError")<{
  readonly status: 400 | 404;
  readonly message: string;
}> {}

const MAX_TITLE = 4096;
/** At most this many bookmarks come in one import. */
export const MAX_IMPORT = 50_000;

interface Row {
  id: number;
  parent_id: number;
  position: number;
  title: string;
  url: string | null;
  added_at: number;
  changed_at: number;
}

const byPosition = (a: Row, b: Row) => a.position - b.position || a.id - b.id;

/** The tree of every row, from the root (chrome.bookmarks.getTree). */
export function treeOf(rows: readonly Row[]): BookmarkNode {
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const list = children.get(row.parent_id);
    if (list) list.push(row);
    else children.set(row.parent_id, [row]);
  }
  const build = (row: Row, index: number): BookmarkNode => {
    const node: BookmarkNode = {
      id: String(row.id),
      parentId: String(row.parent_id),
      index,
      title: row.title,
      dateAdded: row.added_at,
      syncing: false,
    };
    if (row.url !== null) return { ...node, url: row.url };
    const id = String(row.id);
    return {
      ...node,
      dateGroupModified: row.changed_at,
      ...(id === BAR_ID ? { folderType: "bookmarks-bar" as const } : id === OTHER_ID ? { folderType: "other" } : {}),
      children: (children.get(row.id) ?? []).sort(byPosition).map(build),
    };
  };
  return {
    id: ROOT_ID,
    title: "",
    syncing: false,
    children: (children.get(0) ?? []).sort(byPosition).map(build),
  };
}

const fail = (status: 400 | 404, message: string) => Effect.fail(new BookmarkError({ status, message }));
const notFound = () => fail(404, "Can't find bookmark for id.");
const rootFolders = () => fail(400, "Can't modify the root bookmark folders.");

/** The imported bookmarks Rune Browser can open; the rest is counted. */
function keepOpenable(list: readonly ImportedBookmark[], skipped: { count: number }): ImportedBookmark[] {
  return list.flatMap((b): ImportedBookmark[] => {
    const title = (b.title ?? "").slice(0, MAX_TITLE);
    if (b.url !== undefined) {
      const url = bookmarkUrl(b.url);
      if (url) return [{ title, url, dateAdded: b.dateAdded }];
      skipped.count++;
      return [];
    }
    return [{ title, dateAdded: b.dateAdded, children: keepOpenable(b.children ?? [], skipped) }];
  });
}

const sizeOf = (list: readonly ImportedBookmark[]): number =>
  list.reduce((n, b) => n + 1 + sizeOf(b.children ?? []), 0);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Hub;
  // One change at a time: each reads the rows it decides on.
  const lock = yield* Semaphore.make(1);

  const rows = sql<Row>`SELECT * FROM bookmarks`.pipe(Effect.orDie);
  const tree = Effect.map(rows, treeOf);
  const nodeOf = (id: string) => Effect.map(tree, (root) => findNode(root, id));
  const childrenOf = (all: readonly Row[], parent: number) =>
    all.filter((r) => r.parent_id === parent).sort(byPosition);
  // Only ids as written ("1", never "01": the root folders' guard compares strings).
  const rowOf = (all: readonly Row[], id: string) =>
    /^[1-9]\d*$/.test(id) ? all.find((r) => r.id === Number(id)) : undefined;

  /** Puts a folder's children in this order. */
  const reindex = (all: readonly Row[], ids: readonly number[]) => {
    const was = new Map(all.map((r) => [r.id, r.position]));
    return Effect.forEach(
      ids.flatMap((id, position) => (was.get(id) === position ? [] : [{ id, position }])),
      ({ id, position }) => sql`UPDATE bookmarks SET position = ${position} WHERE id = ${id}`,
      { discard: true },
    );
  };
  const touch = (folder: number) =>
    folder === 0 ? Effect.void : sql`UPDATE bookmarks SET changed_at = ${Date.now()} WHERE id = ${folder}`;

  const publish = (change: BookmarkChange) => hub.publish({ type: "bookmarks", topic: topics.bookmarks, change });

  /** A change: serialized, in a transaction, published once it's saved. */
  const change = <A>(
    run: (all: readonly Row[]) => Effect.Effect<{ result: A; change?: BookmarkChange | BookmarkChange[] }, unknown>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        // Database errors are defects; a BookmarkError is the caller's.
        const done = yield* sql
          .withTransaction(Effect.flatMap(rows, run))
          .pipe(Effect.catch((e) => (e instanceof BookmarkError ? Effect.fail(e) : Effect.die(e))));
        for (const c of [done.change ?? []].flat()) yield* publish(c);
        return done.result;
      }),
    );

  const folderFor = (all: readonly Row[], parentId: string) =>
    Effect.gen(function* () {
      if (parentId === ROOT_ID) return yield* rootFolders();
      const parent = rowOf(all, parentId);
      if (!parent) return yield* fail(404, "Can't find parent bookmark for id.");
      if (parent.url !== null) return yield* fail(400, "Parameter 'parentId' does not specify a folder.");
      return parent;
    });

  const insert = (parent: number, position: number, b: { title: string; url?: string; dateAdded?: number }) =>
    Effect.map(
      sql<{ id: number }>`INSERT INTO bookmarks (parent_id, position, title, url, added_at, changed_at)
        VALUES (${parent}, ${position}, ${b.title}, ${b.url ?? null}, ${b.dateAdded ?? Date.now()}, ${Date.now()})
        RETURNING id`,
      (r) => r[0]!.id,
    );

  /** Saves imported bookmarks at the end of a folder; returns the top ones' ids. */
  const insertAll = (
    parent: number,
    from: number,
    list: readonly ImportedBookmark[],
  ): Effect.Effect<number[], unknown> =>
    Effect.forEach(list, (b, i) =>
      Effect.gen(function* () {
        const id = yield* insert(parent, from + i, b);
        if (b.children) yield* insertAll(id, 0, b.children);
        return id;
      }),
    );

  /** chrome.bookmarks.update: a new title or address. */
  const update = (all: readonly Row[], id: string, input: { title?: string; url?: string }) =>
    Effect.gen(function* () {
      const row = rowOf(all, id);
      if (id === ROOT_ID || ROOT_FOLDERS.includes(id)) return yield* rootFolders();
      if (!row) return yield* notFound();
      let url = row.url;
      if (input.url !== undefined) {
        if (row.url === null) return yield* fail(400, "Can't set URL of a bookmark folder.");
        url = bookmarkUrl(input.url);
        if (!url) return yield* fail(400, "Invalid URL.");
      }
      const title = input.title !== undefined ? input.title.slice(0, MAX_TITLE) : row.title;
      yield* sql`UPDATE bookmarks SET title = ${title}, url = ${url} WHERE id = ${row.id}`;
      const node = (yield* nodeOf(id))!;
      const changed: BookmarkChange = { kind: "changed", id, title, ...(url !== null ? { url } : {}) };
      return { result: node, change: title !== row.title || url !== row.url ? changed : undefined };
    });

  /**
   * chrome.bookmarks.move: into a folder (the same one unless given), before the node at `index`
   * (at the end unless given), like Chrome: moving down in the same folder, that's one place less.
   */
  const move = (all: readonly Row[], id: string, input: { parentId?: string; index?: number }) =>
    Effect.gen(function* () {
      const row = rowOf(all, id);
      if (id === ROOT_ID || ROOT_FOLDERS.includes(id)) return yield* rootFolders();
      if (!row) return yield* notFound();
      const parent = yield* folderFor(all, input.parentId ?? String(row.parent_id));
      for (let at: Row | undefined = parent; at; at = all.find((r) => r.id === at!.parent_id))
        if (at.id === row.id) return yield* fail(400, "Can't move a folder into itself or a folder in it.");
      const before = childrenOf(all, row.parent_id).map((r) => r.id);
      const oldIndex = before.indexOf(row.id);
      const same = parent.id === row.parent_id;
      const target = childrenOf(all, parent.id)
        .map((r) => r.id)
        .filter((x) => x !== row.id);
      let index = input.index ?? target.length + (same ? 1 : 0);
      if (!Number.isInteger(index) || index < 0 || index > target.length + (same ? 1 : 0))
        return yield* fail(400, "Index out of bounds.");
      if (same && index > oldIndex) index--;
      index = Math.min(index, target.length);
      target.splice(index, 0, row.id);
      if (same && index === oldIndex) return { result: (yield* nodeOf(id))! };
      yield* sql`UPDATE bookmarks SET parent_id = ${parent.id} WHERE id = ${row.id}`;
      yield* reindex(all, target);
      if (!same)
        yield* reindex(
          all,
          before.filter((x) => x !== row.id),
        );
      yield* touch(parent.id);
      if (!same) yield* touch(row.parent_id);
      const node = (yield* nodeOf(id))!;
      return {
        result: node,
        change: {
          kind: "moved" as const,
          id,
          parentId: String(parent.id),
          index,
          oldParentId: String(row.parent_id),
          oldIndex,
        },
      };
    });

  return {
    tree,
    nodeOf,
    html: Effect.map(tree, bookmarksHtml),

    /** chrome.bookmarks.create: in other bookmarks unless a folder is given, at its end unless an index is. */
    create: (input: { parentId?: string; index?: number; title?: string; url?: string }) =>
      change((all) =>
        Effect.gen(function* () {
          const parent = yield* folderFor(all, input.parentId ?? OTHER_ID);
          let url: string | undefined;
          if (input.url !== undefined) {
            const valid = bookmarkUrl(input.url);
            if (!valid) return yield* fail(400, "Invalid URL.");
            url = valid;
          }
          const siblings = childrenOf(all, parent.id);
          const index = input.index ?? siblings.length;
          if (!Number.isInteger(index) || index < 0 || index > siblings.length)
            return yield* fail(400, "Index out of bounds.");
          const id = yield* insert(parent.id, index, { title: (input.title ?? "").slice(0, MAX_TITLE), url });
          const order = siblings.map((r) => r.id);
          order.splice(index, 0, id);
          yield* reindex(all, order);
          yield* touch(parent.id);
          const node = (yield* nodeOf(String(id)))!;
          return { result: node, change: { kind: "created", id: node.id, node } };
        }),
      ),

    /** chrome.bookmarks.update and/or move, in one go: a new title or address, a new place. */
    edit: (id: string, input: { title?: string; url?: string; parentId?: string; index?: number }) =>
      change((all) =>
        Effect.gen(function* () {
          const changes: BookmarkChange[] = [];
          if (input.title !== undefined || input.url !== undefined) {
            const done = yield* update(all, id, input);
            if (done.change) changes.push(done.change);
          }
          if (input.parentId !== undefined || input.index !== undefined) {
            const done = yield* move(all, id, input);
            if (done.change) changes.push(done.change);
          }
          const node = yield* nodeOf(id);
          if (!node) return yield* notFound();
          return { result: node, change: changes };
        }),
      ),

    /** chrome.bookmarks.remove (a page or an empty folder), or removeTree with `recursive`. */
    remove: (id: string, recursive: boolean) =>
      change((all) =>
        Effect.gen(function* () {
          const row = rowOf(all, id);
          if (id === ROOT_ID || ROOT_FOLDERS.includes(id)) return yield* rootFolders();
          if (!row) return yield* notFound();
          const node = findNode(treeOf(all), id)!;
          if (node.children?.length && !recursive)
            return yield* fail(400, "Can't remove non-empty folder (use recursive to remove).");
          const ids: number[] = [];
          const collect = (n: BookmarkNode) => {
            ids.push(Number(n.id));
            for (const child of n.children ?? []) collect(child);
          };
          collect(node);
          yield* sql`DELETE FROM bookmarks WHERE id IN ${sql.in(ids)}`;
          const siblings = childrenOf(all, row.parent_id).map((r) => r.id);
          yield* reindex(
            all,
            siblings.filter((x) => x !== row.id),
          );
          yield* touch(row.parent_id);
          return {
            result: undefined,
            change: { kind: "removed", id, parentId: String(row.parent_id), index: siblings.indexOf(row.id), node },
          };
        }),
      ),

    /**
     * Another browser's bookmarks, like Chrome imports them: its bar goes on the bookmarks bar
     * and the rest into other bookmarks, each in an "Imported from …" folder where there's
     * something already.
     */
    importBookmarks: (source: string, data: ImportedBookmarks) =>
      change((all) =>
        Effect.gen(function* () {
          const skipped = { count: 0 };
          const bar = keepOpenable(data.bar, skipped);
          const other = keepOpenable(data.other, skipped);
          if (sizeOf(bar) + sizeOf(other) > MAX_IMPORT)
            return yield* fail(400, `That's more than ${MAX_IMPORT.toLocaleString("en")} bookmarks.`);
          const made: number[] = [];
          for (const [root, list] of [
            [Number(BAR_ID), bar],
            [Number(OTHER_ID), other],
          ] as const) {
            if (!list.length) continue;
            const existing = childrenOf(all, root).length;
            const items = existing ? [{ title: `Imported from ${source}`, children: list }] : list;
            made.push(...(yield* insertAll(root, existing, items)));
            yield* touch(root);
          }
          const root = yield* tree;
          const nodes = made.map((id) => findNode(root, String(id))!);
          const added = nodes.reduce((n, node) => n + countPages(node), 0);
          const result: BookmarkImportResult = { added, skipped: skipped.count };
          return { result, change: nodes.length ? { kind: "imported", nodes } : undefined };
        }),
      ),
  };
});

const countPages = (node: BookmarkNode): number =>
  node.url !== undefined ? 1 : (node.children ?? []).reduce((n, c) => n + countPages(c), 0);

export class Bookmarks extends Context.Service<Bookmarks, Effect.Success<typeof make>>()("rune/Bookmarks") {}

export const layer = Layer.effect(Bookmarks, make);
