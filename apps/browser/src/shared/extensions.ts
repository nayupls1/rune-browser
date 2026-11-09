// Chrome extensions in web tabs: what the main process and the Rune Browser window
// exchange, and the pure helpers both sides (and the tests) use: match
// patterns, keyboard shortcuts, manifest strings, what Rune Browser supports, and
// network rules as declarativeNetRequest rules.
import type { NetworkRule } from "./api";
import type { SiteSettingKey } from "./browser";

/** Where an installed extension came from. */
export type ExtensionSource =
  { kind: "browser"; browser: string; profile: string } | { kind: "webstore" } | { kind: "unpacked" };

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** data: URL of its icon. */
  icon: string | null;
  enabled: boolean;
  /** Runs in private windows too. */
  allowPrivate: boolean;
  /** Shown in the toolbar of web tabs (otherwise in the extensions menu). */
  pinned: boolean;
  source: ExtensionSource;
  /** Unpacked extensions are used where they are; the others are copied into Rune Browser's data. */
  path: string;
  /** Has a toolbar button. */
  hasAction: boolean;
  /** Its options page, opened in a web tab. */
  optionsUrl: string | null;
  /** Permissions it asks for that are limited in Rune Browser (see `permissionAbout`). */
  unsupported: string[];
  /** What it asks for (Details on the extensions page): API permissions, and the sites it can read and change. */
  permissions: ExtensionPermission[];
  /** The sites it always has (host permissions, content scripts). */
  siteAccess: string[];
  /**
   * Sites it asks for when it needs them, and whether it has them (see `optionalSiteAccess`). `asked`: in its
   * manifest, not a narrower one it was given; `coveredBy`: a broader site it was given that includes it.
   */
  optionalSiteAccess: { pattern: string; allowed: boolean; asked: boolean; coveredBy: string | null }[];
  /** Its commands that have a key on this platform (`_execute_action` opens its popup). */
  shortcuts: { name: string; description: string; shortcut: string }[];
  /** Can start programs on this computer (native messaging hosts installed for it). */
  nativeMessaging: boolean;
  /** Updates come from the Chrome Web Store (or its own update URL). */
  updates: boolean;
  /** Didn't load, and why. */
  error: string | null;
}

/** One of an extension's API permissions, and whether it has it. */
export interface ExtensionPermission {
  name: string;
  description: string;
  /** What's different in Rune Browser, or null. */
  limited: string | null;
  /** Optional: the extension asks for it when it needs it (chrome.permissions.request). */
  optional: boolean;
  /** Required ones are allowed unless blocked; optional ones once granted. */
  allowed: boolean;
}

/** The toolbar button of an extension, for one tab. */
export interface ExtensionAction {
  extensionId: string;
  title: string;
  /** data: URL. */
  icon: string | null;
  badge: string;
  badgeColor: string;
  badgeTextColor: string | null;
  /** chrome-extension:// URL of its popup, or null when a click goes to the extension. */
  popup: string | null;
  enabled: boolean;
}

/** An extension found in another browser's profile. */
export interface ImportCandidate {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  /** On in that browser. */
  enabledThere: boolean;
  /** Came with the browser (Google Docs Offline…): not picked by default. */
  byDefault: boolean;
  /** Loaded from a folder (developer mode or --load-extension): used where it is. */
  unpacked: boolean;
  /** Already in Rune Browser. */
  installed: boolean;
  /** Has saved settings (chrome.storage.local) that can come along. */
  hasSettings: boolean;
  unsupported: string[];
}

export interface BrowserProfile {
  /** Stable key for this browser + profile. */
  key: string;
  browser: string;
  /** The profile's name in that browser ("Work"), or its folder. */
  profile: string;
  extensions: ImportCandidate[];
}

export interface ImportRequest {
  profileKey: string;
  ids: string[];
  /** Bring their chrome.storage.local data too. */
  settings: boolean;
}

export interface InstallResult {
  installed: { id: string; name: string }[];
  failed: { id: string; name: string; error: string }[];
}

/** The web tabs of each workspace (by webContents id, in sidebar order) and which is selected. */
export interface ExtensionTabs {
  workspaces: Record<string, { tabs: number[]; active: number | null }>;
  /** The workspace on screen, and whether a web tab is what's shown. */
  current: string | null;
  showing: number | null;
}

/** An extension wants a tab opened (chrome.tabs.create, its options page, `search` with the search engine…), selected or closed. */
export type ExtensionTabRequest =
  | { requestId: string; action: "open"; workspaceId: string; url: string; active: boolean; search?: string }
  | { requestId: string; action: "select" | "close" | "discard"; workspaceId: string; tabId: number }
  /** chrome.sessions: the workspace's tabs closed lately (ClosedTab[]), or one opened again (its webContents id). */
  | { requestId: string; action: "closed"; workspaceId: string }
  | { requestId: string; action: "restore"; workspaceId: string; closedAt: number | null }
  /** contentSettings, privacy, fontSettings: a change to the browser settings (true when it's made). */
  | { requestId: string; action: "settings"; change: BrowserSettingsChange }
  /** chrome.tts: speaking (resolves with how it ended), or the rest of it. */
  | { requestId: string; action: "speak"; utterance: TtsUtterance }
  | { requestId: string; action: "tts"; command: "stop" | "pause" | "resume" | "voices" | "speaking" }
  /** chrome.downloads.setUiOptions: whether the downloads button shows. */
  | { requestId: string; action: "downloads-ui"; enabled: boolean }
  /** A question for the user (management.uninstallSelf): true for OK. */
  | { requestId: string; action: "confirm"; workspaceId?: string; message: string; confirmLabel: string }
  /** Something the user should know (an extension started debugging a tab). */
  | { requestId: string; action: "notice"; workspaceId?: string; message: string }
  /** fontSettings.getFontList: the fonts installed here. */
  | { requestId: string; action: "font-list" }
  /** chrome.sidePanel: shows its page in the side panel beside a workspace's tabs (null: closes it). */
  | {
      requestId: string;
      action: "side-panel";
      workspaceId: string;
      extensionId: string;
      name: string;
      url: string | null;
      /** Its toolbar button: closes the panel when it's the one open. */
      toggle?: boolean;
    };

/** A tab closed lately (chrome.sessions). */
export interface ClosedTab {
  url: string;
  title: string;
  /** When it was closed (ms); it's the session's id. */
  at: number;
}

/** What an extension changes in the browser settings (contentSettings, privacy, fontSettings). */
export type BrowserSettingsChange =
  | { kind: "site"; site: string; key: SiteSettingKey; value: "allow" | "block" | null }
  | { kind: "default"; key: SiteSettingKey; value: "allow" | "ask" | "block" }
  /** Every site's own decision for these settings goes (contentSettings.clear). */
  | { kind: "clear"; keys: SiteSettingKey[] }
  | { kind: "privacy"; thirdPartyCookies?: "allow" | "block"; doNotTrack?: boolean }
  | {
      kind: "fonts";
      size?: number;
      fixedSize?: number;
      minimumSize?: number;
      standard?: string;
      serif?: string;
      sansSerif?: string;
      fixed?: string;
    };

/** What chrome.tts.speak says. */
export interface TtsUtterance {
  text: string;
  lang?: string;
  voiceName?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/** How speaking ended, and the voices the system has. */
export type TtsResult = { type: "end" | "interrupted" | "cancelled" } | { type: "error"; errorMessage: string };
export interface SystemVoice {
  voiceName: string;
  lang: string;
  remote: boolean;
}

/** An extension asks for optional permissions (chrome.permissions.request). */
export interface ExtensionPermissionRequest {
  requestId: string;
  extensionId: string;
  name: string;
  permissions: string[];
  origins: string[];
}

/** Open an extension's popup (its keyboard shortcut, or chrome.action.openPopup). */
export interface ExtensionPopupRequest {
  workspaceId: string;
  extensionId: string;
  url: string;
}

/** Rune Browser's own extension in every web tab session: it applies the network rules (Settings → Web tools → Network rules). */
export const BUILTIN_EXTENSION_ID = "ikphnmngfgaajbhljcknjgjlhpdmmjpg";

export const EXTENSION_URL_PATTERN = /^chrome-extension:\/\/([a-p]{32})(\/|$)/;
export const extensionIdOf = (url: string | null | undefined) =>
  url ? (EXTENSION_URL_PATTERN.exec(url)?.[1] ?? null) : null;
export const isExtensionUrl = (url: string | null | undefined) => extensionIdOf(url) !== null;
export const isExtensionId = (id: unknown): id is string => typeof id === "string" && /^[a-p]{32}$/.test(id);

// --- Manifests ---------------------------------------------------------------------

export interface Manifest {
  manifest_version?: number;
  name?: string;
  short_name?: string;
  version?: string;
  description?: string;
  default_locale?: string;
  icons?: Record<string, string>;
  action?: { default_icon?: string | Record<string, string>; default_popup?: string; default_title?: string };
  browser_action?: Manifest["action"];
  page_action?: Manifest["action"];
  options_page?: string;
  options_ui?: { page?: string };
  permissions?: unknown[];
  optional_permissions?: unknown[];
  host_permissions?: unknown[];
  optional_host_permissions?: unknown[];
  commands?: Record<
    string,
    { description?: string; suggested_key?: string | Record<string, string>; global?: boolean }
  >;
  background?: { service_worker?: string; scripts?: string[]; page?: string };
  update_url?: string;
  key?: string;
  theme?: unknown;
  app?: unknown;
  [key: string]: unknown;
}

type Messages = Record<string, { message?: string }>;

/** Replaces `__MSG_name__` placeholders with the extension's messages (keys are case-insensitive). */
export function localize(text: string | undefined, messages: Messages | null): string {
  if (!text) return "";
  if (!messages) return text;
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages))
    if (typeof value?.message === "string") lower[key.toLowerCase()] = value.message;
  return text.replace(/__MSG_([\w@]+)__/g, (all, name: string) => lower[name.toLowerCase()] ?? all);
}

/** Locale folders to look in for messages, best first (en_US → en_US, en, then the default). */
export function localeCandidates(appLocale: string, defaultLocale: string | undefined) {
  const tag = appLocale.replace("-", "_");
  const list = [tag, tag.split("_")[0]!, defaultLocale ?? "", "en"].filter(Boolean);
  return [...new Set(list)];
}

/** The icon file closest to `size` (bigger first). */
export function iconPath(icons: string | Record<string, string> | undefined, size = 32): string | null {
  if (!icons) return null;
  if (typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!sizes.length) return null;
  const best = sizes.find((n) => n >= size) ?? sizes[sizes.length - 1]!;
  return icons[String(best)] ?? null;
}

export const actionOf = (m: Manifest) => m.action ?? m.browser_action ?? m.page_action;
export const optionsPageOf = (m: Manifest) => m.options_ui?.page ?? m.options_page ?? null;

/** What a permission lets an extension do, and what's different about it in Rune Browser (null: works like in Chrome). */
export interface PermissionAbout {
  description: string;
  limited: string | null;
}

const full = (description: string): PermissionAbout => ({ description, limited: null });
const limited = (description: string, note: string): PermissionAbout => ({ description, limited: note });

/** The permissions extensions ask for, natively in Electron, through Rune Browser's shims, or stand-ins that keep the extension working. */
const PERMISSIONS: Record<string, PermissionAbout> = {
  activeTab: full("Use the page you're on when you invoke it"),
  alarms: full("Run tasks on a schedule"),
  background: full("Keep running in the background"),
  bookmarks: full("Read and change your bookmarks"),
  browsingData: full("Clear your browsing data"),
  clipboardRead: full("Read what you copy"),
  clipboardWrite: full("Copy to the clipboard"),
  contentSettings: full("Change site settings (JavaScript, camera, location…)"),
  contextMenus: full("Add items to the right-click menu"),
  cookies: full("Read and change websites' cookies"),
  debugger: full("Debug pages"),
  declarativeContent: full("Show its button only on some pages"),
  declarativeNetRequest: full("Block or change network requests"),
  declarativeNetRequestFeedback: full("See which requests its rules matched"),
  declarativeNetRequestWithHostAccess: full("Block or change network requests on the sites it can access"),
  desktopCapture: full("Record your screen"),
  downloads: full("Download files and manage downloads"),
  "downloads.open": full("Open downloaded files"),
  "downloads.shelf": full("Hide the downloads button"),
  "downloads.ui": full("Hide the downloads button"),
  favicon: full("Show websites' icons"),
  fileSystem: full("Use files (Chrome apps only, like in Chrome)"),
  fontSettings: full("Change font settings"),
  gcm: limited(
    "Get push messages from its servers",
    "Push messages go through Google's servers for Chrome only: it doesn't get them.",
  ),
  geolocation: full("Know your location"),
  history: full("Read and change your browsing history"),
  i18n: full("Show itself in your language"),
  identity: limited(
    "Sign in with your browser's Google account",
    "Signing in on websites works; Rune Browser has no browser account, so getAuthToken fails: sign in on the extension's own page instead.",
  ),
  "identity.email": limited(
    "Know your browser account's email",
    "Rune Browser has no browser account: it sees no email.",
  ),
  idle: full("Know when you're away from the computer"),
  management: full("See and manage your other extensions"),
  menus: full("Add items to the right-click menu"),
  nativeMessaging: full("Talk to programs installed on this computer"),
  notifications: full("Show notifications"),
  offscreen: full("Run hidden pages for its own work"),
  pageCapture: full("Save pages as MHTML"),
  power: full("Keep the computer awake"),
  privacy: full("Change privacy settings"),
  proxy: full("Change proxy settings"),
  scripting: full("Run scripts in pages"),
  search: full("Search with your search engine"),
  sessions: full("See and reopen recently closed tabs"),
  sidePanel: full("Show a side panel"),
  storage: full("Store its settings and data"),
  "system.cpu": full("See the processor"),
  "system.display": full("See your displays"),
  "system.memory": full("See the memory"),
  "system.storage": limited("See storage devices", "It sees your storage devices, but can't eject them."),
  tabCapture: full("Record a tab's video or sound"),
  tabGroups: limited(
    "Use tab groups",
    "Rune Browser has no tab groups (split views are something else): it sees none.",
  ),
  tabs: full("See your tabs' addresses and titles"),
  topSites: full("See your most visited sites"),
  tts: full("Read text aloud"),
  ttsEngine: limited(
    "Provide a voice for reading text aloud",
    "Its voices are offered to other extensions (chrome.tts), not to web pages.",
  ),
  unlimitedStorage: full("Store lots of data"),
  userScripts: full("Run your user scripts on websites"),
  webNavigation: full("Follow how tabs navigate"),
  webRequest: full("See and change network requests"),
  webRequestBlocking: full("Block network requests"),
  webRequestAuthProvider: full("Fill in websites' sign-in prompts (password managers)"),
};

/** Permissions that only allow something (no chrome.* namespace of their own). */
export const PERMISSIONS_WITHOUT_API = new Set([
  "activeTab",
  "background",
  "clipboardRead",
  "clipboardWrite",
  "declarativeNetRequestFeedback",
  "declarativeNetRequestWithHostAccess",
  "downloads.open",
  "downloads.shelf",
  "downloads.ui",
  "favicon",
  "fileSystem",
  "geolocation",
  "identity.email",
  "unlimitedStorage",
  "webRequestAuthProvider",
  "webRequestBlocking",
]);

export function permissionAbout(permission: string): PermissionAbout {
  return (
    PERMISSIONS[permission] ??
    (permission.startsWith("fileSystem.")
      ? PERMISSIONS.fileSystem!
      : limited(
          permission,
          "Rune Browser doesn't have this: what the extension does with it fails, the rest of it keeps working.",
        ))
  );
}

const isHostPattern = (p: string) => p === "<all_urls>" || p.includes("://");

/** Permissions it asks for that are limited in Rune Browser (see `permissionAbout`). */
export function unsupportedPermissions(m: Manifest) {
  const asked = (m.permissions ?? []).filter((p): p is string => typeof p === "string" && !isHostPattern(p));
  return asked.filter((p) => permissionAbout(p).limited !== null).sort();
}

export const permissionsOf = (m: Manifest) =>
  (m.permissions ?? []).filter((p): p is string => typeof p === "string" && !isHostPattern(p));
export const optionalPermissionsOf = (m: Manifest) =>
  (m.optional_permissions ?? []).filter((p): p is string => typeof p === "string" && !isHostPattern(p));

/** Host permissions: MV3's host_permissions, or MV2's permissions that are patterns. */
export const hostPermissionsOf = (m: Manifest) =>
  [...(m.host_permissions ?? []), ...(m.manifest_version === 2 ? (m.permissions ?? []) : [])].filter(
    (p): p is string => typeof p === "string" && isHostPattern(p),
  );

/** Sites it may ask for when it needs them (chrome.permissions.request): optional_host_permissions, or optional permissions that are patterns. */
export const optionalHostPermissionsOf = (m: Manifest) => [
  ...new Set(
    [...(m.optional_host_permissions ?? []), ...(m.optional_permissions ?? [])].filter(
      (p): p is string => typeof p === "string" && isHostPattern(p),
    ),
  ),
];

/**
 * Its optional site access, for its details: the sites it may ask for, and
 * narrower ones it was given (chrome.permissions.request takes any pattern the
 * manifest's optional ones cover). Sites its required access already covers
 * aren't here: it always has those.
 */
export function optionalSiteAccess(m: Manifest, grantedOrigins: readonly string[]) {
  const required = hostPermissionsOf(m);
  const asked = optionalHostPermissionsOf(m);
  /** A broader site it was given that covers this one (switching this one off wouldn't change anything). */
  const broader = (pattern: string) => grantedOrigins.find((o) => o !== pattern && coversPattern([o], pattern)) ?? null;
  return [...new Set([...asked, ...grantedOrigins])]
    .filter((pattern) => !coversPattern(required, pattern))
    .filter((pattern) => asked.includes(pattern) || !broader(pattern))
    .sort()
    .map((pattern) => ({
      pattern,
      allowed: coversPattern(grantedOrigins, pattern),
      asked: asked.includes(pattern),
      coveredBy: broader(pattern),
    }));
}

// --- Match patterns ----------------------------------------------------------------

/**
 * Chrome's match patterns (`<all_urls>`, `*://*.example.com/*`, `https://a.b/path*`).
 * Returns null for an invalid pattern.
 */
export function matchPattern(pattern: string): ((url: string) => boolean) | null {
  if (pattern === "<all_urls>") return (url) => /^(https?|wss?|ftp|file|data|chrome-extension):/i.test(url);
  const m = /^(\*|https?|wss?|ftp|file|urn|chrome-extension):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!m) return null;
  const [, scheme, host, path = "/*"] = m as unknown as [string, string, string, string?];
  if (host !== "*" && host.includes("*") && !(host.startsWith("*.") && !host.slice(2).includes("*"))) return null;
  const hostLower = host.toLowerCase();
  const pathRe = new RegExp(`^${path.split("*").map(escapeRegExp).join(".*")}$`);
  return (url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const s = u.protocol.slice(0, -1).toLowerCase();
    if (scheme === "*" ? !["http", "https", "ws", "wss"].includes(s) : s !== scheme.toLowerCase()) return false;
    const h = u.hostname.toLowerCase();
    if (hostLower !== "*" && s !== "file") {
      if (hostLower.startsWith("*.")) {
        const base = hostLower.slice(2);
        if (h !== base && !h.endsWith(`.${base}`)) return false;
      } else if (h !== hostLower.replace(/:\d+$/, "")) return false;
    }
    return pathRe.test(u.pathname + u.search);
  };
}

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Whether any of the patterns matches the URL. */
export function matchesAny(patterns: readonly string[], url: string) {
  return patterns.some((p) => matchPattern(p)?.(url) ?? false);
}

const ALL_URLS_SCHEMES = ["http", "https", "ws", "wss", "ftp", "file", "data", "chrome-extension"];

/** A match pattern's schemes and host (null: not a valid pattern), with `<all_urls>` as every scheme and host. */
function patternParts(pattern: string) {
  if (pattern === "<all_urls>") return { schemes: ALL_URLS_SCHEMES, host: "*" };
  const m = /^(\*|https?|wss?|ftp|file|urn|chrome-extension):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!m || !matchPattern(pattern)) return null;
  const [, scheme, host] = m as unknown as [string, string, string];
  const s = scheme.toLowerCase();
  return { schemes: s === "*" ? ["http", "https", "ws", "wss"] : [s], host: host.toLowerCase() };
}

/**
 * Whether every site `inner` matches, `outer` matches too, by scheme and host.
 * Paths don't count: Chrome reads host permissions as path "/*", so
 * `https://*\/` covers `https://example.com/*`.
 */
function patternCovers(outer: string, inner: string) {
  const o = patternParts(outer);
  const i = patternParts(inner);
  if (!o || !i) return false;
  if (!i.schemes.every((s) => o.schemes.includes(s))) return false;
  const port = (h: string) => h.replace(/:\d+$/, "");
  if (o.host !== "*") {
    if (i.host === "*") return false;
    if (o.host.startsWith("*.")) {
      const base = o.host.slice(2);
      const host = port(i.host.startsWith("*.") ? i.host.slice(2) : i.host);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (i.host.startsWith("*.") || port(i.host) !== port(o.host)) return false;
  }
  return true;
}

/** Whether the patterns cover this one (like chrome.permissions.contains checks origins). */
export const coversPattern = (patterns: readonly string[], pattern: string) =>
  patterns.includes(pattern) || patterns.some((p) => patternCovers(p, pattern));

// --- Keyboard shortcuts ------------------------------------------------------------------

export type ShortcutPlatform = "linux" | "mac" | "windows" | "chromeos";

export interface Shortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** KeyboardEvent.code it matches (KeyX, Digit1, ArrowUp, F5…). */
  code: string;
}

const NAMED_KEYS: Record<string, string> = {
  comma: "Comma",
  period: "Period",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
  insert: "Insert",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  medianexttrack: "MediaTrackNext",
  mediaprevtrack: "MediaTrackPrevious",
  mediaplaypause: "MediaPlayPause",
  mediastop: "MediaStop",
};

/** Parses a command's key ("Ctrl+Shift+X", "Alt+Shift+L", "Command+Comma"). Null if it isn't one. */
export function parseShortcut(text: string, platform: ShortcutPlatform): Shortcut | null {
  const parts = text.split("+").map((p) => p.trim());
  if (parts.length < 1 || parts.some((p) => !p)) return null;
  const s: Shortcut = { ctrl: false, alt: false, shift: false, meta: false, code: "" };
  for (const part of parts.slice(0, -1)) {
    const p = part.toLowerCase();
    if (p === "ctrl") s[platform === "mac" ? "meta" : "ctrl"] = true;
    else if (p === "command") s.meta = true;
    else if (p === "macctrl") s.ctrl = true;
    else if (p === "alt" || p === "option") s.alt = true;
    else if (p === "shift") s.shift = true;
    else if (p === "search") s.meta = true;
    else return null;
  }
  const key = parts[parts.length - 1]!;
  if (/^[a-z]$/i.test(key)) s.code = `Key${key.toUpperCase()}`;
  else if (/^\d$/.test(key)) s.code = `Digit${key}`;
  else if (/^f([1-9]|1[0-2])$/i.test(key)) s.code = key.toUpperCase();
  else if (NAMED_KEYS[key.toLowerCase()]) s.code = NAMED_KEYS[key.toLowerCase()]!;
  else return null;
  // Media keys work alone; everything else needs Ctrl, Alt or Command.
  if (!s.code.startsWith("Media") && !s.ctrl && !s.alt && !s.meta) return null;
  return s;
}

/** A command's key on this platform (suggested_key is a string or per platform, with a default). */
export function suggestedKey(
  suggested: string | Record<string, string> | undefined,
  platform: ShortcutPlatform,
): string | null {
  if (!suggested) return null;
  if (typeof suggested === "string") return suggested;
  return suggested[platform] ?? suggested.default ?? null;
}

export function shortcutMatches(
  s: Shortcut,
  input: { control: boolean; alt: boolean; shift: boolean; meta: boolean; code: string },
) {
  return (
    s.code === input.code &&
    s.ctrl === input.control &&
    s.alt === input.alt &&
    s.shift === input.shift &&
    s.meta === input.meta
  );
}

/** "Ctrl+Shift+X" as shown to people. */
export function shortcutLabel(text: string) {
  return text
    .split("+")
    .map((p) => p.trim())
    .join("+");
}

const colorNames: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  purple: [128, 0, 128],
};

/** A badge color as Chrome returns it: [r, g, b, a]. */
export function parseColor(value: unknown): [number, number, number, number] | null {
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a = 255] = value.map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))));
    return [r!, g!, b!, a!];
  }
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (colorNames[v]) return [...colorNames[v], 255];
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    const [r, g, b, a = "f"] = [...m[1]!];
    return [parseInt(r! + r, 16), parseInt(g! + g, 16), parseInt(b! + b, 16), parseInt(a + a, 16)];
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m)
    return [
      parseInt(m[1]!.slice(0, 2), 16),
      parseInt(m[1]!.slice(2, 4), 16),
      parseInt(m[1]!.slice(4, 6), 16),
      m[2] ? parseInt(m[2], 16) : 255,
    ];
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = m[1]!
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3)
      return [
        parts[0]!,
        parts[1]!,
        parts[2]!,
        parts[3] === undefined ? 255 : Math.round(parts[3] <= 1 ? parts[3] * 255 : parts[3]),
      ];
  }
  return null;
}

// --- Network rules as declarativeNetRequest rules -------------------------------------------
//
// Rune Browser's own rules (Settings → Web tools → Network rules) are applied with declarativeNetRequest
// by a small built-in extension. Session webRequest hooks would switch off every
// installed extension's blocking (Electron gives the hooks precedence), so the
// rules and extensions like uBlock Origin Lite can work together.

const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as const;

export interface DnrRule {
  id: number;
  priority: number;
  action:
    | { type: "block" }
    | {
        type: "modifyHeaders";
        requestHeaders?: { header: string; operation: "set" | "remove"; value?: string }[];
        responseHeaders?: { header: string; operation: "set" | "remove"; value?: string }[];
      };
  condition: {
    urlFilter?: string;
    regexFilter?: string;
    requestDomains?: string[];
    excludedRequestDomains?: string[];
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
    domainType?: "firstParty" | "thirdParty";
    resourceTypes: string[];
    isUrlFilterCaseSensitive: false;
  };
}

const headerOps = (headers: Record<string, string | null>) =>
  Object.entries(headers).map(([header, value]) =>
    value === null ? { header, operation: "remove" as const } : { header, operation: "set" as const, value },
  );

/**
 * A rule's pattern as a DNR condition. With `*` it matches the whole URL
 * (anchored at both ends), otherwise any URL containing it, case-insensitively
 * like `urlMatcher`. Characters DNR filters treat specially (`|`, `^`) need a
 * regular expression instead.
 */
export function patternCondition(pattern: string): { urlFilter: string } | { regexFilter: string } | null {
  const p = pattern.trim();
  if (!p || /[^\x20-\x7e]/.test(p)) return null;
  const whole = p.includes("*");
  if (!/[|^]/.test(p)) return { urlFilter: whole ? `|${p}|` : p };
  const body = p.split("*").map(escapeRegExp).join(".*");
  return { regexFilter: whole ? `^${body}$` : body };
}

/**
 * The workspace's enabled rules as DNR session rules (block wins over header
 * changes), and Google's sign-in user agent (see `signInRule`), which the
 * rules can override.
 */
export function networkRulesToDnr(
  rules: readonly NetworkRule[],
  workspaceId: string,
  signInUserAgent?: string,
): DnrRule[] {
  const out: DnrRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || (rule.workspaceId !== null && rule.workspaceId !== workspaceId)) continue;
    const condition = patternCondition(rule.pattern);
    if (!condition) continue;
    const base = {
      id: out.length + 1,
      condition: { ...condition, resourceTypes: [...ALL_RESOURCE_TYPES], isUrlFilterCaseSensitive: false as const },
    };
    if (rule.action === "block") {
      out.push({ ...base, priority: 3, action: { type: "block" } });
      continue;
    }
    const requestHeaders = headerOps(rule.requestHeaders);
    const responseHeaders = headerOps(rule.responseHeaders);
    if (!requestHeaders.length && !responseHeaders.length) continue;
    out.push({
      ...base,
      priority: 2,
      action: {
        type: "modifyHeaders",
        ...(requestHeaders.length ? { requestHeaders } : {}),
        ...(responseHeaders.length ? { responseHeaders } : {}),
      },
    });
  }
  if (signInUserAgent) out.push(signInRule(out.length + 1, signInUserAgent));
  return out;
}

/**
 * Web tabs say they're plain Chrome (some sites turn away other browsers), but
 * Google's sign-in tells that it's not Chrome and refuses it as "This browser
 * or app may not be secure". It accepts Electron when it's named, so its
 * pages and requests get the user agent with Electron in it.
 */
export function signInRule(id: number, userAgent: string): DnrRule {
  return {
    id,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "User-Agent", operation: "set", value: userAgent }] },
    condition: {
      requestDomains: ["accounts.google.com"],
      resourceTypes: [...ALL_RESOURCE_TYPES],
      isUrlFilterCaseSensitive: false,
    },
  };
}

// --- Chrome's profile data ----------------------------------------------------------------------

/** Extension locations in Chrome's preferences that are part of the browser itself. */
const BUILT_IN_LOCATIONS = new Set([5, 10]);
/** Loaded from a folder: developer mode (4) or --load-extension (8). */
const UNPACKED_LOCATIONS = new Set([4, 8]);

export interface ProfileExtensionEntry {
  id: string;
  /** As stored: relative to the profile's Extensions folder, or absolute. */
  path: string;
  unpacked: boolean;
  enabled: boolean;
  byDefault: boolean;
  fromWebStore: boolean;
}

/**
 * The extensions a Chrome profile lists in Preferences / Secure Preferences
 * (`extensions.settings`), without the browser's own components, themes and
 * hosted apps.
 */
export function profileExtensions(...prefs: unknown[]): ProfileExtensionEntry[] {
  const found = new Map<string, ProfileExtensionEntry>();
  for (const p of prefs) {
    const settings = (p as { extensions?: { settings?: Record<string, unknown> } } | null)?.extensions?.settings;
    if (!settings || typeof settings !== "object") continue;
    for (const [id, raw] of Object.entries(settings)) {
      const e = raw as {
        location?: number;
        path?: string;
        state?: number;
        disable_reasons?: number | number[];
        was_installed_by_default?: boolean;
        from_webstore?: boolean;
        manifest?: Manifest;
      };
      if (!isExtensionId(id) || typeof e?.path !== "string" || !e.path) continue;
      if (e.location !== undefined && BUILT_IN_LOCATIONS.has(e.location)) continue;
      if (e.manifest && (e.manifest.theme || e.manifest.app)) continue;
      const reasons = e.disable_reasons;
      const disabled = Array.isArray(reasons)
        ? reasons.length > 0
        : typeof reasons === "number"
          ? reasons !== 0
          : e.state === 0;
      const previous = found.get(id);
      found.set(id, {
        id,
        path: e.path,
        unpacked: e.location !== undefined && UNPACKED_LOCATIONS.has(e.location),
        enabled: previous ? previous.enabled && !disabled : !disabled,
        byDefault: e.was_installed_by_default === true,
        fromWebStore: e.from_webstore === true,
      });
    }
  }
  return [...found.values()];
}

/** Chrome's own keyboard shortcuts for extension commands (`extensions.commands`), by extension and command. */
export function profileCommands(prefs: unknown, platform: ShortcutPlatform): Record<string, Record<string, string>> {
  const commands = (
    prefs as { extensions?: { commands?: Record<string, { command_name?: string; extension?: string }> } } | null
  )?.extensions?.commands;
  const out: Record<string, Record<string, string>> = {};
  if (!commands || typeof commands !== "object") return out;
  for (const [binding, value] of Object.entries(commands)) {
    const [plat, key] = binding.includes(":")
      ? [binding.slice(0, binding.indexOf(":")), binding.slice(binding.indexOf(":") + 1)]
      : [platform, binding];
    if (plat !== platform || !value?.extension || !value.command_name || !key) continue;
    (out[value.extension] ??= {})[value.command_name] = key;
  }
  return out;
}

/** Pinned extensions in a Chrome profile. */
export function profilePinned(prefs: unknown): string[] {
  const pinned = (prefs as { extensions?: { pinned_extensions?: unknown } } | null)?.extensions?.pinned_extensions;
  return Array.isArray(pinned) ? pinned.filter(isExtensionId) : [];
}

/** Newer version first ("1.10.0" > "1.9.2"). */
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The extension ID belonging to a public key (what Chrome derives from the manifest's `key`). */
export function extensionIdFromHash(sha256Hex: string) {
  return [...sha256Hex.slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

/**
 * What Chromium hashes for the ID of an extension without a key: its folder's
 * path, as the platform stores paths. On Windows that's UTF-16 with the drive
 * letter upper-cased (UTF-8 bytes would give another ID, and the extension
 * would load under an ID Rune Browser doesn't know).
 */
export function idSourceForPath(
  path: string,
  platform: ShortcutPlatform,
): { text: string; encoding: "utf8" | "utf16le" } {
  if (platform !== "windows") return { text: path, encoding: "utf8" };
  return { text: path.replace(/^([a-z]):/, (_all, drive: string) => `${drive.toUpperCase()}:`), encoding: "utf16le" };
}

/** A Chrome Web Store link or a bare ID → the ID. */
export function webStoreId(input: string): string | null {
  const text = input.trim();
  if (isExtensionId(text)) return text;
  const m = /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/(?:[^/]+\/)?([a-p]{32})/.exec(text);
  return m?.[1] ?? null;
}
