// Bookmarks in the renderer: the tree from the server (bookmarks/Bookmarks.ts),
// kept up to date from the hub, and what the star, Ctrl+D, the bookmarks bar
// and menu, the bookmarks page, the address bar and the command bar do with
// it. Changes from the hub are passed on to the main process too, for
// extensions' chrome.bookmarks events.
import { createMemo, createRoot, createSignal } from "solid-js";
import {
  allBookmarks,
  allFolders,
  BAR_ID,
  findNode,
  OTHER_ID,
  ROOT_ID,
  samePage,
  type BookmarkImportResult,
  type BookmarkNode,
  type BookmarkSource,
} from "../../shared/bookmarks";
import { topics } from "../../shared/hub";
import { toast } from "../components/Toast";
import { request } from "./api";
import { onConnected, watchTopic } from "./realtime";
import { apps, appById, currentWorkspace, isWebTab, newWebTab, selectedId, workspaceTabs } from "./store";
import { pageOf } from "./webtabs";

const folder = (id: string, title: string): BookmarkNode => ({
  id,
  parentId: ROOT_ID,
  title,
  syncing: false,
  children: [],
});
const [tree, setTree] = createSignal<BookmarkNode>({
  id: ROOT_ID,
  title: "",
  syncing: false,
  children: [folder(BAR_ID, "Bookmarks bar"), folder(OTHER_ID, "Other bookmarks")],
});
export const bookmarkTree = tree;

/**
 * The new tree, keeping the old node objects where nothing changed: lists keyed by
 * node (the page's rows) don't redraw them, and a rename being typed stays.
 */
function reuse(old: BookmarkNode | undefined, next: BookmarkNode): BookmarkNode {
  if (!old || old.id !== next.id) return next;
  const was = new Map(old.children?.map((c) => [c.id, c]));
  const kids = next.children?.map((child) => reuse(was.get(child.id), child));
  const same =
    old.title === next.title &&
    old.url === next.url &&
    // Not `index`: nothing here reads it, and a row whose place shifted stays mounted.
    old.parentId === next.parentId &&
    old.dateGroupModified === next.dateGroupModified &&
    old.children?.length === kids?.length &&
    (kids ?? []).every((k, i) => k === old.children![i]);
  return same ? old : { ...next, ...(kids ? { children: kids } : {}) };
}
const refresh = () =>
  request<BookmarkNode>("/api/bookmarks").then(
    (next) => setTree((old) => reuse(old, next)),
    (err) => console.error("Loading bookmarks failed:", err),
  );
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
watchTopic(topics.bookmarks, (msg) => {
  if (msg.type !== "bookmarks") return;
  window.rune.extensions.bookmarksChanged(msg.change);
  // An import sends many at once.
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 30);
});
onConnected(() => void refresh());

export const bookmarkById = (id: string) => findNode(tree(), id);
export const barFolder = () => bookmarkById(BAR_ID)!;
export const otherFolder = () => bookmarkById(OTHER_ID)!;

const memos = createRoot(() => ({
  byPage: createMemo(() => {
    const map = new Map<string, BookmarkNode>();
    for (const node of allBookmarks(tree())) if (!map.has(samePage(node.url!))) map.set(samePage(node.url!), node);
    return map;
  }),
  folders: createMemo(() => allFolders(tree())),
}));

/** The bookmark of a page (the first, if it's bookmarked twice). */
export const bookmarkOf = (url: string | null | undefined) => (url ? memos.byPage().get(samePage(url)) : undefined);
/** Every folder, with how deep it is (for pickers). */
export const bookmarkFolders = () => memos.folders();

/** A page a tab can bookmark: a website, a local file or an extension's page. */
export const canBookmark = (url: string | null | undefined) => !!url && /^(https?|file|chrome-extension):/i.test(url);

/** A site's icon, from a tab showing that site (bookmarks don't keep icons of their own). */
export function faviconFor(url: string | undefined) {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (!host) return null;
  const same = (u: string | null | undefined) => {
    try {
      return !!u && new URL(u).host === host;
    } catch {
      return false;
    }
  };
  return apps.find((a) => a.kind === "web" && a.favicon && same(a.url))?.favicon ?? null;
}

// --- Changes -----------------------------------------------------------------------------

const send = async <T>(path: string, method: string, body?: unknown) => {
  const result = await request<T>(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  await refresh();
  return result;
};

export const addBookmark = (input: { title: string; url?: string; parentId?: string; index?: number }) =>
  send<BookmarkNode>("/api/bookmarks", "POST", input);
export const editBookmark = (id: string, fields: { title?: string; url?: string; parentId?: string; index?: number }) =>
  send<BookmarkNode>(`/api/bookmarks/${id}`, "PATCH", fields);
export const removeBookmark = (id: string) => {
  const node = bookmarkById(id);
  return send<void>(`/api/bookmarks/${id}${node?.children?.length ? "?recursive=1" : ""}`, "DELETE");
};
export const bookmarkSources = () => request<BookmarkSource[]>("/api/bookmarks/sources");
export const importBookmarks = (from: { source: string } | { html: string }) =>
  send<BookmarkImportResult>("/api/bookmarks/import", "POST", from);

/** Saves the bookmarks as an HTML file other browsers import. */
export async function exportBookmarks() {
  const res = await fetch(`${window.rune.serverUrl}/api/bookmarks/export`, {
    headers: { Authorization: `Bearer ${window.rune.token}` },
  });
  if (!res.ok) throw new Error(`Exporting failed (${res.status})`);
  const date = new Date();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = `bookmarks_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// --- Bookmarking -------------------------------------------------------------------------------

const FOLDER_KEY = "rune.bookmarkFolder";
/** Where the star puts new bookmarks: the folder chosen last, the bookmarks bar at first. */
export const lastFolder = () => {
  const id = localStorage.getItem(FOLDER_KEY);
  return id && bookmarkById(id)?.children ? id : BAR_ID;
};
export const rememberFolder = (id: string) => localStorage.setItem(FOLDER_KEY, id);

/** The bookmark being edited in the popover under the star (BookmarkEditor). */
export interface EditorState {
  id: string;
  /** Just bookmarked: the popover says so, and Remove takes it back. */
  created: boolean;
}
const [editor, setEditor] = createSignal<EditorState | null>(null);
export { editor as bookmarkEditor, setEditor as setBookmarkEditor };

/**
 * The star and Ctrl+D, like in Chrome: a page that isn't bookmarked yet is, in the
 * folder used last, and the popover shows it to rename or move right away; one
 * that is opens the popover to change it.
 */
export const bookmarkTab = (tabId: string) => bookmarkTabNow(tabId).catch(failed);
const failed = (err: unknown) => toast({ message: `Bookmarking failed: ${(err as Error).message}`, kind: "error" });

async function bookmarkTabNow(tabId: string) {
  const tab = appById(tabId);
  // The page as it is now (the tab's name and address follow it a moment later).
  const live = pageOf(tabId)?.info();
  const url = live?.url || tab?.url;
  if (!url || !canBookmark(url)) return;
  const existing = bookmarkOf(url);
  // Already open: keep what's being typed in it.
  if (existing) return editor()?.id === existing.id || setEditor({ id: existing.id, created: false });
  const node = await addBookmark({ title: live?.title || tab?.name || url, url, parentId: lastFolder() });
  setEditor({ id: node.id, created: true });
}

/** Every web tab of the workspace in a new folder, which the popover then shows to name. */
export const bookmarkAllTabs = () => bookmarkAllTabsNow().catch(failed);

async function bookmarkAllTabsNow() {
  const tabs = workspaceTabs().filter((t) => t.kind === "web" && canBookmark(t.url));
  if (!tabs.length) return;
  const date = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const made = await addBookmark({ title: `${currentWorkspace()?.name ?? "Tabs"} · ${date}`, parentId: lastFolder() });
  // The folder shows even if one of them fails.
  setEditor({ id: made.id, created: true });
  for (const tab of tabs) await addBookmark({ title: tab.name, url: tab.url!, parentId: made.id });
}

/** Opens a bookmark: in the web tab on screen (like clicking it in Chrome), or a new tab. */
export function openBookmark(node: BookmarkNode, where: "here" | "tab" | "background" = "here") {
  if (!node.url) return;
  const id = selectedId();
  if (where === "here" && id && isWebTab(id) && pageOf(id))
    return void pageOf(id)!
      .navigate(node.url)
      .catch((err) => console.error("Opening the bookmark failed:", err));
  void newWebTab(node.url, { background: where === "background" });
}

/** Every page in a folder (not its subfolders), each in a new tab. */
export function openAll(node: BookmarkNode) {
  const pages = (node.children ?? []).filter((c) => c.url);
  pages.forEach((page, i) => void newWebTab(page.url!, { background: i > 0 }));
}

// --- The bookmarks bar ---------------------------------------------------------------------

const BAR_KEY = "rune.bookmarksBar";
const [barShown, setBarShown] = createSignal(localStorage.getItem(BAR_KEY) === "1");
export const isBookmarksBarShown = barShown;
export function setBookmarksBarShown(shown: boolean) {
  setBarShown(shown);
  localStorage.setItem(BAR_KEY, shown ? "1" : "0");
}
export const toggleBookmarksBar = () => setBookmarksBarShown(!barShown());
