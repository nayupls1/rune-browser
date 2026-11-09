// What the sidebar's top bar shows for the tab on screen (components/TopBar.tsx):
// its address, back, forward and reload, its extensions and its own items in the ⋯ menu. Pages get the whole
// content area, like in Zen Browser; each tab (WebTab, AppTab) registers its
// chrome here while it's mounted.
import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import type { MenuItem } from "../components/ContextMenu";

/** How long a page loads before the address bar shows a spinner. */
const SPINNER_DELAY_MS = 500;

/**
 * Whether the address bar shows a spinner for a page loading: once it has taken a while. Most pages are
 * on screen before that, and an animation anywhere in the window makes the compositor draw the whole
 * window every frame, which delays the page's own first paint. (The Stop button shows it's loading at once.)
 */
export function spinnerFor(loading: () => boolean) {
  const [shown, setShown] = createSignal(false);
  createEffect(() => {
    setShown(false);
    if (!loading()) return;
    const timer = setTimeout(() => setShown(true), SPINNER_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  return shown;
}

export interface TabChrome {
  /** What the address field shows (an app's preview: its localhost URL). */
  url: () => string;
  /** No page yet (a new web tab): the address field takes the focus. */
  blank?: () => boolean;
  /** The address field's icon. */
  icon: () => string;
  /** The page isn't secure (plain HTTP): the address field says so. */
  notSecure?: () => boolean;
  canBack: () => boolean;
  canForward: () => boolean;
  loading: () => boolean;
  back: () => void;
  forward: () => void;
  reload: () => void;
  stop?: () => void;
  /** Opens what was typed in this tab (a URL or a search); false if it can't. Without it, typing opens a new web tab. */
  go?: (input: string) => boolean;
  /**
   * In place of the address field's icon while it isn't being edited: a web tab's site
   * settings, behind its lock or globe (like Zen's and Firefox's identity button).
   */
  identity?: () => JSX.Element;
  /** Inside the address field, at its end (a web tab's bookmark star and page changes, an app's state). */
  addressExtras?: () => JSX.Element;
  /** Its extensions button, in the top row (a web tab's). */
  extensions?: () => JSX.Element;
  /** The tab's own items in the top row's ⋯ menu (an app's logs, data, tools…). */
  menu?: () => (MenuItem | "separator")[];
}

/** The pointer is over the address field: its quieter buttons (the bookmark star) show. */
const [addressHovered, setAddressHovered] = createSignal(false);
export { addressHovered, setAddressHovered };

const [chromes, setChromes] = createSignal<Record<string, TabChrome>>({});

export const chromeOf = (tabId: string | null) => (tabId ? chromes()[tabId] : undefined);

/** Registers a tab's chrome; returns the function that takes it back. */
export function registerChrome(tabId: string, chrome: TabChrome) {
  setChromes((all) => ({ ...all, [tabId]: chrome }));
  return () =>
    setChromes((all) => {
      if (all[tabId] !== chrome) return all;
      const { [tabId]: _, ...rest } = all;
      return rest;
    });
}

/** The web tab whose Network panel is open (command bar: "Network requests"). */
const [networkTab, setNetworkTab] = createSignal<string | null>(null);
export { networkTab, setNetworkTab };

/** Asks the top bar to focus its address field (Ctrl+L). */
const [focusRequest, setFocusRequest] = createSignal(0);
export { focusRequest };
export const focusAddress = () => setFocusRequest((n) => n + 1);
