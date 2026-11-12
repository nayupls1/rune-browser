// A web tab's right-click menu, like Chromium's (render_view_context_menu.cc):
// spelling suggestions, then what was clicked (a link, an image or video, an
// editable field, selected text, else the page), the extensions' items, and
// Inspect last. No Electron imports, so it's tested on its own.
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll";

/** What the video and audio items do to the element that was clicked (mediaActionScript). */
export type MediaAction =
  { kind: "loop"; on: boolean } | { kind: "controls"; on: boolean } | { kind: "pip"; on: boolean };

export interface MenuActions {
  openTab: (url: string, background: boolean) => void;
  /** "Open link in new window" (a private one from a private window) and "Open link in private window". */
  openWindow: (url: string, isPrivate: boolean) => void;
  /** The page is in a private window: its links can't go to another private window, they're in one. */
  isPrivate: boolean;
  /** Loop, Show controls, Picture in picture on the video or audio that was clicked. */
  media: (action: MediaAction) => void;
  copyVideoFrame: () => void;
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
      { label: "Open link in new window", click: () => a.openWindow(link, a.isPrivate) },
      // Chrome's "Open link in incognito window", grayed out in one.
      { label: "Open link in private window", enabled: !a.isPrivate, click: () => a.openWindow(link, true) },
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
  } else if (media === "video" || media === "audio") {
    // Chrome's (AppendMediaItems, AppendVideoItems): the element's state as checkboxes, then its address.
    const kind = media;
    const f = params.mediaFlags;
    groups.push(
      [
        {
          label: "Loop",
          type: "checkbox",
          checked: f.isLooping,
          enabled: !f.inError,
          click: () => a.media({ kind: "loop", on: !f.isLooping }),
        },
        {
          label: "Show controls",
          type: "checkbox",
          checked: f.isControlsVisible,
          enabled: f.canToggleControls,
          click: () => a.media({ kind: "controls", on: !f.isControlsVisible }),
        },
      ],
      [
        ...(src
          ? [
              { label: `Open ${kind} in new tab`, click: () => a.openTab(src, true) },
              { label: `Save ${kind} as…`, enabled: f.canSave, click: () => a.download(src) },
              { label: `Copy ${kind} address`, click: () => a.copyText(src) },
            ]
          : []),
        ...(kind === "video"
          ? [
              { label: "Copy video frame", enabled: !f.inError, click: a.copyVideoFrame },
              {
                label: "Picture in picture",
                type: "checkbox" as const,
                checked: f.isShowingPictureInPicture,
                enabled: f.canShowPictureInPicture,
                click: () => a.media({ kind: "pip", on: !f.isShowingPictureInPicture }),
              },
            ]
          : []),
      ],
    );
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

/**
 * The script a video or audio item runs in the frame that was clicked: the media element at the
 * point (in the frame's CSS pixels; null in a subframe, whose offset isn't known), else the one
 * playing `src`, else the frame's only one. Only numbers, booleans and a JSON string go in: the
 * page decides nothing about what runs. It resolves to whether it found the element.
 */
export function mediaActionScript(action: MediaAction, point: { x: number; y: number } | null, src: string) {
  const at =
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? `document.elementsFromPoint(${Math.round(point.x)}, ${Math.round(point.y)}).find(isMedia)`
      : "undefined";
  const on = action.on === true;
  const act =
    action.kind === "loop"
      ? `el.loop = ${on}; return true;`
      : action.kind === "controls"
        ? `el.controls = ${on}; return true;`
        : on
          ? `return el instanceof HTMLVideoElement ? el.requestPictureInPicture().then(() => true) : false;`
          : `return document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true) : false;`;
  return `(() => {
  const isMedia = (e) => e instanceof HTMLMediaElement;
  let el = ${at};
  if (!el) {
    const all = [...document.querySelectorAll("video, audio")];
    const src = ${JSON.stringify(src)};
    el = (src && all.find((m) => m.currentSrc === src)) || (all.length === 1 ? all[0] : undefined);
  }
  if (!el) return false;
  ${act}
})()`;
}
