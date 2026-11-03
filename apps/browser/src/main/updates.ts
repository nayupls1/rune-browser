// Updates of Rune Browser itself. electron-updater reads the GitHub releases
// (stable ones, or the daily pre-releases too on the daily channel), downloads a newer
// one in the background and installs it when the app quits (or right away
// with "Restart to update"). Only installed builds update: an AppImage, the
// deb/rpm packages, the Windows installer. macOS builds aren't signed yet, and
// unsigned apps can't replace themselves there, so they only link to the
// release (NAT-89).
import { app, ipcMain, type WebContents } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UpdateChannel, UpdateInfo, UpdateStatus } from "../shared/updates";
import { readJson, writeJson } from "./extensions/registry";
import type { AppWindows } from "./windows";

const RELEASES_URL = "https://github.com/nayupls1/rune-browser/releases";
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

/** Why this copy can't update itself, or null if it can. */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return "Updates work in installed builds, not when running from source.";
  if (
    process.platform === "linux" &&
    !process.env.APPIMAGE &&
    !existsSync(join(process.resourcesPath, "package-type"))
  ) {
    return "This build can't update itself. Get the AppImage or a package from the releases page.";
  }
  return null;
}

/** The first line of electron-updater's errors (the rest is response headers); none published yet isn't one. */
function errorStatus(err: unknown): UpdateStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (/No published versions|HttpError: 404/.test(message)) return { state: "idle" };
  return { state: "error", message: (message.split("\n")[0] ?? message).slice(0, 200) };
}

export function setupUpdates(windows: AppWindows) {
  const file = join(app.getPath("userData"), "updates.json");
  let channel: UpdateChannel = readJson<{ channel?: string }>(file)?.channel === "daily" ? "daily" : "stable";
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

  const check = async () => {
    if (reason || status.state === "checking" || status.state === "downloading" || status.state === "ready")
      return info();
    autoUpdater.allowPrerelease = channel === "daily";
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set(errorStatus(err));
    }
    return info();
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
