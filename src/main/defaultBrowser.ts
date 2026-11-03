// Rune Browser as the system's default browser. The installers register it as
// a browser (electron-builder.yml, build/installer.nsh), so it's offered for
// links and web files; here it becomes one copy that takes them: a link opened
// while it runs (a second launch) goes to the running window as a new tab, and
// so do links and files it's started with. Settings shows whether it's the
// default and makes it the default (each system has its own way).
import { app, ipcMain, shell, type BrowserWindow, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  LINUX_DEFAULT_TYPES,
  LINUX_DESKTOP_FILE,
  LINUX_MIME_TYPES,
  WEB_SCHEMES,
  WINDOWS_REGISTERED_NAME,
  type DefaultBrowserStatus,
} from "../shared/defaultBrowser";
import { appImageDesktopEntry, desktopExecArg, linksFromArgs, webLink, withoutLinks } from "./links";

const run = promisify(execFile);

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** What a second launch hands to the running copy (Windows changes the argv it reports itself). */
interface LaunchData {
  argv: string[];
  cwd: string;
}

/**
 * Makes this the one running copy of Rune Browser (for its profile). False if
 * another one runs: it got this launch's links and this copy should quit.
 */
export function claimSingleInstance() {
  return app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() } satisfies LaunchData);
}

/** This launch's arguments for a restart, without the links it was started with (they're open already). */
export const restartArgs = () => withoutLinks(process.argv.slice(1), process.cwd(), isFile);

/**
 * Opens links from other apps in the window as new tabs: the ones it was
 * started with once the window is ready, later ones right away (a second
 * launch, macOS' open-url and open-file events). `showWindow` brings up a
 * window when there's none (macOS keeps running without one).
 */
export function setupLinks(options: { getWindow: () => BrowserWindow | undefined; showWindow: () => void }) {
  const pending = linksFromArgs(process.argv, process.cwd(), isFile);
  /** The window's page, once it has loaded and takes links (lib/webtabs.ts). */
  let ready: WebContents | undefined;
  const offscreen = process.env.RUNE_OFFSCREEN === "1";
  /** Quitting: a link then mustn't bring up a new window (the server is stopping). */
  let quitting = false;
  app.on("before-quit", () => (quitting = true));

  const flush = () => {
    const win = options.getWindow();
    if (!win || win.webContents !== ready || !pending.length) return;
    win.webContents.send("rune:open-links", pending.splice(0));
  };

  const open = (links: string[]) => {
    pending.push(...links);
    const win = options.getWindow();
    if (!win) return quitting ? undefined : options.showWindow();
    if (!offscreen) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    flush();
  };

  app.on("second-instance", (_event, argv, cwd, data) => {
    const launch = data as Partial<LaunchData> | null;
    const args = Array.isArray(launch?.argv) ? launch.argv.filter((a) => typeof a === "string") : argv;
    open(linksFromArgs(args, typeof launch?.cwd === "string" ? launch.cwd : cwd, isFile));
  });
  // macOS hands links and files over as events (also the ones it's started with).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = webLink(url);
    if (link) open([link]);
  });
  app.on("open-file", (event, path) => {
    event.preventDefault();
    open(linksFromArgs(["--", path], process.cwd(), isFile));
  });

  const fromWindow = (sender: WebContents) => sender === options.getWindow()?.webContents;
  app.on("browser-window-created", (_event, win) => {
    // A reload: the page takes links again once it says so (not for loads inside it: pages, popups).
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && ready === win.webContents) ready = undefined;
    });
  });
  ipcMain.on("rune:links-ready", (event) => {
    if (!fromWindow(event.sender)) return;
    ready = event.sender;
    flush();
  });

  ipcMain.handle("rune:default-browser-get", (event) => (fromWindow(event.sender) ? defaultBrowserStatus() : null));
  ipcMain.handle("rune:default-browser-make", async (event) => {
    if (!fromWindow(event.sender)) return null;
    await makeDefaultBrowser().catch((err) => console.warn("Making Rune Browser the default browser failed:", err));
    return defaultBrowserStatus();
  });

  refreshAppImageEntry();
}

// --- Whether it's the default, and making it the default -------------------------------

const dataHome = () => process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
/** Where an AppImage's .desktop file goes (it installs none itself). */
const appImageEntryPath = () => join(dataHome(), "applications", LINUX_DESKTOP_FILE);

/** The installed .desktop file, if there is one. */
function linuxDesktopEntry() {
  const dirs = [dataHome(), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
  return dirs.map((dir) => join(dir, "applications", LINUX_DESKTOP_FILE)).find((path) => existsSync(path));
}

export async function defaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  if (!app.isPackaged) {
    return {
      state: "unsupported",
      reason: "Rune Browser can be the default browser when it's installed, not when it runs from source.",
    };
  }
  if (process.platform === "win32") {
    const handler = await app.getApplicationInfoForProtocol("https://").catch(() => null);
    const isDefault = !!handler && handler.path.toLowerCase() === process.execPath.toLowerCase();
    return isDefault ? { state: "default" } : { state: "not-default", how: "settings" };
  }
  if (process.platform === "darwin") {
    return app.isDefaultProtocolClient("https") ? { state: "default" } : { state: "not-default", how: "confirm" };
  }
  if (!process.env.APPIMAGE && !linuxDesktopEntry()) {
    return { state: "unsupported", reason: `Rune Browser's ${LINUX_DESKTOP_FILE} file isn't installed.` };
  }
  const current = await run("xdg-mime", ["query", "default", "x-scheme-handler/https"]).catch(() => null);
  if (!current) return { state: "unsupported", reason: "Choosing the default browser needs xdg-utils (xdg-mime)." };
  return current.stdout.trim() === LINUX_DESKTOP_FILE ? { state: "default" } : { state: "not-default", how: "direct" };
}

async function makeDefaultBrowser() {
  if (!app.isPackaged) return;
  if (process.platform === "win32") {
    // Windows lets only the user choose: its settings, at Rune Browser's default apps.
    await shell.openExternal(
      `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(WINDOWS_REGISTERED_NAME)}`,
    );
  } else if (process.platform === "darwin") {
    // macOS asks the user to confirm.
    for (const scheme of WEB_SCHEMES) app.setAsDefaultProtocolClient(scheme);
  } else {
    if (process.env.APPIMAGE) writeAppImageEntry(process.env.APPIMAGE);
    await run("xdg-mime", ["default", LINUX_DESKTOP_FILE, ...LINUX_DEFAULT_TYPES]);
  }
}

function writeAppImageEntry(appImage: string) {
  const icon = join(dataHome(), "icons", "rune-browser.png");
  mkdirSync(dirname(icon), { recursive: true });
  writeFileSync(icon, readFileSync(join(app.getAppPath(), "dist", "electron", "icon.png")));
  const entry = appImageEntryPath();
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, appImageDesktopEntry({ appImage, icon, mimeTypes: LINUX_MIME_TYPES }));
  // Menus and "Open with" pick it up (where the tool is installed).
  run("update-desktop-database", [dirname(entry)]).catch(() => {});
}

/** An AppImage that moved (or was updated to a new file) keeps opening the links. */
function refreshAppImageEntry() {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== "linux" || !appImage) return;
  try {
    const entry = readFileSync(appImageEntryPath(), "utf8");
    const exec = `Exec=${desktopExecArg(appImage)} %U\n`;
    if (entry.includes("X-Rune-AppImage=true") && !entry.includes(exec)) writeAppImageEntry(appImage);
  } catch {
    // None written: nothing to follow.
  }
}
