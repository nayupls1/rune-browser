// Running in the background (Settings → General → System, like Chrome's "Continue running background apps"):
// with the setting on (and push on, `runsInBackground`), closing the last window doesn't quit Rune Browser on
// Windows and Linux. The main process, the server and the push connection keep running, and sites' service workers
// still start for their pushes and show notifications (main/push.ts); the windows and their tabs are gone, so their
// pages free their memory. A tray icon says it's running: a click (or its menu's "Open Rune Browser") brings back
// the window that was closed last, with its tabs, as do launching it again, a link from another app
// (main/defaultBrowser.ts) and a click on a notification. Quitting is the tray menu's Quit, Ctrl+Q, the app menu
// or the system shutting down. macOS keeps apps running without windows anyway: nothing changes there (no tray
// icon, the dock's is there).
//
// "Open at login" starts it in the background when the user signs in (main/autostart.ts): no window, only the
// tray icon (the dock's on macOS). Closing the last private window quits as before, unless Rune Browser already
// ran in the background.
import { app, Menu, nativeImage, powerMonitor, Tray, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runsInBackground, type BrowserSettings } from "../shared/browser";
import {
  AUTOSTART_FILE,
  autostartDesktopEntry,
  autostartPath,
  BACKGROUND_ARG,
  isOwnAutostart,
  launchCommand,
  loginItemSettings,
} from "./autostart";
import { xdgDirs } from "./mimeapps";

export interface BackgroundOptions {
  settings: () => BrowserSettings;
  settingsReady: () => boolean;
  /** The tray icon (an .ico on Windows, a .png elsewhere). */
  icon: string;
  /** The e2e checks: no tray icon, and nothing changes in the user's login items. */
  offscreen: boolean;
  /** Brings back a normal window: the one closed last, with its tabs (or a new one). */
  open: () => void;
}

/**
 * Whether this launch asked to start in the background (at login): BACKGROUND_ARG on Windows and Linux, the login
 * item on macOS. It only does if running in the background is on (index.ts asks once it knows the settings).
 */
export function launchedInBackground() {
  if (process.argv.includes(BACKGROUND_ARG)) return true;
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

export function setupBackground(options: BackgroundOptions) {
  /** Running without a normal window (until one opens). */
  let inBackground = false;
  /** The window closed last was a private one. */
  let lastClosedPrivate = false;
  /** Quitting, or the system is shutting down or signing out: the last window closing quits. */
  let ending = false;
  let tray: Tray | null = null;

  app.on("before-quit", () => (ending = true));
  powerMonitor.on("shutdown", () => {
    ending = true;
    if (inBackground) app.quit();
  });

  function showTray() {
    if (tray || options.offscreen || process.platform === "darwin") return;
    try {
      const image = nativeImage.createFromPath(options.icon);
      // A small image: Linux sends it to the panel over D-Bus (StatusNotifierItem), which scales it anyway.
      tray = new Tray(process.platform === "win32" ? image : image.resize({ width: 32, height: 32 }));
    } catch (err) {
      // No tray on this desktop (GNOME without an extension for it): it runs on without one.
      console.warn("Couldn't show the tray icon:", err);
      return;
    }
    tray.setToolTip("Rune Browser");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Rune Browser", click: () => options.open() },
        { type: "separator" },
        { label: "Quit Rune Browser", click: () => app.quit() },
      ]),
    );
    // Windows (and the Linux panels that send clicks): a click opens it.
    tray.on("click", () => options.open());
  }
  function hideTray() {
    tray?.destroy();
    tray = null;
  }

  // --- Open at login -------------------------------------------------------------------------------

  /** The login item as last put in place (null: not yet this run). */
  let login: boolean | null = null;
  function applyLogin() {
    if (!options.settingsReady()) return;
    const want = options.settings().background.openAtLogin;
    if (want === login) return;
    login = want;
    try {
      if (process.platform === "linux") applyAutostartFile(want);
      // A run from the repo or the e2e checks never becomes a login item (it would be Electron's).
      else if (app.isPackaged && !options.offscreen)
        app.setLoginItemSettings(
          loginItemSettings({
            openAtLogin: want,
            packaged: true,
            execPath: process.execPath,
            appPath: app.getAppPath(),
          }),
        );
    } catch (err) {
      console.warn("Couldn't change whether Rune Browser opens at login:", err);
    }
  }

  /**
   * Linux: the autostart file, written (again, an AppImage may have moved) or removed. A run from the repo writes
   * one only where RUNE_AUTOSTART_DIR says (the e2e checks), never to the user's autostart folder.
   */
  function applyAutostartFile(want: boolean) {
    const testDir = app.isPackaged ? undefined : process.env.RUNE_AUTOSTART_DIR;
    if (!app.isPackaged && !testDir) return;
    const path = testDir ? join(testDir, AUTOSTART_FILE) : autostartPath(xdgDirs(process.env, homedir()));
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    // One the user wrote there themselves is theirs: left alone.
    if (current !== null && !isOwnAutostart(current)) return;
    if (!want) {
      if (current !== null) rmSync(path, { force: true });
      return;
    }
    const entry = autostartDesktopEntry({
      command: launchCommand({
        packaged: app.isPackaged,
        execPath: process.execPath,
        appPath: app.getAppPath(),
        appImage: process.env.APPIMAGE,
      }),
      icon: "rune-browser",
    });
    if (entry === current) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry);
  }

  return {
    /** Whether Rune Browser keeps running once its windows are closed (the settings, as they are now). */
    keepsRunning: () => options.settingsReady() && runsInBackground(options.settings()),
    /** Started in the background: no window until it's opened. */
    startHidden() {
      inBackground = true;
      showTray();
    },
    /** Each window, once it's set up (index.ts). */
    track(win: BrowserWindow, isPrivate: boolean) {
      if (!isPrivate) {
        inBackground = false;
        hideTray();
      }
      win.on("close", () => (lastClosedPrivate = isPrivate));
      // Windows signing out or shutting down closes the windows first.
      win.on("session-end", () => (ending = true));
    },
    /** The last window closed (Windows and Linux): true if Rune Browser keeps running in the background. */
    allClosed() {
      if (ending || !options.settingsReady() || !runsInBackground(options.settings())) return false;
      // Closing the last private window quits, as without background mode (unless it already ran in the background).
      if (lastClosedPrivate && !inBackground) return false;
      inBackground = true;
      showTray();
      return true;
    },
    /** The browser settings arrived or changed: "Open at login" put in place. */
    settingsChanged: applyLogin,
  };
}

export type BackgroundControl = ReturnType<typeof setupBackground>;
