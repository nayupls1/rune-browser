// Settings' categories, listed in its sidebar (components/SettingsPage.tsx)
// and the command bar. `view`: Rune Browser's own pages, which are views of their
// own (History…) shown inside Settings.
import { ACTIVITY_VIEW, HISTORY_VIEW, MODS_VIEW, SCHEDULES_VIEW } from "./store";

export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  view?: string;
  group: "settings" | "pages" | "about";
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
    label: "Web tabs",
    icon: "globe",
    group: "settings",
    keywords: "default browser links search engine unload customizations page changes http https insecure not secure",
  },
  { id: "network", label: "Network", icon: "network", group: "settings", keywords: "rules block headers record" },
  { id: "extensions", label: "Extensions", icon: "blocks", group: "settings" },
  { id: "secrets", label: "Secrets", icon: "key-round", group: "settings" },
  { id: "permissions", label: "Permissions", icon: "shield-check", group: "settings" },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: "keyboard",
    group: "settings",
    keywords: "keys hotkeys keybindings",
  },
  { id: "history", label: "History", icon: "file-clock", view: HISTORY_VIEW, group: "pages" },
  { id: "schedules", label: "Schedules", icon: "calendar-clock", view: SCHEDULES_VIEW, group: "pages" },
  { id: "mods", label: "Mods", icon: "puzzle", view: MODS_VIEW, group: "pages" },
  { id: "api-map", label: "API map", icon: "waypoints", group: "pages", keywords: "endpoints api network sites" },
  { id: "activity", label: "Activity", icon: "scroll-text", view: ACTIVITY_VIEW, group: "pages" },
  { id: "about", label: "About", icon: "info", group: "about" },
];
