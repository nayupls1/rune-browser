// Settings' categories, listed in its sidebar (components/SettingsPage.tsx)
// and the command bar: Rune Browser's own settings, the browser settings
// (components/BrowserSettings.tsx, named and ordered like Chrome's) and
// Rune Browser's pages (`view`: views of their own, like History, shown
// inside Settings). The internal pages (rune://version…) aren't in the
// sidebar: About is highlighted while one is shown.
import {
  ACTIVITY_VIEW,
  FLAGS_VIEW,
  GPU_VIEW,
  HISTORY_VIEW,
  MODS_VIEW,
  SCHEDULES_VIEW,
  URLS_VIEW,
  VERSION_VIEW,
} from "./store";

export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  view?: string;
  group: "settings" | "browser" | "pages" | "about" | "internal";
  /** More words the command bar finds it by. */
  keywords?: string;
}

export const settingsSections: SettingsSection[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: "palette",
    group: "settings",
    keywords: "theme colors dark light font",
  },
  { id: "workspace", label: "Workspace", icon: "layers", group: "settings", keywords: "secrets instructions agent" },
  { id: "agent", label: "Agent", icon: "bot", group: "settings", keywords: "default model instructions full access" },
  { id: "providers", label: "Providers", icon: "plug", group: "settings", keywords: "claude codex opencode login" },
  { id: "apps", label: "Apps", icon: "box", group: "settings", keywords: "sandbox shell bubblewrap toolchains ai" },
  {
    id: "web",
    label: "Site customizations",
    icon: "paintbrush",
    group: "settings",
    keywords: "web tabs customizations page changes css javascript",
  },
  { id: "network", label: "Network", icon: "network", group: "settings", keywords: "rules block headers record" },
  { id: "secrets", label: "Secrets", icon: "key-round", group: "settings" },
  { id: "permissions", label: "Permissions", icon: "shield-check", group: "settings", keywords: "agents apps allowed" },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: "keyboard",
    group: "settings",
    keywords: "keys hotkeys keybindings",
  },
  {
    id: "browser-autofill",
    label: "Autofill and passwords",
    icon: "key-square",
    group: "browser",
    keywords: "passwords password manager payment addresses",
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
    keywords: "permissions location camera microphone notifications javascript images sound site data",
  },
  {
    id: "browser-performance",
    label: "Performance",
    icon: "gauge",
    group: "browser",
    keywords: "memory saver unload idle tabs",
  },
  {
    id: "browser-appearance",
    label: "Fonts and zoom",
    icon: "type",
    group: "browser",
    keywords: "appearance font size page zoom",
  },
  { id: "browser-search", label: "Search engine", icon: "search", group: "browser", keywords: "address bar" },
  {
    id: "browser-default",
    label: "Default browser",
    icon: "app-window",
    group: "browser",
    keywords: "links open from other apps",
  },
  {
    id: "browser-startup",
    label: "On startup",
    icon: "power",
    group: "browser",
    keywords: "start pages new tab windows restore",
  },
  { id: "browser-languages", label: "Languages", icon: "languages", group: "browser", keywords: "spell check" },
  { id: "browser-downloads", label: "Downloads", icon: "download", group: "browser", keywords: "folder location" },
  {
    id: "browser-import",
    label: "Import bookmarks and settings",
    icon: "import",
    group: "browser",
    keywords: "chrome brave edge vivaldi",
  },
  { id: "browser-reset", label: "Reset settings", icon: "rotate-ccw", group: "browser", keywords: "defaults" },
  { id: "extensions", label: "Extensions", icon: "blocks", group: "browser" },
  { id: "history", label: "History", icon: "file-clock", view: HISTORY_VIEW, group: "pages" },
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
