// Mods in the renderer (shared/mods.ts, server: mods/Mods.ts): the installed
// ones, reviewing and installing (the review dialog asks first), sharing as a
// code or a file, and the extensions mods bring, which Electron's main process
// installs and removes.
import { createSignal } from "solid-js";
import { topics } from "../../shared/hub";
import { encodeShareCode, isShareCode, type InstalledMod, type Mod, type ModReview } from "../../shared/mods";
import { api, type ModSource } from "./api";
import { onConnected, watchTopic } from "./realtime";

const [installed, setInstalled] = createSignal<InstalledMod[]>([]);
export { installed as installedMods };

export const loadMods = () => api.mods().then(setInstalled, (err) => console.error("Loading mods failed:", err));
watchTopic(topics.mods, (msg) => {
  if (msg.type === "mods-changed") void loadMods();
});
onConnected(() => void loadMods());

export const modName = (id: string | null | undefined) =>
  id ? installed().find((m) => m.mod.id === id)?.mod.name : undefined;

// --- Review before installing ---------------------------------------------------------------

export interface PendingReview {
  mod: Mod;
  review: ModReview;
  installed: InstalledMod | null;
  source: string;
  /** How to install exactly what was reviewed. */
  input: ModSource;
}

const [pending, setPending] = createSignal<PendingReview | null>(null);
export { pending as pendingModReview };
export const closeModReview = () => setPending(null);

/** What the user typed or pasted: a share code, a link or JSON. */
export function sourceOf(text: string): ModSource {
  const t = text.trim();
  if (isShareCode(t)) return { code: t };
  if (/^https?:\/\//i.test(t)) return { url: t };
  try {
    return { mod: JSON.parse(t) };
  } catch {
    throw new Error("Paste a mod's share code (RUNE-MOD:…), a link to a mod, or its JSON.");
  }
}

/** Shows the review of a mod; installing happens from there. */
export async function reviewMod(input: ModSource, source?: string) {
  const result = await api.reviewMod(input);
  // What was fetched is what gets installed (a link could answer differently the second time).
  setPending({ ...result, source: source ?? result.source, input: { mod: result.mod } });
}

/** Installs the reviewed mod, then the extensions it brings; returns what failed. */
export async function installReviewed() {
  const review = pending();
  if (!review) return [];
  const mod = await api.installMod({ ...review.input, source: review.source });
  setPending(null);
  const failed = await installExtensions(mod);
  await loadMods();
  return failed;
}

async function installExtensions(installedMod: InstalledMod) {
  const wanted = installedMod.mod.extensions;
  if (!wanted.length) return [];
  const present = new Set((await window.rune.extensions.list()).extensions.map((e) => e.id));
  const added: string[] = [];
  const failed: string[] = [];
  for (const ext of wanted) {
    if (present.has(ext.id)) continue;
    const result = await window.rune.extensions
      .install(ext.id)
      .catch((err: unknown) => ({ installed: [], failed: [{ id: ext.id, name: ext.name, error: String(err) }] }));
    if (result.installed.some((e) => e.id === ext.id)) added.push(ext.id);
    else failed.push(`${ext.name}: ${result.failed[0]?.error ?? "not installed"}`);
  }
  if (added.length) await api.recordModExtensions(installedMod.mod.id, added);
  return failed;
}

// --- Installed mods ------------------------------------------------------------------------

export async function setModEnabled(id: string, enabled: boolean) {
  const mod = await api.setModEnabled(id, enabled);
  for (const ext of mod.installedExtensions) await window.rune.extensions.setEnabled(ext, enabled).catch(() => {});
  await loadMods();
}

export async function removeMod(id: string) {
  const removed = await api.removeMod(id);
  for (const ext of removed.installedExtensions) await window.rune.extensions.remove(ext).catch(() => {});
  await loadMods();
}

// --- Sharing -------------------------------------------------------------------------------

/** Copies a mod's share code; returns it. */
export async function copyShareCode(mod: Mod) {
  const code = await encodeShareCode(mod);
  await navigator.clipboard.writeText(code).catch(() => {});
  return code;
}

/** Saves a mod as a file (it opens in Rune Browser's Mods page, or as a link once it's online). */
export function saveModFile(mod: Mod) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(mod, null, 2)}\n`], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${mod.id}.runemod.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
