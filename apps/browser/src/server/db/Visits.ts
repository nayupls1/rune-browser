// Browsing history (shared/visits.ts): every page a web tab went to, per
// workspace, with its title and icon as the page reports them. Recorded when
// a tab reports a new address (PATCH /api/apps/:id/page); visits older than
// KEEP_DAYS go. A page that moved on before it had a title within a moment
// was a redirect: the renderer reports only where it went (lib/store.ts updatePage).
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { isRecordable, KEEP_DAYS, rankSuggestions, samePage, searchText, type Visit } from "../../shared/visits";
import { orDieAll, type OrDie } from "./Db";

interface Row {
  id: number;
  workspace_id: string;
  tab_id: string | null;
  url: string;
  title: string;
  favicon: string | null;
  visited_at: string;
}

const toVisit = (r: Row): Visit => ({
  id: r.id,
  workspaceId: r.workspace_id,
  tabId: r.tab_id,
  url: r.url,
  title: r.title,
  favicon: r.favicon,
  visitedAt: r.visited_at,
});

/** Pages considered for the address bar's suggestions (the most recently visited that match). */
const SUGGEST_POOL = 300;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Each word in the title or the address (case-insensitive, `search` is lowercased by searchText). */
  const matching = (search: string) =>
    search
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((word) => sql`instr(search, ${word}) > 0`);

  const latestOfTab = (tabId: string) =>
    sql<Row>`SELECT * FROM visits WHERE tab_id = ${tabId} ORDER BY id DESC LIMIT 1`.pipe(Effect.map((r) => r[0]));

  const prune = () =>
    sql`DELETE FROM visits WHERE visited_at < ${new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString()}`;

  return {
    /**
     * A web tab reported its page (`tab` as it was before): a new address is a visit (unless
     * only its #hash changed), a title or icon for the same page updates the tab's latest
     * visit. True if anything changed.
     */
    record: (
      tab: { id: string; workspaceId: string; url: string | null },
      page: { url?: string; title?: string; favicon?: string | null },
    ) =>
      Effect.gen(function* () {
        const url = page.url ?? tab.url;
        if (!url || !isRecordable(url)) return false;
        const title = page.title?.trim().slice(0, 1000);
        const latest = yield* latestOfTab(tab.id);
        if (page.url && !(tab.url && samePage(tab.url, page.url))) {
          // A page visited before has its title and icon from then until it reports them (pages
          // shown again from the back/forward cache don't).
          const known = title
            ? undefined
            : (yield* sql<Row>`SELECT * FROM visits WHERE workspace_id = ${tab.workspaceId} AND url = ${url} AND title != ''
                ORDER BY id DESC LIMIT 1`)[0];
          const named = title || known?.title || "";
          yield* sql`INSERT INTO visits (workspace_id, tab_id, url, title, favicon, visited_at, search)
            VALUES (${tab.workspaceId}, ${tab.id}, ${url}, ${named}, ${page.favicon ?? known?.favicon ?? null},
              ${new Date().toISOString()}, ${searchText(url, named)})`;
          yield* prune();
          return true;
        }
        if (!latest || !samePage(latest.url, url) || (title === undefined && page.favicon === undefined)) return false;
        const named = title || latest.title;
        yield* sql`UPDATE visits SET
          title = ${named},
          search = ${searchText(latest.url, named)},
          favicon = ${page.favicon !== undefined ? page.favicon : latest.favicon}
          WHERE id = ${latest.id}`;
        return true;
      }),

    /**
     * Visits, newest first: a workspace's (or every workspace's), matching a search, before a visit (paging),
     * in a time range or of one page (chrome.history).
     */
    list: (options: {
      workspaceId: string | null;
      search?: string;
      before?: number;
      since?: string;
      until?: string;
      url?: string;
      limit: number;
    }) => {
      const where = [
        ...(options.workspaceId ? [sql`workspace_id = ${options.workspaceId}`] : []),
        ...(options.before ? [sql`id < ${options.before}`] : []),
        ...(options.since ? [sql`visited_at >= ${options.since}`] : []),
        ...(options.until ? [sql`visited_at < ${options.until}`] : []),
        ...(options.url ? [sql`url = ${options.url}`] : []),
        ...matching(options.search ?? ""),
      ];
      return sql<Row>`SELECT * FROM visits WHERE ${sql.and(where)} ORDER BY id DESC LIMIT ${options.limit}`.pipe(
        Effect.map((rows) => rows.map(toVisit)),
      );
    },

    /** Pages for the address bar: what's typed in their title or address, best first. */
    suggest: (workspaceId: string, query: string, limit: number) =>
      Effect.gen(function* () {
        const where = [sql`workspace_id = ${workspaceId}`, ...matching(query)];
        // SQLite takes the bare columns from the row with the MAX(): the latest title and icon.
        const rows = yield* sql<{ url: string; title: string; favicon: string | null; last: string; n: number }>`
          SELECT url, title, favicon, MAX(visited_at) AS last, COUNT(*) AS n FROM visits
          WHERE ${sql.and(where)} GROUP BY url ORDER BY last DESC LIMIT ${SUGGEST_POOL}`;
        return rankSuggestions(
          query,
          rows.map((r) => ({ url: r.url, title: r.title, favicon: r.favicon, visits: r.n, lastVisit: r.last })),
        ).slice(0, limit);
      }),

    /** A visit added by an extension (chrome.history.addUrl): not in any tab. */
    add: (workspaceId: string, url: string, title: string) =>
      Effect.gen(function* () {
        if (!isRecordable(url)) return false;
        const named = title.trim().slice(0, 1000);
        yield* sql`INSERT INTO visits (workspace_id, tab_id, url, title, favicon, visited_at, search)
          VALUES (${workspaceId}, ${null}, ${url}, ${named}, ${null}, ${new Date().toISOString()}, ${searchText(url, named)})`;
        return true;
      }),

    /** Removes every visit to a page (chrome.history.deleteUrl), in a workspace or all; returns how many. */
    removeUrl: (url: string, workspaceId: string | null) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: number }>`DELETE FROM visits WHERE ${sql.and([
          sql`url = ${url}`,
          ...(workspaceId ? [sql`workspace_id = ${workspaceId}`] : []),
        ])} RETURNING id`;
        return rows.length;
      }),

    /** Removes visits by id (only the workspace's, when one is given); returns how many. */
    remove: (ids: readonly number[], workspaceId: string | null) =>
      Effect.gen(function* () {
        if (!ids.length) return 0;
        const rows = yield* sql<{ id: number }>`DELETE FROM visits WHERE ${sql.and([
          sql.in("id", ids),
          ...(workspaceId ? [sql`workspace_id = ${workspaceId}`] : []),
        ])} RETURNING id`;
        return rows.length;
      }),

    /**
     * The sites (scheme, host and port) visited since a time, in a workspace or all: what "Clear browsing
     * data" clears cookies and the cache of for a time range (Electron can't clear them by time).
     */
    origins: (workspaceId: string | null, since: string) =>
      Effect.gen(function* () {
        const where = [...(workspaceId ? [sql`workspace_id = ${workspaceId}`] : []), sql`visited_at >= ${since}`];
        const rows = yield* sql<{ url: string }>`SELECT DISTINCT url FROM visits WHERE ${sql.and(where)}`;
        const origins = new Set<string>();
        for (const { url } of rows) {
          try {
            const u = new URL(url);
            if (u.protocol === "http:" || u.protocol === "https:") origins.add(u.origin);
          } catch {}
        }
        return [...origins].sort();
      }),

    /** Removes the visits since a time (all of them without one), up to another, in a workspace or all; returns how many. */
    clear: (workspaceId: string | null, since: string | null, until: string | null = null) =>
      Effect.gen(function* () {
        const where = [
          ...(workspaceId ? [sql`workspace_id = ${workspaceId}`] : []),
          ...(since ? [sql`visited_at >= ${since}`] : []),
          ...(until ? [sql`visited_at < ${until}`] : []),
        ];
        const rows = yield* sql<{ id: number }>`DELETE FROM visits WHERE ${sql.and(where)} RETURNING id`;
        return rows.length;
      }),

    prune,
  };
});

export class Visits extends Context.Service<Visits, OrDie<Effect.Success<typeof make>>>()("rune/Visits") {}

export const layer = Layer.effect(Visits, Effect.map(make, orDieAll));
