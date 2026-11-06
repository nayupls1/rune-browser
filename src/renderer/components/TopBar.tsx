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
import { isSidebarHidden, toggleSidebar } from "../lib/layout";
import { colors, font, radius, space } from "../theme.stylex";
import { DownloadsButton } from "./Downloads";
import { Icon } from "./Icon";
import { TabIcon } from "./TabIcon";
import { WindowControls } from "./WindowControls";
import { BookmarksMenu } from "./Bookmarks";
import { ContextMenu, menuAt, type MenuItem, type MenuPosition } from "./ContextMenu";
import { allBookmarks, samePage, type BookmarkNode } from "../../shared/bookmarks";
import { bookmarkTree } from "../lib/bookmarks";
import { runShortcut, shortcutLabel, withKeys } from "../lib/shortcuts";
import { openInternalPage } from "../lib/internalPages";
import { newPrivateWindow, newWindow } from "../lib/windows";
import { pageOf } from "../lib/webtabs";

interface Suggestion {
  key: string;
  /** What Enter does with it, shown on the picked one ("Switch to tab"). */
  action: string;
  icon: () => JSX.Element;
  title: string;
  detail: string;
  /** The address it opens (a bookmark, a page from history): Alt+Enter opens it in a new tab. */
  url?: string;
  run: () => void;
}

/** The address is popped out over the page (being typed in). */
const [addressOpen, setAddressOpen] = createSignal(false);
export { addressOpen };

/** History suggestions shown at once (open tabs come first). */
const HISTORY_SUGGESTIONS = 5;
/** Pages from history shown when the address opens, before anything's typed. */
const RECENT_SUGGESTIONS = 5;
const BOOKMARK_SUGGESTIONS = 4;

/**
 * The strip the window is dragged by, like Zen Browser's: the window's three buttons
 * (macOS: its own traffic lights), then hiding the sidebar, back, forward and reload.
 * The agent and the ⋯ menu are at the bottom of the sidebar; extensions and downloads
 * at the end of the address.
 */
export function NavRow() {
  return (
    <div {...stylex.attrs(styles.nav)} data-titlebar data-nav-row>
      <WindowControls />
      <Show when={isPrivate}>
        {/* Clearly marked, like Chrome's incognito: nothing of it is kept, and agents don't see it. */}
        <span
          {...stylex.attrs(styles.privateBadge)}
          title="Private window: its history, cookies and site data are gone when it closes, and agents don't see it"
          data-private-badge
        >
          <Icon name="hat-glasses" size={14} />
        </span>
      </Show>
      <span {...stylex.attrs(styles.spacer)} />
      <button
        type="button"
        title={withKeys(isSidebarHidden() ? "Keep the sidebar shown" : "Hide the sidebar", "sidebar.toggle")}
        aria-label={isSidebarHidden() ? "Keep the sidebar shown" : "Hide the sidebar"}
        aria-pressed={isSidebarHidden()}
        onClick={toggleSidebar}
        {...stylex.attrs(styles.navButton)}
        data-sidebar-toggle
      >
        <Icon name={isSidebarHidden() ? "panel-left-open" : "panel-left"} size={15} />
      </button>
      <NavButtons />
    </div>
  );
}

/** Back, forward and reload (stop while it loads) for the tab on screen. */
export function NavButtons() {
  const chrome = () => chromeOf(selectedId());
  return (
    <>
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
    </>
  );
}

/** The agent of the tab on screen (Ctrl+I), with a dot while it works. Not in private windows. */
export function AgentButton() {
  const tabId = () => (isTab(selectedId()) ? selectedId()! : null);
  const agentHidden = () => !!tabId() && isAgentCollapsed(tabId()!);
  const agentShown = () => !!tabId() && !isAgentCollapsed(tabId()!);
  const working = () => !!tabId() && !!states[tabId()!]?.running;
  return (
    <Show when={tabId() && !isPrivate}>
      <button
        type="button"
        title={withKeys(agentHidden() ? "Show the agent" : "Hide the agent", "agent.toggle")}
        onClick={() => toggleAgent(tabId()!)}
        {...stylex.attrs(styles.navButton, styles.footerButton, agentShown() && styles.agentOn)}
        data-agent-show={agentHidden() ? "" : undefined}
      >
        <Icon name="bot" size={17} />
        <Show when={working()}>
          <span {...stylex.attrs(styles.workingDot)} />
        </Show>
      </button>
    </Show>
  );
}

/**
 * The ⋯ at the bottom left of the sidebar, like Chrome's ⋮ and Zen's menu: new tabs and
 * windows, bookmarks, history, downloads and extensions, what the browser does
 * to the page (find, zoom, print), the tab's own tools (an app's logs, data,
 * secrets…), Settings. One button instead of a row of them.
 */
export function MoreMenu() {
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
          setBookmarksAt(menuAt(button, 6));
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
          setAt(menuAt(button, 6));
        }}
        {...stylex.attrs(styles.navButton, styles.footerButton, !!at() && styles.navButtonOn)}
        data-more-menu
      >
        <Icon name="ellipsis" size={17} />
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
export function AddressBar(props: { inline?: boolean }) {
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
    // Popped out first: a hidden sidebar lets its address be focused only once it's open (it's inert otherwise).
    start();
    // Inside a batch (a shortcut, an effect) the sidebar's `inert` goes only after it: lift it now.
    input.closest("[inert]")?.removeAttribute("inert");
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
  /**
   * At rest, a web address reads as its site, with the rest of it quieter (like Zen's and
   * Safari's): drawn over the field, whose own text is then hidden.
   */
  const parts = () => {
    if (editing() || notSecure()) return null;
    const shown = shownText();
    const m = /^([^/?#]+)(.*)$/.exec(shown);
    if (!m || !/^https?:/i.test(text())) return null;
    return { host: m[1]!.replace(/^www\./, ""), rest: m[2] === "/" ? "" : m[2]! };
  };
  const showParts = () => !!parts();
  /** The site, shown faintly in the address's place while it's popped out. */
  const ghostHost = () => {
    const url = chrome()?.url() ?? "";
    return /^https?:/i.test(url) ? (/^[^/?#]+/.exec(displayUrl(url))?.[0] ?? "").replace(/^www\./, "") : "";
  };

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
    action: "Open",
    icon: () => <TabIcon tab={{ kind: "web", icon: null, favicon: page.favicon, url: page.url }} size={16} />,
    title: page.title || displayUrl(page.url),
    detail: displayUrl(page.url).slice(0, 80),
    url: page.url,
    run: () => open(page.url),
  });
  const tabSuggestion = (tab: (typeof apps)[number]): Suggestion => {
    const space = workspaces.find((w) => w.id === tab.workspaceId);
    return {
      key: `tab:${tab.id}`,
      action: "Switch to tab",
      icon: () => <TabIcon tab={tab} size={16} />,
      title: tab.name,
      // The workspace only when it's another one than this window's.
      detail: [
        space && space.id !== currentWorkspace()?.id ? space.name : "",
        tab.url ? displayUrl(tab.url).slice(0, 60) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      run: () => void selectApp(tab.id),
    };
  };
  /** Nothing typed yet: the pages visited most often and lately; a page open in a tab (a pinned one…) switches to it. */
  const recent = (): Suggestion[] => {
    const here = chrome()?.url();
    return (
      visited()
        .filter((p) => !here || samePage(p.url) !== samePage(here))
        .slice(0, RECENT_SUGGESTIONS)
        .map((page) => {
          const open = apps.find((t) => t.id !== selectedId() && !!t.url && samePage(t.url) === samePage(page.url));
          return open ? tabSuggestion(open) : historySuggestion(page);
        })
        // Two pages from history can be one open tab.
        .filter((s, i, all) => all.findIndex((o) => o.key === s.key) === i)
    );
  };
  const suggestions = (): Suggestion[] => {
    const q = query();
    if (!q) return editing() ? recent() : [];
    const lower = q.toLowerCase();
    const out: Suggestion[] = [];
    const typedSite = (url: string) =>
      displayUrl(url).toLowerCase().startsWith(lower) || displayUrl(url).toLowerCase().startsWith(`www.${lower}`);

    const target = isExtensionUrl(q) ? q : normalizeUrl(q, searchEngine().url);
    const searching = target.startsWith(searchEngine().url.split("%s")[0]!) && !/^https?:\/\//i.test(q);
    if (!searching)
      out.push({
        key: "go",
        action: "Open",
        icon: () => <Icon name="globe" size={15} />,
        title: target,
        detail: "",
        run: () => open(target, q),
      });
    // Open tabs, in every workspace.
    // One or two letters match the start of a word or of the site (not any letter anywhere); longer, anything.
    const short = lower.length < 3;
    const wordStarts = (text: string) =>
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .some((w) => w.startsWith(lower));
    const hit = (name: string, url?: string | null) =>
      short
        ? wordStarts(name) ||
          (!!url &&
            displayUrl(url)
              .toLowerCase()
              .replace(/^www\./, "")
              .startsWith(lower))
        : name.toLowerCase().includes(lower) || (url ?? "").toLowerCase().includes(lower);
    const tabs = apps
      .filter((t) => t.id !== selectedId() && hit(t.name, t.url))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)))
      .slice(0, 6);
    for (const tab of tabs) out.push(tabSuggestion(tab));
    // Bookmarks, then pages from history, for every word typed (in the name or the address without
    // its scheme); none of them twice, nor the pages open in a tab or the address typed.
    const words = lower.split(/\s+/).filter(Boolean);
    const shown = new Set([target, ...tabs.flatMap((t) => (t.url ? [t.url] : []))].map(samePage));
    const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
    const startsWith = (b: BookmarkNode) => b.title.toLowerCase().startsWith(lower) || bare(b.url!).startsWith(lower);
    const marks: BookmarkNode[] = [];
    for (const mark of allBookmarks(bookmarkTree())
      .filter((b) =>
        short ? hit(b.title, b.url) : words.every((w) => b.title.toLowerCase().includes(w) || bare(b.url!).includes(w)),
      )
      .sort((a, b) => Number(!startsWith(a)) - Number(!startsWith(b)))) {
      if (marks.length === BOOKMARK_SUGGESTIONS) break;
      if (shown.has(samePage(mark.url!))) continue;
      shown.add(samePage(mark.url!));
      marks.push(mark);
    }
    for (const mark of marks)
      out.push({
        key: `bookmark:${mark.id}`,
        action: "Open",
        icon: () => <Icon name="star" size={15} />,
        title: mark.title || displayUrl(mark.url!),
        detail: displayUrl(mark.url!).slice(0, 70),
        url: mark.url,
        run: () => open(mark.url!),
      });
    // Not the page on screen either (Enter on it would only reload it).
    const here = chrome()?.url();
    const pages = visited()
      .filter(
        (p) =>
          !shown.has(samePage(p.url)) &&
          (!here || samePage(p.url) !== samePage(here)) &&
          (short ? hit(p.title, p.url) : matches(p, words)),
      )
      .slice(0, HISTORY_SUGGESTIONS);
    for (const page of pages) out.push(historySuggestion(page));
    out.push({
      key: "search",
      action: "Search",
      icon: () => <Icon name="search" size={15} />,
      title: q,
      detail: `${searchEngine().label} search`,
      run: () => open(normalizeUrl(q, searchEngine().url)),
    });
    // Typed words (not an address): the matching tabs and bookmarks first, then the search, unless
    // a page from history is the site being typed ("git" → github.com).
    // A tab or bookmark goes first (what Enter does) only when its name or site starts with what's typed;
    // a letter that's merely somewhere in a title searches, like Firefox's and Zen's address bars.
    const leads = (name: string, url?: string | null) =>
      name.toLowerCase().startsWith(lower) || (!!url && typedSite(url));
    const strong =
      tabs.some((t) => leads(t.name, t.url)) ||
      marks.some((m) => leads(m.title, m.url)) ||
      (!!pages[0] && typedSite(pages[0].url));
    if (searching && !strong) out.unshift(out.pop()!);
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
    setAddressOpen(true);
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
  // In the bar with horizontal tabs, while it isn't popped out.
  const compact = () => !!props.inline && !floating();
  createEffect(() => setAddressOpen(editing()));
  const hasList = () => editing() && list().length > 0;

  return (
    <div {...stylex.attrs(styles.addressSlot, props.inline && styles.addressSlotInline)} data-address-slot>
      <Show when={floating()}>
        {/* Its place in the sidebar, faint while it's popped out. */}
        <div {...stylex.attrs(styles.ghost)} aria-hidden="true">
          <Icon name="globe" size={13} />
          {ghostHost()}
        </div>
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
        {...stylex.attrs(styles.address, compact() && styles.addressCompact, floating() && styles.addressFloating)}
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
        <div
          {...stylex.attrs(
            styles.addressRow,
            compact() && styles.addressCompact,
            floating() && styles.addressRowFloating,
          )}
        >
          {/* While the page loads, a spinner in place of its icon (the address bar is the toolbar). */}
          <Switch
            fallback={
              <Show
                when={!editing() && chrome()?.identity}
                keyed
                fallback={
                  <Icon
                    name={editing() ? "search" : (chrome()?.icon() ?? "search")}
                    size={floating() ? 18 : 13}
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
          <span {...stylex.attrs(styles.field)}>
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
                // What's typed, read first: starting to edit puts the full address in the field (it was shown
                // without its scheme), which would overwrite it when no focus event came first.
                const value = e.currentTarget.value;
                // Typing is editing, whether or not the focus event came first.
                start();
                setTyped(true);
                setText(value);
                e.currentTarget.value = value;
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
                    from === -1
                      ? e.key === "ArrowDown"
                        ? 0
                        : n - 1
                      : (from + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
                  );
                }
              }}
              {...stylex.attrs(
                styles.addressInput,
                floating() && styles.addressInputFloating,
                showParts() && styles.addressInputUnder,
              )}
              data-address
            />
            <Show when={parts()}>
              {(p) => (
                <span {...stylex.attrs(styles.addressShown)} aria-hidden="true" data-address-shown>
                  <span {...stylex.attrs(styles.addressHost)}>{p().host}</span>
                  <span {...stylex.attrs(styles.addressRest)}>{p().rest}</span>
                </span>
              )}
            </Show>
          </span>
          {/* Keyed: the tab on screen changes, and with it what's shown here. */}
          <Show when={!editing() && chrome()?.addressExtras} keyed>
            {(extras) => extras()}
          </Show>
          <Show when={!editing()}>
            <Show when={chrome()?.extensions} keyed>
              {(extensions) => extensions()}
            </Show>
            <DownloadsButton />
          </Show>
          <Show when={floating()}>
            <kbd {...stylex.attrs(styles.escHint)}>esc</kbd>
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
                  <span {...stylex.attrs(styles.suggestionIcon, isActive(i()) && styles.suggestionIconOn)}>
                    {s.icon()}
                  </span>
                  <span {...stylex.attrs(styles.suggestionText)}>
                    <span {...stylex.attrs(styles.suggestionTitle)}>{s.title}</span>
                    <Show when={s.detail || s.key.startsWith("tab:")}>
                      <span {...stylex.attrs(styles.suggestionDetail)}>
                        {/* Open in a tab: Enter switches to it rather than loading it here. */}
                        <Show when={s.key.startsWith("tab:")}>
                          <Icon name="app-window" size={12} {...stylex.attrs(styles.tabGlyph)} />
                        </Show>
                        {s.detail}
                      </span>
                    </Show>
                  </span>
                  <Show when={isActive(i())}>
                    <span {...stylex.attrs(styles.suggestionAction, isActive(i()) && styles.suggestionActionOn)}>
                      {s.action}
                      <Show when={isActive(i())}>
                        <Icon name="corner-down-left" size={12} />
                      </Show>
                    </span>
                  </Show>
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
  from: { opacity: 0, transform: "translateX(-50%) translateY(-6px) scale(0.985)" },
  to: { opacity: 1, transform: "translateX(-50%) translateY(0) scale(1)" },
});

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const pulse = stylex.keyframes({ "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } });

/** Ink on the sidebar: a translucent tint of the text color, so it suits every theme. */
const ink = (percent: number) => `color-mix(in oklab, ${colors.text} ${percent}%, transparent)`;

const styles = stylex.create({
  privateBadge: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 22,
    borderRadius: radius.full,
    // Fixed colors: it reads as "private" whatever the theme.
    backgroundColor: "#2e1f5e",
    color: "#e4dcff",
  },
  nav: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    flexShrink: 0,
    height: 36,
    marginTop: -10,
    marginInline: -4,
    paddingInline: 2,
  },
  navButton: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: 8,
    backgroundColor: { default: "transparent", ":hover": ink(7), ":active": ink(11), ":disabled": "transparent" },
    color: { default: ink(58), ":hover": colors.text, ":disabled": ink(26) },
    cursor: { default: "pointer", ":disabled": "default" },
    transitionProperty: "background-color, color",
    transitionDuration: "120ms",
  },
  navButtonOn: { backgroundColor: ink(9), color: colors.text },
  footerButton: { width: 32, height: 32 },
  agentOn: { backgroundColor: colors.accentSoft, color: { default: colors.accent, ":hover": colors.accent } },
  workingDot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    boxShadow: `0 0 0 2px ${colors.sidebar}`,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  spacer: { flex: 1 },
  // Keeps the address's place in the sidebar while it floats.
  addressSlot: { position: "relative", flexShrink: 0, height: 36, marginBottom: 4 },
  // In the bar with horizontal tabs: compact, so the tabs have the room (it pops out to type).
  addressSlotInline: { flex: "0 1 300px", minWidth: 150, height: 32, marginBottom: 0 },
  address: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: 36,
    borderRadius: 10,
    backgroundColor: { default: ink(7.5), ":hover": ink(10.5) },
    fontFamily: font.sans,
    cursor: "text",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  // Focused: over the page, centered near the top of the window, like Zen's and Arc's.
  ghost: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    gap: 7,
    paddingInline: 11,
    overflow: "hidden",
    whiteSpace: "nowrap",
    borderRadius: 10,
    backgroundColor: ink(4),
    color: `light-dark(${ink(32)}, ${ink(42)})`,
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  addressFloating: {
    position: "fixed",
    zIndex: 1500,
    top: "max(64px, 16vh)",
    left: "50%",
    transform: "translateX(-50%)",
    width: "min(680px, calc(100vw - 48px))",
    height: "auto",
    maxHeight: "calc(100vh - 16vh - 32px)",
    overflow: "hidden",
    borderRadius: 16,
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px ${ink(9)}, 0 32px 80px -16px rgb(0 0 0 / 0.38), 0 10px 28px -8px rgb(0 0 0 / 0.16)`,
    animationName: popOut,
    animationDuration: "160ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.9, 0.3, 1.2)",
  },
  addressRow: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 7,
    flexShrink: 0,
    height: 36,
    paddingLeft: 11,
    paddingRight: 4,
  },
  addressCompact: { height: 32 },
  addressRowFloating: { height: 56, gap: 12, paddingLeft: 20, paddingRight: 16 },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1499,
    // light-dark(): the theme's mode (lib/theme.ts sets color-scheme), not the system's.
    backgroundColor: "light-dark(rgb(0 0 0 / 0.14), rgb(0 0 0 / 0.28))",
    animationName: fadeIn,
    animationDuration: "140ms",
  },
  addressIcon: { flexShrink: 0, color: ink(50) },
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
  field: { position: "relative", display: "flex", alignItems: "center", flex: 1, minWidth: 0, height: "100%" },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    letterSpacing: "-0.005em",
    textOverflow: "ellipsis",
    cursor: "text",
    "::placeholder": { color: ink(42) },
    "::selection": { backgroundColor: `color-mix(in oklab, ${colors.accent} 24%, transparent)`, color: colors.text },
  },
  addressInputFloating: { fontSize: 17, letterSpacing: "-0.01em" },
  // The field's own text, while the site and the rest of the address are drawn over it.
  addressInputUnder: { color: "transparent" },
  addressShown: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    fontSize: font.sm,
    letterSpacing: "-0.005em",
    maskImage: "linear-gradient(90deg, #000 calc(100% - 20px), transparent)",
  },
  addressHost: { flexShrink: 0, color: colors.text, fontWeight: 500 },
  addressRest: { flexShrink: 1, minWidth: 0, overflow: "hidden", color: ink(42) },
  escHint: {
    flexShrink: 0,
    paddingInline: 6,
    paddingBlock: 2,
    borderRadius: 5,
    backgroundColor: ink(6),
    color: ink(48),
    fontFamily: font.sans,
    fontSize: 11,
    fontWeight: 500,
  },
  suggestions: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingTop: 6,
    paddingBottom: 8,
    paddingInline: 8,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: ink(7),
  },
  suggestionsHeading: {
    paddingInline: 12,
    paddingTop: 6,
    paddingBottom: 6,
    color: ink(45),
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  suggestion: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
    height: 44,
    paddingInline: 12,
    borderWidth: 0,
    borderRadius: 10,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.md,
    textAlign: "left",
    cursor: "pointer",
  },
  suggestionOn: { backgroundColor: ink(9) },
  // Each icon on a small tile, so favicons, stars and globes line up as one column.
  suggestionIcon: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    flexShrink: 0,
    borderRadius: 7,
    backgroundColor: ink(5),
    color: ink(55),
  },
  suggestionIconOn: { backgroundColor: colors.surface, boxShadow: `0 0 0 1px ${ink(13)}`, color: colors.text },
  suggestionText: { display: "flex", alignItems: "baseline", gap: 10, flex: 1, minWidth: 0 },
  suggestionTitle: {
    flexShrink: 0,
    maxWidth: "62%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
    letterSpacing: "-0.005em",
  },
  suggestionDetail: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: ink(45),
    fontSize: font.sm,
  },
  tabGlyph: { marginRight: 5, verticalAlign: "-1px" },
  suggestionAction: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    height: 22,
    paddingInline: 8,
    borderRadius: 6,
    color: ink(45),
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  suggestionActionOn: { backgroundColor: colors.surface, boxShadow: `0 0 0 1px ${ink(9)}`, color: ink(70) },
});
