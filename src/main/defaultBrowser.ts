// Rune Browser as the system's default browser. The installers register it as
// a browser (electron-builder.yml, build/installer.nsh), so it's offered for
// links and web files; here it becomes one copy that takes them: a link opened
// while it runs (a second launch) goes to the running window as a new tab, and
// so do links and files it's started with. Settings shows whether it's the
// default and makes it the default (each system has its own way).
import { app, ipcMain, shell, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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
import { defaultFor, mimeappsFiles, withDefault, xdgDirs } from "./mimeapps";
import type { AppWindows } from "./windows";

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
 * Opens links from other apps as new tabs in the window used last (never a
 * private one): the ones it was started with once that window is ready, later
 * ones right away (a second launch, macOS' open-url and open-file events).
 * `showWindow` brings up a normal window when there's none (macOS keeps running
 * without one, and only private windows may be open).
 */
export function setupLinks(options: { windows: AppWindows; showWindow: () => void }) {
  const pending = linksFromArgs(process.argv, process.cwd(), isFile);
  /** The windows' pages that have loaded and take links (lib/webtabs.ts). */
  const ready = new Set<WebContents>();
  const offscreen = process.env.RUNE_OFFSCREEN === "1";
  /** Quitting: a link then mustn't bring up a new window (the server is stopping). */
  let quitting = false;
  app.on("before-quit", () => (quitting = true));

  const flush = () => {
    const win = options.windows.current("normal");
    if (!win || !ready.has(win.webContents) || !pending.length) return;
    win.webContents.send("rune:open-links", pending.splice(0));
  };

  const open = (links: string[]) => {
    pending.push(...links);
    const win = options.windows.current("normal");
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

  const fromWindow = (sender: WebContents) => options.windows.isUi(sender);
  app.on("browser-window-created", (_event, win) => {
    // A reload: the page takes links again once it says so (not for loads inside it: pages, popups).
    const contents = win.webContents;
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) ready.delete(contents);
    });
    contents.once("destroyed", () => ready.delete(contents));
  });
  ipcMain.on("rune:links-ready", (event) => {
    if (!fromWindow(event.sender)) return;
    ready.add(event.sender);
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

/** System tools (xdg-utils, KDE's) are optional: a missing or stuck one just isn't used. */
const tool = (command: string, args: string[]) =>
  run(command, args, { timeout: 10_000 }).then(
    (r) => r.stdout.trim(),
    () => null,
  );

const xdg = () => xdgDirs(process.env, homedir());
/** Where an AppImage's .desktop file goes (it installs none itself). */
const appImageEntryPath = () => join(xdg().dataHome, "applications", LINUX_DESKTOP_FILE);

/** Where a .desktop file is installed (the user's applications first), if it is. */
function desktopEntryPath(desktop: string) {
  const dirs = xdg();
  return [dirs.dataHome, ...dirs.dataDirs]
    .map((dir) => join(dir, "applications", desktop))
    .find((path) => existsSync(path));
}

const readOrNull = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Whether Rune Browser opens web links on this Linux desktop: xdg-utils where
 * it's installed (it knows each desktop's own setting), else the mimeapps.list
 * files, as xdg-open reads them.
 */
async function isLinuxDefault() {
  if ((await tool("xdg-settings", ["check", "default-web-browser", LINUX_DESKTOP_FILE])) === "yes") return true;
  const queried = await tool("xdg-mime", ["query", "default", "x-scheme-handler/https"]);
  if (queried !== null) return queried === LINUX_DESKTOP_FILE;
  const files = mimeappsFiles(xdg()).map(readOrNull);
  return defaultFor(files, "x-scheme-handler/https", (d) => !!desktopEntryPath(d)) === LINUX_DESKTOP_FILE;
}

export async function defaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  if (!app.isPackaged) {
    return {
      state: "unsupported",
      reason: "Available in installed builds, not when running from source.",
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
  if (!process.env.APPIMAGE && !desktopEntryPath(LINUX_DESKTOP_FILE)) {
    return { state: "unsupported", reason: `Rune Browser's ${LINUX_DESKTOP_FILE} file isn't installed.` };
  }
  return (await isLinuxDefault()) ? { state: "default" } : { state: "not-default", how: "direct" };
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
    await makeLinuxDefault();
  }
}

/**
 * Linux has no one place for the default browser, so it's set in all of them:
 * the user's mimeapps.list (and the desktop's own one, which comes first) for
 * links and web pages, which every desktop and xdg-open read; then each
 * desktop's own setting through xdg-settings (GNOME, KDE and the others it knows) and KDE's
 * BrowserApplication, where those tools are installed. An AppImage writes its
 * .desktop file first.
 */
async function makeLinuxDefault() {
  if (process.env.APPIMAGE) writeAppImageEntry(process.env.APPIMAGE);
  const dirs = xdg();
  const files = [
    ...dirs.desktops.map((d) => join(dirs.configHome, `${d}-mimeapps.list`)).filter((path) => existsSync(path)),
    join(dirs.configHome, "mimeapps.list"),
  ];
  for (const link of files) {
    // A mimeapps.list linked from elsewhere (dotfiles, home-manager) is changed where it is.
    const file = existsSync(link) ? realpathSync(link) : link;
    mkdirSync(dirname(file), { recursive: true });
    // Only a missing file starts empty: one that can't be read (another owner) mustn't be replaced
    // by one with only Rune Browser's defaults in it.
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const next = withDefault(current, LINUX_DESKTOP_FILE, LINUX_DEFAULT_TYPES);
    // Whole or not at all: other apps read it at any time.
    writeFileSync(`${file}.rune-tmp`, next);
    renameSync(`${file}.rune-tmp`, file);
  }
  await tool("xdg-settings", ["set", "default-web-browser", LINUX_DESKTOP_FILE]);
  if (dirs.desktops.includes("kde")) {
    const args = ["--file", "kdeglobals", "--group", "General", "--key", "BrowserApplication", LINUX_DESKTOP_FILE];
    if ((await tool("kwriteconfig6", args)) === null) await tool("kwriteconfig5", args);
  }
}

function writeAppImageEntry(appImage: string) {
  const icon = join(xdg().dataHome, "icons", "rune-browser.png");
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
  if (process.platform === "linux" && process.env.APPIMAGE) appImageMoved(process.env.APPIMAGE);
}

/**
 * The AppImage is at another path now (moved, or updated to a file of a new name,
 * main/updates.ts): the .desktop file written for it (if any) opens links with that one.
 */
export function appImageMoved(appImage: string) {
  try {
    const entry = readFileSync(appImageEntryPath(), "utf8");
    const exec = `Exec=${desktopExecArg(appImage)} %U\n`;
    if (entry.includes("X-Rune-AppImage=true") && !entry.includes(exec)) writeAppImageEntry(appImage);
  } catch {
    // None written: nothing to follow.
  }
}
