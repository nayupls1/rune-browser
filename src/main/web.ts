// Web tabs and app previews: pages shown in <webview> guests. They get no
// preload and no Node. The web tabs of a workspace share one session (each
// workspace has its own cookies and logins); every app preview gets a session
// of its own (apps all run on 127.0.0.1, and cookies don't separate
// ports). Popups become new tabs, browser shortcuts are forwarded to the Rune Browser
// window, and the renderer can screenshot them and use DevTools on them for
// the agents. Web tab sessions
// run the installed Chrome extensions (see extensions/).
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import {
  APP_PARTITION_PATTERN,
  DEFAULT_WORKSPACE,
  WEB_PARTITION,
  WEB_PARTITION_PATTERN,
  webPartition,
} from "../shared/api";
import { join } from "node:path";
import { setupExtensions } from "./extensions";
import { setupDevtools } from "./devtools";
import { setupNetwork } from "./network";
import { setupOverrides } from "./overrides";
import { setupShortcuts } from "./shortcuts";
import type { Observation } from "../shared/endpoints";

const isWebUrl = (url: string) => /^https?:/i.test(url);
/** A local file, opened in a web tab by the user (dropped on Rune Browser, or from a chat). */
const isFileUrl = (url: string) => /^file:\/\//i.test(url);
/** Where Rune Browser serves apps (see the server's runtime). */
const isAppUrl = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/i.test(url);

// Websites get the harmless permissions only (no camera, location, notifications…).
const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

export function setupWebTabs(
  getWindow: () => BrowserWindow | undefined,
  onApiCall?: (workspaceId: string, observation: Observation) => void,
) {
  const send = (channel: string, ...args: unknown[]) => getWindow()?.webContents.send(channel, ...args);
  const shortcuts = setupShortcuts(getWindow);
  const extensions = setupExtensions({
    getWindow,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    workspaceOf: (s) => webSessions.get(s),
  });
  /** Websites, and the pages of the extensions running in that session. */
  const isTabUrl = (s: Electron.Session, url: string) => isWebUrl(url) || extensions.isExtensionPage(s, url);
  /** In the background: Ctrl+click and middle click, like in a browser. */
  const openTab = (s: Electron.Session, url: string, background = false) =>
    isTabUrl(s, url) && send("rune:open-tab", url, background);
  const network = setupNetwork({
    getWindow,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    workspaceOf: (s) => webSessions.get(s),
    applyRules: (rules) => extensions.setNetworkRules(rules),
    onApiCall,
  });

  const overrides = setupOverrides({
    getWindow,
    workspaceOf: (s) => webSessions.get(s),
    onOverridden: (id, requestId, title) => network.markOverridden(id, requestId, title),
  });

  const devtools = setupDevtools({ getWindow, isWebTab: (contents) => webSessions.has(contents.session) });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, prefs, params) => {
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      const src = params.src ?? "";
      const partition = params.partition ?? "";
      const isWeb = WEB_PARTITION_PATTERN.test(partition);
      const web =
        isWeb &&
        (isWebUrl(src) ||
          isFileUrl(src) ||
          src === "about:blank" ||
          extensions.isExtensionPage(webSession(partition), src));
      const preview = APP_PARTITION_PATTERN.test(partition) && (isAppUrl(src) || src === "about:blank");
      if (!web && !preview) return event.preventDefault();
      if (web) {
        webSession(partition);
        // Extension pages in iframes (password managers' fill-in menus…) get the extension APIs too.
        prefs.nodeIntegrationInSubFrames = true;
      } else lockDown(session.fromPartition(partition));
    });
    if (contents.getType() === "webview") setupGuest(contents);
  });

  function setupGuest(contents: WebContents) {
    const isPreview = () => !webSessions.has(contents.session);
    // Traffic and console of app previews too: their agents debug with them (main/devtools.ts).
    network.watch(contents);
    overrides.track(contents);
    devtools.track(contents);
    if (!isPreview()) extensions.trackGuest(contents);
    contents.setWindowOpenHandler(({ url, disposition }) => {
      openTab(contents.session, url, disposition === "background-tab");
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      // App previews stay on the app; links elsewhere open as web tabs.
      if (isPreview() ? isAppUrl(url) : isTabUrl(contents.session, url) || url.startsWith("about:")) return;
      // Local files only when the user opens one (a file dropped on the page), never when a page
      // (or an agent's script in it) navigates there: that would read any file on the computer.
      if (!isPreview() && isFileUrl(url) && !event.initiator) return;
      event.preventDefault();
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
      else openTab(contents.session, url);
    });
    // The browser's reserved keys first, then the extensions' shortcuts, then the page (which may pass a shortcut on).
    contents.on("before-input-event", (event, input) => {
      const shortcut = shortcuts.match(input);
      if (shortcut?.page === "reserved") {
        if (shortcuts.handlePageInput(contents, input, shortcut)) event.preventDefault();
      } else if (!isPreview() && extensions.handleInput(contents.session, input)) {
        event.preventDefault();
      } else if (shortcut && shortcuts.handlePageInput(contents, input, shortcut)) {
        event.preventDefault();
      }
    });
    contents.on("input-event", (_event, input) => shortcuts.handlePageMouse(contents, input));
    // Ctrl+scroll zooms, like Ctrl+Plus and Minus.
    contents.on("zoom-changed", (_event, direction) =>
      send("rune:shortcut", { id: direction === "in" ? "zoom.in" : "zoom.out", contentsId: contents.id }),
    );
    contents.on("context-menu", (_event, params) => {
      Menu.buildFromTemplate(contextMenu(contents, params)).popup({ window: getWindow() });
    });
  }

  /** A menu item shows its shortcut (the keys run it from the page, not the menu). */
  const keys = (id: string) => {
    const accelerator = shortcuts.accelerator(id);
    return accelerator ? { accelerator, registerAccelerator: false } : {};
  };

  function contextMenu(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [];
    const history = contents.navigationHistory;
    if (params.linkURL && isWebUrl(params.linkURL)) {
      items.push(
        { label: "Open link in new tab", click: () => openTab(contents.session, params.linkURL, true) },
        { label: "Open link in browser", click: () => shell.openExternal(params.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.mediaType === "image" && params.srcURL) {
      items.push(
        { label: "Open image in new tab", click: () => openTab(contents.session, params.srcURL) },
        { label: "Copy image", click: () => contents.copyImageAt(params.x, params.y) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(
        { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { label: "Select all", click: () => contents.selectAll() },
        { type: "separator" },
      );
    } else if (params.selectionText) {
      items.push({ label: "Copy", click: () => contents.copy() }, { type: "separator" });
    }
    const fromExtensions = extensions.menuItems(contents, params);
    if (fromExtensions.length) items.push(...fromExtensions, { type: "separator" });
    items.push(
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack(), ...keys("nav.back") },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward(), ...keys("nav.forward") },
      { label: "Reload", click: () => contents.reload(), ...keys("nav.reload") },
      { type: "separator" },
      { label: "Save as…", click: () => void savePage(contents), ...keys("page.save") },
      { label: "Print…", click: () => contents.print(), ...keys("page.print") },
      { type: "separator" },
      { label: "Open page in browser", click: () => shell.openExternal(contents.getURL()) },
      {
        label: "Inspect element",
        click: () => contents.inspectElement(params.x, params.y),
        ...keys("page.inspect"),
      },
    );
    return items;
  }

  const lockedDown = new WeakSet<Electron.Session>();
  function lockDown(s: Electron.Session) {
    if (lockedDown.has(s)) return;
    lockedDown.add(s);
    // Extension pages also get what their manifest asks for (clipboardRead, notifications).
    const allowed = (permission: string, url: string | undefined) =>
      allowedPermissions.has(permission) || (webSessions.has(s) && extensions.allowsPermission(s, permission, url));
    s.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(allowed(permission, details.requestingUrl)),
    );
    s.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  }

  /** The session of a workspace's web tabs, set up on first use. Maps to the workspace. */
  const webSessions = new WeakMap<Electron.Session, string>();
  function webSession(partition: string) {
    const s = session.fromPartition(partition);
    if (webSessions.has(s)) return s;
    webSessions.set(s, partition === WEB_PARTITION ? DEFAULT_WORKSPACE : partition.slice(WEB_PARTITION.length + 1));
    lockDown(s);
    void extensions.attach(s);
    // A plain Chrome user agent: some sites turn away unknown browsers. Google's
    // sign-in gets Electron's instead (see signInRule).
    s.setUserAgent(app.userAgentFallback.replace(/ (RuneBrowser|Electron)\/\S+/gi, ""));
    return s;
  }

  // A site (or a proxy) asks for a username and password: extensions first (a
  // password manager fills it in), then Rune Browser's own sign-in dialog.
  // Electron would cancel it otherwise. App previews keep that.
  const authPrompts = new Map<string, (value: { username: string; password: string } | null) => void>();
  let authPromptIds = 0;
  app.on("login", (event, contents, details, authInfo, callback) => {
    if (!contents || contents.isDestroyed() || !webSessions.has(contents.session)) return;
    event.preventDefault();
    void (async () => {
      let answer: Awaited<ReturnType<typeof extensions.authRequired>> = null;
      try {
        answer = await extensions.authRequired(contents, details.url, authInfo);
      } catch (err) {
        console.warn("Asking extensions for a sign-in failed:", err);
      }
      if (answer === "cancel") return callback();
      if (answer) return callback(answer.username, answer.password);
      const win = getWindow();
      if (!win || contents.isDestroyed()) return callback();
      const requestId = String(++authPromptIds);
      const typed = await new Promise<{ username: string; password: string } | null>((resolve) => {
        authPrompts.set(requestId, resolve);
        contents.once("destroyed", () => resolve(null));
        send("rune:auth-prompt", {
          requestId,
          url: details.url,
          host: authInfo.host,
          realm: authInfo.realm,
          isProxy: authInfo.isProxy,
          contentsId: contents.id,
        });
      });
      authPrompts.delete(requestId);
      if (typed) callback(typed.username, typed.password);
      else callback();
    })();
  });
  ipcMain.on("rune:auth-reply", (event, requestId: unknown, value: unknown) => {
    if (event.sender !== getWindow()?.webContents || typeof requestId !== "string") return;
    const v = value as { username?: unknown; password?: unknown } | null;
    authPrompts.get(requestId)?.(
      v && typeof v.username === "string" && typeof v.password === "string"
        ? { username: v.username, password: v.password }
        : null,
    );
  });

  // A deleted workspace's cookies, logins and cache go with it.
  ipcMain.handle("rune:clear-workspace", async (event, workspaceId: unknown) => {
    if (event.sender !== getWindow()?.webContents || typeof workspaceId !== "string" || !/^[\w-]+$/.test(workspaceId))
      return;
    const s = session.fromPartition(webPartition(workspaceId));
    await extensions.detach(s);
    await s.clearStorageData();
    await s.clearCache();
  });

  // A dropped file the browser can't show is downloaded, like Chrome does.
  ipcMain.on("rune:download", (event, workspaceId: unknown, url: unknown) => {
    if (event.sender !== getWindow()?.webContents || typeof workspaceId !== "string" || !/^[\w-]+$/.test(workspaceId))
      return;
    if (typeof url === "string" && (isFileUrl(url) || isWebUrl(url)))
      webSession(webPartition(workspaceId)).downloadURL(url);
  });

  ipcMain.on("rune:open-external", (event, url: unknown) => {
    if (event.sender !== getWindow()?.webContents) return;
    if (typeof url === "string" && isWebUrl(url)) void shell.openExternal(url);
  });

  // DevTools for the user, like Chromium's F12, Ctrl+Shift+J (the console) and Ctrl+Shift+C (picking an element).
  ipcMain.on("rune:open-devtools", (event, id: unknown, panel: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) return;
    const show = () => {
      const call =
        panel === "console"
          ? `DevToolsAPI.showPanel("console")`
          : panel === "sources"
            ? `DevToolsAPI.showPanel("sources")`
            : panel === "inspect"
              ? `DevToolsAPI.enterInspectElementMode()`
              : null;
      if (call) void target.devToolsWebContents?.executeJavaScript(`try { ${call} } catch {}`).catch(() => {});
    };
    if (target.isDevToolsOpened()) {
      target.devToolsWebContents?.focus();
      return show();
    }
    target.once("devtools-opened", () => setTimeout(show, 300));
    target.openDevTools();
  });

  ipcMain.handle("rune:save-page", async (event, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) return;
    await savePage(target);
  });

  async function savePage(contents: WebContents) {
    const win = getWindow();
    if (!win) return;
    const name =
      (contents.getTitle() || "page")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim()
        .slice(0, 120) || "page";
    const picked = await dialog.showSaveDialog(win, {
      title: "Save page as",
      defaultPath: join(app.getPath("downloads"), `${name}.html`),
      filters: [
        { name: "Web page, complete", extensions: ["html"] },
        { name: "Web page, HTML only", extensions: ["htm"] },
      ],
    });
    if (picked.canceled || !picked.filePath || contents.isDestroyed()) return;
    // .htm: only the HTML; .html: with its images, styles and scripts in a folder next to it.
    const htmlOnly = picked.filePath.toLowerCase().endsWith(".htm");
    await contents.savePage(picked.filePath, htmlOnly ? "HTMLOnly" : "HTMLComplete").catch((err) => {
      console.warn("Saving the page failed:", err);
    });
  }

  ipcMain.handle("rune:capture", async (event, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) {
      throw new Error("Unknown page");
    }
    const image = await target.capturePage();
    const scaled = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
    return scaled.toJPEG(75).toString("base64");
  });

  return {
    /** A key pressed in the Rune Browser window: an extension's shortcut (for the workspace on screen) runs. */
    windowInput: (input: Input) => extensions.handleInput(null, input),
  };
}

/** Keeps the Rune Browser window on Rune Browser: links open as web tabs instead. */
export function guardWindow(win: BrowserWindow, rendererOrigin: string, onInput?: (input: Input) => boolean) {
  const send = (channel: string, ...args: unknown[]) => win.webContents.send(channel, ...args);
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (isWebUrl(url)) send("rune:open-tab", url, disposition === "background-tab");
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === rendererOrigin) return;
    event.preventDefault();
    if (isWebUrl(url)) send("rune:open-tab", url);
  });
  // Rune Browser's own shortcuts are the renderer's (lib/shortcuts.ts); extensions' come first.
  win.webContents.on("before-input-event", (event, input) => {
    if (onInput?.(input)) event.preventDefault();
  });
}
