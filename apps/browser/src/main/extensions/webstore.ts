// Installing and updating extensions from the Chrome Web Store (or an
// extension's own update server), the way Chrome does: the update protocol
// says which version is current, and the CRX package comes signed.
import { net } from "electron";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "../../shared/extensions";
import { extractZip, parseCrx } from "./crx";
import { readManifest, Registry } from "./registry";

export const WEB_STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";

const chromeVersion = () => process.versions.chrome ?? "152.0.0.0";

const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

/** Downloads, checks and unpacks a CRX into the extension's folder. Returns the folder and version. */
async function downloadCrx(id: string, url: string) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok)
    throw new Error(
      res.status === 204 || res.status === 404
        ? "Not found in the Chrome Web Store"
        : `Download failed (${res.status})`,
    );
  const file = Buffer.from(await res.arrayBuffer());
  if (!file.length) throw new Error("Not found in the Chrome Web Store");
  const crx = parseCrx(file);
  if (crx.id !== id) throw new Error("The download is a different extension");
  const tmp = Registry.installDir(id, "_download");
  rmSync(tmp, { recursive: true, force: true });
  try {
    extractZip(crx.zip, tmp);
    // Like Chrome: the key keeps the ID, the update URL brings updates.
    const manifestFile = join(tmp, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8").replace(/^﻿/, ""));
    if (manifest.theme || manifest.app) throw new Error("Themes and apps aren't supported");
    manifest.key ??= crx.key;
    manifest.update_url ??= WEB_STORE_UPDATE_URL;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const version = readManifest(tmp).version;
    const dir = Registry.installDir(id, version);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { dir, version };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Installs the current version of a Chrome Web Store extension. */
export function downloadFromWebStore(id: string) {
  const x = query({ id, installsource: "ondemand", uc: "" });
  return downloadCrx(
    id,
    `${WEB_STORE_UPDATE_URL}?response=redirect&prodversion=${chromeVersion()}&acceptformat=crx2,crx3&x=${encodeURIComponent(x)}`,
  );
}

export interface UpdateInfo {
  id: string;
  version: string;
  codebase: string;
}

/** Asks an update server which of these extensions have a newer version. */
export async function checkUpdates(
  updateUrl: string,
  extensions: { id: string; version: string }[],
): Promise<UpdateInfo[]> {
  if (!extensions.length || !/^https:\/\//i.test(updateUrl)) return [];
  const params = extensions
    .map((e) => `x=${encodeURIComponent(query({ id: e.id, v: e.version, installsource: "", uc: "" }))}`)
    .join("&");
  const sep = updateUrl.includes("?") ? "&" : "?";
  const res = await net.fetch(
    `${updateUrl}${sep}response=updatecheck&prodversion=${chromeVersion()}&acceptformat=crx2,crx3&${params}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!res.ok) return [];
  const xml = await res.text();
  const found: UpdateInfo[] = [];
  for (const m of xml.matchAll(/<app\b[^>]*\bappid="([a-p]{32})"[^>]*>([\s\S]*?)<\/app>/g)) {
    const check = /<updatecheck\b([^>]*)\/?>/.exec(m[2]!)?.[1] ?? "";
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(check)?.[1];
    const version = attr("version");
    const codebase = attr("codebase")?.replace(/&amp;/g, "&");
    const current = extensions.find((e) => e.id === m[1]);
    if (!current || attr("status") === "noupdate" || !version || !codebase) continue;
    if (compareVersions(version, current.version) > 0 && /^https:\/\//i.test(codebase))
      found.push({ id: m[1]!, version, codebase });
  }
  return found;
}

/** Downloads an update found by `checkUpdates`. */
export const downloadUpdate = (update: UpdateInfo) => downloadCrx(update.id, update.codebase);
