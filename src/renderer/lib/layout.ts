// Where the tabs are (a horizontal tab bar at the top, or the vertical sidebar), the tab
// sidebar's width and whether it's hidden (like Zen's compact mode: the page gets the whole
// window, and the sidebar slides in over it from the left edge), and the agent sidebar's
// width. Remembered across restarts.
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import type { Settings } from "../../shared/settings";
import { settings, settingsLoaded, updateSettings } from "./settings";

export type TabLayout = Settings["tabs"]["layout"];

const LAYOUT_KEY = "rune.tabLayout";
const readCachedLayout = (): TabLayout | null => {
  try {
    const value = localStorage.getItem(LAYOUT_KEY);
    return value === "horizontal" || value === "vertical" ? value : null;
  } catch {
    return null;
  }
};
// The layout last used, until the settings are loaded: no flash of the other one at startup.
const cachedLayout = readCachedLayout();

/** Where the tabs are: Settings → Appearance, or the tab bar's menu. */
export const tabLayout = (): TabLayout =>
  settingsLoaded() ? settings().tabs.layout : (cachedLayout ?? settings().tabs.layout);
export const isHorizontal = () => tabLayout() === "horizontal";

export function setTabLayout(layout: TabLayout) {
  updateSettings((s) => ({ ...s, tabs: { ...s.tabs, layout } }));
}

createRoot(() => {
  createEffect(() => {
    if (!settingsLoaded()) return;
    try {
      localStorage.setItem(LAYOUT_KEY, tabLayout());
    } catch {
      // Only a convenience for the next start.
    }
  });
  // A hidden sidebar shown for now (its menu may have switched the layout) mustn't come back stuck open later,
  // whichever window changed it.
  // (A memo: only a change of the layout, not of any other setting.)
  createEffect(on(createMemo(tabLayout), () => setSidebarPeek(false), { defer: true }));
});

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 232;

const KEY = "rune.sidebar";

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as { width?: number; hidden?: boolean };
  } catch {
    return {};
  }
})();

const clamp = (width: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));

const [width, setWidthSignal] = createSignal(clamp(typeof saved.width === "number" ? saved.width : SIDEBAR_DEFAULT));
const [hidden, setHiddenSignal] = createSignal(saved.hidden === true);

const save = () => localStorage.setItem(KEY, JSON.stringify({ width: width(), hidden: hidden() }));

export const sidebarWidth = width;
/** The vertical sidebar is hidden (with horizontal tabs there's no sidebar to hide). */
export const isSidebarHidden = () => !isHorizontal() && hidden();
/** A hidden sidebar shown over the page for now (the pointer at the window's left edge). */
export const [sidebarPeek, setSidebarPeek] = createSignal(false);

/** While dragging, `persist` is false so only the end of the drag is written. */
export function setSidebarWidth(value: number, persist = true) {
  setWidthSignal(clamp(value));
  if (persist) save();
}

export function setSidebarHidden(value: boolean) {
  setHiddenSignal(value);
  setSidebarPeek(false);
  save();
}

export const toggleSidebar = () => {
  if (!isHorizontal()) setSidebarHidden(!hidden());
};

/** The tab being dragged from the sidebar, if any (drop targets light up for it). */
export const [draggedTab, setDraggedTab] = createSignal<string | null>(null);
/** The data type of a tab drag. */
export const TAB_DRAG_TYPE = "application/x-rune-tab";
/** A split view being dragged from the sidebar (all its tabs move together). */
export const [draggedSplit, setDraggedSplit] = createSignal<string | null>(null);

// --- The agent sidebar's width (components/AgentSidebar.tsx), the same in every tab ---------

export const AGENT_MIN = 280;
export const AGENT_MAX = 760;
export const AGENT_DEFAULT = 380;

const AGENT_KEY = "rune.agentSidebar";
const clampAgent = (value: number) => Math.round(Math.min(AGENT_MAX, Math.max(AGENT_MIN, value)));
const [agentWidth, setAgentWidthSignal] = createSignal(
  clampAgent(
    (() => {
      try {
        const saved = JSON.parse(localStorage.getItem(AGENT_KEY) ?? "{}") as { width?: number };
        return typeof saved.width === "number" ? saved.width : AGENT_DEFAULT;
      } catch {
        return AGENT_DEFAULT;
      }
    })(),
  ),
);

export { agentWidth };

/** The page keeps at least this much of the window next to the sidebars, unless the agent sidebar needs it for its minimum. */
export const PAGE_MIN = 160;

/**
 * How wide the agent sidebar may be: most of the window, leaving the page
 * PAGE_MIN beside it and the tab sidebar (when that's beside the page, not
 * over it). On a window too narrow for that it still gets AGENT_MIN, from the
 * page's share, and never more than the window has left.
 */
export const agentMaxWidth = () => {
  const beside = !isHorizontal() && !isSidebarHidden() ? sidebarWidth() : 0;
  // The page's column keeps its padding (App.tsx) even when the page has no room left.
  const padding = 8;
  return `min(70vw, max(calc(100vw - ${beside + PAGE_MIN}px), min(${AGENT_MIN}px, calc(100vw - ${beside + padding}px))))`;
};

/** While dragging, `persist` is false so only the end of the drag is written. */
export function setAgentWidth(value: number, persist = true) {
  setAgentWidthSignal(clampAgent(value));
  if (persist) localStorage.setItem(AGENT_KEY, JSON.stringify({ width: agentWidth() }));
}
