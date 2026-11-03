// Elements the user picked in a tab's page (the crosshair) for its agent, per
// tab: the page marks them, the agent sidebar shows them as chips and sends
// them with the next message.
import { createStore, produce } from "solid-js/store";
import type { ElementInfo } from "../../shared/api";

const [picks, setPicks] = createStore<Record<string, ElementInfo[]>>({});
const [picking, setPicking] = createStore<Record<string, boolean>>({});

export const picksOf = (tabId: string) => picks[tabId] ?? [];
export const isPicking = (tabId: string) => !!picking[tabId];
export const setPickingIn = (tabId: string, value: boolean) => setPicking(tabId, value);

export const addPick = (tabId: string, element: ElementInfo) =>
  setPicks(
    produce((all) => {
      const list = (all[tabId] ??= []);
      if (!list.some((p) => p.selector === element.selector)) list.push(element);
    }),
  );

export const removePick = (tabId: string, selector: string) =>
  setPicks(tabId, (list) => (list ?? []).filter((p) => p.selector !== selector));

export const clearPicks = (tabId: string) => setPicks(tabId, []);
