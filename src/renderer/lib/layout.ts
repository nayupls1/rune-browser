// The tab sidebar's width and whether it's hidden (like Zen's compact mode: the page
// gets the whole window, and the sidebar slides in over it from the left edge), and
// the agent sidebar's width. Remembered across restarts.
import { createSignal } from "solid-js";

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
export const isSidebarHidden = hidden;
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

export const toggleSidebar = () => setSidebarHidden(!hidden());

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

/** While dragging, `persist` is false so only the end of the drag is written. */
export function setAgentWidth(value: number, persist = true) {
  setAgentWidthSignal(clampAgent(value));
  if (persist) localStorage.setItem(AGENT_KEY, JSON.stringify({ width: agentWidth() }));
}
