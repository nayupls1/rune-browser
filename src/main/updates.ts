// Updates of Rune Browser itself. electron-updater reads the GitHub releases
// (stable ones, or the daily pre-releases too on the daily channel), downloads a newer
// one in the background and installs it when the app quits (or right away
// with "Restart to update"). Only installed builds update: an AppImage, the
// deb/rpm/pacman packages, the Windows installer. macOS builds aren't signed yet, and
// unsigned apps can't replace themselves there, so they only link to the
// release (NAT-89).
//
// Which release is newest is decided here, not by electron-updater: it takes
// GitHub's latest stable release, or on the daily channel the first daily build in
// the feed, which skipped stable releases and depended on the feed's order. Here
// it's the highest version the channel gets (shared/updates.ts), and the updater
// reads that release's feed (latest*.yml) directly.
import { app, ipcMain, net, type WebContents } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appImageMoved } from "./defaultBrowser";
import {
  defaultChannel,
  releasesNewestFirst,
  tagsFromFeed,
  type UpdateChannel,
  type UpdateInfo,
  type UpdateStatus,
} from "../shared/updates";
import { readJson, writeJson } from "./extensions/registry";
import type { AppWindows } from "./windows";

const RELEASES_URL = "https://github.com/nayupls1/rune-browser/releases";
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

/** Why this copy can't update itself, or null if it can. */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return "Only installed builds update.";
  if (
    process.platform === "linux" &&
    !process.env.APPIMAGE &&
    !existsSync(join(process.resourcesPath, "package-type"))
  ) {
    return "This build can't update itself. Get the AppImage or a package from the releases page.";
  }
  return null;
}

const REPO = "nayupls1/rune-browser";
const RELEASES_TIMEOUT_MS = 30_000;
/** Releases newer than the latest stable one looked at for one that's published (the newest is, unless one is being made or failed). */
const CANDIDATES = 8;

class NotFound extends Error {}

async function fetchText(url: string, accept: string) {
  const response = await net.fetch(url, {
    headers: { Accept: accept },
    cache: "no-store",
    // A stuck connection mustn't leave it checking forever (no later check would start).
    signal: AbortSignal.timeout(RELEASES_TIMEOUT_MS),
  });
  if (response.status === 404) throw new NotFound(`HttpError: 404 for ${url}`);
  if (!response.ok) throw new Error(`HttpError: ${response.status} for ${url}`);
  return response.text();
}

/** The update feed this copy reads, as electron-updater names it (latest.yml, latest-linux.yml…). */
function feedFile() {
  if (process.platform === "win32") return "latest.yml";
  if (process.platform === "darwin") return "latest-mac.yml";
  return process.arch === "x64" ? "latest-linux.yml" : `latest-linux-${process.arch}.yml`;
}

/**
 * The release a channel updates to: the newest one, by version, that's published
 * with this platform's feed. Candidates are GitHub's latest stable release
 * (however many daily builds came after it) and, on the daily channel, the
 * releases in the feed, which also lists tags whose release is still being made
 * or failed: those are skipped. Null if nothing is published.
 */
async function releaseFor(channel: UpdateChannel): Promise<string | null> {
  const [latest, feed] = await Promise.all([
    fetchText(`${RELEASES_URL}/latest`, "application/json")
      .then((text) => (JSON.parse(text) as { tag_name?: unknown }).tag_name)
      .then((tag) => (typeof tag === "string" ? [tag] : []))
      // None published yet.
      .catch((err) => (err instanceof NotFound ? [] : Promise.reject(err))),
    channel === "daily"
      ? fetchText(`${RELEASES_URL}.atom`, "application/atom+xml, application/xml")
          .then((xml) => tagsFromFeed(xml, REPO))
          // Without the feed, the latest stable release is still a candidate.
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);
  let probed = 0;
  for (const tag of releasesNewestFirst([...latest, ...feed], channel)) {
    // GitHub's latest release is published: nothing older needs looking at.
    if (tag === latest[0]) return tag;
    if (probed++ === CANDIDATES) break;
    try {
      await fetchText(`${RELEASES_URL}/download/${encodeURIComponent(tag)}/${feedFile()}`, "*/*");
      return tag;
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
    }
  }
  return latest[0] ?? null;
}

/** The first line of electron-updater's errors (the rest is response headers); none published yet isn't one. */
function errorStatus(err: unknown): UpdateStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (/No published versions|HttpError: 404/.test(message)) return { state: "idle" };
  return { state: "error", message: (message.split("\n")[0] ?? message).slice(0, 200) };
}

export function setupUpdates(windows: AppWindows) {
  const file = join(app.getPath("userData"), "updates.json");
  const saved = readJson<{ channel?: string }>(file)?.channel;
  let channel: UpdateChannel = saved === "daily" || saved === "stable" ? saved : defaultChannel(app.getVersion());
  let checkedAt: string | null = null;
  const reason = unsupportedReason();
  let status: UpdateStatus = reason ? { state: "unsupported", reason } : { state: "idle" };
  const manual = process.platform === "darwin";

  const info = (): UpdateInfo => ({ version: app.getVersion(), channel, checkedAt, status });
  const set = (next: UpdateStatus) => {
    status = next;
    if (next.state !== "checking" && next.state !== "downloading") checkedAt = new Date().toISOString();
    windows.broadcast("rune:updates-changed", info());
  };

  const check = async (): Promise<UpdateInfo> => {
    if (reason || status.state === "checking" || status.state === "downloading" || status.state === "ready")
      return info();
    const checking = channel;
    try {
      set({ state: "checking" });
      const tag = await releaseFor(checking);
      // The channel changed meanwhile: what this check found is for the other one.
      if (channel !== checking) return recheck();
      if (!tag) {
        set({ state: "idle" });
        return info();
      }
      // That release's own feed (latest.yml, latest-linux.yml…) and installers.
      autoUpdater.setFeedURL({
        provider: "generic",
        url: `${RELEASES_URL}/download/${encodeURIComponent(tag)}`,
        // GitHub's file host refuses requests for several ranges at once (differential downloads ask for them).
        useMultipleRangeRequest: false,
      });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set(errorStatus(err));
    }
    return channel !== checking ? recheck() : info();
  };
  /** Checks again for the channel chosen while a check ran (unless that one found an update already). */
  const recheck = (): Promise<UpdateInfo> => {
    if (status.state === "checking") set({ state: "idle" });
    return check();
  };

  if (!reason) {
    autoUpdater.autoDownload = !manual;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
    autoUpdater.on("update-not-available", () => set({ state: "idle" }));
    autoUpdater.on("update-available", (update) =>
      set(
        manual
          ? { state: "available", version: update.version, url: `${RELEASES_URL}/tag/v${update.version}` }
          : { state: "downloading", version: update.version, percent: 0 },
      ),
    );
    autoUpdater.on("download-progress", (progress) => {
      if (status.state === "downloading") set({ ...status, percent: Math.round(progress.percent) });
    });
    autoUpdater.on("update-downloaded", (update) => set({ state: "ready", version: update.version }));
    // An AppImage updated to a file of a new name: the .desktop file written for it follows.
    autoUpdater.on("appimage-filename-updated", (path) => appImageMoved(path));
    autoUpdater.on("error", (err) => set(errorStatus(err)));
    setTimeout(() => void check(), FIRST_CHECK_MS);
    setInterval(() => void check(), CHECK_EVERY_MS);
  }

  const fromWindow = (sender: WebContents) => windows.isUi(sender);
  ipcMain.handle("rune:updates-get", (event) => (fromWindow(event.sender) ? info() : null));
  ipcMain.handle("rune:updates-check", (event) => (fromWindow(event.sender) ? check() : null));
  ipcMain.handle("rune:updates-set-channel", (event, value: unknown) => {
    if (!fromWindow(event.sender) || (value !== "stable" && value !== "daily")) return null;
    channel = value;
    writeJson(file, { channel });
    // A new channel can mean another latest release.
    if (status.state === "idle" || status.state === "error" || status.state === "available") void check();
    return info();
  });
  ipcMain.on("rune:updates-install", (event) => {
    if (fromWindow(event.sender) && status.state === "ready") autoUpdater.quitAndInstall();
  });
}
