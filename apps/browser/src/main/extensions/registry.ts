// The installed extensions: a small JSON file in Rune Browser's user data, next to
// the extensions that were copied in (`<userData>/extensions/<id>/<version>/`).
// Unpacked ones stay where they are. What a manifest says (localized name,
// icons, options page…) is read from disk and cached.
import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import {
  actionOf,
  extensionIdFromHash,
  hostPermissionsOf,
  idSourceForPath,
  iconPath,
  isExtensionId,
  localeCandidates,
  localize,
  optionalPermissionsOf,
  optionalSiteAccess,
  optionsPageOf,
  permissionAbout,
  permissionsOf,
  suggestedKey,
  unsupportedPermissions,
  type ExtensionInfo,
  type ExtensionSource,
  type Manifest,
  type ShortcutPlatform,
} from "../../shared/extensions";

export interface InstalledExtension {
  id: string;
  /** The folder Electron loads. */
  path: string;
  /** Copied into Rune Browser's data (deleted with it); otherwise used where it is. */
  managed: boolean;
  enabled: boolean;
  pinned: boolean;
  source: ExtensionSource;
  installedAt: number;
  /** Keyboard shortcuts changed from the manifest's (command → "Ctrl+Shift+Y"). */
  commands?: Record<string, string>;
  /** Optional permissions and origins the user granted (chrome.permissions.request, or in its details). */
  granted?: { permissions: string[]; origins: string[] };
  /** Permissions it asks for that the user blocked (in its details). */
  denied?: string[];
  /** Runs in private windows too (off unless the user allows it, like Chrome's "Allow in Incognito"). */
  allowPrivate?: boolean;
  /** chrome.storage.local data imported from another browser, copied into each workspace before its first start. */
  seed?: string;
}

interface RegistryFile {
  version: 1;
  autoUpdate: boolean;
  extensions: InstalledExtension[];
}

export const extensionsDir = () => join(app.getPath("userData"), "extensions");

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes through a temp file so a crash never leaves half a file. */
export function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, file);
}

/** A manifest with the strings localized, plus what's derived from it. */
export interface ManifestInfo {
  manifest: Manifest;
  name: string;
  description: string;
  version: string;
  messages: Record<string, { message?: string }> | null;
}

const manifestCache = new Map<string, { mtime: number; info: ManifestInfo }>();

/** Reads an extension's manifest (cached until the file changes). Throws if there's none. */
export function readManifest(dir: string): ManifestInfo {
  const file = join(dir, "manifest.json");
  const mtime = statSync(file).mtimeMs;
  const cached = manifestCache.get(dir);
  if (cached?.mtime === mtime) return cached.info;
  // Chrome tolerates a BOM and comments in manifests; JSON.parse doesn't.
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    manifest = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  }
  const messages = readMessages(dir, manifest.default_locale);
  const info: ManifestInfo = {
    manifest,
    name: localize(manifest.name, messages) || localize(manifest.short_name, messages) || "Extension",
    description: localize(manifest.description, messages),
    version: String(manifest.version ?? "0"),
    messages,
  };
  manifestCache.set(dir, { mtime, info });
  return info;
}

function readMessages(dir: string, defaultLocale: string | undefined) {
  for (const locale of localeCandidates(app.getLocale() || "en", defaultLocale)) {
    const messages = readJson<Record<string, { message?: string }>>(join(dir, "_locales", locale, "messages.json"));
    if (messages) return messages;
  }
  return null;
}

/** A file inside an extension (paths in manifests may start with "/"), or null if it escapes it. */
export function extensionFile(dir: string, path: string) {
  const file = normalize(join(dir, path.replace(/^\/+/, "")));
  return file.startsWith(normalize(dir) + sep) ? file : null;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};
const iconCache = new Map<string, string | null>();

/** An image file of the extension as a data: URL (cached). */
export function imageDataUrl(dir: string, path: string | null | undefined): string | null {
  if (!path) return null;
  const file = extensionFile(dir, path);
  if (!file) return null;
  if (iconCache.has(file)) return iconCache.get(file)!;
  let url: string | null = null;
  try {
    const type = MIME[extname(file).toLowerCase()];
    if (type) url = `data:${type};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    url = null;
  }
  iconCache.set(file, url);
  return url;
}

export function forgetIcons(dir: string) {
  for (const key of iconCache.keys()) if (key.startsWith(dir)) iconCache.delete(key);
  manifestCache.delete(dir);
}

export class Registry {
  private file = join(extensionsDir(), "registry.json");
  private data: RegistryFile;

  constructor() {
    const stored = readJson<RegistryFile>(this.file);
    this.data = {
      version: 1,
      autoUpdate: stored?.autoUpdate ?? true,
      extensions: (stored?.extensions ?? []).filter((e) => isExtensionId(e?.id) && typeof e.path === "string"),
    };
  }

  private save() {
    writeJson(this.file, this.data);
  }

  list() {
    return this.data.extensions;
  }

  get(id: string) {
    return this.data.extensions.find((e) => e.id === id);
  }

  get autoUpdate() {
    return this.data.autoUpdate;
  }

  set autoUpdate(value: boolean) {
    this.data.autoUpdate = value;
    this.save();
  }

  /** Adds or replaces an extension (keeping its pinned/enabled state and grants when it's an update). */
  put(entry: InstalledExtension) {
    const index = this.data.extensions.findIndex((e) => e.id === entry.id);
    if (index === -1) this.data.extensions.push(entry);
    else this.data.extensions[index] = entry;
    this.save();
  }

  update(id: string, change: Partial<InstalledExtension>) {
    const entry = this.get(id);
    if (!entry) return undefined;
    Object.assign(entry, change);
    this.save();
    return entry;
  }

  remove(id: string) {
    const entry = this.get(id);
    if (!entry) return;
    this.data.extensions = this.data.extensions.filter((e) => e.id !== id);
    this.save();
    if (entry.managed) rmSync(join(extensionsDir(), id), { recursive: true, force: true });
    else if (entry.seed) rmSync(entry.seed, { recursive: true, force: true });
  }

  /** Where a copied extension's files go. */
  static installDir(id: string, version: string) {
    return join(extensionsDir(), id, version.replace(/[^\w.-]/g, "_"));
  }
}

/** Chromium's ID for an extension without a key: from the folder it's loaded from. */
export function idForPath(path: string) {
  const { text, encoding } = idSourceForPath(path, platform);
  return extensionIdFromHash(createHash("sha256").update(Buffer.from(text, encoding)).digest("hex"));
}

export const platform: ShortcutPlatform =
  process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";

/** An extension's commands and their keys on this platform (the user's own, else the manifest's suggestion; "" if none). */
export function commandsOf(entry: InstalledExtension, info: ManifestInfo) {
  return Object.entries(info.manifest.commands ?? {}).map(([name, c]) => ({
    name,
    description: localize(c?.description, info.messages),
    shortcut: entry.commands?.[name] ?? suggestedKey(c?.suggested_key, platform) ?? "",
  }));
}

/** How an installed extension is shown in the Rune Browser window. */
export function describe(entry: InstalledExtension, error: string | null, hasNativeHosts: boolean): ExtensionInfo {
  let info: ManifestInfo | null = null;
  try {
    info = existsSync(entry.path) ? readManifest(entry.path) : null;
  } catch {
    info = null;
  }
  const m = info?.manifest ?? {};
  const options = optionsPageOf(m);
  return {
    id: entry.id,
    name: info?.name ?? entry.id,
    version: info?.version ?? "",
    description: info?.description ?? "",
    icon: info ? imageDataUrl(entry.path, iconPath(m.icons, 48) ?? iconPath(actionOf(m)?.default_icon, 48)) : null,
    enabled: entry.enabled,
    allowPrivate: entry.allowPrivate === true,
    pinned: entry.pinned,
    source: entry.source,
    path: entry.path,
    hasAction: !!actionOf(m),
    optionsUrl: options ? `chrome-extension://${entry.id}/${options.replace(/^\/+/, "")}` : null,
    unsupported: unsupportedPermissions(m),
    permissions: [
      ...permissionsOf(m).map((name) => ({
        name,
        ...permissionAbout(name),
        optional: false,
        allowed: !entry.denied?.includes(name),
      })),
      ...optionalPermissionsOf(m)
        .filter((name) => !permissionsOf(m).includes(name))
        .map((name) => ({
          name,
          ...permissionAbout(name),
          optional: true,
          allowed: !!entry.granted?.permissions.includes(name) && !entry.denied?.includes(name),
        })),
    ].sort((a, b) => a.name.localeCompare(b.name)),
    // Its host permissions and where its content scripts run.
    siteAccess: [
      ...new Set([
        ...hostPermissionsOf(m),
        ...((m as { content_scripts?: { matches?: unknown[] }[] }).content_scripts ?? []).flatMap((c) =>
          (c.matches ?? []).filter((x): x is string => typeof x === "string"),
        ),
      ]),
    ].sort(),
    optionalSiteAccess: optionalSiteAccess(m, entry.granted?.origins ?? []),
    shortcuts: info ? commandsOf(entry, info).filter((c) => c.shortcut) : [],
    nativeMessaging: permissionsOf(m).includes("nativeMessaging") && hasNativeHosts,
    updates: entry.source.kind !== "unpacked" && typeof m.update_url === "string",
    error: info ? error : `The extension's folder is gone: ${entry.path}`,
  };
}
