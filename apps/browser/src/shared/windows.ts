// Rune Browser's windows. Every window has an id, and every open tab belongs to
// one (AppSummary.windowId). The main process keeps the windows' places in
// windows.json (main/windows.ts), so they come back after a restart and closed
// ones can be reopened with their tabs. Private windows are never saved: their
// tabs are deleted when they close, and their pages' session is wiped then.

/** Private windows' ids start with this; their tabs are private too. */
export const PRIVATE_WINDOW_PREFIX = "private-";
export const WINDOW_ID_PATTERN = /^(w|private)-[\w-]{1,40}$/;

export const isPrivateWindow = (id: string | null | undefined): boolean => !!id && id.startsWith(PRIVATE_WINDOW_PREFIX);

export const newWindowId = (isPrivate = false) =>
  `${isPrivate ? PRIVATE_WINDOW_PREFIX : "w-"}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** Where a window was and how big (x and y only where the platform says; Wayland doesn't). */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  id: string;
  bounds: WindowBounds;
  maximized: boolean;
  /** Closed windows: when. */
  closedAt?: number;
}

/** windows.json: the windows open when Rune Browser last ran, and the ones closed before (newest first). */
export interface WindowsFile {
  version: 1;
  open: SavedWindow[];
  closed: SavedWindow[];
}

/** How many closed windows can be reopened; older ones are forgotten, with their tabs. */
export const CLOSED_WINDOWS_MAX = 10;

/**
 * What a window was opened for: a new tab (Ctrl+N), the startup setting (the first window at launch), a link
 * ("Open link in new window": a tab of its own, in the workspace it came from), or its tabs.
 */
export type WindowIntent = "new-tab" | "startup" | { url: string; workspaceId?: string } | null;

export const DEFAULT_BOUNDS: WindowBounds = { width: 1100, height: 750 };

/** Settings → General → On startup (shared/browser.ts): the windows as they were, a new tab, or the startup pages. */
export type OnStartup = "continue" | "newTab" | "pages";

export interface StartupPlan {
  open: SavedWindow[];
  closed: SavedWindow[];
  /** Windows dropped from the closed list: their tabs go. */
  forget: string[];
}

const validBounds = (b: unknown): b is WindowBounds => {
  const v = b as Partial<WindowBounds> | null;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  return (
    !!v &&
    n(v.width) &&
    n(v.height) &&
    v.width! >= 200 &&
    v.height! >= 150 &&
    (v.x === undefined || n(v.x)) &&
    (v.y === undefined || n(v.y))
  );
};

/** A windows.json as read from disk: anything malformed is left out (and private windows never belong there). */
export function parseWindowsFile(raw: unknown): WindowsFile {
  const list = (value: unknown): SavedWindow[] =>
    (Array.isArray(value) ? value : [])
      .filter(
        (w): w is SavedWindow =>
          !!w &&
          typeof w.id === "string" &&
          WINDOW_ID_PATTERN.test(w.id) &&
          !isPrivateWindow(w.id) &&
          validBounds(w.bounds),
      )
      .map((w) => ({
        id: w.id,
        bounds: w.bounds,
        maximized: w.maximized === true,
        ...(typeof w.closedAt === "number" ? { closedAt: w.closedAt } : {}),
      }));
  const file = raw as Partial<WindowsFile> | null;
  const open = list(file?.open);
  const ids = new Set(open.map((w) => w.id));
  const closed: SavedWindow[] = [];
  for (const w of list(file?.closed)) {
    if (ids.has(w.id)) continue;
    ids.add(w.id);
    closed.push(w);
  }
  return { version: 1, open, closed };
}

/** A new window that hasn't been anywhere yet. */
export const freshWindow = (): SavedWindow => ({ id: newWindowId(), bounds: { ...DEFAULT_BOUNDS }, maximized: false });

/**
 * Which windows open at startup. "continue": all the ones open last time (one
 * new window the first time). Otherwise only the first of them (which then opens
 * a new tab or the startup pages, lib/browser.ts); the others become closed
 * windows, so they can still be reopened with their tabs.
 */
export function startupPlan(saved: WindowsFile, onStartup: OnStartup, now = Date.now()): StartupPlan {
  const open = saved.open.length ? saved.open : [freshWindow()];
  if (onStartup === "continue") return trimClosed({ open, closed: saved.closed, forget: [] });
  const [first, ...rest] = open;
  return trimClosed({
    open: [first!],
    closed: [...rest.map((w) => ({ ...w, closedAt: now })), ...saved.closed],
    forget: [],
  });
}

/** Keeps the newest CLOSED_WINDOWS_MAX closed windows; the rest are forgotten. */
export function trimClosed<T extends { closed: SavedWindow[]; forget: string[] }>(plan: T): T {
  const keep = plan.closed.slice(0, CLOSED_WINDOWS_MAX);
  const dropped = plan.closed.slice(CLOSED_WINDOWS_MAX).map((w) => w.id);
  return { ...plan, closed: keep, forget: [...plan.forget, ...dropped] };
}

/**
 * Where tabs go when the windows change (POST /api/windows): the server deletes
 * private tabs whose window isn't open and the tabs of forgotten windows,
 * and gives tabs of windows it doesn't know (or none) to the first open window.
 */
export interface WindowsSync {
  open: string[];
  closed: string[];
  forget: string[];
}

export type TabFate = "keep" | "delete" | { adopt: string };

/** What happens to one tab in a sync (see WindowsSync). */
export function tabFate(tab: { windowId: string | null }, sync: WindowsSync): TabFate {
  const open = new Set(sync.open);
  if (tab.windowId && open.has(tab.windowId)) return "keep";
  if (isPrivateWindow(tab.windowId)) return "delete";
  if (tab.windowId && sync.closed.includes(tab.windowId)) return "keep";
  if (tab.windowId && sync.forget.includes(tab.windowId)) return "delete";
  const home = sync.open.find((id) => !isPrivateWindow(id));
  return home ? { adopt: home } : "keep";
}
