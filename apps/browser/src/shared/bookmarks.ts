// Bookmarks: Chrome's tree (a root with the bookmarks bar and other bookmarks,
// folders and pages in them), shaped like chrome.bookmarks' nodes so extensions
// get them as they are. The server keeps them (db/Bookmarks.ts); this file has
// what the server, the renderer and the main process share: finding and
// searching in the tree, and the formats bookmarks come in and go out as
// (Chrome's Bookmarks file, Firefox's places, the HTML file every browser
// imports and exports).

export const ROOT_ID = "0";
export const BAR_ID = "1";
export const OTHER_ID = "2";
export const ROOT_FOLDERS = [BAR_ID, OTHER_ID];

export interface BookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  /** Pages have one; folders don't. */
  url?: string;
  /** Milliseconds since the epoch. */
  dateAdded?: number;
  /** Folders: when their contents last changed. */
  dateGroupModified?: number;
  /** The bookmarks bar and other bookmarks (Chrome 134's folderType). */
  folderType?: "bookmarks-bar" | "other";
  syncing: boolean;
  /** Folders (the root too). */
  children?: BookmarkNode[];
}

/** What extensions and the renderer are told when bookmarks change (chrome.bookmarks' events). */
export type BookmarkChange =
  | { kind: "created"; id: string; node: BookmarkNode }
  | { kind: "removed"; id: string; parentId: string; index: number; node: BookmarkNode }
  | { kind: "changed"; id: string; title: string; url?: string }
  | { kind: "moved"; id: string; parentId: string; index: number; oldParentId: string; oldIndex: number }
  /** Bookmarks were imported: the top-level nodes made (each with its children). */
  | { kind: "imported"; nodes: BookmarkNode[] };

/** A bookmark or folder from another browser, before it's saved. */
export interface ImportedBookmark {
  title: string;
  url?: string;
  dateAdded?: number;
  children?: ImportedBookmark[];
}

/** Another browser's bookmarks: what was on its bookmarks bar, and everything else. */
export interface ImportedBookmarks {
  bar: ImportedBookmark[];
  other: ImportedBookmark[];
}

/** A browser profile on this computer whose bookmarks can be imported. */
export interface BookmarkSource {
  id: string;
  browser: string;
  profile: string;
  count: number;
}

export interface BookmarkImportResult {
  added: number;
  /** Bookmarks of kinds Rune Browser can't open (javascript:, place: queries…), left out. */
  skipped: number;
}

// --- Addresses -------------------------------------------------------------------------

const SCHEMES = new Set(["http:", "https:", "file:", "chrome-extension:"]);

/** A bookmark's address, written the way the browser does (`https://example.com/`); null if it can't be one. */
export function bookmarkUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 8192) return null;
  try {
    const url = new URL(text);
    return SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** The same page for "is it bookmarked": the address without its #fragment. */
export const samePage = (url: string) => {
  const parsed = bookmarkUrl(url);
  return parsed ? parsed.replace(/#.*$/, "") : url;
};

// --- The tree --------------------------------------------------------------------------

/** Every node under `node` (itself first). */
export function* walk(node: BookmarkNode): Generator<BookmarkNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

export const findNode = (root: BookmarkNode, id: string) => {
  for (const node of walk(root)) if (node.id === id) return node;
  return undefined;
};

/** The folders from the root down to the node (not including it). */
export function ancestors(root: BookmarkNode, id: string): BookmarkNode[] {
  const path: BookmarkNode[] = [];
  const visit = (node: BookmarkNode): boolean => {
    if (node.id === id) return true;
    path.push(node);
    for (const child of node.children ?? []) if (visit(child)) return true;
    path.pop();
    return false;
  };
  return visit(root) ? path : [];
}

export const isFolder = (node: BookmarkNode) => node.url === undefined;

/** The node without its children (chrome.bookmarks.get and search answer like this). */
export const withoutChildren = ({ children: _, ...node }: BookmarkNode): BookmarkNode => node;

/** Pages bookmarked (not folders), in the tree's order. */
export const allBookmarks = (root: BookmarkNode) => [...walk(root)].filter((n) => n.url !== undefined);

/** Every folder but the root, with how deep it is (the root's own folders are 0). */
export function allFolders(root: BookmarkNode): { node: BookmarkNode; depth: number }[] {
  const out: { node: BookmarkNode; depth: number }[] = [];
  const visit = (node: BookmarkNode, depth: number) => {
    for (const child of node.children ?? []) {
      if (!isFolder(child)) continue;
      out.push({ node: child, depth });
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

/**
 * chrome.bookmarks.search: a string's words all appear in the title or the
 * address (any case); an object can also ask for an exact `url` or `title`.
 */
export function searchBookmarks(
  root: BookmarkNode,
  query: string | { query?: string; url?: string; title?: string },
): BookmarkNode[] {
  const q = typeof query === "string" ? { query } : query;
  const words = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const url = q.url !== undefined ? (bookmarkUrl(q.url) ?? q.url) : undefined;
  if (!words.length && url === undefined && q.title === undefined) return [];
  return [...walk(root)].filter((node) => {
    if (ROOT_FOLDERS.includes(node.id) || node.id === ROOT_ID) return false;
    if (url !== undefined && node.url !== url) return false;
    if (q.title !== undefined && node.title !== q.title) return false;
    const text = `${node.title}\n${node.url ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The pages bookmarked last, newest first. */
export const recentBookmarks = (root: BookmarkNode, count: number) =>
  allBookmarks(root)
    .sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0))
    .slice(0, Math.max(0, count));

/** How many pages Rune Browser can open there are in a tree of imported bookmarks. */
export const countImported = (list: ImportedBookmark[]): number =>
  list.reduce((n, b) => n + (b.url !== undefined ? (bookmarkUrl(b.url) ? 1 : 0) : countImported(b.children ?? [])), 0);

// --- Chrome's Bookmarks file --------------------------------------------------------------

interface ChromeNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  children?: ChromeNode[];
}

/** Chrome's times are microseconds since 1601. */
const fromWebkitTime = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000 - 11_644_473_600_000) : undefined;
};

const fromChrome = (nodes: ChromeNode[] | undefined): ImportedBookmark[] =>
  (Array.isArray(nodes) ? nodes : []).flatMap((n): ImportedBookmark[] => {
    if (!n || typeof n !== "object") return [];
    const title = typeof n.name === "string" ? n.name : "";
    const dateAdded = fromWebkitTime(n.date_added);
    if (n.type === "url" && typeof n.url === "string") return [{ title, url: n.url, dateAdded }];
    if (n.type === "folder") return [{ title, dateAdded, children: fromChrome(n.children) }];
    return [];
  });

/** A Chromium browser's `Bookmarks` file (JSON): its bar, other and mobile bookmarks. */
export function chromeBookmarks(json: unknown): ImportedBookmarks {
  const roots = (json as { roots?: Record<string, ChromeNode> } | null)?.roots ?? {};
  const mobile = fromChrome(roots.synced?.children);
  return {
    bar: fromChrome(roots.bookmark_bar?.children),
    other: [
      ...fromChrome(roots.other?.children),
      ...(mobile.length ? [{ title: roots.synced?.name || "Mobile bookmarks", children: mobile }] : []),
    ],
  };
}

// --- Firefox's places ---------------------------------------------------------------------

/** A row of Firefox's moz_bookmarks, with its moz_places url. */
export interface FirefoxRow {
  id: number;
  type: number;
  parent: number;
  position: number;
  title: string | null;
  url: string | null;
  dateAdded: number | null;
  guid: string;
}

/** Firefox's (and Zen's, LibreWolf's…) bookmarks: its toolbar, menu, other and mobile bookmarks. */
export function firefoxBookmarks(rows: FirefoxRow[]): ImportedBookmarks {
  const children = new Map<number, FirefoxRow[]>();
  for (const row of rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  const build = (parent: number): ImportedBookmark[] =>
    (children.get(parent) ?? [])
      .sort((a, b) => a.position - b.position)
      .flatMap((row): ImportedBookmark[] => {
        const title = row.title ?? "";
        // Firefox keeps microseconds.
        const dateAdded = row.dateAdded ? Math.round(row.dateAdded / 1000) : undefined;
        if (row.type === 1 && row.url) return [{ title, url: row.url, dateAdded }];
        if (row.type === 2) return [{ title, dateAdded, children: build(row.id) }];
        return []; // separators
      });
  const root = (guid: string) => rows.find((r) => r.guid === guid);
  const items = (guid: string) => {
    const row = root(guid);
    return row ? build(row.id) : [];
  };
  const folder = (guid: string, fallback: string) => {
    const list = items(guid);
    return list.length ? [{ title: root(guid)?.title || fallback, children: list }] : [];
  };
  return {
    bar: items("toolbar_____"),
    other: [
      ...items("unfiled_____"),
      ...folder("menu________", "Bookmarks Menu"),
      ...folder("mobile______", "Mobile Bookmarks"),
    ],
  };
}

// --- The bookmarks HTML file --------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attribute = (attrs: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
};

const seconds = (value: string | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
};

/**
 * The "Netscape bookmark file" every browser imports and exports: folders are
 * <H3>s followed by a <DL> of their contents, pages are <A HREF>s. The folder
 * marked PERSONAL_TOOLBAR_FOLDER is the bookmarks bar; Firefox's "Other
 * Bookmarks" (UNFILED_BOOKMARKS_FOLDER) goes with the rest.
 */
export function parseBookmarksHtml(html: string): ImportedBookmarks {
  const result: ImportedBookmarks = { bar: [], other: [] };
  const top: ImportedBookmark[] = [];
  // The list being filled, and the folder its next <DL> belongs to.
  const stack: ImportedBookmark[][] = [];
  let current: ImportedBookmark[] = top;
  let pending: { list: ImportedBookmark[]; role: "bar" | "unfiled" | null } | null = null;
  let barList: ImportedBookmark[] | null = null;
  let unfiledList: ImportedBookmark[] | null = null;
  const tag = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  const lower = html.toLowerCase();
  // Where an entry's text ends: its closing tag, or the next entry or list.
  const textEnd = /<\/a\b|<\/h3\b|<\/?dl\b|<dt\b|<dd\b|<h3\b|<a\b/g;
  let started = false;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const closing = m[1] === "/";
    const name = m[2]?.toLowerCase();
    if (!name) continue;
    if (name === "dl") {
      if (closing) {
        current = stack.pop() ?? top;
        continue;
      }
      // The first <DL> is the file's own list.
      if (!started) {
        started = true;
        continue;
      }
      stack.push(current);
      const into = pending?.list ?? [];
      if (pending?.role === "bar") barList = into;
      if (pending?.role === "unfiled") unfiledList = into;
      current = into;
      pending = null;
      continue;
    }
    if (closing || (name !== "a" && name !== "h3")) continue;
    // The text runs to its closing tag, or the next entry's if that's missing (an icon's <IMG> is skipped).
    textEnd.lastIndex = tag.lastIndex;
    const stop = textEnd.exec(lower);
    const end = stop ? stop.index : html.length;
    const text = decodeEntities(html.slice(tag.lastIndex, end).replace(/<[^>]*>/g, "")).trim();
    if (stop && stop[0] === `</${name}`) tag.lastIndex = Math.max(tag.lastIndex, lower.indexOf(">", end) + 1);
    const dateAdded = seconds(attribute(m[3]!, "add_date"));
    if (name === "h3") {
      const folder: ImportedBookmark = { title: text, dateAdded, children: [] };
      const role = /personal_toolbar_folder\s*=\s*"?true/i.test(m[3]!)
        ? "bar"
        : /unfiled_bookmarks_folder\s*=\s*"?true/i.test(m[3]!)
          ? "unfiled"
          : null;
      if (!role) current.push(folder);
      pending = { list: folder.children!, role };
    } else {
      const href = attribute(m[3]!, "href");
      if (href) current.push({ title: text, url: href, dateAdded });
    }
  }
  result.bar = barList ?? [];
  result.other = [...top, ...(unfiledList ?? [])];
  return result;
}

/** The bookmarks as the HTML file other browsers import (Chrome's export, the bar marked as the toolbar). */
export function bookmarksHtml(root: BookmarkNode): string {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const date = (ms: number | undefined) => (ms ? ` ADD_DATE="${Math.floor(ms / 1000)}"` : "");
  const write = (nodes: readonly BookmarkNode[], depth: number) => {
    const pad = "    ".repeat(depth);
    for (const node of nodes) {
      if (node.url !== undefined) {
        lines.push(`${pad}<DT><A HREF="${escapeHtml(node.url)}"${date(node.dateAdded)}>${escapeHtml(node.title)}</A>`);
        continue;
      }
      const modified = node.dateGroupModified ? ` LAST_MODIFIED="${Math.floor(node.dateGroupModified / 1000)}"` : "";
      const bar = node.id === BAR_ID ? ' PERSONAL_TOOLBAR_FOLDER="true"' : "";
      lines.push(`${pad}<DT><H3${date(node.dateAdded)}${modified}${bar}>${escapeHtml(node.title)}</H3>`);
      lines.push(`${pad}<DL><p>`);
      write(node.children ?? [], depth + 1);
      lines.push(`${pad}</DL><p>`);
    }
  };
  // The bar as the toolbar folder, other bookmarks loose after it (where browsers put what they import).
  const bar = (root.children ?? []).filter((n) => n.id === BAR_ID);
  const rest = (root.children ?? []).flatMap((n) =>
    n.id === BAR_ID ? [] : n.id === OTHER_ID ? (n.children ?? []) : [n],
  );
  write(bar, 1);
  write(rest, 1);
  lines.push("</DL><p>", "");
  return lines.join("\n");
}
