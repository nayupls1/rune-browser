// Web tabs' back/forward history (shared/tabHistory.ts): what each tab's page has, kept here
// while the window is open (an unloaded tab, a closed one for Ctrl+Shift+T) and saved with the
// tab (PUT /api/apps/:id/history) so it comes back after a restart. A private window saves
// nothing: its tabs' history lives only here, until the window closes.
import { trimHistory, type TabHistory } from "../../shared/tabHistory";
import { api } from "./api";

const isPrivate = window.rune.window.private;
const known = new Map<string, TabHistory>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const save = (tabId: string) => {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  return isPrivate ? Promise.resolve() : api.setTabHistory(tabId, known.get(tabId) ?? null).catch(() => {});
};

/** The tab's page has this history now: kept, and saved a moment later. */
export function rememberHistory(tabId: string, history: TabHistory | null) {
  const kept = trimHistory(history);
  if (!kept) return;
  const before = known.get(tabId);
  if (before && JSON.stringify(before) === JSON.stringify(kept)) return;
  known.set(tabId, kept);
  clearTimeout(timers.get(tabId));
  timers.set(
    tabId,
    setTimeout(() => void save(tabId), 500),
  );
}

/** Saves what's waiting right away (the tab is unloading or closing). */
export function flushHistory(tabId: string) {
  return timers.has(tabId) ? save(tabId) : Promise.resolve();
}

/** A tab's history: what this window knows, or what was saved with it. */
export async function historyOf(tabId: string): Promise<TabHistory | null> {
  const mine = known.get(tabId);
  if (mine) return mine;
  if (isPrivate) return null;
  return api.tabHistory(tabId).then(
    (r) => trimHistory(r.history),
    () => null,
  );
}

/** What the window knows of a tab's history (a closed tab's, for Ctrl+Shift+T). */
export const knownHistory = (tabId: string) => known.get(tabId) ?? null;

/** A new tab starts with this history (a closed tab opened again). */
export function giveHistory(tabId: string, history: TabHistory | null) {
  const kept = trimHistory(history);
  if (kept) known.set(tabId, kept);
}

/** The tab is gone. */
export function forgetHistory(tabId: string) {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  known.delete(tabId);
}
