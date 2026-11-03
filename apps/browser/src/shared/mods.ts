// Mods: customizations packaged to share with others. A mod is one JSON
// document: page changes (how sites look and work, shared/web.ts), Rune Browser's
// theme and Chrome Web Store extensions. It travels as a file, a link to that
// file or a share code (the JSON, compressed, after "RUNE-MOD:"), and is
// reviewed before it's installed (reviewMod). Installed mods can be turned off
// or removed, which takes back everything they did (server: mods/Mods.ts).
import { Schema } from "effect";
import type { PageChangeSpec } from "./api";
import { GlobalTheme } from "./settings";
import { pageChangeProblem, pageChangeSpec } from "./web";

export const MOD_FORMAT = "rune-mod";
export const SHARE_CODE_PREFIX = "RUNE-MOD:";
/** A mod's JSON is at most this big. */
export const MOD_MAX_BYTES = 1_000_000;
export const MOD_MAX_CHANGES = 200;
export const MOD_MAX_EXTENSIONS = 20;

/** A Chrome Web Store extension the mod installs. */
export interface ModExtension {
  id: string;
  name: string;
}

export interface Mod {
  format: typeof MOD_FORMAT;
  version: 1;
  /** Stable across versions: installing a mod with the same id updates it. */
  id: string;
  name: string;
  description: string;
  author: string;
  modVersion: string;
  pageChanges: PageChangeSpec[];
  theme: GlobalTheme | null;
  extensions: ModExtension[];
}

/** A mod as installed (GET /api/mods). */
export interface InstalledMod {
  mod: Mod;
  enabled: boolean;
  /** Where it came from: "code", "file", a URL, "gallery" or "you" (packaged here). */
  source: string;
  installedAt: string;
  /** Extensions this mod installed (removed with it); ones that were already there stay. */
  installedExtensions: string[];
}

/** A mod in the gallery, with where it's listed. */
export interface GalleryEntry {
  mod: Mod;
  /** "Rune Browser" for the built-in examples, else the gallery's URL. */
  gallery: string;
}

export interface GalleryResult {
  entries: GalleryEntry[];
  /** Galleries that couldn't be read, and why. */
  errors: { gallery: string; error: string }[];
}

const MOD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const decodeTheme = Schema.decodeUnknownSync(GlobalTheme);

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** A mod from untrusted JSON: everything checked and normalized, or why it isn't a mod. */
export function parseMod(json: unknown): { mod: Mod } | { error: string } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "That isn't a Rune Browser mod." };
  const raw = json as Record<string, unknown>;
  if (raw.format !== MOD_FORMAT) return { error: "That isn't a Rune Browser mod (its format isn't rune-mod)." };
  if (raw.version !== 1)
    return { error: "This mod was made by a newer Rune Browser. Update Rune Browser to install it." };
  const id = text(raw.id, 64).toLowerCase();
  if (!MOD_ID.test(id)) return { error: "The mod's id is missing or invalid." };
  const name = text(raw.name, 80);
  if (!name) return { error: "The mod has no name." };
  const changes = Array.isArray(raw.pageChanges) ? raw.pageChanges : [];
  if (changes.length > MOD_MAX_CHANGES) return { error: `A mod has at most ${MOD_MAX_CHANGES} page changes.` };
  const pageChanges: PageChangeSpec[] = [];
  for (const [i, change] of changes.entries()) {
    const problem =
      change && typeof change === "object" ? pageChangeProblem(change as PageChangeSpec) : "it isn't an object";
    if (problem) return { error: `Page change ${i + 1} is invalid: ${problem}` };
    pageChanges.push(pageChangeSpec(change as PageChangeSpec));
  }
  let theme: GlobalTheme | null = null;
  if (raw.theme !== undefined && raw.theme !== null) {
    try {
      theme = decodeTheme(raw.theme);
    } catch (err) {
      return { error: `The theme is invalid: ${err instanceof Error ? err.message.split("\n")[0] : err}` };
    }
  }
  const extensionList = Array.isArray(raw.extensions) ? raw.extensions : [];
  if (extensionList.length > MOD_MAX_EXTENSIONS)
    return { error: `A mod installs at most ${MOD_MAX_EXTENSIONS} extensions.` };
  const extensions: ModExtension[] = [];
  for (const e of extensionList) {
    const ext = (e ?? {}) as Record<string, unknown>;
    const extId = text(ext.id, 32);
    if (!EXTENSION_ID.test(extId)) return { error: "An extension isn't a Chrome Web Store id." };
    if (!extensions.some((x) => x.id === extId)) extensions.push({ id: extId, name: text(ext.name, 80) || extId });
  }
  if (!pageChanges.length && !theme && !extensions.length) return { error: "The mod doesn't change anything." };
  return {
    mod: {
      format: MOD_FORMAT,
      version: 1,
      id,
      name,
      description: text(raw.description, 1000),
      author: text(raw.author, 80) || "Someone",
      modVersion: text(raw.modVersion, 20) || "1",
      pageChanges,
      theme,
      extensions,
    },
  };
}

// --- Review ------------------------------------------------------------------------------

/** What a page change's scope means, for people. */
export function scopeLabel(scope: PageChangeSpec["scope"]) {
  if (scope.type === "page") return scope.value;
  if (scope.type === "site") return scope.value;
  return everywhere(scope) ? "every site" : `pages matching ${scope.value}`;
}

/** A pattern that matches any site: its host part is only wildcards (like "*" or "*.*"). */
const everywhere = (scope: PageChangeSpec["scope"]) => {
  if (scope.type !== "pattern") return false;
  const host =
    scope.value
      .trim()
      .replace(/^(\*|https?):\/\//i, "")
      .split("/")[0] ?? "";
  return !host.replace(/[*.]/g, "");
};

/** Whether a page change can run JavaScript: scripts, buttons, HTML with handlers or script URLs, on* attributes. */
export function runsCode(change: PageChangeSpec) {
  if (change.action === "script" || change.action === "button") return true;
  if (change.action === "insert")
    return /<script|\son[a-z]+\s*=|javascript:|<iframe|<object|<embed/i.test(change.value ?? "");
  if (change.action === "attribute")
    return /^on/i.test(change.name ?? "") || /^\s*javascript:/i.test(change.value ?? "");
  return false;
}

export interface ModReview {
  /** Each thing it changes. */
  changes: { title: string; where: string; what: string; code?: string }[];
  /** What it may do, worst first. */
  permissions: { level: "danger" | "warning" | "info"; text: string }[];
}

const actionLabels: Record<PageChangeSpec["action"], string> = {
  hide: "Hides elements",
  style: "Restyles elements",
  text: "Replaces text",
  attribute: "Sets an attribute",
  insert: "Adds content",
  button: "Adds a button",
  css: "Adds a stylesheet",
  script: "Runs a script",
};

const list = (items: string[]) =>
  items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;

/** What installing a mod does and may do, for the review before installing it. */
export function reviewMod(mod: Mod): ModReview {
  const changes = mod.pageChanges.map((c) => ({
    title: c.title,
    where: scopeLabel(c.scope),
    what: actionLabels[c.action],
    ...(c.action === "script"
      ? { code: c.value }
      : c.action === "button"
        ? { code: c.onClick }
        : runsCode(c)
          ? { code: c.value }
          : {}),
  }));
  const permissions: ModReview["permissions"] = [];
  const codeWhere = [...new Set(mod.pageChanges.filter(runsCode).map((c) => scopeLabel(c.scope)))];
  if (codeWhere.length) {
    permissions.push({
      level: "danger",
      text: `Runs its own JavaScript on ${list(codeWhere)}. It can read and change everything you see and do there, with your logins. Only install it if you trust ${mod.author}.`,
    });
  }
  if (mod.extensions.length) {
    permissions.push({
      level: "warning",
      text: `Installs ${mod.extensions.length === 1 ? "an extension" : `${mod.extensions.length} extensions`} from the Chrome Web Store: ${list(mod.extensions.map((e) => e.name))}. Extensions can read and change the sites they're allowed on; Settings → Extensions shows what each one asks for.`,
    });
  }
  const lookWhere = [...new Set(mod.pageChanges.filter((c) => !runsCode(c)).map((c) => scopeLabel(c.scope)))];
  if (lookWhere.length)
    permissions.push({
      level: "info",
      text: `Changes how ${list(lookWhere)} ${lookWhere.length === 1 ? "looks" : "look"}.`,
    });
  if (mod.theme)
    permissions.push({
      level: "info",
      text: "Changes Rune Browser's theme. Turning the mod off or removing it brings yours back.",
    });
  return { changes, permissions };
}

// --- Share codes ---------------------------------------------------------------------------

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (text: string) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity) {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) throw new Error("The mod is too big");
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A share code for a mod: "RUNE-MOD:" and the compressed JSON. */
export async function encodeShareCode(mod: Mod) {
  const bytes = await pipeThrough(new TextEncoder().encode(JSON.stringify(mod)), new CompressionStream("deflate-raw"));
  return `${SHARE_CODE_PREFIX}${toBase64Url(bytes)}`;
}

/** The JSON in a share code (not checked yet: parseMod). */
export async function decodeShareCode(code: string): Promise<unknown> {
  const body = code.trim().replace(/\s+/g, "");
  if (!body.toUpperCase().startsWith(SHARE_CODE_PREFIX)) throw new Error("That isn't a mod's share code.");
  try {
    const bytes = await pipeThrough(
      fromBase64Url(body.slice(SHARE_CODE_PREFIX.length)),
      new DecompressionStream("deflate-raw"),
      MOD_MAX_BYTES,
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(
      err instanceof Error && err.message === "The mod is too big"
        ? err.message
        : "The share code is damaged (copied only partly?).",
    );
  }
}

export const isShareCode = (text: string) => text.trim().toUpperCase().startsWith(SHARE_CODE_PREFIX);

/** A new mod id from its name (with a random end, so two people's "Dark mode" don't collide). */
export const newModId = (name: string) =>
  `${
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "mod"
  }-${crypto.randomUUID().slice(0, 6)}`;
