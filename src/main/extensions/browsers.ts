// Other browsers on this computer (Chrome, Chromium, Brave, Edge, Vivaldi):
// their profiles and the extensions installed in them, and copying those over.
// Store extensions are copied into Rune Browser's data; ones loaded from a folder are
// used where they are. Their chrome.storage.local data (settings, logins of the
// extension…) can come along: it's copied aside and put into each workspace
// before the extension first starts there.
import { app } from "electron";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  iconPath,
  profileCommands,
  profileExtensions,
  profilePinned,
  unsupportedPermissions,
  type BrowserProfile,
  type ImportCandidate,
  type ProfileExtensionEntry,
} from "../../shared/extensions";
import {
  extensionsDir,
  idForPath,
  imageDataUrl,
  platform,
  readJson,
  readManifest,
  Registry,
  type InstalledExtension,
} from "./registry";

export { platform };

/** A browser's user data folder (the one with "Local State" and the profiles). */
export interface BrowserDir {
  browser: string;
  dir: string;
}

/** Where Chromium-based browsers keep their data, per platform. RUNE_BROWSER_DIRS ("Name=/path;…") replaces the list (tests). */
export function browserDirs(): BrowserDir[] {
  const override = process.env.RUNE_BROWSER_DIRS;
  if (override !== undefined) {
    return override
      .split(";")
      .filter(Boolean)
      .map((pair) => ({ browser: pair.slice(0, pair.indexOf("=")), dir: pair.slice(pair.indexOf("=") + 1) }));
  }
  const home = homedir();
  const list: [string, string][] = [];
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    list.push(
      ["Google Chrome", join(base, "Google", "Chrome")],
      ["Chrome Beta", join(base, "Google", "Chrome Beta")],
      ["Chrome Canary", join(base, "Google", "Chrome Canary")],
      ["Chromium", join(base, "Chromium")],
      ["Brave", join(base, "BraveSoftware", "Brave-Browser")],
      ["Microsoft Edge", join(base, "Microsoft Edge")],
      ["Vivaldi", join(base, "Vivaldi")],
      ["Arc", join(base, "Arc", "User Data")],
    );
  } else if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    list.push(
      ["Google Chrome", join(base, "Google", "Chrome", "User Data")],
      ["Chrome Beta", join(base, "Google", "Chrome Beta", "User Data")],
      ["Chrome Canary", join(base, "Google", "Chrome SxS", "User Data")],
      ["Chromium", join(base, "Chromium", "User Data")],
      ["Brave", join(base, "BraveSoftware", "Brave-Browser", "User Data")],
      ["Microsoft Edge", join(base, "Microsoft", "Edge", "User Data")],
      ["Vivaldi", join(base, "Vivaldi", "User Data")],
    );
  } else {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const flatpak = (appId: string, path: string) => join(home, ".var", "app", appId, "config", path);
    list.push(
      ["Google Chrome", join(config, "google-chrome")],
      ["Chrome Beta", join(config, "google-chrome-beta")],
      ["Chrome Dev", join(config, "google-chrome-unstable")],
      ["Chromium", join(config, "chromium")],
      ["Brave", join(config, "BraveSoftware", "Brave-Browser")],
      ["Brave Beta", join(config, "BraveSoftware", "Brave-Browser-Beta")],
      ["Brave Nightly", join(config, "BraveSoftware", "Brave-Browser-Nightly")],
      ["Microsoft Edge", join(config, "microsoft-edge")],
      ["Edge Beta", join(config, "microsoft-edge-beta")],
      ["Edge Dev", join(config, "microsoft-edge-dev")],
      ["Vivaldi", join(config, "vivaldi")],
      ["Thorium", join(config, "thorium")],
      ["Google Chrome (Flatpak)", flatpak("com.google.Chrome", "google-chrome")],
      ["Chromium (Flatpak)", flatpak("org.chromium.Chromium", "chromium")],
      ["Brave (Flatpak)", flatpak("com.brave.Browser", join("BraveSoftware", "Brave-Browser"))],
      ["Microsoft Edge (Flatpak)", flatpak("com.microsoft.Edge", "microsoft-edge")],
      ["Vivaldi (Flatpak)", flatpak("com.vivaldi.Vivaldi", "vivaldi")],
      ["Chromium (Snap)", join(home, "snap", "chromium", "common", "chromium")],
    );
  }
  return list.map(([browser, dir]) => ({ browser, dir }));
}

interface FoundProfile {
  key: string;
  browser: string;
  name: string;
  dir: string;
  prefs: unknown;
  entries: ProfileExtensionEntry[];
}

/** The profiles of a browser, from its Local State (or the folders that look like profiles). */
function profilesOf({ browser, dir }: BrowserDir): FoundProfile[] {
  if (!existsSync(dir)) return [];
  const state = readJson<{ profile?: { info_cache?: Record<string, { name?: string }> } }>(join(dir, "Local State"));
  const names = state?.profile?.info_cache ?? {};
  let folders = Object.keys(names);
  if (!folders.length) {
    try {
      folders = readdirSync(dir).filter((f) => f === "Default" || /^Profile \d+$/.test(f));
    } catch {
      folders = [];
    }
  }
  const found: FoundProfile[] = [];
  for (const folder of folders) {
    const profileDir = join(dir, folder);
    const prefs = readJson(join(profileDir, "Preferences"));
    const secure = readJson(join(profileDir, "Secure Preferences"));
    if (!prefs && !secure) continue;
    found.push({
      key: createHash("sha256").update(profileDir).digest("hex").slice(0, 16),
      browser,
      name: names[folder]?.name || folder,
      dir: profileDir,
      prefs,
      entries: profileExtensions(prefs, secure),
    });
  }
  return found;
}

const extensionDirOf = (profile: FoundProfile, entry: ProfileExtensionEntry) =>
  isAbsolute(entry.path) ? entry.path : join(profile.dir, "Extensions", entry.path);

/** Storage of an extension in a profile (or a session's folder), by kind. */
export const storageFolders = (id: string) => [
  join("Local Extension Settings", id),
  join("DNR Extension Rules", id),
  join("IndexedDB", `chrome-extension_${id}_0.indexeddb.leveldb`),
  join("IndexedDB", `chrome-extension_${id}_0.indexeddb.blob`),
];

function hasFiles(dir: string) {
  try {
    return readdirSync(dir).some((f) => f !== "LOCK" && f !== "LOG" && f !== "LOG.old");
  } catch {
    return false;
  }
}

function candidate(profile: FoundProfile, entry: ProfileExtensionEntry, registry: Registry): ImportCandidate | null {
  const dir = extensionDirOf(profile, entry);
  let info;
  try {
    info = readManifest(dir);
  } catch {
    return null;
  }
  const m = info.manifest;
  if (m.theme || m.app) return null;
  return {
    id: entry.id,
    name: info.name,
    version: info.version,
    description: info.description,
    icon: imageDataUrl(dir, iconPath(m.icons, 48)),
    enabledThere: entry.enabled,
    byDefault: entry.byDefault,
    unpacked: entry.unpacked,
    installed: !!registry.get(entry.id),
    hasSettings: storageFolders(entry.id).some((f) => hasFiles(join(profile.dir, f))),
    unsupported: unsupportedPermissions(m),
  };
}

/** Every browser profile found, with its preferences (Settings → Browser → Import). */
export const browserProfiles = () =>
  browserDirs()
    .flatMap(profilesOf)
    .map((p) => ({ key: p.key, browser: p.browser, name: p.name, prefs: p.prefs }));

let cache: FoundProfile[] = [];

/** Every profile with extensions, in every browser found. */
export function detectBrowsers(registry: Registry): BrowserProfile[] {
  cache = browserDirs().flatMap(profilesOf);
  return cache
    .map((p) => ({
      key: p.key,
      browser: p.browser,
      profile: p.name,
      extensions: p.entries
        .map((e) => candidate(p, e, registry))
        .filter((c): c is ImportCandidate => c !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((p) => p.extensions.length > 0);
}

/** Copies an extension's chrome.storage data aside, to go into each workspace. */
function copySeed(profileDir: string, id: string): string | undefined {
  const seed = join(extensionsDir(), "seeds", id);
  rmSync(seed, { recursive: true, force: true });
  let copied = false;
  for (const folder of storageFolders(id)) {
    const from = join(profileDir, folder);
    if (!hasFiles(from)) continue;
    // The browser may be running: its lock file stays behind.
    cpSync(from, join(seed, folder), { recursive: true, filter: (src) => basename(src) !== "LOCK" });
    copied = true;
  }
  return copied ? seed : undefined;
}

export interface ImportedExtension {
  entry: InstalledExtension;
  name: string;
}

/**
 * Brings extensions over from a profile found by `detectBrowsers`: their files,
 * on/off, pinned, their keyboard shortcuts, and optionally their settings.
 */
export function importExtensions(registry: Registry, profileKey: string, ids: string[], settings: boolean) {
  const profile = cache.find((p) => p.key === profileKey);
  if (!profile) throw new Error("That browser profile is no longer there");
  const pinned = new Set(profilePinned(profile.prefs));
  const commands = profileCommands(profile.prefs, platform);
  const installed: ImportedExtension[] = [];
  const failed: { id: string; name: string; error: string }[] = [];
  for (const id of ids) {
    const found = profile.entries.find((e) => e.id === id);
    if (!found) {
      failed.push({ id, name: id, error: "Not in that profile" });
      continue;
    }
    const from = extensionDirOf(profile, found);
    let name = id;
    try {
      const info = readManifest(from);
      name = info.name;
      let path = from;
      let managed = false;
      if (!found.unpacked) {
        path = Registry.installDir(id, info.version);
        rmSync(path, { recursive: true, force: true });
        cpSync(from, path, { recursive: true });
        managed = true;
        // Without a key, the ID comes from the folder: it would change.
        if (!info.manifest.key && idForPath(path) !== id) throw new Error("It has no key, so it can't keep its ID");
      } else if (!statSync(from).isDirectory()) {
        throw new Error(`Its folder is gone: ${from}`);
      }
      const previous = registry.get(id);
      const entry: InstalledExtension = {
        id,
        path,
        managed,
        enabled: true,
        pinned: pinned.has(id) || (previous?.pinned ?? false),
        source: { kind: "browser", browser: profile.browser, profile: profile.name },
        installedAt: Date.now(),
        ...(commands[id] ? { commands: commands[id] } : previous?.commands ? { commands: previous.commands } : {}),
        ...(previous?.granted ? { granted: previous.granted } : {}),
      };
      const seed = settings ? copySeed(profile.dir, id) : undefined;
      if (seed) entry.seed = seed;
      if (previous?.managed && previous.path !== path) rmSync(previous.path, { recursive: true, force: true });
      registry.put(entry);
      installed.push({ entry, name });
    } catch (err) {
      failed.push({ id, name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { installed, failed };
}

/** Rune Browser's own native messaging hosts folder (checked before the browsers'). */
export const nativeHostsDir = () => join(app.getPath("userData"), "NativeMessagingHosts");
