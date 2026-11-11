// A web tab's back/forward history, kept with the tab (the apps table's `history`) so it comes back
// after a restart, when an unloaded tab is opened again, and with Ctrl+Shift+T, like Chrome restores
// tabs. Only the address and title of each page: no page state (scroll, what was typed), which the
// tab keeps in memory while it's unloaded (renderer: lib/pagestate.ts). Private windows keep nothing.
// The main process rebuilds it in a fresh page with navigationHistory.restore (main/web.ts).

export interface HistoryEntry {
  url: string;
  title: string;
}

export interface TabHistory {
  entries: HistoryEntry[];
  /** The page the tab is on. */
  index: number;
}

/** Pages kept per tab, like Chrome keeps about 50 when it restores one. */
export const MAX_HISTORY = 50;
const MAX_URL = 8000;
const MAX_TITLE = 300;

/** Pages a tab can open again by itself: websites, extension pages and local files the user opened. */
export const isRestorableUrl = (url: string) =>
  url.length <= MAX_URL && /^(https?:\/\/|chrome-extension:\/\/|file:\/\/\/)/i.test(url);

/**
 * A tab's history as it's kept: pages it can't open again by itself left out (about:blank, data:),
 * titles shortened, at most MAX_HISTORY pages around the current one (more of them back than forward).
 * With `current`, the tab's saved address: when the history ends elsewhere (saved a moment apart),
 * it goes there as a new page, like a navigation would. Null when there's nothing to keep.
 */
export function trimHistory(history: TabHistory | null | undefined, current?: string | null): TabHistory | null {
  const raw = Array.isArray(history?.entries) ? history.entries : [];
  const at = Number.isInteger(history?.index) ? history!.index : raw.length - 1;
  const entries: HistoryEntry[] = [];
  let index = -1;
  raw.forEach((e, i) => {
    if (!e || typeof e.url !== "string" || !isRestorableUrl(e.url)) return;
    entries.push({ url: e.url, title: typeof e.title === "string" ? e.title.slice(0, MAX_TITLE) : "" });
    // The current page, or the closest one before it that's kept.
    if (i <= at) index = entries.length - 1;
  });
  if (index === -1) index = entries.length ? 0 : -1;
  if (current && isRestorableUrl(current) && entries[index]?.url !== current) {
    entries.splice(index + 1);
    entries.push({ url: current, title: "" });
    index = entries.length - 1;
  }
  if (!entries.length) return null;
  if (entries.length <= MAX_HISTORY) return { entries, index };
  const forward = Math.min(entries.length - 1 - index, Math.floor(MAX_HISTORY / 4));
  const start = Math.max(0, index - (MAX_HISTORY - 1 - forward));
  return { entries: entries.slice(start, start + MAX_HISTORY), index: index - start };
}

/** Whether there's anything to go back or forward to (otherwise the address alone is enough). */
export const hasHistory = (history: TabHistory | null | undefined): history is TabHistory =>
  !!history && history.entries.length > 1;
