// The top of the sidebar, like Zen Browser's: the window's close button, the
// agent, extensions, downloads, back, forward, reload and a ⋯ menu (bookmarks, history,
// the tab's own tools…), then the address of the tab on screen (an app's localhost URL).
// Focusing the address pops it out over the page, big, with suggestions from open tabs,
// bookmarks and history (before anything's typed: the pages visited most). Pages get the whole
// content area. Each tab provides what's shown here (lib/tabChrome.ts).
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import { normalizeUrl } from "../../shared/web";
import { isExtensionUrl } from "../../shared/extensions";
import { displayUrl, type VisitSuggestion } from "../../shared/visits";
import { api } from "../lib/api";
import { searchEngine } from "../lib/settings";
import {
  apps,
  currentWorkspace,
  DOWNLOADS_VIEW,
  HISTORY_VIEW,
  isAgentCollapsed,
  isPrivate,
  isTab,
  newWebTab,
  openSettings,
  selectApp,
  selectedId,
  states,
  toggleAgent,
  workspaces,
} from "../lib/store";
import { chromeOf, focusRequest, setAddressHovered } from "../lib/tabChrome";
import { colors, font, radius, space } from "../theme.stylex";
import { DownloadsButton } from "./Downloads";
import { Icon } from "./Icon";
import { TabIcon } from "./TabIcon";
import { WindowControls } from "./WindowControls";
import { BookmarksMenu } from "./Bookmarks";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { allBookmarks, samePage, type BookmarkNode } from "../../shared/bookmarks";
import { bookmarkTree } from "../lib/bookmarks";
import { runShortcut, shortcutLabel, withKeys } from "../lib/shortcuts";
import { openInternalPage } from "../lib/internalPages";
import { newPrivateWindow, newWindow } from "../lib/windows";
import { pageOf } from "../lib/webtabs";

interface Suggestion {
  key: string;
  icon: () => JSX.Element;
  title: string;
  detail: string;
  /** The address it opens (a bookmark, a page from history): Alt+Enter opens it in a new tab. */
  url?: string;
  run: () => void;
}

/** History suggestions shown at once (open tabs come first). */
const HISTORY_SUGGESTIONS = 5;
/** Pages from history shown when the address opens, before anything's typed. */
const RECENT_SUGGESTIONS = 6;
const BOOKMARK_SUGGESTIONS = 4;

/**
 * The strip the window is dragged by, like Zen Browser's: the close button
 * (macOS: its own traffic lights), the agent, the tab's extensions (once there are
 * any) and downloads (once there are any), then back, forward, reload and the ⋯ menu.
 */
export function NavRow(props: { compact: boolean }) {
  const chrome = () => chromeOf(selectedId());
  const tabId = () => (isTab(selectedId()) ? selectedId()! : null);
  const agentHidden = () => !!tabId() && isAgentCollapsed(tabId()!);
  const agentShown = () => !!tabId() && !isAgentCollapsed(tabId()!);
  const working = () => !!tabId() && !!states[tabId()!]?.running;
  return (
    <div {...stylex.attrs(styles.nav, props.compact && styles.navCompact)} data-titlebar data-nav-row>
      <WindowControls />
      <Show when={isPrivate}>
        {/* Clearly marked, like Chrome's incognito: nothing of it is kept, and agents don't see it. */}
        <span
          {...stylex.attrs(styles.privateBadge, props.compact && styles.privateBadgeCompact)}
          title="Private window: its history, cookies and site data are gone when it closes, and agents don't see it"
          data-private-badge
        >
          <Icon name="hat-glasses" size={15} />
          <Show when={!props.compact}>Private</Show>
        </span>
      </Show>
      <Show when={!props.compact}>
        <Show when={tabId() && !isPrivate}>
          <button
            type="button"
            title={withKeys(agentHidden() ? "Show the agent" : "Hide the agent", "agent.toggle")}
            onClick={() => toggleAgent(tabId()!)}
            {...stylex.attrs(styles.navButton, styles.agentButton, agentShown() && styles.agentOn)}
            data-agent-show={agentHidden() ? "" : undefined}
          >
            <Icon name="bot" size={16} />
            <Show when={working()}>
              <span {...stylex.attrs(styles.workingDot)} />
            </Show>
          </button>
        </Show>
        {/* Keyed: the tab on screen changes, and with it its extensions. */}
        <Show when={chrome()?.extensions} keyed>
          {(extensions) => extensions()}
        </Show>
        <DownloadsButton />
        <span {...stylex.attrs(styles.spacer)} />
        <button
          type="button"
          title="Back (Alt+←)"
          disabled={!chrome()?.canBack()}
          onClick={() => chrome()?.back()}
          {...stylex.attrs(styles.navButton)}
          data-back
        >
          <Icon name="arrow-left" size={16} />
        </button>
        <button
          type="button"
          title="Forward (Alt+→)"
          disabled={!chrome()?.canForward()}
          onClick={() => chrome()?.forward()}
          {...stylex.attrs(styles.navButton)}
          data-forward
        >
          <Icon name="arrow-right" size={16} />
        </button>
        <Show
          when={chrome()?.loading() && chrome()?.stop}
          fallback={
            <button
              type="button"
              title={withKeys("Reload", "nav.reload")}
              disabled={!chrome()}
              onClick={() => chrome()?.reload()}
              {...stylex.attrs(styles.navButton)}
              data-reload
            >
              <Icon name="rotate-cw" size={15} />
            </button>
          }
        >
          <button type="button" title="Stop" onClick={() => chrome()?.stop?.()} {...stylex.attrs(styles.navButton)}>
            <Icon name="x" size={16} />
          </button>
        </Show>
        <MoreMenu />
      </Show>
    </div>
  );
}

/**
 * The ⋯ at the end of the top row, like Chrome's ⋮ and Zen's menu: new tabs and
 * windows, bookmarks, history, downloads and extensions, what the browser does
 * to the page (find, zoom, print), the tab's own tools (an app's logs, data,
 * secrets…), Settings. One button instead of a row of them.
 */
function MoreMenu() {
  const [at, setAt] = createSignal<MenuPosition>();
  const [bookmarksAt, setBookmarksAt] = createSignal<MenuPosition>();
  let button!: HTMLButtonElement;
  const tabId = () => (isTab(selectedId()) ? selectedId() : null);
  const hint = (id: string) => shortcutLabel(id);
  /** What the browser does to the tab's page (its keyboard shortcuts' actions), where it has one. */
  const pageItems = (): (MenuItem | "separator")[] => {
    const id = tabId();
    if (!id || !pageOf(id)?.view()) return [];
    const item = (shortcut: string, label: string, icon: string): MenuItem => ({
      id: shortcut,
      label,
      icon,
      hint: hint(shortcut),
      onSelect: () => void runShortcut(shortcut, { tabId: id, source: "window" }),
    });
    return [
      "separator",
      item("find.open", "Find in page…", "search"),
      item("zoom.in", "Zoom in", "zoom-in"),
      item("zoom.out", "Zoom out", "zoom-out"),
      item("page.print", "Print…", "printer"),
    ];
  };
  const items = (): (MenuItem | "separator")[] => {
    const tab = chromeOf(selectedId())?.menu?.() ?? [];
    return [
      { id: "new-tab", label: "New tab", icon: "plus", hint: hint("tab.new"), onSelect: () => void newWebTab() },
      { id: "new-window", label: "New window", icon: "app-window", hint: hint("window.new"), onSelect: newWindow },
      {
        id: "new-private-window",
        label: "New private window",
        icon: "hat-glasses",
        hint: hint("window.private"),
        onSelect: newPrivateWindow,
      },
      "separator",
      {
        id: "bookmarks",
        label: "Bookmarks",
        icon: "bookmark",
        // Its own menu, where this one was.
        onSelect: () => {
          const r = button.getBoundingClientRect();
          setBookmarksAt({ x: r.left, y: r.bottom + 4 });
        },
      },
      {
        id: "history",
        label: "History",
        icon: "rotate-ccw-clock",
        hint: hint("open.history"),
        onSelect: () => void selectApp(HISTORY_VIEW),
      },
      {
        id: "downloads",
        label: "Downloads",
        icon: "download",
        hint: hint("open.downloads"),
        onSelect: () => void selectApp(DOWNLOADS_VIEW),
      },
      { id: "extensions", label: "Extensions", icon: "puzzle", onSelect: () => openSettings("extensions") },
      ...pageItems(),
      ...(tab.length ? (["separator", ...tab] as const) : []),
      "separator",
      {
        id: "settings",
        label: "Settings",
        icon: "settings",
        hint: hint("open.settings"),
        onSelect: () => openSettings(),
      },
    ];
  };
  return (
    <>
      <button
        type="button"
        ref={button}
        title="More: bookmarks, history, downloads, the tab's tools, settings"
        aria-haspopup="menu"
        aria-expanded={!!at()}
        onClick={() => {
          if (at()) return setAt();
          const r = button.getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
        {...stylex.attrs(styles.navButton, !!at() && styles.navButtonOn)}
        data-more-menu
      >
        <Icon name="ellipsis" size={16} />
      </button>
      <Show when={at()} keyed>
        {(position) => <ContextMenu items={items()} position={position} anchor={button} onClose={() => setAt()} />}
      </Show>
      <Show when={bookmarksAt()} keyed>
        {(position) => <BookmarksMenu position={position} onClose={() => setBookmarksAt()} />}
      </Show>
    </>
  );
}

/**
 * The address of the tab on screen, compact in the sidebar (without its scheme). Focused,
 * it pops out over the page like Zen's: big, centered near the top, with suggestions under
 * it: open tabs (all workspaces), bookmarks, pages from the workspace's history, the URL,
 * a search; before anything's typed, the pages visited most often and lately.
 */
export function AddressBar() {
  const chrome = () => chromeOf(selectedId());
  const [text, setText] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  // The suggestion picked with the arrow keys or the mouse (by key: pages from history arrive
  // later and move the others), or the first.
  const [picked, setPicked] = createSignal<string>();
  // Something was typed since it opened (until then it shows the address, selected, and the recent pages).
  const [typed, setTyped] = createSignal(false);
  let input!: HTMLInputElement;

  // Shows the tab's address unless you're typing.
  createEffect(() => {
    const url = chrome()?.url() ?? "";
    if (!editing()) setText(url);
  });
  createEffect(on(focusRequest, () => focus(), { defer: true }));
  // Another tab on screen: what was being typed for the last one goes (a new blank tab takes the focus again below).
  createEffect(on(selectedId, () => editing() && finish(), { defer: true }));
  // A new web tab starts here.
  createEffect(
    on(
      () => [selectedId(), chrome()?.blank?.()] as const,
      ([, blank]) => blank && queueMicrotask(focus),
    ),
  );

  function focus() {
    input.focus();
    input.select();
  }

  // A web tab's site settings button stays while it loads (it shows the spinner itself).
  const loadingShown = () => !editing() && !chrome()?.identity && !!chrome()?.loading();
  const notSecure = () => !editing() && !!chrome()?.notSecure?.();
  const query = () => (editing() && typed() ? text().trim() : "");
  /**
   * In the sidebar the address is shown without its scheme, like Zen's (in full while editing,
   * and for a page that isn't secure: its http:// is the warning).
   */
  const shownText = () => (editing() || notSecure() ? text() : displayUrl(text()));

  // Pages from history for what's typed, fetched after a short pause (none in private windows);
  // with nothing typed, the pages visited most. Until the answer comes, the last ones that still
  // match stay, so the list doesn't flicker.
  const [visited, setVisited] = createSignal<VisitSuggestion[]>([]);
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on([query, editing, () => currentWorkspace()?.id], ([q, open, workspaceId]) => {
      clearTimeout(historyTimer);
      if (!open || !workspaceId || isPrivate) return setVisited([]);
      historyTimer = setTimeout(
        () => {
          api.suggestVisits(workspaceId, q, (q ? HISTORY_SUGGESTIONS : RECENT_SUGGESTIONS) + 3).then(
            (pages) => editing() && query() === q && setVisited(pages),
            () => {},
          );
        },
        q ? 60 : 0,
      );
    }),
  );
  onCleanup(() => clearTimeout(historyTimer));
  const matches = (page: VisitSuggestion, words: string[]) =>
    words.every((w) => page.title.toLowerCase().includes(w) || page.url.toLowerCase().includes(w));
  const historySuggestion = (page: VisitSuggestion): Suggestion => ({
    key: `history:${page.url}`,
    icon: () => <TabIcon tab={{ kind: "web", icon: null, favicon: page.favicon, url: page.url }} size={14} />,
    title: page.title || displayUrl(page.url),
    detail: displayUrl(page.url).slice(0, 80),
    url: page.url,
    run: () => open(page.url),
  });
  /** Nothing typed yet: the pages visited most often and lately (not the one on screen). */
  const recent = (): Suggestion[] => {
    const here = chrome()?.url();
    return visited()
      .filter((p) => !here || samePage(p.url) !== samePage(here))
      .slice(0, RECENT_SUGGESTIONS)
      .map(historySuggestion);
  };
  const suggestions = (): Suggestion[] => {
    const q = query();
    if (!q) return editing() ? recent() : [];
    const lower = q.toLowerCase();
    const out: Suggestion[] = [];
    const target = isExtensionUrl(q) ? q : normalizeUrl(q, searchEngine().url);
    const searching = target.startsWith(searchEngine().url.split("%s")[0]!) && !/^https?:\/\//i.test(q);
    if (!searching)
      out.push({
        key: "go",
        icon: () => <Icon name="globe" size={14} />,
        title: target,
        detail: "Open",
        run: () => open(target, q),
      });
    // Open tabs, in every workspace.
    const tabs = apps
      .filter(
        (t) =>
          t.id !== selectedId() &&
          (t.name.toLowerCase().includes(lower) || (t.url ?? "").toLowerCase().includes(lower)),
      )
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)))
      .slice(0, 6);
    for (const tab of tabs) {
      const space = workspaces.find((w) => w.id === tab.workspaceId);
      out.push({
        key: `tab:${tab.id}`,
        icon: () => <TabIcon tab={tab} size={14} />,
        title: tab.name,
        detail: `Switch to tab${workspaces.length > 1 && space ? ` · ${space.name}` : ""}${tab.url ? ` · ${tab.url.replace(/^https?:\/\//, "").slice(0, 60)}` : ""}`,
        run: () => void selectApp(tab.id),
      });
    }
    // Bookmarks, then pages from history, for every word typed (in the name or the address without
    // its scheme); none of them twice, nor the pages open in a tab or the address typed.
    const words = lower.split(/\s+/).filter(Boolean);
    const shown = new Set([target, ...tabs.flatMap((t) => (t.url ? [t.url] : []))].map(samePage));
    const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
    const startsWith = (b: BookmarkNode) => b.title.toLowerCase().startsWith(lower) || bare(b.url!).startsWith(lower);
    const marks: BookmarkNode[] = [];
    for (const mark of allBookmarks(bookmarkTree())
      .filter((b) => words.every((w) => b.title.toLowerCase().includes(w) || bare(b.url!).includes(w)))
      .sort((a, b) => Number(!startsWith(a)) - Number(!startsWith(b)))) {
      if (marks.length === BOOKMARK_SUGGESTIONS) break;
      if (shown.has(samePage(mark.url!))) continue;
      shown.add(samePage(mark.url!));
      marks.push(mark);
    }
    for (const mark of marks)
      out.push({
        key: `bookmark:${mark.id}`,
        icon: () => <Icon name="star" size={14} />,
        title: mark.title || displayUrl(mark.url!),
        detail: `Bookmark · ${displayUrl(mark.url!).slice(0, 70)}`,
        url: mark.url,
        run: () => open(mark.url!),
      });
    const pages = visited()
      .filter((p) => !shown.has(samePage(p.url)) && matches(p, words))
      .slice(0, HISTORY_SUGGESTIONS);
    for (const page of pages) out.push(historySuggestion(page));
    out.push({
      key: "search",
      icon: () => <Icon name="search" size={14} />,
      title: q,
      detail: `Search with ${searchEngine().label}`,
      run: () => open(normalizeUrl(q, searchEngine().url)),
    });
    // Typed words (not an address): the matching tabs and bookmarks first, then the search, unless
    // a page from history is the site being typed ("git" → github.com).
    const typedSite = (url: string) =>
      displayUrl(url).toLowerCase().startsWith(lower) || displayUrl(url).toLowerCase().startsWith(`www.${lower}`);
    if (searching && !tabs.length && !marks.length && !(pages[0] && typedSite(pages[0].url))) out.unshift(out.pop()!);
    // A bare path ("/act") is more likely part of an open tab's address than a local file: tabs first.
    if (!searching && tabs.length && /^file:/i.test(target) && !/^file:/i.test(q))
      out.splice(tabs.length, 0, out.shift()!);
    return out;
  };

  /**
   * In this tab when it can (a web tab), else in a new web tab. A typed path goes to the
   * app on screen first (its preview); elsewhere it's a local file.
   */
  function open(target: string, typed?: string) {
    if (openInternalPage(target)) return;
    const c = chrome();
    if (typed?.startsWith("/") && c?.go?.(typed)) return;
    if (!(c?.go && c.go(target))) void newWebTab(target);
  }

  /** Losing the focus closes it a moment later, unless it gets the focus back first (Ctrl+T, Ctrl+L right after). */
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(blurTimer));
  const start = () => {
    clearTimeout(blurTimer);
    if (editing()) return;
    setEditing(true);
    setTyped(false);
    setPicked(undefined);
  };
  const finish = () => {
    setEditing(false);
    setTyped(false);
    setText(chrome()?.url() ?? "");
    input.blur();
  };
  const run = (s: Suggestion | undefined) => {
    if (!s) return;
    s.run();
    finish();
  };
  /**
   * Enter with modifiers, like in Chromium: Ctrl+Enter makes "example" www.example.com,
   * Alt+Enter (Cmd+Enter on macOS) and Shift+Enter open in a new tab. True if it handled it.
   */
  const enterWith = (e: KeyboardEvent) => {
    const typed = text().trim();
    const newTab = window.rune.window.platform === "darwin" ? e.metaKey : e.altKey || e.shiftKey;
    const complete = e.ctrlKey && !e.metaKey && /^[\w-]+$/.test(typed);
    if (!typed || (!newTab && !complete)) return false;
    e.preventDefault();
    const chosen = list()[active()];
    // A suggested tab is switched to, wherever it is.
    if (!complete && chosen?.key.startsWith("tab:")) {
      run(chosen);
      return true;
    }
    const target = complete
      ? `https://www.${typed}.com/`
      : chosen?.key === "go"
        ? chosen.title
        : chosen?.url
          ? chosen.url
          : isExtensionUrl(typed)
            ? typed
            : normalizeUrl(typed, searchEngine().url);
    if (newTab && !openInternalPage(target)) void newWebTab(target);
    else if (!newTab) open(target, typed);
    finish();
    return true;
  };
  const list = createMemo(() => suggestions());
  // With something typed the first suggestion is what Enter does; before that, only one picked
  // with the arrow keys or the mouse (Enter goes to the address shown).
  const active = () => {
    const i = list().findIndex((s) => s.key === picked());
    return i === -1 && query() ? 0 : i;
  };
  const setActive = (i: number) => setPicked(list()[i]?.key);
  const isActive = (i: number) => i === active();
  const floating = () => editing();
  const hasList = () => editing() && list().length > 0;

  return (
    <div {...stylex.attrs(styles.addressSlot)} data-address-slot>
      <Show when={floating()}>
        {/* Clicking outside closes it (and isn't a click on what's under it). Not portaled: it stays under the address. */}
        <div
          {...stylex.attrs(styles.backdrop)}
          onMouseDown={(e) => {
            e.preventDefault();
            finish();
          }}
          data-address-backdrop
        />
      </Show>
      <form
        {...stylex.attrs(styles.address, floating() && styles.addressFloating)}
        onSubmit={(e) => {
          e.preventDefault();
          const chosen = list()[active()];
          if (chosen) return run(chosen);
          const typed = text().trim();
          if (!typed) return;
          open(isExtensionUrl(typed) ? typed : normalizeUrl(typed, searchEngine().url), typed);
          finish();
        }}
        // Open, a click anywhere in it (its padding, the icon, the list's heading) keeps typing in the input.
        onMouseDown={(e) => {
          if (!floating() || e.target === input) return;
          e.preventDefault();
          input.focus();
        }}
        onMouseEnter={() => setAddressHovered(true)}
        onMouseLeave={() => setAddressHovered(false)}
        data-address-bar
        data-address-open={floating() ? "" : undefined}
        data-address-icon={chrome()?.icon()}
      >
        <div {...stylex.attrs(styles.addressRow, floating() && styles.addressRowFloating)}>
          {/* While the page loads, a spinner in place of its icon (the address bar is the toolbar). */}
          <Switch
            fallback={
              <Show
                when={!editing() && chrome()?.identity}
                keyed
                fallback={
                  <Icon
                    name={editing() ? "search" : (chrome()?.icon() ?? "search")}
                    size={floating() ? 16 : 13}
                    {...stylex.attrs(styles.addressIcon, notSecure() && styles.notSecure)}
                  />
                }
              >
                {(identity) => identity()}
              </Show>
            }
          >
            <Match when={loadingShown()}>
              <Icon
                name="loader-circle"
                size={13}
                {...stylex.attrs(styles.addressIcon, styles.spinning)}
                data-address-loading
              />
            </Match>
          </Switch>
          <Show when={notSecure()}>
            <span
              title="The connection to this site isn't encrypted: others on the network can see and change what you send and get"
              {...stylex.attrs(styles.notSecureLabel)}
              data-not-secure
            >
              Not secure
            </span>
          </Show>
          <input
            ref={input}
            value={shownText()}
            placeholder="Search or enter an address"
            spellcheck={false}
            onFocus={(e) => {
              start();
              // The full address (it was shown without its scheme), selected to type over.
              e.currentTarget.value = text();
              e.currentTarget.select();
            }}
            onBlur={() => {
              clearTimeout(blurTimer);
              blurTimer = setTimeout(() => editing() && finish(), 120);
            }}
            onInput={(e) => {
              // Typing is editing, whether or not the focus event came first.
              start();
              setTyped(true);
              setText(e.currentTarget.value);
              setPicked(undefined);
            }}
            onKeyDown={(e) => {
              const n = list().length;
              if (e.key === "Escape") return finish();
              if (e.key === "Enter" && enterWith(e)) return;
              if (!n) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const from = active();
                setActive(
                  from === -1 ? (e.key === "ArrowDown" ? 0 : n - 1) : (from + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
                );
              }
            }}
            {...stylex.attrs(styles.addressInput, floating() && styles.addressInputFloating)}
            data-address
          />
          {/* Keyed: the tab on screen changes, and with it what's shown here. */}
          <Show when={!editing() && chrome()?.addressExtras} keyed>
            {(extras) => extras()}
          </Show>
        </div>
        <Show when={hasList()}>
          <div role="listbox" {...stylex.attrs(styles.suggestions)} data-suggestions>
            <Show when={!query()}>
              <div {...stylex.attrs(styles.suggestionsHeading)}>Visited often</div>
            </Show>
            <For each={list()}>
              {(s, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive(i())}
                  // The arrow keys move through them; Tab goes on past the address.
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i())}
                  onClick={() => run(s)}
                  {...stylex.attrs(styles.suggestion, isActive(i()) && styles.suggestionOn)}
                  data-suggestion={s.key}
                  data-suggestion-url={s.url}
                >
                  <span {...stylex.attrs(styles.suggestionIcon)}>{s.icon()}</span>
                  <span {...stylex.attrs(styles.suggestionTitle)}>{s.title}</span>
                  <span {...stylex.attrs(styles.suggestionDetail)}>{s.detail}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </form>
    </div>
  );
}

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

const popOut = stylex.keyframes({
  from: { transform: "translateX(-50%) scale(0.97)" },
  to: { transform: "translateX(-50%) scale(1)" },
});

const pulse = stylex.keyframes({ "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } });

const styles = stylex.create({
  privateBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    height: 24,
    paddingInline: 8,
    borderRadius: 999,
    // Fixed colors: it reads as "private" whatever the theme.
    backgroundColor: "#2e1f5e",
    color: "#e4dcff",
    fontSize: font.sm,
    fontWeight: 600,
  },
  privateBadgeCompact: { paddingInline: 5 },
  nav: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    height: 40,
    marginTop: `calc(-1 * ${space.md})`,
    marginInline: `calc(-1 * ${space.md})`,
    paddingInline: 10,
  },
  navCompact: { justifyContent: "center", marginInline: -8, paddingInline: 0 },
  navButton: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text, ":disabled": colors.border },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  navButtonOn: { backgroundColor: colors.surfaceHover, color: colors.text },
  agentButton: { color: { default: colors.muted, ":hover": colors.text } },
  agentOn: { color: { default: colors.accent, ":hover": colors.accent } },
  workingDot: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 6,
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  spacer: { flex: 1 },
  // Keeps the address's place in the sidebar while it floats.
  addressSlot: { position: "relative", flexShrink: 0, height: 32 },
  address: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: 32,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: colors.surface,
    boxShadow: `0 0 0 1px ${colors.border}`,
    fontFamily: font.sans,
  },
  // Focused: over the page, centered near the top of the window, like Zen's address bar.
  addressFloating: {
    position: "fixed",
    zIndex: 1500,
    top: "max(56px, 14vh)",
    left: "50%",
    transform: "translateX(-50%)",
    width: "min(720px, calc(100vw - 48px))",
    height: "auto",
    maxHeight: "calc(100vh - 14vh - 24px)",
    overflow: "hidden",
    borderRadius: radius.lg,
    borderColor: colors.accent,
    boxShadow: "0 24px 64px rgb(0 0 0 / 0.28), 0 4px 16px rgb(0 0 0 / 0.12)",
    animationName: popOut,
    animationDuration: "120ms",
    animationTimingFunction: "ease-out",
  },
  addressRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    height: 30,
    paddingInline: 10,
  },
  addressRowFloating: { height: 50, gap: 10, paddingInline: 16 },
  backdrop: { position: "fixed", inset: 0, zIndex: 1499, backgroundColor: "rgb(0 0 0 / 0.12)" },
  addressIcon: { flexShrink: 0, color: colors.muted },
  notSecure: { color: colors.warning },
  notSecureLabel: {
    flexShrink: 0,
    paddingRight: 6,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    color: colors.warning,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  spinning: {
    color: colors.accent,
    animationName: spin,
    animationDuration: "0.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
    textOverflow: "ellipsis",
  },
  addressInputFloating: { fontSize: 15 },
  suggestions: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflowY: "auto",
    padding: 6,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  suggestionsHeading: {
    paddingInline: space.sm,
    paddingBlock: 4,
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 600,
  },
  suggestion: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: 38,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
  },
  suggestionOn: { backgroundColor: colors.surfaceHover },
  suggestionIcon: { display: "grid", placeItems: "center", width: 18, flexShrink: 0, color: colors.muted },
  suggestionTitle: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
  },
  suggestionDetail: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.muted,
    fontSize: font.xs,
  },
});
