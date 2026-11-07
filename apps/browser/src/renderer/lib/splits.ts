// Split view: tabs of a workspace shown side by side (or stacked). A split is
// shown whenever one of its tabs is selected; the selected one has the focus.
// Splits are saved with their workspace (normalizeSplits keeps them consistent).
import { normalizeSplits, SPLIT_MAX_TABS, type TabSplit } from "../../shared/api";
import { toast } from "../components/Toast";
import { api } from "./api";
import { allApps, appById, selectApp, selectedId, showSplits, workspaceById, workspaces } from "./store";

export type SplitSide = "left" | "right" | "top" | "bottom";

const splitsIn = (workspaceId: string) => workspaceById(workspaceId)?.splits ?? [];
const workspaceOfSplit = (splitId: string) => workspaces.find((w) => w.splits.some((s) => s.id === splitId));

/** The split a tab is in. */
export const splitOf = (tabId: string | null | undefined) => {
  const tab = appById(tabId ?? null);
  return tab ? splitsIn(tab.workspaceId).find((s) => s.tabs.includes(tab.id)) : undefined;
};

/** The split on screen: the selected tab's, if it's in one. */
export const visibleSplit = () => splitOf(selectedId());

/** The tabs on screen. */
export const visibleTabs = (): string[] => visibleSplit()?.tabs ?? (selectedId() ? [selectedId()!] : []);

const equal = (n: number) => Array.from({ length: n }, () => 1 / n);

/** The split without that tab (normalizeSplits drops it when one tab is left). */
const without = (split: TabSplit, tabId: string): TabSplit => {
  const i = split.tabs.indexOf(tabId);
  return i === -1
    ? split
    : { ...split, tabs: split.tabs.filter((_, j) => j !== i), sizes: split.sizes.filter((_, j) => j !== i) };
};

async function save(workspaceId: string, splits: TabSplit[]) {
  const clean = normalizeSplits(
    splits,
    // Every window's tabs: a split of another window's tabs stays as it is.
    allApps()
      .filter((a) => a.workspaceId === workspaceId)
      .map((a) => a.id),
  );
  showSplits(workspaceId, clean);
  try {
    await api.setSplits(workspaceId, clean);
  } catch (err) {
    toast({
      message: `Saving the split view failed: ${err instanceof Error ? err.message : String(err)}`,
      kind: "error",
    });
  }
}

const full = () => toast({ message: `A split view holds up to ${SPLIT_MAX_TABS} tabs.`, kind: "info" });

/**
 * Shows `tabId` next to `targetId`: on that side of it, or at that end of
 * its split if it's in one. The tab leaves the split it was in, and gets the focus.
 */
export function splitWith(targetId: string, tabId: string, side: SplitSide) {
  const target = appById(targetId);
  const tab = appById(tabId);
  if (!target || !tab || targetId === tabId || target.workspaceId !== tab.workspaceId) return;
  const workspaceId = target.workspaceId;
  const atStart = side === "left" || side === "top";
  let splits = splitsIn(workspaceId).map((s) => without(s, tabId));
  const existing = splits.find((s) => s.tabs.includes(targetId) && s.tabs.length >= 2);
  if (existing) {
    if (existing.tabs.length >= SPLIT_MAX_TABS) return full();
    const tabs = atStart ? [tabId, ...existing.tabs] : [...existing.tabs, tabId];
    splits = splits.map((s) => (s === existing ? { ...s, tabs, sizes: equal(tabs.length) } : s));
  } else {
    splits = splits.filter((s) => !s.tabs.includes(targetId));
    splits.push({
      id: crypto.randomUUID(),
      direction: side === "left" || side === "right" ? "row" : "column",
      tabs: atStart ? [tabId, targetId] : [targetId, tabId],
      sizes: [0.5, 0.5],
    });
  }
  void save(workspaceId, splits);
  void selectApp(tabId);
}

/** Puts a tab into a split at a position (moving it within the split, or from another one). */
export function placeInSplit(splitId: string, tabId: string, index: number) {
  const workspace = workspaceOfSplit(splitId);
  const split = workspace?.splits.find((s) => s.id === splitId);
  if (!workspace || !split || appById(tabId)?.workspaceId !== workspace.id) return;
  const wasIn = split.tabs.indexOf(tabId);
  if (wasIn === -1 && split.tabs.length >= SPLIT_MAX_TABS) return full();
  const rest = split.tabs.filter((t) => t !== tabId);
  const at = Math.max(0, Math.min(rest.length, wasIn !== -1 && wasIn < index ? index - 1 : index));
  const tabs = [...rest.slice(0, at), tabId, ...rest.slice(at)];
  // Reordering keeps the sizes with their panes; a new pane makes them equal.
  const sizes = wasIn === -1 ? equal(tabs.length) : tabs.map((t) => split.sizes[split.tabs.indexOf(t)]!);
  void save(
    workspace.id,
    workspace.splits.map((s) => (s.id === splitId ? { ...s, tabs, sizes } : without(s, tabId))),
  );
}

/** Takes a tab out of its split (a split of two ends). */
export function removeFromSplit(tabId: string) {
  const tab = appById(tabId);
  if (!tab || !splitOf(tabId)) return;
  void save(
    tab.workspaceId,
    splitsIn(tab.workspaceId).map((s) => without(s, tabId)),
  );
}

/** Ends a split: its tabs go back to being shown one at a time. */
export function unsplit(splitId: string) {
  const workspace = workspaceOfSplit(splitId);
  if (workspace)
    void save(
      workspace.id,
      workspace.splits.filter((s) => s.id !== splitId),
    );
}

/** Side by side ⇄ stacked. */
export function rotateSplit(splitId: string) {
  const workspace = workspaceOfSplit(splitId);
  if (!workspace) return;
  void save(
    workspace.id,
    workspace.splits.map((s) => (s.id === splitId ? { ...s, direction: s.direction === "row" ? "column" : "row" } : s)),
  );
}

/** New pane sizes: shown right away, saved when `persist` (at the end of a drag). */
export function resizeSplit(splitId: string, sizes: number[], persist: boolean) {
  const workspace = workspaceOfSplit(splitId);
  if (!workspace) return;
  const splits = workspace.splits.map((s) => (s.id === splitId ? { ...s, sizes } : s));
  if (persist) void save(workspace.id, splits);
  else showSplits(workspace.id, splits);
}

/** Equal sizes again. */
export function evenSplit(splitId: string) {
  const split = workspaceOfSplit(splitId)?.splits.find((s) => s.id === splitId);
  if (split) resizeSplit(splitId, equal(split.tabs.length), true);
}
