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
  type CertificateProblem,
  PRIVATE_PARTITION,
  PRIVATE_WORKSPACE,
  WEB_PARTITION,
  WEB_PARTITION_PATTERN,
  webPartition,
} from "../shared/api";
import { join } from "node:path";
import { setupBrowser } from "./browser";
import { setupExtensions } from "./extensions";
import { setupDevtools } from "./devtools";
import { setupNetwork } from "./network";
import { setupOverrides } from "./overrides";
import { setupShortcuts } from "./shortcuts";
import { buildContextMenu } from "./contextMenu";
import type { Observation } from "../shared/endpoints";
import { insecureAction, type InsecurePolicy } from "../shared/insecure";
import type { AppWindows } from "./windows";

const isWebUrl = (url: string) => /^https?:/i.test(url);
/** A local file, opened in a web tab by the user (dropped on Rune Browser, or from a chat). */
const isFileUrl = (url: string) => /^file:\/\//i.test(url);
/** Where Rune Browser serves apps (see the server's runtime). */
const isAppUrl = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/i.test(url);

// Websites get the harmless permissions, and what their site settings allow (camera, location, notifications…).
const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

export function setupWebTabs(windows: AppWindows, onApiCall?: (workspaceId: string, observation: Observation) => void) {
  /** Tells the window a page is in. */
  const sendTo = (contents: WebContents, channel: string, ...args: unknown[]) =>
    windows.of(contents)?.webContents.send(channel, ...args);
  const shortcuts = setupShortcuts(windows);
  // Plain HTTP (shared/insecure.ts): what a page navigates to itself, and redirects, are held
  // back here; the tab (components/WebTab.tsx) tries HTTPS or warns. The windows send the policy.
  let insecurePolicy: InsecurePolicy = { enabled: true, allowed: [] };
  ipcMain.on("rune:insecure-policy", (event, value: unknown) => {
    if (!windows.isUi(event.sender) || !value || typeof value !== "object") return;
    const v = value as { enabled?: unknown; allowed?: unknown };
    insecurePolicy = {
      enabled: v.enabled !== false,
      allowed: Array.isArray(v.allowed) ? v.allowed.filter((h): h is string => typeof h === "string") : [],
    };
  });
  /** Holds back a web tab's navigation to an insecure page; true if it did. The tab's window warns. */
  const holdInsecure = (contents: WebContents, url: string) => {
    if (insecureAction(url, insecurePolicy).kind === "allow") return false;
    sendTo(contents, "rune:insecure", { contentsId: contents.id, url });
    return true;
  };
  const browser = setupBrowser({
    windows,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    isWebSession: (s) => webSessions.has(s),
    rulesChanged: () => extensions.rulesChanged(),
  });
  const extensions = setupExtensions({
    windows,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    workspaceOf: (s) => webSessions.get(s),
    holdInsecure,
    moreRules: (firstId) => browser.rules(firstId),
  });
  /** Websites, and the pages of the extensions running in that session. */
  const isTabUrl = (s: Electron.Session, url: string) => isWebUrl(url) || extensions.isExtensionPage(s, url);
  /** In the background: Ctrl+click and middle click, like in a browser. A new tab opens in the page's window. */
  const openTab = (contents: WebContents, url: string, background = false) =>
    isTabUrl(contents.session, url) && sendTo(contents, "rune:open-tab", url, background);
  const network = setupNetwork({
    windows,
    webSession: (workspaceId) => webSession(webPartition(workspaceId)),
    workspaceOf: (s) => webSessions.get(s),
    applyRules: (rules) => extensions.setNetworkRules(rules),
    // Private windows leave nothing behind, not even the shapes of the APIs their pages call.
    onApiCall: (workspaceId, observation) => workspaceId !== PRIVATE_WORKSPACE && onApiCall?.(workspaceId, observation),
  });

  const overrides = setupOverrides({
    windows,
    workspaceOf: (s) => webSessions.get(s),
    onOverridden: (id, requestId, title) => network.markOverridden(id, requestId, title),
  });

  const devtools = setupDevtools({ windows, isWebTab: (contents) => webSessions.has(contents.session) });

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
        browser.webPreferences(prefs);
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
    if (!isPreview()) {
      extensions.trackGuest(contents);
      browser.trackGuest(contents);
    }
    contents.setWindowOpenHandler(({ url, disposition }) => {
      openTab(contents, url, disposition === "background-tab");
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isPreview() && holdInsecure(contents, url)) return event.preventDefault();
      // App previews stay on the app; links elsewhere open as web tabs.
      if (isPreview() ? isAppUrl(url) : isTabUrl(contents.session, url) || url.startsWith("about:")) return;
      // Local files only when the user opens one (a file dropped on the page), never when a page
      // (or an agent's script in it) navigates there: that would read any file on the computer.
      if (!isPreview() && isFileUrl(url) && !event.initiator) return;
      event.preventDefault();
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
      else openTab(contents, url);
    });
    // A redirect to plain HTTP, whoever started the navigation (the tab, the agent, the page).
    contents.on("will-redirect", (details) => {
      if (details.isMainFrame && !isPreview() && holdInsecure(contents, details.url)) details.preventDefault();
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
      sendTo(contents, "rune:shortcut", { id: direction === "in" ? "zoom.in" : "zoom.out", contentsId: contents.id }),
    );
    contents.on("context-menu", (_event, params) => {
      Menu.buildFromTemplate(contextMenu(contents, params)).popup({ window: windows.of(contents) });
    });
  }

  /** A menu item shows its shortcut (the keys run it from the page, not the menu). */
  const keys = (id: string) => {
    const accelerator = shortcuts.accelerator(id);
    return accelerator ? { accelerator, registerAccelerator: false } : {};
  };

  /** The search engine Settings picked (the renderer sends it), for "Search … for" in the menu. */
  let searchEngine: { label: string; url: string } | undefined;
  ipcMain.on("rune:search-engine", (event, value: unknown) => {
    if (!windows.isUi(event.sender)) return;
    const v = value as { label?: unknown; url?: unknown } | null;
    if (v && typeof v.label === "string" && typeof v.url === "string" && /^https:\/\/.*%s/.test(v.url))
      searchEngine = { label: v.label.slice(0, 60), url: v.url };
  });

  function contextMenu(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
    const history = contents.navigationHistory;
    return buildContextMenu(params, {
      openTab: (url, background) => openTab(contents, url, background),
      openExternal: (url) => void shell.openExternal(url),
      copyText: (text) => clipboard.writeText(text),
      download: (url) => contents.downloadURL(url),
      copyImageAt: (x, y) => contents.copyImageAt(x, y),
      edit: (command) => contents[command](),
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => void contents.session.addWordToSpellCheckerDictionary(word),
      emoji: app.isEmojiPanelSupported() ? () => app.showEmojiPanel() : undefined,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      back: () => history.goBack(),
      forward: () => history.goForward(),
      reload: () => contents.reload(),
      savePage: () => void savePage(contents),
      print: () => contents.print(),
      viewSource: () => openDevTools(contents, "sources"),
      inspect: (x, y) => contents.inspectElement(x, y),
      pageUrl: contents.getURL(),
      search: searchEngine,
      keys,
      extensionItems: extensions.menuItems(contents, params),
    });
  }

  const lockedDown = new WeakSet<Electron.Session>();
  function lockDown(s: Electron.Session) {
    if (lockedDown.has(s)) return;
    lockedDown.add(s);
    // Extension pages also get what their manifest asks for (clipboardRead, notifications), and
    // websites what their site settings allow (Settings → Browser → Site settings).
    const allowed = (permission: string, url: string | undefined, mediaTypes?: readonly string[]) =>
      allowedPermissions.has(permission) ||
      (webSessions.has(s) &&
        (extensions.allowsPermission(s, permission, url) || browser.permission(permission, url, mediaTypes) === true));
    s.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(allowed(permission, details.requestingUrl, "mediaTypes" in details ? details.mediaTypes : undefined)),
    );
    s.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
      allowed(
        permission,
        requestingOrigin,
        "mediaType" in details && details.mediaType && details.mediaType !== "unknown"
          ? [details.mediaType]
          : undefined,
      ),
    );
  }

  /** The session of a workspace's web tabs, set up on first use. Maps to the workspace. */
  const webSessions = new WeakMap<Electron.Session, string>();
  function webSession(partition: string) {
    const s = session.fromPartition(partition);
    if (webSessions.has(s)) return s;
    webSessions.set(
      s,
      partition === PRIVATE_PARTITION
        ? PRIVATE_WORKSPACE
        : partition === WEB_PARTITION
          ? DEFAULT_WORKSPACE
          : partition.slice(WEB_PARTITION.length + 1),
    );
    lockDown(s);
    void extensions.attach(s);
    // A plain Chrome user agent: some sites turn away unknown browsers. Google's
    // sign-in gets Electron's instead (see signInRule).
    s.setUserAgent(webUserAgent());
    browser.setupSession(s);
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
      const win = windows.of(contents);
      if (!win || contents.isDestroyed()) return callback();
      const requestId = String(++authPromptIds);
      const typed = await new Promise<{ username: string; password: string } | null>((resolve) => {
        authPrompts.set(requestId, resolve);
        contents.once("destroyed", () => resolve(null));
        win.webContents.send("rune:auth-prompt", {
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
    if (!windows.isUi(event.sender) || typeof requestId !== "string") return;
    const v = value as { username?: unknown; password?: unknown } | null;
    authPrompts.get(requestId)?.(
      v && typeof v.username === "string" && typeof v.password === "string"
        ? { username: v.username, password: v.password }
        : null,
    );
  });

  // A site's certificate isn't valid: the tab shows "Your connection is not private"
  // (renderer: components/LoadError.tsx), and the user can go on to the site anyway, like
  // in Chrome. That's remembered for the site and certificate in the workspace's session
  // until Rune Browser quits. Pages and agents can't ask for it: only Rune Browser's window.
  const certificateExceptions = new WeakMap<Electron.Session, Set<string>>();
  const certificateProblems = new Map<number, CertificateProblem>();
  const exceptionKey = (url: string, fingerprint: string) => {
    try {
      return `${new URL(url).host} ${fingerprint}`;
    } catch {
      return null;
    }
  };
  app.on("certificate-error", (event, contents, url, error, certificate, callback, isMainFrame) => {
    if (!webSessions.has(contents.session)) return;
    event.preventDefault();
    const key = exceptionKey(url, certificate.fingerprint);
    if (key && certificateExceptions.get(contents.session)?.has(key)) return callback(true);
    if (isMainFrame) {
      if (!certificateProblems.has(contents.id))
        contents.once("destroyed", () => certificateProblems.delete(contents.id));
      certificateProblems.set(contents.id, {
        url,
        error,
        subject: certificate.subjectName,
        issuer: certificate.issuerName,
        validFrom: certificate.validStart * 1000,
        validUntil: certificate.validExpiry * 1000,
        fingerprint: certificate.fingerprint,
      });
    }
    callback(false);
  });
  const guestOf = (event: Electron.IpcMainInvokeEvent, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    return target && target.getType() === "webview" && target.hostWebContents === event.sender ? target : undefined;
  };
  /** The tab's last certificate problem, if it was for the site at `url` (a redirect may have changed the path). */
  const problemFor = (target: WebContents | undefined, url: unknown) => {
    const problem = target && certificateProblems.get(target.id);
    if (!problem || typeof url !== "string") return undefined;
    return exceptionKey(problem.url, "") === exceptionKey(url, "") ? problem : undefined;
  };
  ipcMain.handle(
    "rune:certificate-problem",
    (event, id: unknown, url: unknown) => problemFor(guestOf(event, id), url) ?? null,
  );
  ipcMain.handle("rune:certificate-proceed", (event, id: unknown, url: unknown) => {
    const target = guestOf(event, id);
    const problem = problemFor(target, url);
    if (!target || !problem || !webSessions.has(target.session)) return false;
    const key = exceptionKey(problem.url, problem.fingerprint);
    if (!key) return false;
    const exceptions = certificateExceptions.get(target.session) ?? new Set<string>();
    exceptions.add(key);
    certificateExceptions.set(target.session, exceptions);
    return true;
  });

  // A deleted workspace's cookies, logins and cache go with it.
  ipcMain.handle("rune:clear-workspace", async (event, workspaceId: unknown) => {
    if (!windows.isUi(event.sender) || typeof workspaceId !== "string" || !/^[\w-]+$/.test(workspaceId)) return;
    const s = session.fromPartition(webPartition(workspaceId));
    await extensions.detach(s);
    await s.clearStorageData();
    await s.clearCache();
  });

  // A dropped file the browser can't show is downloaded, like Chrome does.
  ipcMain.on("rune:download", (event, workspaceId: unknown, url: unknown) => {
    if (!windows.isUi(event.sender) || typeof workspaceId !== "string" || !/^[\w-]+$/.test(workspaceId)) return;
    if (typeof url === "string" && (isFileUrl(url) || isWebUrl(url)))
      webSession(webPartition(workspaceId)).downloadURL(url);
  });

  ipcMain.on("rune:open-external", (event, url: unknown) => {
    if (!windows.isUi(event.sender)) return;
    if (typeof url === "string" && isWebUrl(url)) void shell.openExternal(url);
  });

  // DevTools for the user, like Chromium's F12, Ctrl+Shift+J (the console) and Ctrl+Shift+C (picking an element).
  function openDevTools(target: WebContents, panel: unknown) {
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
  }
  ipcMain.on("rune:open-devtools", (event, id: unknown, panel: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) return;
    openDevTools(target, panel);
  });

  ipcMain.handle("rune:save-page", async (event, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!target || target.getType() !== "webview" || target.hostWebContents !== event.sender) return;
    await savePage(target);
  });

  async function savePage(contents: WebContents) {
    const win = windows.of(contents);
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

/** What web tabs tell sites: a plain Chrome user agent (see webSession). */
export const webUserAgent = () => app.userAgentFallback.replace(/ (RuneBrowser|Electron)\/\S+/gi, "");

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
