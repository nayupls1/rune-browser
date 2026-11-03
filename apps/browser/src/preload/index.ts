import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { RuneBridge } from "../shared/api";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const listen =
  <T>(channel: string) =>
  (fn: (value: T) => void) => {
    const handler = (_event: unknown, value: T) => fn(value);
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
  };

const bridge: RuneBridge = {
  serverUrl: arg("rune-server-url"),
  token: arg("rune-token"),
  safeMode: arg("rune-safe-mode") === "1",
  offscreen: arg("rune-offscreen") === "1",
  relaunch: (safeMode) => ipcRenderer.send("rune:relaunch", safeMode),
  window: {
    platform: process.platform,
    minimize: () => ipcRenderer.send("rune:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("rune:window", "toggle-maximize"),
    close: () => ipcRenderer.send("rune:window", "close"),
    discard: () => ipcRenderer.send("rune:window", "discard"),
    toggleFullScreen: () => ipcRenderer.send("rune:window", "toggle-fullscreen"),
    quit: () => ipcRenderer.send("rune:window", "quit"),
    onMaximized: listen("rune:maximized"),
    id: arg("rune-window"),
    private: arg("rune-private") === "1",
    takeIntent: () => ipcRenderer.invoke("rune:window-intent"),
    open: (options) => ipcRenderer.invoke("rune:window-open", options ?? {}),
    others: () => ipcRenderer.invoke("rune:window-others"),
    focus: (windowId) => ipcRenderer.send("rune:window-focus", windowId),
    closed: () => ipcRenderer.invoke("rune:window-closed"),
    reopen: (windowId) => ipcRenderer.invoke("rune:window-reopen", windowId),
  },
  pickFolder: (title) => ipcRenderer.invoke("rune:pick-folder", title),
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  internals: {
    version: () => ipcRenderer.invoke("rune:internals-version"),
    gpu: () => ipcRenderer.invoke("rune:internals-gpu"),
    flags: () => ipcRenderer.invoke("rune:internals-flags"),
    setFlag: (id, value) => ipcRenderer.invoke("rune:internals-set-flag", id, value),
    resetFlags: () => ipcRenderer.invoke("rune:internals-reset-flags"),
  },
  updates: {
    get: () => ipcRenderer.invoke("rune:updates-get"),
    check: () => ipcRenderer.invoke("rune:updates-check"),
    setChannel: (channel) => ipcRenderer.invoke("rune:updates-set-channel", channel),
    install: () => ipcRenderer.send("rune:updates-install"),
    onChanged: listen("rune:updates-changed"),
  },
  defaultBrowser: {
    get: () => ipcRenderer.invoke("rune:default-browser-get"),
    make: () => ipcRenderer.invoke("rune:default-browser-make"),
  },
  browser: {
    setSettings: (settings) => ipcRenderer.send("rune:browser-settings", settings),
    clearData: (workspaceIds, what) => ipcRenderer.invoke("rune:browser-clear-data", workspaceIds, what),
    siteData: (workspaceId) => ipcRenderer.invoke("rune:browser-site-data", workspaceId),
    clearSite: (workspaceIds, site) => ipcRenderer.invoke("rune:browser-clear-site", workspaceIds, site),
    detectImports: () => ipcRenderer.invoke("rune:browser-import-detect"),
    info: () => ipcRenderer.invoke("rune:browser-info"),
  },
  downloads: {
    list: () => ipcRenderer.invoke("rune:downloads-list"),
    act: (id, action) => ipcRenderer.invoke("rune:downloads-act", id, action),
    clear: () => ipcRenderer.invoke("rune:downloads-clear"),
    onChanged: listen("rune:downloads-changed"),
  },
  web: {
    clearWorkspace: (workspaceId) => ipcRenderer.invoke("rune:clear-workspace", workspaceId),
    onOpenTab: (fn) => {
      const handler = (_event: unknown, url: string, background?: boolean) => fn(url, background === true);
      ipcRenderer.on("rune:open-tab", handler);
      return () => void ipcRenderer.removeListener("rune:open-tab", handler);
    },
    onOpenLinks: listen("rune:open-links"),
    linksReady: () => ipcRenderer.send("rune:links-ready"),
    onShortcut: listen("rune:shortcut"),
    setShortcuts: (bindings) => ipcRenderer.send("rune:shortcuts", bindings),
    openDevTools: (webContentsId, panel) => ipcRenderer.send("rune:open-devtools", webContentsId, panel),
    savePage: (webContentsId) => ipcRenderer.invoke("rune:save-page", webContentsId),
    capture: (webContentsId) => ipcRenderer.invoke("rune:capture", webContentsId),
    openExternal: (url) => ipcRenderer.send("rune:open-external", url),
    pathForFile: (file) => webUtils.getPathForFile(file),
    download: (workspaceId, url) => ipcRenderer.send("rune:download", workspaceId, url),
    devtools: (webContentsId, command, params) => ipcRenderer.invoke("rune:devtools", webContentsId, command, params),
    network: {
      list: (webContentsId, filter) => ipcRenderer.invoke("rune:network-list", webContentsId, filter),
      get: (webContentsId, id, reveal) => ipcRenderer.invoke("rune:network-get", webContentsId, id, reveal),
      clear: (webContentsId) => ipcRenderer.invoke("rune:network-clear", webContentsId),
      use: (webContentsId, id, chat) => ipcRenderer.invoke("rune:network-use", webContentsId, id, chat),
      replay: (target, overrides, reveal) => ipcRenderer.invoke("rune:network-replay", target, overrides, reveal),
      draft: (webContentsId, id) => ipcRenderer.invoke("rune:network-draft", webContentsId, id),
      setRules: (rules) => ipcRenderer.send("rune:network-rules", rules),
      setOverrides: (overrides) => ipcRenderer.send("rune:network-overrides", overrides),
      setRecording: (enabled) => ipcRenderer.send("rune:network-recording", enabled),
      onChanged: listen("rune:network-changed"),
    },
    onAuthPrompt: listen("rune:auth-prompt"),
    setInsecurePolicy: (policy) => ipcRenderer.send("rune:insecure-policy", policy),
    onInsecure: listen("rune:insecure"),
    authReply: (requestId, value) => ipcRenderer.send("rune:auth-reply", requestId, value),
    permissions: {
      pending: () => ipcRenderer.invoke("rune:site-permissions-pending"),
      usage: (webContentsId) => ipcRenderer.invoke("rune:site-permissions-usage", webContentsId),
      reply: (requestId, answer) => ipcRenderer.send("rune:site-permissions-reply", requestId, answer),
      stop: (webContentsId, keys) => ipcRenderer.invoke("rune:site-permissions-stop", webContentsId, keys),
      pickScreen: (requestId, pick) => ipcRenderer.send("rune:screen-pick-reply", requestId, pick),
      openSystemSettings: (kind) => ipcRenderer.send("rune:site-permissions-system-settings", kind),
      onPrompt: listen("rune:site-permission-prompt"),
      onPromptDone: listen("rune:site-permission-prompt-done"),
      onUsage: listen("rune:site-permission-usage"),
      onNotice: listen("rune:site-permission-notice"),
      onScreenPick: listen("rune:screen-pick"),
      onScreenPickDone: listen("rune:screen-pick-done"),
    },
    certificateProblem: (webContentsId, url) => ipcRenderer.invoke("rune:certificate-problem", webContentsId, url),
    proceedAnyway: (webContentsId, url) => ipcRenderer.invoke("rune:certificate-proceed", webContentsId, url),
    setSearchEngine: (engine) => ipcRenderer.send("rune:search-engine", engine),
  },
  extensions: {
    list: () => ipcRenderer.invoke("rune:extensions-list"),
    prepare: (workspaceId) => ipcRenderer.invoke("rune:extensions-prepare", workspaceId),
    actions: (workspaceId, webContentsId) => ipcRenderer.invoke("rune:extensions-actions", workspaceId, webContentsId),
    click: (workspaceId, extensionId) => ipcRenderer.invoke("rune:extensions-click", workspaceId, extensionId),
    actionMenu: (workspaceId, extensionId) =>
      ipcRenderer.invoke("rune:extensions-action-menu", workspaceId, extensionId),
    detectBrowsers: () => ipcRenderer.invoke("rune:extensions-detect"),
    import: (request) => ipcRenderer.invoke("rune:extensions-import", request),
    install: (input) => ipcRenderer.invoke("rune:extensions-install", input),
    loadUnpacked: () => ipcRenderer.invoke("rune:extensions-load-unpacked"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("rune:extensions-set-enabled", id, enabled),
    setAllowPrivate: (id, allowed) => ipcRenderer.invoke("rune:extensions-set-allow-private", id, allowed),
    setPermission: (id, permission, allowed) =>
      ipcRenderer.invoke("rune:extensions-set-permission", id, permission, allowed),
    setPinned: (id, pinned) => ipcRenderer.invoke("rune:extensions-set-pinned", id, pinned),
    remove: (id) => ipcRenderer.invoke("rune:extensions-remove", id),
    setAutoUpdate: (enabled) => ipcRenderer.invoke("rune:extensions-set-auto-update", enabled),
    update: () => ipcRenderer.invoke("rune:extensions-update"),
    setTabs: (tabs) => ipcRenderer.send("rune:extensions-tabs", tabs),
    reply: (requestId, value) => ipcRenderer.send("rune:extensions-reply", requestId, value),
    bookmarksChanged: (change) => ipcRenderer.send("rune:extensions-bookmarks-changed", change),
    onChanged: listen("rune:extensions-changed"),
    onActionsChanged: listen("rune:extensions-actions-changed"),
    onTabRequest: listen("rune:extensions-tab"),
    onPermissionRequest: listen("rune:extensions-permission"),
    onPopup: listen("rune:extensions-popup"),
    onManage: listen("rune:extensions-manage"),
  },
};

contextBridge.exposeInMainWorld("rune", bridge);
