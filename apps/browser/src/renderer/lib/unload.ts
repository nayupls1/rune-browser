// Tab unloading: tabs that haven't been on screen for a while (Settings →
// Tabs) have their page closed to free its memory. What the page showed (URL,
// scroll position, form input: lib/pagestate.ts) is kept and put back when the
// tab is opened again. Never unloaded: tabs on screen, pinned tabs, tabs whose
// agent is working and pages playing sound. The chat and the app's server
// aren't affected, and agents wake a tab up when they need its page (wakePage).
import { createEffect, createRoot, on } from "solid-js";
import { forgetSavedPage, savePage } from "./pagestate";
import { settings } from "./settings";
import { visibleTabs } from "./splits";
import { appById, isLoaded, lastUsedAt, markUsed, openedIds, states, unmountTab } from "./store";
import { pageOf, wakePage } from "./webtabs";

const SWEEP_MS = 30_000;

export const isOnScreen = (id: string) => visibleTabs().includes(id);

/** Whether a tab can be unloaded by hand right now: it's loaded and not on screen. */
export const canUnload = (id: string) => isLoaded(id) && !isOnScreen(id);

/** Closes a tab's page, keeping what it showed for when it's opened again. */
export async function unloadTab(id: string) {
  if (!canUnload(id)) return false;
  const page = await pageOf(id)
    ?.saveState()
    .catch(() => null);
  // It may have been opened while its state was read.
  if (!canUnload(id)) return false;
  if (page) savePage(id, page);
  else forgetSavedPage(id);
  unmountTab(id);
  return true;
}

/** Tabs idle long enough to be unloaded at `now`. */
export function idleTabs(now = Date.now()) {
  const minutes = settings().tabs.unloadAfterMinutes;
  if (minutes <= 0) return [];
  return openedIds().filter((id) => {
    if (!canUnload(id) || appById(id)?.pinned || states[id]?.running || pageOf(id)?.busy()) return false;
    return now - (lastUsedAt(id) ?? now) >= minutes * 60_000;
  });
}

/** Unloads the idle tabs; returns which. */
export async function sweep(now = Date.now()) {
  const unloaded: string[] = [];
  for (const id of idleTabs(now)) if (await unloadTab(id)) unloaded.push(id);
  return unloaded;
}

/** Starts watching for idle tabs (once, from App). */
export function startUnloading() {
  createRoot(() => {
    // A tab counts as used while it's on screen and when it leaves the screen.
    createEffect(
      on(visibleTabs, (now, before) => {
        for (const id of [...now, ...(before ?? [])]) markUsed(id);
      }),
    );
  });
  setInterval(() => {
    for (const id of visibleTabs()) markUsed(id);
    void sweep();
  }, SWEEP_MS);
}

/** Unloads every loaded tab that isn't on screen (pinned ones too: this is by hand). */
export async function unloadOtherTabs() {
  let count = 0;
  for (const id of openedIds()) if (await unloadTab(id)) count++;
  return count;
}

// For the e2e checks: run a sweep as if it were later, and wake a tab like an agent would.
declare global {
  interface Window {
    __runeTabs?: { sweep: (inMs: number) => Promise<string[]>; wake: (id: string) => Promise<string> };
  }
}
window.__runeTabs = {
  sweep: (inMs) => sweep(Date.now() + inMs),
  wake: async (id) => (await wakePage(id)).info().url,
};
