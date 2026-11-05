// The browser settings on Rune Browser's side: sent to the main process (which
// puts them into effect in web tabs, main/browser.ts) whenever they change,
// sites' zoom remembered, and what happens on startup.
import { createEffect, createRoot, createSignal } from "solid-js";
import {
  siteOf,
  withSiteSetting,
  withSiteZoom,
  zoomFor,
  type BrowserSettings,
  type SiteDecision,
  type SiteSettingKey,
} from "../../shared/browser";
import { hostOf } from "../../shared/web";
import { settings, settingsLoaded, updateSettings } from "./settings";
import { apps, newWebTab, selectApp } from "./store";

createRoot(() => {
  createEffect(() => {
    if (settingsLoaded()) window.rune.browser.setSettings(settings().browser);
  });
});

/** The site Settings → Site settings shows (null: all of them). */
const [siteShown, setSiteShown] = createSignal<string | null>(null);
export { siteShown };
export const showSite = (site: string | null) => setSiteShown(site);

/** The site of a URL for its settings (without "www."), or "" when it's not a website. */
export const siteForUrl = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? siteOf(u.hostname) : "";
  } catch {
    return "";
  }
};

/** Changes the browser settings (saved like the others). */
export const updateBrowser = (update: (current: BrowserSettings) => BrowserSettings) =>
  updateSettings((s) => ({ ...s, browser: update(s.browser) }));

/** Sets a site's own decision for a setting, or goes back to the default (undefined). */
export const setSiteSetting = (site: string, key: SiteSettingKey, value: SiteDecision | undefined) =>
  updateBrowser((b) => withSiteSetting(b, site, key, value));

/** The zoom a page at `url` gets: its site's, or the default. */
export const zoomForUrl = (url: string) => zoomFor(settings().browser, hostOf(url));

/** The default zoom (what "actual size" goes back to, like in Chrome). */
export const defaultZoom = () => settings().browser.zoom.default;

/** Remembers the zoom of the page's site (web pages only). */
export function rememberZoom(url: string, factor: number) {
  // A private window remembers nothing: its pages keep their zoom only while they're open.
  if (window.rune.window.private) return;
  const host = /^https?:/i.test(url) ? hostOf(url) : "";
  if (host) updateBrowser((b) => withSiteZoom(b, host, factor));
}

/**
 * On startup (once per launch, not when the window reloads): a new tab, or
 * the startup pages (a tab already showing one is reused). "Continue where
 * you left off" keeps the tabs as they were, which is what happens anyway.
 */
export async function runStartup() {
  if (sessionStorage.getItem("rune.started")) return;
  sessionStorage.setItem("rune.started", "1");
  const { mode, pages } = settings().browser.startup;
  if (mode === "newTab") await newWebTab();
  else if (mode === "pages") {
    let first: string | undefined;
    for (const url of pages) {
      const open = apps.find((a) => a.kind === "web" && a.url === url);
      const id = open?.id ?? (await newWebTab(url, { background: true })).id;
      first ??= id;
    }
    if (first) await selectApp(first);
  }
}
