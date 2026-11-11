import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { systemOpenAction } from "../shared/web";
import { apiMapReporter } from "./apiMap";
import { describeExitCode, redactPaths } from "./crashReport";
import { setupCrashReports } from "./crashes";
import { claimSingleInstance, restartArgs, setupLinks } from "./defaultBrowser";
import { applyDefaultFeatures, applyFlags } from "./flags";
import { setupInternals } from "./internals";
import { startServer, type ServerHandle } from "./server";
import { appUserModelId, taskbarDetails } from "./taskbar";
import { setupUpdates } from "./updates";
import { useChromeUserAgent } from "./userAgent";
import { guardWindow, setupWebTabs } from "./web";
import { createWindowManager } from "./windows";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Plain Chrome everywhere, extensions' and sites' service workers included (see userAgent.ts).
useChromeUserAgent();

// Chromium finds the keyring only on desktops it knows (GNOME, KDE…). Elsewhere
// (Hyprland, Sway…) it would keep the keys of cookies and safeStorage under a
// hardcoded password. Without a Secret Service, encryption is reported as
// unavailable (see sealKey.ts). KDE's KWallet is found on its own.
if (
  process.platform === "linux" &&
  !app.commandLine.hasSwitch("password-store") &&
  !/kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")
) {
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

// Lets tests run against a throwaway profile instead of the real data.
if (process.env.RUNE_USER_DATA_DIR) app.setPath("userData", process.env.RUNE_USER_DATA_DIR);
// ...and a throwaway downloads folder instead of the user's.
if (process.env.RUNE_DOWNLOADS_DIR) app.setPath("downloads", process.env.RUNE_DOWNLOADS_DIR);

// One copy per profile: launching it again (a link from another app, once it's the
// default browser) hands the links to the running one, which opens them as tabs.
// (process.exit: nothing below may run, the app isn't even ready.)
if (!claimSingleInstance()) {
  console.log("Rune Browser already runs with this profile: opening there instead.");
  process.exit(0);
}

// Crash reports and logs/crashes.log (as early as possible, to catch everything).
const crashes = setupCrashReports();

// An extension (or anything else) failing in the background is logged instead
// of taking the app down with an error dialog.
const survived = (what: string, err: unknown) => {
  console.error(`${what}:`, err);
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  crashes.log(`${what}: ${redactPaths(text, homedir()).split("\n").slice(0, 6).join("\n")}`);
};
process.on("uncaughtException", (err) => survived("Uncaught error in the main process", err));
process.on("unhandledRejection", (reason) => survived("Unhandled rejection in the main process", reason));

// Bun inlines `__dirname` at bundle time, so resolve build output from the app
// root instead (works both unpackaged and inside the packaged asar).
const distDir = join(app.getAppPath(), "dist");

// Windows groups the taskbar button, its icon and notifications by an ID, and
// every window says which icon and command its button (and a pin of it) has.
if (process.platform === "win32") {
  app.setAppUserModelId(appUserModelId(app.isPackaged));
  const details = taskbarDetails({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    iconPath: join(distDir, "electron", "icon.ico"),
  });
  app.on("browser-window-created", (_event, win) => win.setAppDetails(details));
}

// In production the renderer is served from a custom privileged scheme instead
// of file:// so it gets a real origin (needed for CORS against the Bun server).
const APP_SCHEME = "app";
const APP_HOST = "rune";
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : `${APP_SCHEME}://${APP_HOST}`;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let server: ServerHandle | undefined;
let web: ReturnType<typeof setupWebTabs> | undefined;

// Safe mode: the renderer leaves out the theme and site customizations, so
// whatever broke the UI can be undone in History. rune://flags are left out too.
const safeMode = process.argv.includes("--safe-mode") || process.env.RUNE_SAFE_MODE === "1";

// rune://flags, as Chromium switches (before the app is ready).
const appliedFlags = applyFlags(safeMode);
applyDefaultFeatures();

function relaunch(safe: boolean) {
  const args = restartArgs().filter((a) => a !== "--safe-mode");
  app.relaunch({ args: safe ? [...args, "--safe-mode"] : args });
  app.quit();
}

const manager = createWindowManager({
  rendererUrl: devServerUrl ?? `${APP_SCHEME}://${APP_HOST}/`,
  preload: join(distDir, "electron/preload.cjs"),
  // The window and taskbar icon (Windows wants an .ico; the packaged app's executable has one too).
  icon: join(distDir, "electron", process.platform === "win32" ? "icon.ico" : "icon.png"),
  safeMode,
  offscreen: process.env.RUNE_OFFSCREEN === "1",
  onCreated: setupWindow,
});
const { windows } = manager;

// Links and files from other apps (registered before the app is ready: macOS sends the first ones then).
setupLinks({
  windows,
  showWindow: () => {
    if (server) manager.showNormal();
  },
});

ipcMain.on("rune:relaunch", (event, safe: unknown) => {
  if (windows.isUi(event.sender)) relaunch(safe === true);
});

// A folder of the user's (importing an existing project as an app).
ipcMain.handle("rune:pick-folder", async (event, title: unknown) => {
  const win = windows.of(event.sender);
  if (!win || !windows.isUi(event.sender)) return null;
  const picked = await dialog.showOpenDialog(win, {
    title: typeof title === "string" ? title.slice(0, 200) : "Choose a folder",
    properties: ["openDirectory"],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

// Files of the user's to open in tabs (Ctrl+O, like Chromium's "Open file").
ipcMain.handle("rune:pick-files", async (event) => {
  const win = windows.of(event.sender);
  if (!win || !windows.isUi(event.sender)) return [];
  const picked = await dialog.showOpenDialog(win, { title: "Open file", properties: ["openFile", "multiSelections"] });
  return picked.canceled ? [] : picked.filePaths;
});

// A file or folder from the chat (a file link's chip; the server says which paths the chat may show) in the
// system's app, or shown in its folder. Only known document, media and archive types open with their app, and
// plain folders in the file manager; everything else (programs, scripts, macOS bundles, disk images, macro
// documents…) is only shown in its folder: a click in the chat never runs anything. Offscreen (the e2e checks), nothing opens: it only answers.
ipcMain.handle("rune:open-path", async (event, path: unknown, how: unknown) => {
  if (!windows.isUi(event.sender)) return "Not allowed";
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return "Not a path";
  const info = await stat(path).catch(() => null);
  if (!info) return "It was moved or deleted";
  const directory = info.isDirectory();
  if (!directory && !info.isFile()) return "Not a file or folder";
  // A macOS bundle is a folder that launches when opened, whatever its name says.
  const bundle =
    directory &&
    (await access(join(path, "Contents", "Info.plist")).then(
      () => true,
      () => false,
    ));
  const reveal =
    how === "reveal" ||
    systemOpenAction(path, { directory, bundle, mode: process.platform === "win32" ? 0 : info.mode }) === "reveal";
  if (process.env.RUNE_OFFSCREEN === "1") return reveal ? "revealed" : "opened";
  if (reveal) {
    shell.showItemInFolder(path);
    return "revealed";
  }
  const error = await shell.openPath(path);
  return error || "opened";
});

function registerAppProtocol() {
  const root = join(distDir, "renderer");
  protocol.handle(APP_SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
    const target = pathname === "/" || !/\.[a-z0-9]+$/i.test(pathname) ? join(root, "index.html") : file;
    return net.fetch(pathToFileURL(target).toString());
  });
}

/** The backend server crashed: chats, agents and apps stop working until Rune Browser restarts. */
function serverStopped(exit: { code: number | null; signal: string | null; stderr: string[] }) {
  const at = Date.now();
  const how = exit.signal ? `signal ${exit.signal}` : `exit code ${describeExitCode(exit.code)}`;
  crashes.log(
    `The backend server stopped (${how})${exit.stderr.length ? `. Its last output: ${exit.stderr.slice(-15).join("\n")}` : ""}`,
  );
  void crashes.show(windows.current(), {
    title: "Rune Browser's background service stopped",
    message: "Chats, agents and apps won't work until Rune Browser restarts. Your tabs and chats are kept.",
    what: `The backend server stopped unexpectedly (${how})`,
    since: at - 1000,
    action: { label: "Restart Rune Browser", run: () => relaunch(false) },
  });
}

/** What every window gets besides its page (windows.ts): links stay in Rune Browser, crashes and safe mode. */
function setupWindow(win: BrowserWindow) {
  guardWindow(win, rendererOrigin, (input) => web?.windowInput(input) ?? false);
  // The window's page crashed (out of memory, a GPU or renderer bug): it comes back, a few times at most.
  let pageCrashes: number[] = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    console.error("The window's page is gone:", details.reason);
    pageCrashes = [...pageCrashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (pageCrashes.length <= 3) return win.webContents.reload();
    // It keeps crashing: tell the user rather than leave an empty window.
    void crashes.show(win, {
      title: "Rune Browser stopped working",
      message:
        "Rune Browser's window crashed several times in a row. Restarting it in safe mode leaves out themes and site changes, in case one of them is the cause.",
      what: `The window's page crashed ${pageCrashes.length} times in a minute (${details.reason}, exit code ${describeExitCode(details.exitCode)})`,
      since: pageCrashes[0]! - 1000,
      action: { label: "Restart in safe mode", run: () => relaunch(true) },
    });
  });
  // Works even when the UI itself is unusable.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && input.alt && input.shift && input.key.toLowerCase() === "s") {
      event.preventDefault();
      relaunch(true);
    }
  });
  if (devServerUrl) win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(async () => {
  if (!devServerUrl) registerAppProtocol();
  web = setupWebTabs(
    windows,
    apiMapReporter(() => server),
    () => server,
  );
  setupUpdates(windows);
  setupInternals({ windows, appliedFlags, safeMode });

  const failedToStart = (err: unknown) => {
    crashes.log(`The backend server didn't start: ${err}`);
    dialog.showErrorBox("Rune Browser", `Failed to start the backend server:\n\n${err}`);
    crashes.cleanExit();
    app.exit(1);
  };
  try {
    server = await startServer({ allowedOrigin: rendererOrigin, onExit: serverStopped });
    // Linux opens the windows while the server starts (their requests wait for it): starting takes
    // about as long. Elsewhere they wait for it, as Windows' GPU process crashed later on (a CHECK,
    // again and again until Chromium gave up) when its window came up that early; macOS isn't tested.
    if (process.platform !== "linux") await server.ready;
  } catch (err) {
    return failedToStart(err);
  }
  server.ready.catch(failedToStart);

  await manager.start(server);
  const first = windows.current();
  if (first) crashes.checkPreviousRun(first);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) manager.activate();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => server?.stop());
