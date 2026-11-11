// The command bar (Ctrl+K): what it offers and how a query ranks it. Tabs,
// workspaces and Rune Browser's own commands, plus routing for free text: a
// URL opens, a sentence goes to the agent, anything else can be searched for.
import { createSignal } from "solid-js";
import { isImageIcon, type AppSummary } from "../../shared/api";
import { normalizeUrl } from "../../shared/web";
import { searchEngine, settings, updateSettings } from "./settings";
import {
  ACTIVITY_VIEW,
  BOOKMARKS_VIEW,
  SCHEDULES_VIEW,
  apps,
  newChat,
  createWorkspace,
  currentWorkspace,
  deleteApp,
  duplicateApp,
  DOWNLOADS_VIEW,
  HISTORY_VIEW,
  SNAPSHOTS_VIEW,
  isAgentCollapsed,
  MODS_VIEW,
  isTab,
  moveApp,
  newWebTab,
  renameApp,
  selectApp,
  switchToTab,
  selectedId,
  setAgentCollapsed,
  setTabPinned,
  openSettings,
  showWorkspace,
  states,
  stopAgent,
  workspaceById,
  workspaces,
  closeTab,
  reopenClosedTab,
  isPrivate,
} from "./store";
import { newPrivateWindow, newWindow, reopenWindow } from "./windows";
import { isHorizontal, isSidebarHidden, setTabLayout, toggleSidebar } from "./layout";
import { removeFromSplit, rotateSplit, splitOf, splitWith, unsplit, visibleTabs } from "./splits";
import { pageOf } from "./webtabs";
import { runShortcut } from "./shortcuts";
import { networkTab, setNetworkTab } from "./tabChrome";
import { unloadOtherTabs } from "./unload";
import { sendWithShares } from "./sharing";
import { reviewMod } from "./mods";
import { settingsSections } from "./settingsSections";
import { openInternalPage } from "./internalPages";
import { internalUrlOf, isInternalUrl } from "../../shared/internalPages";
import { isShareCode } from "../../shared/mods";
import { confirmDialog } from "../components/ConfirmDialog";
import { openBookmarkImport } from "../components/BookmarksPage";
import { allBookmarks } from "../../shared/bookmarks";
import {
  bookmarkAllTabs,
  bookmarkOf,
  bookmarkTab,
  bookmarkTree,
  canBookmark,
  exportBookmarks,
  faviconFor,
  isBookmarksBarShown,
  openBookmark,
  toggleBookmarksBar,
} from "./bookmarks";
import { toast } from "../components/Toast";

export interface Command {
  id: string;
  title: string;
  /** Shown after the title, muted (a tab's site and workspace…). */
  subtitle?: string;
  /** Lucide icon name; a web tab shows its favicon instead. */
  icon: string;
  favicon?: string | null;
  /** What kind of thing it is, shown on the right. */
  group: string;
  /** More words it should be found by. */
  keywords?: string;
  /** The keyboard shortcut that does the same (shared/shortcuts.ts), shown next to it. */
  keys?: string;
  /** Asks for text first; this is the placeholder. */
  input?: string;
  /** Ranks it regardless of how the query matches (routing). */
  rank?: number;
  run: (input?: string) => unknown;
}

const [open, setOpen] = createSignal(false);
export { open as commandBarOpen };

export function openCommandBar() {
  setOpen(!open());
}

export const closeCommandBar = () => setOpen(false);

// --- Ranking ---------------------------------------------------------------------------

/** How well `query` (lowercase, trimmed) matches `text`: 0 for not at all, up to 100 for exactly. */
export function matchScore(query: string, text: string) {
  if (!query) return 0;
  const t = text.toLowerCase();
  if (t === query) return 100;
  if (t.startsWith(query)) return 90;
  const at = t.indexOf(query);
  if (at > 0 && /[\s\-_/.:(]/.test(t[at - 1]!)) return 80;
  if (at > 0) return 70;
  const words = query.split(/\s+/);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 60;
  // Letters in order ("nwt" → "New web tab"): the tighter, the better.
  let from = 0;
  let first = -1;
  for (const ch of query) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, from);
    if (i === -1) return 0;
    if (first === -1) first = i;
    from = i + 1;
  }
  const spread = from - first;
  return Math.max(10, 30 - Math.max(0, spread - query.length) * 2);
}

const scoreOf = (query: string, command: Command) =>
  Math.max(
    matchScore(query, command.title),
    Math.floor(matchScore(query, command.subtitle ?? "") * 0.7),
    Math.floor(matchScore(query, command.keywords ?? "") * 0.8),
  );

/** URLs and things that look like a domain, not searches. */
export function asUrl(text: string) {
  const search = searchEngine().url;
  const url = normalizeUrl(text, search);
  return url && url !== search.replace("%s", encodeURIComponent(text.trim())) ? url : null;
}

const isSentence = (text: string) => text.split(/\s+/).length >= 3;

/** What the bar shows for `query`, best first. */
export function results(query: string, commands: Command[], limit = 50): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored = commands.map((command, i) => ({
    command,
    i,
    score: command.rank ?? scoreOf(q, command),
  }));
  // "Add expense lunch 12" runs "Add expense" with "lunch 12".
  for (const command of commands) {
    const prefix = `${command.title.toLowerCase()} `;
    if (!command.input || !q.startsWith(prefix) || q.length === prefix.length) continue;
    const rest = query.trim().slice(prefix.length).trim();
    scored.push({
      command: {
        ...command,
        id: `${command.id}:with`,
        subtitle: `${command.subtitle ? `${command.subtitle} · ` : ""}with “${rest}”`,
        input: undefined,
        run: () => command.run(rest),
      },
      i: -1,
      score: 950,
    });
  }
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.command);
}

// --- The commands ----------------------------------------------------------------------

const hostLabel = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

function tabCommand(app: AppSummary): Command {
  const workspace = workspaces.length > 1 ? workspaceById(app.workspaceId)?.name : undefined;
  const where = [hostLabel(app.url), workspace].filter(Boolean).join(" · ");
  return {
    id: `tab:${app.id}`,
    title: app.name,
    subtitle: where || undefined,
    // Its own icon (an image shows like a favicon), else the default.
    icon: app.icon && !isImageIcon(app.icon) ? app.icon : "globe",
    favicon: isImageIcon(app.icon) ? app.icon : !app.icon ? app.favicon : undefined,
    group: "Tab",
    keywords: app.url ?? "",
    run: () => switchToTab(app.id),
  };
}

/** Sends a prompt to a tab's agent, with the page and picked elements if the tab is open. */
function askAgent(id: string, prompt: string) {
  void selectApp(id);
  setAgentCollapsed(id, false);
  const page = pageOf(id);
  if (page) page.send(prompt);
  else void sendWithShares(id, prompt);
}

function scrollToWorkspaceSettings() {
  void openSettings("workspace");
}

/** Commands about the tab you're on. */
function currentTabCommands(id: string): Command[] {
  const app = apps.find((a) => a.id === id);
  if (!app) return [];
  const state = states[id];
  const name = `“${app.name}”`;
  const list: Command[] = [
    {
      id: "tab.rename",
      title: "Rename tab",
      subtitle: app.name,
      icon: "pencil",
      group: "Tab",
      input: "New name",
      run: (name) => name?.trim() && renameApp(id, name.trim()),
    },
    {
      id: "tab.duplicate",
      title: "Duplicate tab",
      subtitle: app.name,
      icon: "copy",
      group: "Tab",
      run: () => duplicateApp(id),
    },
    {
      id: "tab.agent",
      title: isAgentCollapsed(id) ? "Show the agent" : "Hide the agent",
      keys: "agent.toggle",
      icon: "panel-right",
      group: "Tab",
      keywords: "toggle panel chat",
      run: () => setAgentCollapsed(id, !isAgentCollapsed(id)),
    },
  ];
  list.push(
    app.pinned
      ? {
          id: "tab.pin",
          title: "Allow unloading this tab",
          subtitle: app.name,
          icon: "pin-off",
          group: "Tab",
          keywords: "unpin memory idle",
          run: () => setTabPinned(id, false),
        }
      : {
          id: "tab.pin",
          title: "Keep this tab loaded",
          subtitle: app.name,
          icon: "pin",
          group: "Tab",
          keywords: "pin memory idle unload",
          run: () => setTabPinned(id, true),
        },
  );
  if (state?.running)
    list.push({
      id: "tab.stop",
      title: "Stop the agent",
      subtitle: app.name,
      icon: "square",
      group: "Tab",
      run: () => stopAgent(id),
    });
  list.push({
    id: "tab.close",
    title: "Close tab",
    keys: "tab.close",
    icon: "x",
    group: "Tab",
    run: () => closeTab(id),
  });
  // What the browser does to the page (the keys' actions: lib/shortcuts.ts).
  if (pageOf(id)?.view())
    list.push(
      ...(
        [
          ["find.open", "Find in page", "search", "search text"],
          ["zoom.in", "Zoom in", "zoom-in", "bigger larger"],
          ["zoom.out", "Zoom out", "zoom-out", "smaller"],
          ["zoom.reset", "Actual size", "scan", "zoom reset 100%"],
          ["page.print", "Print…", "printer", "pdf paper"],
          ["page.save", "Save page as…", "download", "download html file"],
          ["nav.hard-reload", "Reload without the cache", "refresh-ccw", "hard reload cache"],
          ["page.devtools", "Developer tools", "code-xml", "devtools inspect console f12"],
        ] as const
      ).map(([shortcut, title, icon, keywords]): Command => ({
        id: `page.${shortcut}`,
        title,
        icon,
        group: "Page",
        keywords,
        keys: shortcut,
        run: () => runShortcut(shortcut, { tabId: id, source: "window" }),
      })),
    );
  list.push(
    {
      id: "tab.reload",
      title: "Reload page",
      keys: "nav.reload",
      icon: "rotate-cw",
      group: "Tab",
      run: () => pageOf(id)?.reload(),
    },
    {
      id: "tab.network",
      title: networkTab() === id ? "Hide network requests" : "Network requests",
      subtitle: app.name,
      icon: "network",
      group: "Tab",
      keywords: "traffic api requests responses devtools",
      run: () => setNetworkTab(networkTab() === id ? null : id),
    },
  );
  if (state?.messages.length && !state.running) {
    list.push({
      id: "tab.newChat",
      title: "New chat",
      subtitle: app.name,
      icon: "message-square-plus",
      group: "Tab",
      keywords: "clear fresh conversation reset agent",
      run: () => newChat(id),
    });
  }
  for (const w of workspaces) {
    if (w.id !== app.workspaceId)
      list.push({
        id: `tab.move:${w.id}`,
        title: `Move tab to ${w.name}`,
        subtitle: app.name,
        icon: "folder-input",
        group: "Tab",
        run: () => moveApp(id, w.id),
      });
  }
  list.push({
    id: "tab.delete",
    title: "Delete tab",
    subtitle: app.name,
    icon: "trash",
    group: "Tab",
    run: async () => {
      if (
        await confirmDialog(`Delete ${name} and its chats?`, {
          confirmLabel: "Delete",
          danger: true,
        })
      )
        await deleteApp(id);
    },
  });
  return list;
}

function runeCommands(): Command[] {
  const theme = (mode: "system" | "light" | "dark", title: string, icon: string): Command => ({
    id: `theme.${mode}`,
    title,
    icon,
    group: "Rune Browser",
    keywords: "theme appearance color scheme",
    run: () => updateSettings((s) => ({ ...s, theme: { ...s.theme, mode } })),
  });
  return [
    {
      id: "new.web",
      title: "New web tab",
      keys: "tab.new",
      icon: "globe",
      group: "Rune Browser",
      keywords: "browser",
      run: () => newWebTab(),
    },
    {
      id: "window.new",
      title: "New window",
      keys: "window.new",
      icon: "app-window",
      group: "Rune Browser",
      keywords: "browser open",
      run: () => newWindow(),
    },
    {
      id: "window.private",
      title: "New private window",
      keys: "window.private",
      icon: "hat-glasses",
      group: "Rune Browser",
      keywords: "incognito private browsing",
      run: () => newPrivateWindow(),
    },
    ...(isPrivate
      ? []
      : [
          {
            id: "window.reopen",
            title: "Reopen closed window",
            icon: "app-window",
            group: "Rune Browser",
            keywords: "restore undo close window",
            run: () => reopenWindow(),
          },
        ]),
    {
      id: "tabs.unload",
      title: "Unload other tabs",
      icon: "moon",
      group: "Rune Browser",
      keywords: "memory free discard sleep background",
      run: async () => {
        const count = await unloadOtherTabs();
        toast({
          message: count ? `Unloaded ${count} tab${count === 1 ? "" : "s"}` : "No other tabs are loaded",
          kind: "info",
        });
      },
    },
    {
      id: "new.workspace",
      title: "New workspace",
      icon: "layers",
      group: "Rune Browser",
      input: "Name",
      run: (name) => name?.trim() && createWorkspace(name.trim()),
    },
    // With horizontal tabs there's no sidebar to hide.
    ...(isHorizontal()
      ? []
      : [
          {
            id: "sidebar.toggle",
            title: isSidebarHidden() ? "Show the sidebar" : "Hide the sidebar",
            keys: "sidebar.toggle",
            icon: "panel-left",
            group: "Rune Browser",
            keywords: "toggle hide show tabs",
            run: toggleSidebar,
          } satisfies Command,
        ]),
    {
      id: "tabs.layout",
      title: isHorizontal() ? "Use vertical tabs" : "Use horizontal tabs",
      icon: isHorizontal() ? "panel-left" : "panel-top",
      group: "Rune Browser",
      keywords: "tab bar sidebar layout horizontal vertical top side",
      run: () => setTabLayout(isHorizontal() ? "vertical" : "horizontal"),
    },
    // Every category of Settings, by name ("Settings: Agents").
    ...settingsSections
      .filter((section) => !section.view)
      .map((section): Command => ({
        id: `settings.${section.id}`,
        title: `Settings: ${section.label}`,
        icon: section.icon,
        group: "Rune Browser",
        keywords: `preferences ${section.keywords ?? ""}`,
        run: () => openSettings(section.id),
      })),
    // The internal pages ("Open GPU", rune://gpu).
    ...settingsSections
      .filter((section) => section.group === "internal" && section.view)
      .map((section): Command => ({
        id: `open.${section.id}`,
        title: `Open ${section.label}`,
        subtitle: internalUrlOf({ view: section.view! }),
        icon: section.icon,
        group: "Rune Browser",
        keywords: section.keywords,
        run: () => selectApp(section.view!),
      })),
    {
      id: "open.downloads",
      title: "Open Downloads",
      icon: "download",
      group: "Rune Browser",
      keys: "open.downloads",
      keywords: "files saved downloaded",
      run: () => selectApp(DOWNLOADS_VIEW),
    },
    {
      id: "open.history",
      title: "Open History",
      icon: "rotate-ccw-clock",
      group: "Rune Browser",
      keywords: "browsing visited pages sites",
      run: () => selectApp(HISTORY_VIEW),
    },
    {
      id: "open.snapshots",
      title: "Open Snapshots",
      icon: "file-clock",
      group: "Rune Browser",
      keywords: "history undo restore versions changes",
      run: () => selectApp(SNAPSHOTS_VIEW),
    },
    {
      id: "open.schedules",
      title: "Open Schedules",
      icon: "calendar-clock",
      group: "Rune Browser",
      keywords: "background runs cron jobs timer",
      run: () => selectApp(SCHEDULES_VIEW),
    },
    {
      id: "open.mods",
      title: "Open Mods",
      icon: "puzzle",
      group: "Rune Browser",
      keywords: "install share gallery themes customizations extensions",
      run: () => selectApp(MODS_VIEW),
    },
    {
      id: "open.activity",
      title: "Open Activity",
      icon: "activity",
      group: "Rune Browser",
      keywords: "audit log",
      run: () => selectApp(ACTIVITY_VIEW),
    },
    {
      id: "open.settings",
      title: "Open Settings",
      icon: "settings",
      group: "Rune Browser",
      keywords: "preferences",
      run: () => openSettings(),
    },
    {
      id: "open.workspace-settings",
      title: "Workspace settings",
      subtitle: currentWorkspace()?.name,
      icon: "layers",
      group: "Rune Browser",
      keywords: "instructions agent default model",
      run: scrollToWorkspaceSettings,
    },
    theme("system", "Theme: match the system", "monitor"),
    theme("light", "Theme: light", "sun"),
    theme("dark", "Theme: dark", "moon"),
    window.rune.safeMode
      ? {
          id: "restart.normal",
          title: "Restart normally",
          icon: "power",
          group: "Rune Browser",
          keywords: "safe mode",
          run: () => window.rune.relaunch(false),
        }
      : {
          id: "restart.safe",
          title: "Restart in safe mode",
          icon: "life-buoy",
          group: "Rune Browser",
          keywords: "recovery broken theme",
          run: () => window.rune.relaunch(true),
        },
  ];
}

/** The split view of the tab you're on, and (when something is typed) splitting it with another tab. */
function splitCommands(id: string, typed: boolean): Command[] {
  const app = apps.find((a) => a.id === id);
  if (!app) return [];
  const split = splitOf(id);
  const list: Command[] = [];
  if (split) {
    list.push(
      {
        id: "split.rotate",
        title: split.direction === "row" ? "Stack the split view" : "Split view side by side",
        icon: split.direction === "row" ? "rows-2" : "columns-2",
        group: "Split view",
        keywords: "rotate vertical horizontal",
        run: () => rotateSplit(split.id),
      },
      {
        id: "split.remove",
        title: "Remove from split view",
        subtitle: app.name,
        icon: "square-x",
        group: "Split view",
        run: () => removeFromSplit(id),
      },
      {
        id: "split.end",
        title: "Unsplit",
        icon: "square-split-horizontal",
        group: "Split view",
        keywords: "close split view",
        run: () => unsplit(split.id),
      },
    );
  }
  if (typed) {
    for (const tab of apps) {
      if (tab.workspaceId !== app.workspaceId || visibleTabs().includes(tab.id)) continue;
      list.push({
        id: `split.with:${tab.id}`,
        title: `Split with ${tab.name}`,
        icon: "columns-2",
        group: "Split view",
        keywords: "side by side split view",
        run: () => splitWith(id, tab.id, "right"),
      });
    }
  }
  return list;
}

/** Bookmarking, the bookmarks page and bar, and (when something is typed) the bookmarks themselves. */
function bookmarkCommands(typed: boolean): Command[] {
  const id = selectedId();
  const url = isTab(id) ? apps.find((a) => a.id === id)?.url : undefined;
  const list: Command[] = [];
  if (isTab(id) && canBookmark(url))
    list.push({
      id: "bookmark.page",
      title: bookmarkOf(url) ? "Edit this tab's bookmark" : "Bookmark this tab",
      keys: "bookmark.page",
      icon: "star",
      group: "Bookmarks",
      keywords: "favorite save star",
      run: () => bookmarkTab(id),
    });
  list.push(
    {
      id: "bookmark.all",
      title: "Bookmark all tabs",
      keys: "bookmark.all",
      icon: "folder-plus",
      group: "Bookmarks",
      keywords: "favorite save folder",
      run: () => bookmarkAllTabs(),
    },
    {
      id: "open.bookmarks",
      title: "Open Bookmarks",
      keys: "open.bookmarks",
      icon: "bookmark",
      group: "Bookmarks",
      keywords: "manager favorites organize",
      run: () => selectApp(BOOKMARKS_VIEW),
    },
    {
      id: "bookmarks.bar",
      title: isBookmarksBarShown() ? "Hide the bookmarks bar" : "Show the bookmarks bar",
      keys: "bookmarks.bar",
      icon: "panel-top",
      group: "Bookmarks",
      keywords: "toggle toolbar",
      run: toggleBookmarksBar,
    },
    {
      id: "bookmarks.import",
      title: "Import bookmarks…",
      icon: "download",
      group: "Bookmarks",
      keywords: "chrome firefox safari edge brave html migrate",
      run: openBookmarkImport,
    },
    {
      id: "bookmarks.export",
      title: "Export bookmarks",
      icon: "upload",
      group: "Bookmarks",
      keywords: "html file backup save",
      run: () => exportBookmarks(),
    },
  );
  if (typed)
    for (const node of allBookmarks(bookmarkTree()))
      list.push({
        id: `bookmark:${node.id}`,
        title: node.title || node.url!,
        subtitle: node.url!.replace(/^https?:\/\//, "").slice(0, 80),
        icon: "star",
        favicon: faviconFor(node.url),
        group: "Bookmark",
        keywords: node.url,
        run: () => openBookmark(node, "tab"),
      });
  return list;
}

/** For free text: open it, ask about it, build it or search for it. */
function routed(query: string, best: number): Command[] {
  const text = query.trim();
  if (!text) return [];
  const list: Command[] = [];
  // A mod's share code: review it, then install (one step from a paste).
  if (isShareCode(text)) {
    return [
      {
        id: "route.mod",
        title: "Install this mod…",
        subtitle: "Review what it changes first",
        icon: "puzzle",
        group: "Mods",
        rank: 1000,
        run: () =>
          reviewMod({ code: text }).catch((err) =>
            toast({
              message: err instanceof Error ? err.message : String(err),
              kind: "error",
            }),
          ),
      },
    ];
  }
  const url = asUrl(text);
  const id = selectedId();
  const tab = isTab(id) ? apps.find((a) => a.id === id) : undefined;
  if (url && isInternalUrl(url)) {
    list.push({
      id: "route.open",
      title: `Open ${url}`,
      subtitle: "Rune Browser's page",
      icon: "settings",
      group: "Web",
      rank: 1000,
      run: () => void openInternalPage(url),
    });
    return list;
  }
  if (url) {
    list.push({
      id: "route.open",
      title: `Open ${text}`,
      subtitle: "in a new tab",
      icon: "globe",
      group: "Web",
      rank: 1000,
      run: () => newWebTab(url),
    });
    if (tab) {
      list.push({
        id: "route.here",
        title: `Open ${text}`,
        subtitle: "in this tab",
        icon: "corner-down-right",
        group: "Web",
        rank: 999,
        run: () => pageOf(tab.id)?.navigate(url),
      });
    }
    return list;
  }
  // A sentence nothing matched well is most likely meant for an agent.
  const forAgent = isSentence(text) && best < 70;
  if (tab) {
    list.push({
      id: "route.ask",
      title: text,
      subtitle: `Ask the agent in ${tab.name}`,
      icon: "message-circle",
      group: "Agent",
      rank: forAgent ? 900 : 3,
      run: () => askAgent(tab.id, text),
    });
  }
  list.push({
    id: "route.ask-new",
    title: text,
    subtitle: "Ask the agent in a new tab",
    icon: "sparkles",
    group: "Agent",
    rank: forAgent ? 850 : 2,
    run: async () => askAgent((await newWebTab()).id, text),
  });
  list.push({
    id: "route.search",
    title: text,
    subtitle: "Search the web",
    icon: "search",
    group: "Web",
    rank: forAgent ? 800 : 1,
    run: () => newWebTab(normalizeUrl(text, searchEngine().url)),
  });
  return list;
}

/** What a private window leaves out: agents and workspaces. */
const notInPrivate =
  /^(tab\.agent|tab\.newChat|tab\.move:|tab\.delete|new\.workspace|workspace:|route\.ask|open\.workspace-settings)/;

/** Everything the bar can do right now, in the order it shows them without a query. */
export function commands(query: string): Command[] {
  const current = currentWorkspace()?.id;
  const id = selectedId();
  const inWorkspace = (workspaceId: string) => workspaceId === current;
  const tabs = [...apps].sort((a, b) => Number(inWorkspace(b.workspaceId)) - Number(inWorkspace(a.workspaceId)));
  const list: Command[] = [
    ...tabs.filter((a) => a.id !== id).map(tabCommand),
    ...(isTab(id) ? currentTabCommands(id) : []),
    ...(isTab(id) ? splitCommands(id, !!query.trim()) : []),
    ...workspaces
      .filter((w) => w.id !== current)
      .map((w): Command => ({
        id: `workspace:${w.id}`,
        title: w.name,
        subtitle: "Switch workspace",
        icon: w.icon ?? "layers",
        group: "Workspace",
        run: () => showWorkspace(w.id),
      })),
    ...runeCommands(),
    ...bookmarkCommands(!!query.trim()),
    {
      id: "tab.reopen",
      title: "Reopen closed tab",
      keys: "tab.reopen",
      icon: "undo-2",
      group: "Rune Browser",
      keywords: "restore undo close",
      run: () => reopenClosedTab(),
    },
  ];
  const q = query.trim().toLowerCase();
  const best = q ? Math.max(0, ...list.map((c) => scoreOf(q, c))) : 0;
  const all = [...list, ...routed(query, best)];
  return isPrivate ? all.filter((c) => !notInPrivate.test(c.id)) : all;
}
