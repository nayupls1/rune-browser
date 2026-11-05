// Settings' categories, listed in its sidebar (components/SettingsPage.tsx)
// and the command bar: Rune Browser's own settings, the browser settings
// (components/BrowserSettings.tsx, named and ordered like Chrome's) and
// Rune Browser's pages (`view`: views of their own, like History, shown
// inside Settings). The internal pages (rune://version…) aren't in the
// sidebar: About is highlighted while one is shown.
import {
  ACTIVITY_VIEW,
  BOOKMARKS_VIEW,
  DOWNLOADS_VIEW,
  FLAGS_VIEW,
  GPU_VIEW,
  HISTORY_VIEW,
  MODS_VIEW,
  SCHEDULES_VIEW,
  SNAPSHOTS_VIEW,
  URLS_VIEW,
  VERSION_VIEW,
} from "./store";

export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  view?: string;
  group: "browser" | "agents" | "pages" | "about" | "internal";
  /** More words the command bar and Settings' search find it by. */
  keywords?: string;
  /**
   * The category it's a part of: shown on that category's page (in the order of this list), not in the
   * sidebar. Opening it opens that page, scrolled to it.
   */
  parent?: string;
}

export const settingsSections: SettingsSection[] = [
  {
    id: "browser-startup",
    label: "On startup",
    icon: "power",
    group: "browser",
    parent: "general",
    keywords: "start pages new tab windows restore",
  },
  {
    id: "browser-default",
    label: "Default browser",
    icon: "app-window",
    group: "browser",
    parent: "general",
    keywords: "links open from other apps",
  },
  {
    id: "browser-search",
    label: "Search engine",
    icon: "search",
    group: "browser",
    parent: "general",
    keywords: "address bar google duckduckgo bing",
  },
  {
    id: "browser-downloads",
    label: "Downloads",
    icon: "download",
    group: "browser",
    parent: "general",
    keywords: "folder location ask where to save",
  },
  {
    id: "browser-languages",
    label: "Languages",
    icon: "languages",
    group: "browser",
    parent: "general",
    keywords: "spell check",
  },
  {
    id: "browser-performance",
    label: "Performance",
    icon: "gauge",
    group: "browser",
    parent: "general",
    keywords: "memory saver unload idle tabs",
  },
  {
    id: "browser-import",
    label: "Import",
    icon: "import",
    group: "browser",
    parent: "general",
    keywords: "import bookmarks and settings chrome brave edge vivaldi firefox",
  },
  {
    id: "browser-reset",
    label: "Reset settings",
    icon: "rotate-ccw",
    group: "browser",
    parent: "general",
    keywords: "defaults",
  },
  {
    id: "general",
    label: "General",
    icon: "settings-2",
    group: "browser",
    keywords: "startup default browser search engine downloads languages performance import reset",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: "palette",
    group: "browser",
    keywords: "theme colors dark light mode accent corners font",
  },
  {
    id: "browser-appearance",
    label: "Fonts and zoom",
    icon: "type",
    group: "browser",
    parent: "appearance",
    keywords: "font size page zoom",
  },
  {
    id: "browser-privacy",
    label: "Privacy and security",
    icon: "shield",
    group: "browser",
    keywords: "clear browsing data cookies cache third-party do not track https http insecure not secure",
  },
  {
    id: "browser-sites",
    label: "Site settings",
    icon: "sliders-horizontal",
    group: "browser",
    keywords:
      "permissions location camera microphone notifications screen sharing clipboard midi fonts javascript images sound site data",
  },
  {
    id: "browser-autofill",
    label: "Passwords and autofill",
    icon: "key-square",
    group: "browser",
    keywords: "passwords password manager payment addresses",
  },
  { id: "extensions", label: "Extensions", icon: "blocks", group: "browser", keywords: "add-ons chrome web store" },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: "keyboard",
    group: "browser",
    keywords: "keys hotkeys keybindings",
  },
  {
    id: "providers",
    label: "Coding agents",
    icon: "plug",
    group: "agents",
    parent: "agent",
    keywords: "providers claude codex opencode login",
  },
  {
    id: "agent",
    label: "Agents",
    icon: "bot",
    group: "agents",
    keywords: "default model instructions full access providers",
  },
  { id: "apps", label: "Apps", icon: "box", group: "agents", keywords: "sandbox shell bubblewrap toolchains ai" },
  { id: "workspace", label: "Workspace", icon: "layers", group: "agents", keywords: "secrets instructions agent" },
  { id: "secrets", label: "Secrets", icon: "lock-keyhole", group: "agents", keywords: "api keys tokens" },
  {
    id: "permissions",
    label: "Agent permissions",
    icon: "hand",
    group: "agents",
    keywords: "agents apps allowed remembered decisions",
  },
  {
    id: "web",
    label: "Web tools",
    icon: "wrench",
    group: "agents",
    keywords: "site customizations page changes css javascript web tabs network",
  },
  {
    id: "network",
    label: "Network rules",
    icon: "network",
    group: "agents",
    parent: "web",
    keywords: "rules block headers record",
  },
  {
    id: "bookmarks",
    label: "Bookmarks",
    icon: "bookmark",
    view: BOOKMARKS_VIEW,
    group: "pages",
    keywords: "favorites import export",
  },
  { id: "downloads", label: "Downloads", icon: "download", view: DOWNLOADS_VIEW, group: "pages" },
  {
    id: "history",
    label: "History",
    icon: "rotate-ccw-clock",
    view: HISTORY_VIEW,
    group: "pages",
    keywords: "browsing visited pages sites clear",
  },
  {
    id: "snapshots",
    label: "Snapshots",
    icon: "file-clock",
    view: SNAPSHOTS_VIEW,
    group: "pages",
    keywords: "undo restore versions changes",
  },
  { id: "schedules", label: "Schedules", icon: "calendar-clock", view: SCHEDULES_VIEW, group: "pages" },
  { id: "mods", label: "Mods", icon: "puzzle", view: MODS_VIEW, group: "pages" },
  { id: "api-map", label: "API map", icon: "waypoints", group: "pages", keywords: "endpoints api network sites" },
  { id: "activity", label: "Activity", icon: "scroll-text", view: ACTIVITY_VIEW, group: "pages" },
  { id: "about", label: "About", icon: "info", group: "about", keywords: "version update" },
  {
    id: "version",
    label: "Version",
    icon: "info",
    view: VERSION_VIEW,
    group: "internal",
    keywords: "rune://version chromium electron",
  },
  {
    id: "gpu",
    label: "GPU",
    icon: "cpu",
    view: GPU_VIEW,
    group: "internal",
    keywords: "rune://gpu graphics acceleration",
  },
  {
    id: "flags",
    label: "Flags",
    icon: "flask-conical",
    view: FLAGS_VIEW,
    group: "internal",
    keywords: "rune://flags experiments chromium",
  },
  {
    id: "rune-urls",
    label: "Rune URLs",
    icon: "list",
    view: URLS_VIEW,
    group: "internal",
    keywords: "rune:// chrome:// internal pages",
  },
];
