// How Windows shows Rune Browser on the taskbar. Windows groups windows by an
// App User Model ID and takes the button's icon (and what a pinned button
// launches) from a shortcut with that ID, else from the window's own details.
// So every window carries them: the installed app's executable (its icon is
// Rune's), and the right icon however it was started (a pin, the unpacked
// build, a shortcut that's gone).
import type { AppDetailsOptions } from "electron";

/** electron-builder.yml's appId: the installer's shortcuts carry it. */
export const APP_USER_MODEL_ID = "dev.runebrowser.app";

/**
 * Runs from the repo (`bun run start`, e2e) are `electron.exe`, with Electron's
 * icon: their own ID keeps them out of the installed app's taskbar button and
 * pins, which would otherwise show (and launch) Electron.
 */
export const DEV_APP_USER_MODEL_ID = `${APP_USER_MODEL_ID}.dev`;

export function appUserModelId(packaged: boolean) {
  return packaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
}

const quote = (arg: string) => `"${arg}"`;

/** A window's taskbar details (BrowserWindow.setAppDetails). */
export function taskbarDetails(o: {
  packaged: boolean;
  /** process.execPath: rune-browser.exe, or electron.exe when unpackaged. */
  execPath: string;
  /** app.getAppPath(): what electron.exe runs when unpackaged. */
  appPath: string;
  /** Rune's .ico, for unpackaged runs (electron.exe has Electron's icon). */
  iconPath: string;
}): AppDetailsOptions {
  return {
    appId: appUserModelId(o.packaged),
    appIconPath: o.packaged ? o.execPath : o.iconPath,
    appIconIndex: 0,
    relaunchCommand: o.packaged ? quote(o.execPath) : `${quote(o.execPath)} ${quote(o.appPath)}`,
    relaunchDisplayName: o.packaged ? "Rune Browser" : "Rune Browser (dev)",
  };
}
