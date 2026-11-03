// A web tab's right-click menu, like Chromium's (render_view_context_menu.cc):
// spelling suggestions, then what was clicked (a link, an image or video, an
// editable field, selected text, else the page), the extensions' items, and
// Inspect last. No Electron imports, so it's tested on its own.
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll";

export interface MenuActions {
  openTab: (url: string, background: boolean) => void;
  /** In the system's default browser. */
  openExternal: (url: string) => void;
  copyText: (text: string) => void;
  /** Saves a URL (a link, an image) where the user picks. */
  download: (url: string) => void;
  copyImageAt: (x: number, y: number) => void;
  edit: (command: EditCommand) => void;
  replaceMisspelling: (word: string) => void;
  addToDictionary: (word: string) => void;
  /** The system's emoji picker, where there is one. */
  emoji?: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  back: () => void;
  forward: () => void;
  reload: () => void;
  savePage: () => void;
  print: () => void;
  viewSource: () => void;
  /** The page's address (web pages only: "Open page in default browser"). */
  pageUrl: string;
  inspect: (x: number, y: number) => void;
  /** The search engine Settings picked: "Search DuckDuckGo for …". */
  search?: { label: string; url: string };
  /** A menu item's shortcut (shown only: the keys work from the page). */
  keys: (id: string) => Partial<MenuItemConstructorOptions>;
  /** The extensions' items for this click (chrome.contextMenus). */
  extensionItems: MenuItemConstructorOptions[];
}

const isWebUrl = (url: string) => /^https?:/i.test(url);
const separator: MenuItemConstructorOptions = { type: "separator" };

/** "Search Google for “a long sel…”": Chromium shortens the selection to 32 characters. */
export const quoteSelection = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length > 32 ? `${flat.slice(0, 31)}…` : flat}”`;
};

/** A selection that's an address: "Go to …" instead of searching for it. */
export function selectionUrl(text: string): string | null {
  const flat = text.trim();
  if (!flat || /\s/.test(flat) || flat.length > 2000) return null;
  if (/^https?:\/\/\S+$/i.test(flat)) return flat;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(flat)) return `https://${flat}`;
  return null;
}

/** Adds groups of items with one separator between non-empty groups. */
function joined(groups: MenuItemConstructorOptions[][]) {
  const out: MenuItemConstructorOptions[] = [];
  for (const group of groups.filter((g) => g.length)) {
    if (out.length) out.push(separator);
    out.push(...group);
  }
  return out;
}

export function buildContextMenu(params: ContextMenuParams, a: MenuActions): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  const media = params.mediaType;
  const link = params.linkURL && isWebUrl(params.linkURL) ? params.linkURL : "";
  const src = params.srcURL && isWebUrl(params.srcURL) ? params.srcURL : "";
  const selection = params.selectionText.trim();

  if (params.isEditable && params.misspelledWord) {
    groups.push([
      ...(params.dictionarySuggestions.length
        ? params.dictionarySuggestions.slice(0, 5).map((word) => ({
            label: word,
            click: () => a.replaceMisspelling(word),
          }))
        : [{ label: "No spelling suggestions", enabled: false }]),
      separator,
      { label: "Add to dictionary", click: () => a.addToDictionary(params.misspelledWord) },
    ]);
  }

  if (link) {
    groups.push([
      { label: "Open link in new tab", click: () => a.openTab(link, true) },
      { label: "Open link in default browser", click: () => a.openExternal(link) },
      separator,
      { label: "Save link as…", click: () => a.download(link) },
      { label: "Copy link address", click: () => a.copyText(link) },
      ...(params.linkText.trim() && !selection
        ? [{ label: "Copy link text", click: () => a.copyText(params.linkText.trim()) }]
        : []),
    ]);
  }

  if (media === "image" && src) {
    groups.push([
      { label: "Open image in new tab", click: () => a.openTab(src, true) },
      { label: "Save image as…", click: () => a.download(src) },
      { label: "Copy image", click: () => a.copyImageAt(params.x, params.y) },
      { label: "Copy image address", click: () => a.copyText(src) },
    ]);
  } else if ((media === "video" || media === "audio") && src) {
    const kind = media;
    groups.push([
      { label: `Open ${kind} in new tab`, click: () => a.openTab(src, true) },
      { label: `Save ${kind} as…`, enabled: params.mediaFlags.canSave, click: () => a.download(src) },
      { label: `Copy ${kind} address`, click: () => a.copyText(src) },
    ]);
  }

  if (params.isEditable) {
    const f = params.editFlags;
    groups.push(
      a.emoji ? [{ label: "Emoji", click: a.emoji }] : [],
      [
        { label: "Undo", enabled: f.canUndo, click: () => a.edit("undo") },
        { label: "Redo", enabled: f.canRedo, click: () => a.edit("redo") },
      ],
      [
        { label: "Cut", enabled: f.canCut, click: () => a.edit("cut") },
        { label: "Copy", enabled: f.canCopy, click: () => a.edit("copy") },
        { label: "Paste", enabled: f.canPaste, click: () => a.edit("paste") },
        {
          label: "Paste as plain text",
          enabled: f.canPaste && f.canEditRichly,
          click: () => a.edit("pasteAndMatchStyle"),
        },
        { label: "Select all", enabled: f.canSelectAll, click: () => a.edit("selectAll") },
      ],
    );
  } else if (selection) {
    const url = selectionUrl(selection);
    const search = a.search;
    const go: MenuItemConstructorOptions[] = url
      ? [{ label: `Go to ${url.replace(/^https:\/\//, "")}`, click: () => a.openTab(url, false) }]
      : search
        ? [
            {
              label: `Search ${search.label} for ${quoteSelection(selection)}`,
              click: () => a.openTab(search.url.replace("%s", encodeURIComponent(selection)), false),
            },
          ]
        : [];
    groups.push([
      { label: "Copy", click: () => a.edit("copy") },
      ...go,
      { label: "Print…", click: a.print, ...a.keys("page.print") },
    ]);
  }

  // Nothing in particular was clicked: the page's own items.
  if (!link && media === "none" && !params.isEditable && !selection) {
    groups.push(
      [
        { label: "Back", enabled: a.canGoBack, click: a.back, ...a.keys("nav.back") },
        { label: "Forward", enabled: a.canGoForward, click: a.forward, ...a.keys("nav.forward") },
        { label: "Reload", click: a.reload, ...a.keys("nav.reload") },
      ],
      [
        { label: "Save as…", click: a.savePage, ...a.keys("page.save") },
        { label: "Print…", click: a.print, ...a.keys("page.print") },
      ],
      [
        ...(isWebUrl(a.pageUrl)
          ? [{ label: "Open page in default browser", click: () => a.openExternal(a.pageUrl) }]
          : []),
        { label: "View page source", click: a.viewSource, ...a.keys("page.source") },
      ],
    );
  }

  groups.push(a.extensionItems);
  groups.push([{ label: "Inspect", click: () => a.inspect(params.x, params.y), ...a.keys("page.inspect") }]);
  return joined(groups);
}
