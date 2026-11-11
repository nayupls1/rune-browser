// The keyboard shortcuts' handler. Every action (shared/shortcuts.ts) has what
// it does here, and when it applies: a key whose action doesn't apply (no tab
// to close, nothing loading to stop) does nothing, and keys pressed in
// Rune Browser's own UI that it used itself (an input's Escape) aren't taken.
// Keys pressed in pages come from the main process (main/shortcuts.ts), which
// gets the keymap from here. App starts it (startShortcuts).
import { createMemo, createRoot, createEffect, createSignal } from "solid-js";
import {
  formatCombo,
  keymapOf,
  keyPlatform,
  matchShortcut,
  mouseComboOf,
  resolveBindings,
  type ShortcutDef,
} from "../../shared/shortcuts";
import type { ShortcutEvent } from "../../shared/api";
import { settings } from "./settings";
import {
  appById,
  BOOKMARKS_VIEW,
  closeTab,
  currentWorkspace,
  DOWNLOADS_VIEW,
  duplicateApp,
  HISTORY_VIEW,
  isPrivate,
  isSettingsView,
  isTab,
  newWebTab,
  openSettings,
  reopenClosedTab,
  reorderTabs,
  selectApp,
  selectedId,
  setTabPinned,
  showWorkspace,
  toggleAgent,
  workspaces,
  workspaceTabs,
} from "./store";
import { openCommandBar } from "./commands";
import { toggleSidebar } from "./layout";
import { splitOf } from "./splits";
import { chromeOf, focusAddress } from "./tabChrome";
import { pageOf, tabOfContents } from "./webtabs";
import { findStep, openFind, zoom } from "./pageTools";
import { bookmarkAllTabs, bookmarkTab, canBookmark, toggleBookmarksBar } from "./bookmarks";
import { newPrivateWindow, newWindow } from "./windows";
import { pickAndOpenFiles } from "./files";

export const platform = keyPlatform(window.rune.window.platform);

let bindingsMemo: (() => Record<string, string[]>) | undefined;
let keymapMemo: (() => ReturnType<typeof keymapOf>) | undefined;

/** Every action's keys (the defaults, with the user's changes from Settings). */
export const bindings = () => bindingsMemo?.() ?? resolveBindings(platform, settings().shortcuts);

/** An action's first keys as shown to people ("Ctrl+Shift+T", "⇧⌘T"), if it has any. */
export function shortcutLabel(id: string) {
  const first = bindings()[id]?.[0];
  return first ? formatCombo(first, platform) : undefined;
}

/** "Close tab (Ctrl+W)": a tooltip with the action's keys, if it has any. */
export const withKeys = (label: string, id: string) => {
  const keys = shortcutLabel(id);
  return keys ? `${label} (${keys})` : label;
};

/** Where the key was pressed: in a page (the tab showing it), or in Rune Browser's own UI (the tab on screen). */
interface Context {
  tabId: string | null;
  source: "page" | "window";
}

interface Action {
  /** Whether it does something now; the key is left alone otherwise. */
  when?: (ctx: Context) => boolean;
  run: (ctx: Context) => unknown;
}

const page = (ctx: Context) => (ctx.tabId ? pageOf(ctx.tabId) : undefined);
const view = (ctx: Context) => page(ctx)?.view();
const hasTab = (ctx: Context) => isTab(ctx.tabId);
const hasView = (ctx: Context) => !!view(ctx);
const contentsIdOf = (ctx: Context) => {
  try {
    return view(ctx)?.getWebContentsId();
  } catch {
    return undefined;
  }
};

/** The tabs in the order the sidebar shows them: pinned tiles, then the list (a split view's tabs together). */
export function sidebarOrder(): string[] {
  const tabs = workspaceTabs();
  const isTile = (id: string) => appById(id)?.pinned && !splitOf(id);
  const order = tabs.filter((t) => isTile(t.id)).map((t) => t.id);
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (isTile(tab.id)) continue;
    const split = splitOf(tab.id);
    if (!split) order.push(tab.id);
    else if (!seen.has(split.id)) {
      seen.add(split.id);
      order.push(...split.tabs.filter((id) => tabs.some((t) => t.id === id)));
    }
  }
  return order;
}

function selectRelative(ctx: Context, offset: number) {
  const order = sidebarOrder();
  if (order.length < 2) return;
  const at = ctx.tabId ? order.indexOf(ctx.tabId) : -1;
  const next = order[(at + offset + order.length) % order.length];
  if (next) void selectApp(next);
}

function selectNth(n: number | "last") {
  const order = sidebarOrder();
  const id = n === "last" ? order[order.length - 1] : order[n - 1];
  if (id) void selectApp(id);
}

/** Moves the tab one place up or down the list. */
function moveTab(ctx: Context, offset: number) {
  const ids = workspaceTabs().map((t) => t.id);
  const at = ctx.tabId ? ids.indexOf(ctx.tabId) : -1;
  const to = at + offset;
  if (at === -1 || to < 0 || to >= ids.length) return;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  void reorderTabs(ids);
}

/** Closes the tab; the window stays, with a new tab once the last one's gone. Settings and Rune Browser's pages go back to the tab. */
async function closeCurrent(ctx: Context) {
  if (isSettingsView(selectedId()) && ctx.source === "window") {
    const workspace = currentWorkspace();
    if (workspace) await showWorkspace(workspace.id);
    return;
  }
  if (!isTab(ctx.tabId)) return;
  await closeTab(ctx.tabId);
  if (!workspaceTabs().length) await newWebTab();
}

const actions: Record<string, Action> = {
  "tab.new": { run: () => newWebTab() },
  "tab.close": {
    when: (ctx) => hasTab(ctx) || (ctx.source === "window" && isSettingsView(selectedId())),
    run: closeCurrent,
  },
  "tab.reopen": { run: () => reopenClosedTab() },
  "tab.next": { when: () => sidebarOrder().length > 1, run: (ctx) => selectRelative(ctx, 1) },
  "tab.previous": { when: () => sidebarOrder().length > 1, run: (ctx) => selectRelative(ctx, -1) },
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
      `tab.select-${n}`,
      { when: () => sidebarOrder().length >= n, run: () => selectNth(n) } satisfies Action,
    ]),
  ),
  "tab.last": { when: () => sidebarOrder().length > 0, run: () => selectNth("last") },
  "tab.move-left": { when: hasTab, run: (ctx) => moveTab(ctx, -1) },
  "tab.move-right": { when: hasTab, run: (ctx) => moveTab(ctx, 1) },
  "tab.duplicate": { when: hasTab, run: (ctx) => duplicateApp(ctx.tabId!) },
  "tab.pin": { when: hasTab, run: (ctx) => setTabPinned(ctx.tabId!, !appById(ctx.tabId)?.pinned) },
  "tab.search": { run: () => openCommandBar() },

  "nav.back": { when: (ctx) => !!page(ctx), run: (ctx) => page(ctx)!.back() },
  "nav.forward": { when: (ctx) => !!page(ctx), run: (ctx) => page(ctx)!.forward() },
  "nav.reload": { when: (ctx) => !!chromeOf(ctx.tabId), run: (ctx) => chromeOf(ctx.tabId)!.reload() },
  "nav.hard-reload": {
    when: (ctx) => hasView(ctx) || !!chromeOf(ctx.tabId),
    run: (ctx) => (view(ctx) ? view(ctx)!.reloadIgnoringCache() : chromeOf(ctx.tabId)!.reload()),
  },
  // Escape in Rune Browser's own UI closes its menus and dialogs instead.
  "nav.stop": {
    when: (ctx) => ctx.source === "page" && !!chromeOf(ctx.tabId)?.loading() && !!chromeOf(ctx.tabId)?.stop,
    run: (ctx) => chromeOf(ctx.tabId)!.stop!(),
  },
  "nav.address": { when: hasTab, run: (ctx) => focusAddressOf(ctx) },
  "nav.search": { when: hasTab, run: (ctx) => focusAddressOf(ctx) },

  "find.open": { when: hasView, run: (ctx) => openFind(ctx.tabId!) },
  "find.next": { when: hasView, run: (ctx) => findStep(ctx.tabId!, true) },
  "find.previous": { when: hasView, run: (ctx) => findStep(ctx.tabId!, false) },
  "zoom.in": { when: hasView, run: (ctx) => zoom(ctx.tabId!, 1) },
  "zoom.out": { when: hasView, run: (ctx) => zoom(ctx.tabId!, -1) },
  "zoom.reset": { when: hasView, run: (ctx) => zoom(ctx.tabId!, 0) },
  "page.print": { when: hasView, run: (ctx) => view(ctx)!.print() },
  "page.save": {
    when: (ctx) => contentsIdOf(ctx) !== undefined,
    run: (ctx) => window.rune.web.savePage(contentsIdOf(ctx)!),
  },
  "page.devtools": { when: (ctx) => contentsIdOf(ctx) !== undefined, run: (ctx) => devtools(ctx, "elements") },
  "page.source": { when: (ctx) => contentsIdOf(ctx) !== undefined, run: (ctx) => devtools(ctx, "sources") },
  "page.console": { when: (ctx) => contentsIdOf(ctx) !== undefined, run: (ctx) => devtools(ctx, "console") },
  "page.inspect": { when: (ctx) => contentsIdOf(ctx) !== undefined, run: (ctx) => devtools(ctx, "inspect") },

  "window.new": { run: () => newWindow() },
  "file.open": { run: () => pickAndOpenFiles() },
  "window.private": { run: () => newPrivateWindow() },
  "window.fullscreen": { run: () => window.rune.window.toggleFullScreen() },
  "window.close": { run: () => window.rune.window.close() },
  "app.quit": { run: () => window.rune.window.quit() },

  "bookmark.page": { when: (ctx) => canBookmark(appById(ctx.tabId)?.url), run: (ctx) => bookmarkTab(ctx.tabId!) },
  "bookmark.all": {
    when: () => workspaceTabs().some((t) => canBookmark(t.url)),
    run: () => bookmarkAllTabs(),
  },
  "open.bookmarks": { run: () => selectApp(BOOKMARKS_VIEW) },
  "bookmarks.bar": { run: () => toggleBookmarksBar() },
  "open.history": { run: () => selectApp(HISTORY_VIEW) },
  "open.downloads": { run: () => selectApp(DOWNLOADS_VIEW) },
  "open.clear-data": { run: () => openSettings("browser-clear") },
  "open.settings": { run: () => openSettings() },
  "open.extensions": { run: () => openSettings("extensions") },
  "open.shortcuts": { run: () => openSettings("shortcuts") },

  "app.command-bar": { run: () => openCommandBar() },
  // Private windows have no agents or workspaces.
  "agent.toggle": { when: (ctx) => hasTab(ctx) && !isPrivate, run: (ctx) => toggleAgent(ctx.tabId!) },
  "sidebar.toggle": { run: () => toggleSidebar() },
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
      `workspace.select-${n}`,
      {
        when: () => !isPrivate && !!workspaces[n - 1],
        run: () => showWorkspace(workspaces[n - 1]!.id),
      } satisfies Action,
    ]),
  ),
};

function focusAddressOf(ctx: Context) {
  // A page in another pane of a split: its tab becomes the one on screen first.
  if (ctx.tabId && ctx.tabId !== selectedId()) void selectApp(ctx.tabId);
  focusAddress();
}

function devtools(ctx: Context, panel: "elements" | "console" | "sources" | "inspect") {
  window.rune.web.openDevTools(contentsIdOf(ctx)!, panel);
}

/** Runs a shortcut's action if it applies; true if it did. */
export function runShortcut(id: string, ctx: Context = { tabId: selectedId(), source: "window" }) {
  const action = actions[id];
  if (!action || (action.when && !action.when(ctx))) return false;
  Promise.resolve()
    .then(() => action.run(ctx))
    .catch((err) => console.error(`The shortcut ${id} failed:`, err));
  return true;
}

// The Settings field recording a new shortcut gets every key.
const [recording, setRecording] = createSignal(false);
export { setRecording as setRecordingShortcut };

/** Starts handling keys (App, once). */
export function startShortcuts() {
  createRoot(() => {
    bindingsMemo = createMemo(() => resolveBindings(platform, settings().shortcuts));
    keymapMemo = createMemo(() => keymapOf(bindingsMemo!()));
    // Keys pressed in pages are matched in the main process.
    createEffect(() => window.rune.web.setShortcuts(bindingsMemo!()));
  });

  // Keys pressed in pages, that they passed on.
  window.rune.web.onShortcut((event: ShortcutEvent) => {
    const tabId = (event.contentsId !== undefined && tabOfContents(event.contentsId)) || selectedId();
    runShortcut(event.id, { tabId, source: event.contentsId !== undefined ? "page" : "window" });
  });

  // Keys pressed in Rune Browser itself. After the UI's own handlers: what they
  // used (preventDefault) stays theirs (the agent picker's Ctrl+Tab).
  window.addEventListener("keydown", (e) => {
    if (recording() || !keymapMemo) return;
    const def: ShortcutDef | undefined = matchShortcut(keymapMemo(), {
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
    });
    if (!def || e.defaultPrevented) return;
    if (runShortcut(def.id)) e.preventDefault();
  });

  // The mouse's back and forward buttons over Rune Browser itself: the tab on
  // screen goes back (pages' own are the main process's). Left alone, they'd
  // take Rune Browser's own window back.
  const mouseShortcut = (e: MouseEvent) => {
    if (recording() || !keymapMemo) return;
    const pressed = mouseComboOf(e.button, { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    if (!pressed) return;
    e.preventDefault();
    const def = keymapMemo().get(pressed);
    if (def && e.type === "mouseup") runShortcut(def.id);
  };
  window.addEventListener("mousedown", mouseShortcut);
  window.addEventListener("mouseup", mouseShortcut);
}
