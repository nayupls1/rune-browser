// Rune Browser's internal pages: rune:// addresses, like Chromium's chrome://
// pages. Typing a chrome:// (or about:) address opens the rune:// page that
// matches it. Pages of Chromium's that Rune Browser doesn't have are listed
// too, with why, so rune://rune-urls (and docs/chromium-parity.md) show the gaps.

export const INTERNAL_SCHEME = "rune";

/** Where an internal page opens: a category of Settings, one of Rune Browser's pages, or a new tab. */
export type InternalTarget =
  | { settings: string }
  /** A pseudo tab id (renderer: lib/store.ts) shown in Settings. */
  | { view: string }
  | { newTab: true };

export interface InternalPage {
  /** rune://<host> */
  host: string;
  title: string;
  /** What it shows, for rune://rune-urls. */
  description: string;
  target: InternalTarget;
  /** Chromium's own names for it (chrome://<alias>), when they differ. */
  aliases?: string[];
}

/** Pseudo tab ids of the internal pages that are views of their own (renderer: lib/store.ts). */
export const VERSION_VIEW = "version";
export const GPU_VIEW = "gpu";
export const FLAGS_VIEW = "flags";
export const URLS_VIEW = "rune-urls";

export const internalPages: InternalPage[] = [
  {
    host: "settings",
    title: "Settings",
    description: "Rune Browser's settings; rune://settings/<category> opens one category.",
    target: { settings: "" },
    aliases: ["preferences", "help", "settings-frame"],
  },
  {
    host: "extensions",
    title: "Extensions",
    description: "Installed extensions: add, turn off, remove, their permissions.",
    target: { settings: "extensions" },
    aliases: ["extensions-frame", "apps"],
  },
  {
    host: "version",
    title: "Version",
    description: "Rune Browser's version, the Chromium, Electron, V8 and Node.js it runs on, and its paths.",
    target: { view: VERSION_VIEW },
  },
  {
    host: "gpu",
    title: "GPU",
    description: "Graphics features and whether they're hardware accelerated, and the GPU's details.",
    target: { view: GPU_VIEW },
  },
  {
    host: "flags",
    title: "Flags",
    description: "Experimental Chromium features to turn on or off.",
    target: { view: FLAGS_VIEW },
  },
  {
    host: "rune-urls",
    title: "Rune URLs",
    description: "This list.",
    target: { view: URLS_VIEW },
    aliases: ["chrome-urls", "about", "internals"],
  },
  {
    host: "newtab",
    title: "New tab",
    description: "A new web tab.",
    target: { newTab: true },
    aliases: ["new-tab-page"],
  },
  {
    host: "downloads",
    title: "Downloads",
    description: "Everything you downloaded, by day: open, show in folder, retry.",
    target: { view: "downloads" },
  },
  {
    host: "history",
    title: "History",
    description: "The pages you visited, by day: search, open again, delete.",
    target: { view: "history" },
  },
  {
    host: "bookmarks",
    title: "Bookmarks",
    description: "Your bookmarks in their folders: search, rename, move, import and export.",
    target: { view: "bookmarks" },
  },
  // Rune Browser's own pages.
  {
    host: "activity",
    title: "Activity",
    description: "The activity log: what agents, apps and you did, and what was allowed.",
    target: { view: "activity" },
  },
  {
    host: "snapshots",
    title: "Snapshots",
    description: "The snapshots of apps and site changes, to undo a change or go back to a version.",
    target: { view: "snapshots" },
  },
  {
    host: "schedules",
    title: "Schedules",
    description: "Prompts and pages that run on a schedule.",
    target: { view: "schedules" },
  },
  {
    host: "mods",
    title: "Mods",
    description: "Changes to Rune Browser's own interface.",
    target: { view: "mods" },
  },
  {
    host: "api-map",
    title: "API map",
    description: "The APIs of the sites you visit, learned while browsing.",
    target: { settings: "api-map" },
  },
  {
    host: "shortcuts",
    title: "Keyboard shortcuts",
    description: "Every keyboard shortcut, to look up and change.",
    target: { settings: "shortcuts" },
  },
];

/** How a Chromium page fares in Rune Browser. */
export type ParityStatus = "matched" | "different" | "not-yet" | "not-applicable";

export interface ChromiumPage {
  host: string;
  status: ParityStatus;
  /** What Rune Browser has instead, or why not. */
  note: string;
}

/**
 * chrome:// pages, from chrome://chrome-urls. Pages Rune Browser has (above) are
 * "matched"; the rest say what's different.
 */
export const chromiumPages: ChromiumPage[] = [
  {
    host: "settings",
    status: "matched",
    note: "rune://settings, with Rune Browser's own settings beside the browser's",
  },
  { host: "extensions", status: "matched", note: "rune://extensions" },
  { host: "version", status: "matched", note: "rune://version" },
  { host: "gpu", status: "matched", note: "rune://gpu" },
  { host: "flags", status: "matched", note: "rune://flags, a chosen set of Chromium's flags" },
  { host: "chrome-urls", status: "matched", note: "rune://rune-urls" },
  { host: "newtab", status: "matched", note: "rune://newtab opens a new web tab" },
  { host: "history", status: "matched", note: "rune://history" },
  { host: "downloads", status: "matched", note: "rune://downloads" },
  { host: "bookmarks", status: "matched", note: "rune://bookmarks" },
  {
    host: "password-manager",
    status: "not-yet",
    note: "No password manager yet: extensions (Bitwarden, 1Password) work",
  },
  { host: "settings/content", status: "not-yet", note: "Site permissions are on their way" },
  { host: "inspect", status: "different", note: "DevTools open from the page (F12)" },
  { host: "crashes", status: "different", note: "Rune Browser tells you when it crashed, with a report to send" },
  { host: "about", status: "matched", note: "rune://rune-urls" },
  { host: "accessibility", status: "not-applicable", note: "A Chromium developer page" },
  { host: "components", status: "not-applicable", note: "Rune Browser updates as a whole" },
  { host: "policy", status: "not-applicable", note: "No enterprise policies" },
  { host: "management", status: "not-applicable", note: "No enterprise management" },
  { host: "sync-internals", status: "not-applicable", note: "No Google account sync" },
  { host: "signin-internals", status: "not-applicable", note: "No Google account sign-in" },
  { host: "net-internals", status: "not-applicable", note: "The Network panel shows a tab's traffic" },
  { host: "net-export", status: "not-applicable", note: "The Network panel shows a tab's traffic" },
  { host: "media-internals", status: "not-applicable", note: "A Chromium developer page" },
  { host: "webrtc-internals", status: "not-applicable", note: "A Chromium developer page" },
  { host: "serviceworker-internals", status: "not-applicable", note: "DevTools' Application panel" },
  { host: "indexeddb-internals", status: "not-applicable", note: "DevTools' Application panel" },
  { host: "process-internals", status: "not-applicable", note: "A Chromium developer page" },
  { host: "tracing", status: "not-applicable", note: "DevTools' Performance panel" },
  { host: "sandbox", status: "not-applicable", note: "A Chromium developer page" },
  { host: "dino", status: "not-applicable", note: "No offline game" },
];

export interface InternalUrl {
  /** rune://<host>/<path>, how Rune Browser shows it. */
  url: string;
  host: string;
  /** After the host, without the leading slash ("" for none). */
  path: string;
  /** The page it opens; undefined for a rune:// address that isn't one. */
  page?: InternalPage;
}

const pageByHost = new Map<string, InternalPage>();
for (const page of internalPages) {
  pageByHost.set(page.host, page);
  for (const alias of page.aliases ?? []) pageByHost.set(alias, page);
}

/**
 * Parses an internal address: rune://, chrome:// (its rune:// page, like Edge does
 * with edge://), or about: (about:version is Chromium's chrome://version; about:blank
 * isn't an internal page). Null for anything else.
 */
export function parseInternalUrl(input: string): InternalUrl | null {
  const text = input.trim();
  const match = /^(?:(rune|chrome):\/\/|about:)([\w-]+)?\/?([^?#]*)/i.exec(text);
  if (!match) return null;
  const scheme = match[1]?.toLowerCase();
  const host = (match[2] ?? "").toLowerCase();
  if (!scheme && (host === "" || host === "blank" || host === "srcdoc")) return null;
  const page = pageByHost.get(host);
  // chrome://help is the About page.
  const path = host === "help" ? "about" : match[3]!.replace(/\/+$/, "");
  const canonical = page?.host ?? host;
  return { url: `${INTERNAL_SCHEME}://${canonical}${path ? `/${path}` : ""}`, host: canonical, path, page };
}

export const isInternalUrl = (input: string) => parseInternalUrl(input) !== null;

/**
 * Chromium's settings pages (chrome://settings/<page>) and the Settings category
 * each one is in. Rune Browser's own category ids work too.
 */
const chromiumSettings: Record<string, string> = {
  appearance: "appearance",
  fonts: "browser-appearance",
  autofill: "browser-autofill",
  passwords: "browser-autofill",
  privacy: "browser-privacy",
  security: "browser-privacy",
  cookies: "browser-privacy",
  clearBrowserData: "browser-privacy",
  content: "browser-sites",
  performance: "browser-performance",
  search: "browser-search",
  searchEngines: "browser-search",
  defaultBrowser: "browser-default",
  onStartup: "browser-startup",
  languages: "browser-languages",
  downloads: "browser-downloads",
  importData: "browser-import",
  reset: "browser-reset",
  resetProfileSettings: "browser-reset",
  extensions: "extensions",
  help: "about",
  about: "about",
  shortcuts: "shortcuts",
};

/** The Settings category rune://settings/<path> opens ("" for the one last shown). */
export function settingsCategoryOf(path: string, known: readonly string[]) {
  const first = path.split("/")[0] ?? "";
  if (known.includes(first)) return first;
  const mapped = chromiumSettings[first];
  return mapped && known.includes(mapped) ? mapped : "";
}

/** The rune:// address of a Settings category or page, for the address bar. */
export function internalUrlOf(target: InternalTarget): string {
  if ("newTab" in target) return `${INTERNAL_SCHEME}://newtab`;
  if ("view" in target) {
    const page = internalPages.find((p) => "view" in p.target && p.target.view === target.view);
    return `${INTERNAL_SCHEME}://${page?.host ?? target.view}`;
  }
  const page = internalPages.find((p) => "settings" in p.target && p.target.settings === target.settings);
  if (page) return `${INTERNAL_SCHEME}://${page.host}`;
  return `${INTERNAL_SCHEME}://settings${target.settings ? `/${target.settings}` : ""}`;
}

// --- rune://version and rune://gpu -----------------------------------------------------------

/** rune://version: like chrome://version. */
export interface VersionInfo {
  rune: string;
  /** Packaged ("Official build") or run from source. */
  packaged: boolean;
  chromium: string;
  electron: string;
  v8: string;
  node: string;
  os: string;
  /** What web tabs tell sites. */
  userAgent: string;
  commandLine: string;
  executablePath: string;
  profilePath: string;
}

/** rune://gpu: Chromium's feature status and GPU info, as Electron gives them. */
export interface GpuReport {
  featureStatus: Record<string, string>;
  info: Record<string, unknown>;
}

const gpuFeatureNames: Record<string, string> = {
  "2d_canvas": "Canvas",
  canvas_oop_rasterization: "Canvas out-of-process rasterization",
  direct_rendering_display_compositor: "Direct Rendering Display Compositor",
  gpu_compositing: "Compositing",
  multiple_raster_threads: "Multiple Raster Threads",
  opengl: "OpenGL",
  rasterization: "Rasterization",
  raw_draw: "Raw Draw",
  skia_graphite: "Skia Graphite",
  video_decode: "Video Decode",
  video_encode: "Video Encode",
  vulkan: "Vulkan",
  webgl: "WebGL",
  webgl2: "WebGL2",
  webgpu: "WebGPU",
  webnn: "WebNN",
};

const gpuStatusLabels: Record<string, string> = {
  enabled: "Hardware accelerated",
  enabled_on: "Enabled",
  enabled_force: "Hardware accelerated",
  enabled_force_on: "Force enabled",
  enabled_readback: "Hardware accelerated but at reduced performance",
  disabled_software: "Software only. Hardware acceleration disabled",
  disabled_off: "Disabled",
  disabled_off_ok: "Disabled",
  unavailable_software: "Software only, hardware acceleration unavailable",
  unavailable_off: "Unavailable",
  unavailable_off_ok: "Unavailable",
};

/** "Canvas: Hardware accelerated", like chrome://gpu's Graphics Feature Status. */
export function gpuFeatureRows(status: Record<string, string>) {
  return Object.entries(status)
    .map(([key, value]) => ({
      name: gpuFeatureNames[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      status: gpuStatusLabels[value] ?? value,
      good: value.startsWith("enabled"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** GPU info as name and value rows ("gpuDevice[0].vendorId", "0x10de"). */
export function flattenGpuInfo(info: unknown, prefix = ""): [string, string][] {
  if (info === null || info === undefined) return [];
  if (Array.isArray(info)) return info.flatMap((item, i) => flattenGpuInfo(item, `${prefix}[${i}]`));
  if (typeof info === "object")
    return Object.entries(info as Record<string, unknown>).flatMap(([key, value]) =>
      flattenGpuInfo(value, prefix ? `${prefix}.${key}` : key),
    );
  const value =
    typeof info === "number" && /(vendorId|deviceId)$/.test(prefix)
      ? `0x${info.toString(16).padStart(4, "0")}`
      : String(info);
  return [[prefix, value]];
}
