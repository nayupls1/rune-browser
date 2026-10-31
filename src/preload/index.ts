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
    toggleFullScreen: () => ipcRenderer.send("rune:window", "toggle-fullscreen"),
    quit: () => ipcRenderer.send("rune:window", "quit"),
    onMaximized: listen("rune:maximized"),
  },
  pickFolder: (title) => ipcRenderer.invoke("rune:pick-folder", title),
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  updates: {
    get: () => ipcRenderer.invoke("rune:updates-get"),
    check: () => ipcRenderer.invoke("rune:updates-check"),
    setChannel: (channel) => ipcRenderer.invoke("rune:updates-set-channel", channel),
    install: () => ipcRenderer.send("rune:updates-install"),
    onChanged: listen("rune:updates-changed"),
  },
  web: {
    clearWorkspace: (workspaceId) => ipcRenderer.invoke("rune:clear-workspace", workspaceId),
    onOpenTab: (fn) => {
      const handler = (_event: unknown, url: string, background?: boolean) => fn(url, background === true);
      ipcRenderer.on("rune:open-tab", handler);
      return () => void ipcRenderer.removeListener("rune:open-tab", handler);
    },
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
      replay: (target, overrides, reveal) => ipcRenderer.invoke("rune:network-replay", target, overrides, reveal),
      draft: (webContentsId, id) => ipcRenderer.invoke("rune:network-draft", webContentsId, id),
      setRules: (rules) => ipcRenderer.send("rune:network-rules", rules),
      setOverrides: (overrides) => ipcRenderer.send("rune:network-overrides", overrides),
      setRecording: (enabled) => ipcRenderer.send("rune:network-recording", enabled),
      onChanged: listen("rune:network-changed"),
    },
    onAuthPrompt: listen("rune:auth-prompt"),
    authReply: (requestId, value) => ipcRenderer.send("rune:auth-reply", requestId, value),
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
    setPermission: (id, permission, allowed) =>
      ipcRenderer.invoke("rune:extensions-set-permission", id, permission, allowed),
    setPinned: (id, pinned) => ipcRenderer.invoke("rune:extensions-set-pinned", id, pinned),
    remove: (id) => ipcRenderer.invoke("rune:extensions-remove", id),
    setAutoUpdate: (enabled) => ipcRenderer.invoke("rune:extensions-set-auto-update", enabled),
    update: () => ipcRenderer.invoke("rune:extensions-update"),
    setTabs: (tabs) => ipcRenderer.send("rune:extensions-tabs", tabs),
    reply: (requestId, value) => ipcRenderer.send("rune:extensions-reply", requestId, value),
    onChanged: listen("rune:extensions-changed"),
    onActionsChanged: listen("rune:extensions-actions-changed"),
    onTabRequest: listen("rune:extensions-tab"),
    onPermissionRequest: listen("rune:extensions-permission"),
    onPopup: listen("rune:extensions-popup"),
    onManage: listen("rune:extensions-manage"),
  },
};

contextBridge.exposeInMainWorld("rune", bridge);
