// The History page (Ctrl+H): the pages web tabs visited (shared/visits.ts),
// grouped by day, searchable, for the current workspace or all of them. Single
// visits can be removed, and "Clear history" deletes a time range or
// everything. A click opens the page in a new tab.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { topics } from "../../shared/hub";
import { byDay, dayLabel, displayUrl, type Visit } from "../../shared/visits";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { currentWorkspace, isPrivate, newWebTab, openSettings, workspaces } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { TabIcon } from "./TabIcon";
import { Button, EmptyState, Input } from "./ui";

const PAGE = 100;
/** The most the server returns at once. */
const MAX = 500;

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function BrowsingHistoryPage() {
  const [everywhere, setEverywhere] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [visits, setVisits] = createSignal<Visit[]>([]);
  const [more, setMore] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const workspaceId = () => (everywhere() ? null : (currentWorkspace()?.id ?? null));

  // A newer request replaces an older one still on its way (typing a search).
  let generation = 0;
  /** The first page, older ones (`before`), or a live update (`live`: what's shown is reloaded, older ones stay). */
  const load = async (options: { before?: number; live?: boolean } = {}) => {
    const { before, live } = options;
    if (isPrivate) return;
    const mine = ++generation;
    const limit = before ? PAGE : live ? Math.min(MAX, Math.max(PAGE, visits().length)) : PAGE;
    const page = await api.visits({ workspaceId: workspaceId(), search: search().trim(), before, limit });
    if (mine !== generation) return;
    const last = page.at(-1)?.id;
    const older = live && page.length === limit && last !== undefined ? visits().filter((v) => v.id < last) : [];
    setVisits((list) => (before ? [...list, ...page] : [...page, ...older]));
    if (!older.length) setMore(page.length === limit);
    setLoaded(true);
  };

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on([workspaceId, search], (_, prev) => {
      clearTimeout(searchTimer);
      // Typing waits for a pause; another workspace loads right away.
      if (prev && prev[0] === workspaceId()) searchTimer = setTimeout(() => void load(), 200);
      else void load();
    }),
  );
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(
    watchTopic(topics.visits, (msg) => {
      if (msg.type !== "visits-changed") return;
      if (workspaceId() && msg.workspaceId && msg.workspaceId !== workspaceId()) return;
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => void load({ live: true }), 300);
    }),
  );
  onCleanup(() => {
    clearTimeout(searchTimer);
    clearTimeout(liveTimer);
  });

  const remove = async (visit: Visit) => {
    setVisits((list) => list.filter((v) => v.id !== visit.id));
    await api.deleteVisits(workspaceId(), [visit.id]).catch(() => void load({ live: true }));
  };

  /** In a new tab of the workspace it was visited in; in the background with Ctrl/Cmd or the middle button. */
  const open = (visit: Visit, background: boolean) => {
    const workspaceId = workspaces.some((w) => w.id === visit.workspaceId) ? visit.workspaceId : undefined;
    void newWebTab(visit.url, { workspaceId, background });
  };

  return (
    <div {...stylex.attrs(styles.page)} data-browsing-history>
      <header {...stylex.attrs(styles.header)}>
        <h1 {...stylex.attrs(styles.title)}>History</h1>
        <p {...stylex.attrs(styles.muted)}>
          The pages you visited in web tabs, for the last 90 days. Each workspace keeps its own.
        </p>
      </header>
      {/* Private windows record nothing, and don't show the other windows' history either. */}
      <Show
        when={!isPrivate}
        fallback={
          <p {...stylex.attrs(styles.card, styles.empty)} data-history-private>
            Private windows keep no history. Pages you visit in normal windows are listed there.
          </p>
        }
      >
        <div {...stylex.attrs(styles.filters)}>
          <div {...stylex.attrs(styles.searchBox)}>
            <Icon name="search" size={14} {...stylex.attrs(styles.searchIcon)} />
            <Input
              type="search"
              placeholder="Search history"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              xstyle={styles.search}
              data-history-search
            />
          </div>
          <Show when={workspaces.length > 1}>
            <select
              value={everywhere() ? "all" : "current"}
              onChange={(e) => setEverywhere(e.currentTarget.value === "all")}
              {...stylex.attrs(styles.select)}
              data-history-scope
            >
              <option value="current">{currentWorkspace()?.name ?? "This workspace"}</option>
              <option value="all">All workspaces</option>
            </select>
          </Show>
          {/* Like Chrome's: clearing is one thing, with cookies and the cache, in Privacy and security. */}
          <Button onClick={() => void openSettings("browser-privacy")} data-history-clear>
            <Icon name="trash" size={14} />
            Clear browsing data
          </Button>
        </div>
        <Show
          when={visits().length}
          fallback={
            <Show when={loaded()}>
              <EmptyState
                icon={search().trim() ? "search-x" : "rotate-ccw-clock"}
                title={search().trim() ? "No pages match your search" : "No history yet"}
                hint={search().trim() ? undefined : "Pages you visit in web tabs show up here."}
                data-history-empty
              />
            </Show>
          }
        >
          <For each={byDay(visits())}>
            {(day) => (
              <section {...stylex.attrs(styles.card)} data-history-day={day.key}>
                <h2 {...stylex.attrs(styles.day)}>{dayLabel(day.visits[0]!.visitedAt)}</h2>
                <ul {...stylex.attrs(styles.list)}>
                  <For each={day.visits}>
                    {(visit) => (
                      <li {...stylex.attrs(styles.row)} data-visit={visit.id}>
                        <span {...stylex.attrs(styles.time)}>{time(visit.visitedAt)}</span>
                        <a
                          href={visit.url}
                          title={visit.url}
                          onClick={(e) => {
                            e.preventDefault();
                            open(visit, e.ctrlKey || e.metaKey);
                          }}
                          onAuxClick={(e) => {
                            if (e.button !== 1) return;
                            e.preventDefault();
                            open(visit, true);
                          }}
                          {...stylex.attrs(styles.link)}
                          data-visit-link
                        >
                          <TabIcon
                            tab={{ kind: "web", icon: null, favicon: visit.favicon, url: visit.url }}
                            size={16}
                          />
                          <span {...stylex.attrs(styles.visitTitle)}>{visit.title || displayUrl(visit.url)}</span>
                          <span {...stylex.attrs(styles.host)}>{hostOf(visit.url)}</span>
                        </a>
                        <Show when={everywhere()}>
                          <span {...stylex.attrs(styles.workspace)}>
                            {workspaces.find((w) => w.id === visit.workspaceId)?.name}
                          </span>
                        </Show>
                        <button
                          type="button"
                          title="Remove from history"
                          aria-label="Remove from history"
                          onClick={() => void remove(visit)}
                          {...stylex.attrs(styles.remove)}
                          data-visit-remove
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
          <Show when={more()}>
            <button
              type="button"
              onClick={() => void load({ before: visits().at(-1)?.id })}
              {...stylex.attrs(styles.more)}
            >
              Show older
            </button>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

/** The site of a page ("example.com"), or "File" for a local file. */
const hostOf = (url: string) => {
  if (/^file:/i.test(url)) return "File";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const styles = stylex.create({
  page: {
    boxSizing: "border-box",
    maxWidth: 760,
    marginInline: "auto",
    paddingTop: 36,
    paddingInline: 40,
    paddingBottom: 96,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  header: { display: "flex", flexDirection: "column", gap: space.xs },
  title: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    fontSize: 24,
    fontWeight: 650,
    letterSpacing: "-0.02em",
  },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  filters: { display: "flex", gap: space.sm, alignItems: "center" },
  searchBox: { position: "relative", flex: 1, minWidth: 0 },
  searchIcon: {
    position: "absolute",
    left: 10,
    top: "50%",
    transform: "translateY(-50%)",
    color: colors.muted,
    pointerEvents: "none",
  },
  search: { height: 32, paddingLeft: 30, fontSize: font.sm },
  select: {
    height: 32,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: font.sm,
  },
  card: {
    margin: 0,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  empty: { padding: space.lg, color: colors.muted, fontSize: font.sm, textAlign: "center" },
  day: {
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    fontSize: font.sm,
    fontWeight: 600,
  },
  list: { listStyle: "none", margin: 0, padding: 0 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingInline: space.lg,
    height: 38,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  time: { width: 64, flexShrink: 0, color: colors.muted, fontSize: font.xs, fontVariantNumeric: "tabular-nums" },
  link: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    color: colors.text,
    textDecoration: "none",
    fontSize: font.sm,
    cursor: "pointer",
  },
  visitTitle: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  host: { flexShrink: 0, color: colors.muted, fontSize: font.xs, whiteSpace: "nowrap" },
  workspace: {
    flexShrink: 0,
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: font.xs,
  },
  remove: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.bg },
    color: colors.muted,
    cursor: "pointer",
  },
  more: {
    alignSelf: "center",
    paddingBlock: 6,
    paddingInline: space.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
  },
});
