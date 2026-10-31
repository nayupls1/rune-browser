// Dragging things into Rune Browser, like into Chrome: files dropped on the
// tab list or the window open in new tabs (on a tab: in that tab), several
// files in several tabs; links and text dropped on the tab list open or are
// searched for. Files the browser can't show are downloaded (lib/files.ts).
// Pages get what's dropped on them themselves (an upload area takes the file;
// elsewhere the page's tab opens it): the window never sees those drags.
import { createSignal } from "solid-js";
import { normalizeUrl } from "../../shared/web";
import { openFile, openUrl } from "./files";
import { draggedSplit, draggedTab, TAB_DRAG_TYPE } from "./layout";
import { settings } from "./settings";

/** Where a drag would open: a tab (its id), a new tab from the tab list, or a new tab from the window. */
export type DropTarget = { kind: "tab"; id: string } | { kind: "list" } | { kind: "window"; tabId?: string };

const [dropTarget, setTarget] = createSignal<DropTarget | null>(null);
export { dropTarget };

// Drags don't reliably say when they leave the window: the indicator goes once dragover stops.
let clearTimer: ReturnType<typeof setTimeout> | undefined;
export function setDropTarget(target: DropTarget | null) {
  clearTimeout(clearTimer);
  const current = dropTarget();
  if (JSON.stringify(current) !== JSON.stringify(target)) setTarget(target);
  if (target) clearTimer = setTimeout(() => setTarget(null), 200);
}

/** A drag from outside Rune Browser's own UI (not a tab, split view or workspace being moved). */
const isOwnDrag = (dt: DataTransfer) =>
  !!draggedTab() ||
  !!draggedSplit() ||
  dt.types.some((t) => t.startsWith("application/x-rune")) ||
  dt.types.includes(TAB_DRAG_TYPE);

/** Files are being dragged in. */
export const hasFiles = (dt: DataTransfer | null) => !!dt && !isOwnDrag(dt) && dt.types.includes("Files");

/** Files, a link or text is being dragged in (what the tab list takes). */
export const hasDroppable = (dt: DataTransfer | null) =>
  !!dt &&
  !isOwnDrag(dt) &&
  (dt.types.includes("Files") || dt.types.includes("text/uri-list") || dt.types.includes("text/plain"));

/** A dropped link's URL, or text as an address or a search. */
function droppedUrl(dt: DataTransfer): string | null {
  const link = dt
    .getData("text/uri-list")
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.startsWith("#"));
  const text = (link ?? dt.getData("text/plain")).trim();
  if (!text || text.length > 4000) return null;
  const url = normalizeUrl(text.split(/\r?\n/)[0]!, settings().web.searchEngine);
  return /^(https?|file):\/\//i.test(url) ? url : null;
}

/**
 * Opens what was dropped: the first file (or the link) in `tabId` if given,
 * the rest in new tabs (in the background, like Chrome). True if something opened.
 */
export function openDropped(dt: DataTransfer, options: { tabId?: string } = {}) {
  const files = [...dt.files].map((file) => ({ file, path: window.rune.web.pathForFile(file) })).filter((f) => f.path);
  if (files.length) {
    // One after the other, so the tabs come in the files' order.
    void (async () => {
      for (const [i, { file, path }] of files.entries())
        await openFile(path, { mime: file.type, tabId: i === 0 ? options.tabId : undefined, background: i > 0 });
    })();
    return true;
  }
  if (dt.files.length) return false;
  const url = droppedUrl(dt);
  if (!url) return false;
  void openUrl(url, { tabId: options.tabId });
  return true;
}
