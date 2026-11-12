// Starting Rune Browser in the background when the user signs in (Settings →
// General → System → Open at login, main/background.ts). macOS and Windows have
// login items (app.setLoginItemSettings); Linux desktops start what's in the
// XDG autostart folder (~/.config/autostart), so a .desktop file goes there.
// Either way it starts with BACKGROUND_ARG: no window, only what runs in the
// background (the push connection, the server).
import { posix } from "node:path";
import { LINUX_DESKTOP_FILE } from "../shared/defaultBrowser";
import { desktopExecArg } from "./links";
import type { XdgDirs } from "./mimeapps";

/** Started without a window (at login): only what runs in the background. */
export const BACKGROUND_ARG = "--background";

/** The autostart file's name (the same as the installed .desktop file's, which desktops show it by). */
export const AUTOSTART_FILE = LINUX_DESKTOP_FILE;

/** Where the autostart file goes: the user's autostart folder (XDG Autostart). */
export const autostartPath = (dirs: Pick<XdgDirs, "configHome">) =>
  posix.join(dirs.configHome, "autostart", AUTOSTART_FILE);

/**
 * What starts Rune Browser: the AppImage (the file the user has, not where it's mounted), the installed app, or
 * Electron with the app's folder (a run from the repo).
 */
export function launchCommand(o: { packaged: boolean; execPath: string; appPath: string; appImage?: string }) {
  if (o.appImage) return [o.appImage];
  return o.packaged ? [o.execPath] : [o.execPath, o.appPath];
}

/**
 * The autostart .desktop file: Rune Browser in the background. `X-Rune-Autostart` marks it as Rune Browser's own (a
 * file the user wrote there themselves isn't replaced or removed).
 */
export function autostartDesktopEntry(o: { command: readonly string[]; icon: string }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Rune Browser",
    "Comment=Keeps notifications from closed tabs arriving",
    `Exec=${[...o.command.map(desktopExecArg), BACKGROUND_ARG].join(" ")}`,
    `Icon=${o.icon}`,
    "Terminal=false",
    "StartupWMClass=rune-browser",
    "X-GNOME-Autostart-enabled=true",
    "X-Rune-Autostart=true",
    "",
  ].join("\n");
}

/** Whether an autostart file is Rune Browser's own (written by autostartDesktopEntry). */
export const isOwnAutostart = (text: string) => /^X-Rune-Autostart=true$/m.test(text);

/** Login item settings for macOS and Windows (app.setLoginItemSettings): Windows passes BACKGROUND_ARG. */
export function loginItemSettings(o: { openAtLogin: boolean; packaged: boolean; execPath: string; appPath: string }) {
  const [path, ...args] = launchCommand(o);
  return {
    openAtLogin: o.openAtLogin,
    // Windows only (macOS says wasOpenedAtLogin instead): the arguments are quoted, as its run key needs.
    path: path!,
    args: [...args.map((a) => `"${a}"`), BACKGROUND_ARG],
  };
}
