import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { apiMapReporter } from "./apiMap";
import { startServer, type ServerHandle } from "./server";
import { appUserModelId, taskbarDetails } from "./taskbar";
import { setupUpdates } from "./updates";
import { guardWindow, setupWebTabs } from "./web";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Chromium finds the keyring only on desktops it knows (GNOME, KDE…). Elsewhere
// (Hyprland, Sway…) it would keep the keys of cookies and safeStorage under a
// hardcoded password. Without a Secret Service, encryption is reported as
// unavailable (see secretsKey.ts). KDE's KWallet is found on its own.
if (
  process.platform === "linux" &&
  !app.commandLine.hasSwitch("password-store") &&
  !/kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")
) {
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

// An extension (or anything else) failing in the background is logged instead
// of taking the app down with an error dialog.
process.on("uncaughtException", (err) => console.error("Uncaught error in the main process:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection in the main process:", reason));

// Lets tests run against a throwaway profile instead of the real data.
if (process.env.RUNE_USER_DATA_DIR) app.setPath("userData", process.env.RUNE_USER_DATA_DIR);

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
let mainWindow: BrowserWindow | undefined;
let web: ReturnType<typeof setupWebTabs> | undefined;

// Safe mode: the renderer leaves out the theme and site customizations, so
// whatever broke the UI can be undone in History.
const safeMode = process.argv.includes("--safe-mode") || process.env.RUNE_SAFE_MODE === "1";

function relaunch(safe: boolean) {
  const args = process.argv.slice(1).filter((a) => a !== "--safe-mode");
  app.relaunch({ args: safe ? [...args, "--safe-mode"] : args });
  app.quit();
}

ipcMain.on("rune:relaunch", (event, safe: unknown) => {
  if (event.sender === mainWindow?.webContents) relaunch(safe === true);
});

// A folder of the user's (importing an existing project as an app).
ipcMain.handle("rune:pick-folder", async (event, title: unknown) => {
  const win = mainWindow;
  if (!win || event.sender !== win.webContents) return null;
  const picked = await dialog.showOpenDialog(win, {
    title: typeof title === "string" ? title.slice(0, 200) : "Choose a folder",
    properties: ["openDirectory"],
  });
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});

// The window's buttons (drawn by the renderer when there's no frame) and double-clicking a top bar.
ipcMain.on("rune:window", (event, action: unknown) => {
  const win = mainWindow;
  if (!win || event.sender !== win.webContents) return;
  if (action === "minimize") win.minimize();
  else if (action === "close") win.close();
  else if (action === "toggle-fullscreen") win.setFullScreen(!win.isFullScreen());
  else if (action === "quit") app.quit();
  else if (action === "toggle-maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
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

function createWindow(server: ServerHandle) {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    // The window and taskbar icon (Windows wants an .ico; the packaged app's executable has one too).
    icon: join(distDir, "electron", process.platform === "win32" ? "icon.ico" : "icon.png"),
    // No title bar (like Chrome). macOS keeps its traffic lights (top left); elsewhere the
    // window is frameless and the renderer draws minimize, maximize and close (top right).
    // Its top bars are where the window is dragged (lib/windowChrome.ts).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 16 } }
      : { frame: false }),
    webPreferences: {
      preload: join(distDir, "electron/preload.cjs"),
      additionalArguments: [
        `--rune-server-url=${server.url}`,
        `--rune-token=${server.token}`,
        ...(safeMode ? ["--rune-safe-mode=1"] : []),
        ...(process.env.RUNE_OFFSCREEN === "1" ? ["--rune-offscreen=1"] : []),
      ],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Web tabs are <webview> guests (locked down in web.ts).
      webviewTag: true,
      // Agent runs stream into the window while it's in the background.
      backgroundThrottling: false,
      // Tests render without a visible window (always painted, nothing pops up).
      offscreen: process.env.RUNE_OFFSCREEN === "1",
    },
  });

  win.once("ready-to-show", () => {
    if (process.env.RUNE_OFFSCREEN !== "1") win.show();
  });

  mainWindow = win;
  const sendMaximized = () => win.webContents.send("rune:maximized", win.isMaximized());
  win.on("maximize", sendMaximized);
  win.on("unmaximize", sendMaximized);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  guardWindow(win, rendererOrigin, (input) => web?.windowInput(input) ?? false);
  // The window's page crashed (out of memory, a GPU or renderer bug): it comes back, a few times at most.
  let crashes: number[] = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    console.error("The window's page is gone:", details.reason);
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (crashes.length <= 3) win.webContents.reload();
  });
  // Works even when the UI itself is unusable.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && input.alt && input.shift && input.key.toLowerCase() === "s") {
      event.preventDefault();
      relaunch(true);
    }
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL(`${APP_SCHEME}://${APP_HOST}/`);
  }
}

app.whenReady().then(async () => {
  if (!devServerUrl) registerAppProtocol();
  web = setupWebTabs(
    () => mainWindow,
    apiMapReporter(() => server),
  );
  setupUpdates(() => mainWindow);

  try {
    server = await startServer(rendererOrigin);
  } catch (err) {
    dialog.showErrorBox("Rune Browser", `Failed to start the backend server:\n\n${err}`);
    app.exit(1);
    return;
  }

  createWindow(server);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) createWindow(server);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => server?.stop());
