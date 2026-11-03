// Browsing history: the pages web tabs visited, per workspace (db/Visits.ts),
// listed by the History page and suggested by the address bar.

/** One visit to a page. */
export interface Visit {
  id: number;
  workspaceId: string;
  /** The tab it happened in (it may have been closed since). */
  tabId: string | null;
  url: string;
  title: string;
  favicon: string | null;
  visitedAt: string;
}

/** A page from history for the address bar: its latest title and icon, how often and when it was last visited. */
export interface VisitSuggestion {
  url: string;
  title: string;
  favicon: string | null;
  visits: number;
  lastVisit: string;
}

/** How long visits are kept, like Chromium. */
export const KEEP_DAYS = 90;

/** What "Clear history" offers, like Chromium's "Delete browsing data". */
export const clearRanges = [
  { id: "hour", label: "Last hour", ms: 3600_000 },
  { id: "day", label: "Last 24 hours", ms: 24 * 3600_000 },
  { id: "week", label: "Last 7 days", ms: 7 * 24 * 3600_000 },
  { id: "month", label: "Last 4 weeks", ms: 28 * 24 * 3600_000 },
  { id: "all", label: "All time", ms: null },
] as const;

/** Pages that go into history: websites and local files (not blank, extension or data pages). */
export const isRecordable = (url: string) => /^(https?|file):/i.test(url) && url.length <= 8000;

/** What history's search looks in: the title and the address (also decoded), lowercased here since SQLite's lower() only folds ASCII. */
export const searchText = (url: string, title: string) => {
  let decoded = url;
  try {
    decoded = decodeURI(url);
  } catch {}
  return [title, url, ...(decoded === url ? [] : [decoded])].join("\n").toLowerCase();
};

/** The same page for history: only the #hash differs (in-page anchors aren't another visit). */
export const samePage = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];

/** The calendar day of a time, in local time (for grouping visits by day). */
export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A day's heading: "Today", "Yesterday", or the date. */
export const dayLabel = (iso: string, now = new Date()) => {
  const key = dayKey(iso);
  const date = new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: new Date(iso).getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  if (key === dayKey(now.toISOString())) return `Today – ${date}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday.toISOString())) return `Yesterday – ${date}`;
  return date;
};

/** Visits grouped by day, newest first (the list is newest first already). */
export const byDay = <T extends { visitedAt: string }>(visits: readonly T[]) => {
  const days: { key: string; visits: T[] }[] = [];
  for (const visit of visits) {
    const key = dayKey(visit.visitedAt);
    if (days.at(-1)?.key === key) days.at(-1)!.visits.push(visit);
    else days.push({ key, visits: [visit] });
  }
  return days;
};

/**
 * Pages from history best first for what's typed: an address that starts with it (the site
 * you're typing), then titles with a word that starts with it, then anything containing it;
 * within those, pages visited more often and more recently.
 */
export const rankSuggestions = (query: string, pages: readonly VisitSuggestion[], now = Date.now()) => {
  const q = query.trim().toLowerCase();
  const score = (page: VisitSuggestion) => {
    const address = displayUrl(page.url).toLowerCase();
    const title = page.title.toLowerCase();
    let s = 0;
    if (address.startsWith(q) || address.startsWith(`www.${q}`)) s += 100;
    else if (address.split(/[./?#&=_-]/).some((part) => part.startsWith(q))) s += 40;
    if (title.startsWith(q)) s += 40;
    else if (title.split(/\W+/).some((word) => word.startsWith(q))) s += 25;
    const days = Math.max(0, (now - Date.parse(page.lastVisit)) / 86400_000);
    return s + Math.min(page.visits, 20) * 2 + Math.max(0, 30 - days);
  };
  return pages
    .map((page) => ({ page, score: score(page) }))
    .sort((a, b) => b.score - a.score || a.page.url.length - b.page.url.length)
    .map((r) => r.page);
};

/** A URL as the address bar and the list show it: without the scheme and a lone trailing slash. */
export const displayUrl = (url: string) => url.replace(/^https?:\/\//i, "").replace(/^([^/?#]+)\/$/, "$1");
