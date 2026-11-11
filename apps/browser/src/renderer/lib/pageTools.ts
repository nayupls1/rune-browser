// What the browser does to a tab's page from the keyboard and the address
// bar: find in page (components/FindBar.tsx) and zoom. Pages of the same site
// share their zoom, like in Chromium, and web pages' sites keep it (the browser
// settings' page zoom).
import { createEffect, createRoot, on } from "solid-js";
import { createStore } from "solid-js/store";
import { defaultZoom, rememberZoom, zoomForUrl } from "./browser";
import { settings } from "./settings";
import { pageOf } from "./webtabs";

// --- Find in page ------------------------------------------------------------------

export interface FindState {
  open: boolean;
  query: string;
  /** The match that's highlighted (1-based) and how many there are; 0 of 0 before anything's found. */
  active: number;
  total: number;
  /** Bumped to focus (and select) the find field again. */
  focus: number;
}

const [finds, setFinds] = createStore<Record<string, FindState>>({});

export const findOf = (tabId: string): FindState | undefined => finds[tabId];

const viewOf = (tabId: string) => pageOf(tabId)?.view();

/** Opens the find bar (or focuses it again), with the last search. */
export function openFind(tabId: string) {
  const current = finds[tabId];
  setFinds(tabId, {
    open: true,
    query: current?.query ?? "",
    active: current?.active ?? 0,
    total: current?.total ?? 0,
    focus: (current?.focus ?? 0) + 1,
  });
  if (current?.query) search(tabId, current.query);
}

export function closeFind(tabId: string) {
  if (!finds[tabId]?.open) return;
  setFinds(tabId, { open: false });
  try {
    viewOf(tabId)?.stopFindInPage("keepSelection");
  } catch {
    // the page is gone
  }
}

/** Searches the page as the text is typed (a new search). */
export function search(tabId: string, query: string) {
  setFinds(tabId, { query });
  const view = viewOf(tabId);
  if (!view) return;
  if (!query) {
    setFinds(tabId, { active: 0, total: 0 });
    view.stopFindInPage("clearSelection");
    return;
  }
  view.findInPage(query, { findNext: true });
}

/** The next or previous match; opens the find bar if it's closed. */
export function findStep(tabId: string, forward: boolean) {
  const state = finds[tabId];
  if (!state?.open || !state.query) return openFind(tabId);
  viewOf(tabId)?.findInPage(state.query, { forward, findNext: false });
}

/** What the page found (its found-in-page event). */
export function foundInPage(tabId: string, result: { activeMatchOrdinal: number; matches: number }) {
  setFinds(tabId, { active: result.activeMatchOrdinal, total: result.matches });
}

// --- Zoom --------------------------------------------------------------------------

/** Chromium's zoom levels. */
export const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next zoom level in or out from a factor. */
export function nextZoom(factor: number, direction: 1 | -1) {
  if (direction > 0) return ZOOM_FACTORS.find((f) => f > factor + 0.001) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;
  return [...ZOOM_FACTORS].reverse().find((f) => f < factor - 0.001) ?? ZOOM_FACTORS[0]!;
}

const [zooms, setZooms] = createStore<Record<string, number>>({});

/** The page's zoom (1 = actual size). */
export const zoomOf = (tabId: string) => zooms[tabId] ?? 1;
/** Whether the page's zoom is known (it has loaded a page). */
export const zoomKnown = (tabId: string) => zooms[tabId] !== undefined;

/** Reads the page's zoom again (after a navigation: another site may have another). */
function syncZoom(tabId: string) {
  try {
    const view = viewOf(tabId);
    if (view) setZooms(tabId, view.getZoomFactor());
  } catch {
    // not ready
  }
}

/** A web page got its site's zoom (after a navigation), or the default zoom. */
export function applySiteZoom(tabId: string, url: string) {
  const view = viewOf(tabId);
  if (!view) return;
  try {
    const factor = zoomForUrl(url);
    if (Math.abs(view.getZoomFactor() - factor) > 0.001) view.setZoomFactor(factor);
    setZooms(tabId, factor);
  } catch {
    // not ready
  }
}

// A changed default zoom (or a site's, from Settings) applies to the open web pages right away.
createRoot(() =>
  createEffect(
    on(
      () => JSON.stringify(settings().browser.zoom),
      () => {
        for (const id of Object.keys(zooms)) {
          const page = pageOf(id);
          if (!page) continue;
          try {
            applySiteZoom(id, page.view()?.getURL() ?? "");
          } catch {
            // not ready
          }
        }
      },
      { defer: true },
    ),
  ),
);

/** Zooms in (1), out (-1) or back to the default size (0). Sites remember it. */
export function zoom(tabId: string, direction: 1 | -1 | 0) {
  const view = viewOf(tabId);
  if (!view) return false;
  const factor = direction === 0 ? defaultZoom() : nextZoom(view.getZoomFactor(), direction);
  view.setZoomFactor(factor);
  setZooms(tabId, factor);
  rememberZoom(view.getURL(), factor);
  // The site's other tabs zoom with it.
  setTimeout(() => {
    for (const id of Object.keys(zooms)) if (id !== tabId) syncZoom(id);
  }, 100);
  return true;
}
