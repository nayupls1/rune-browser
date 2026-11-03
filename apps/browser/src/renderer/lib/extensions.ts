// Chrome extensions, as the Rune Browser window sees them: the installed list, their
// toolbar buttons, and what they ask of the window. Extensions see the web tabs
// of their workspace as their tabs (by webContents id), so the tab list is
// reported whenever it changes; tabs they open, select or close go through the
// normal tab store.
import { createEffect, createRoot, createSignal } from "solid-js";
import type {
  ExtensionInfo,
  ExtensionPermissionRequest,
  ExtensionPopupRequest,
  ExtensionTabs,
} from "../../shared/extensions";
import { confirmDialog } from "../components/ConfirmDialog";
import {
  apps,
  deleteApp,
  lastTabOf,
  newWebTab,
  openedIds,
  openSettings,
  selectApp,
  selectedId,
  currentWorkspace,
  appById,
  isPrivate,
  sessionWorkspace,
} from "./store";
import { PRIVATE_WORKSPACE } from "../../shared/api";
import { pageOf, pagesVersion, tabOfContents } from "./webtabs";
import { searchEngine } from "./settings";

const bridge = window.rune.extensions;

const [list, setList] = createSignal<ExtensionInfo[]>([]);
const [autoUpdate, setAutoUpdateSignal] = createSignal(true);
export { autoUpdate };
export const extensionList = list;
export const extensionById = (id: string) => list().find((e) => e.id === id);

export async function refreshExtensions() {
  const r = await bridge.list();
  setList(r.extensions);
  setAutoUpdateSignal(r.autoUpdate);
}
bridge.onChanged(() => void refreshExtensions());
void refreshExtensions().catch((err) => console.error("Loading the extensions failed:", err));

// Toolbar buttons change per workspace (badges, icons); toolbars refetch when theirs did.
const [actionsVersions, setActionsVersions] = createSignal<Record<string, number>>({});
export const actionsVersion = (workspaceId: string) => actionsVersions()[workspaceId] ?? 0;
bridge.onActionsChanged((workspaceId) =>
  setActionsVersions((v) => ({ ...v, [workspaceId]: (v[workspaceId] ?? 0) + 1 })),
);

// A popup to open (an extension's shortcut, or chrome.action.openPopup); the visible tab's toolbar shows it.
const [popupRequest, setPopupRequest] = createSignal<ExtensionPopupRequest | null>(null);
export { popupRequest, setPopupRequest };
bridge.onPopup((request) => setPopupRequest(request));

/** Settings → Extensions. */
export function showExtensionSettings() {
  void openSettings("extensions");
}
bridge.onManage(showExtensionSettings);

// --- The tabs extensions see -----------------------------------------------------------

const contentsOf = (tabId: string) => {
  try {
    return pageOf(tabId)?.webContentsId() ?? null;
  } catch {
    return null;
  }
};

createRoot(() => {
  createEffect(() => {
    pagesVersion();
    const opened = new Set(openedIds());
    const selected = selectedId();
    const current = isPrivate ? PRIVATE_WORKSPACE : (currentWorkspace()?.id ?? null);
    const tabs: ExtensionTabs = { workspaces: {}, current, showing: null };
    for (const app of apps) {
      if (app.kind !== "web" || !opened.has(app.id)) continue;
      const id = contentsOf(app.id);
      if (id === null) continue;
      // A private window's tabs are all in the private session's extensions' view.
      const ws = (tabs.workspaces[sessionWorkspace(app)] ??= { tabs: [], active: null });
      ws.tabs.push(id);
      // The selected tab of a workspace: the one on screen, or the last one shown there.
      if (app.id === selected || (ws.active === null && app.id === lastTabOf(app.workspaceId))) ws.active = id;
      if (app.id === selected) tabs.showing = id;
    }
    bridge.setTabs(tabs);
  });
});

/** Waits for a tab's page to have its webContents. */
async function contentsWhenReady(tabId: string, ms = 10_000) {
  for (const start = Date.now(); Date.now() - start < ms;) {
    const id = contentsOf(tabId);
    if (id !== null) return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

bridge.onTabRequest(async (request) => {
  try {
    if (request.action === "open") {
      // chrome.search.query: the search engine from Settings.
      const url = request.search ? searchEngine().url.replace("%s", encodeURIComponent(request.search)) : request.url;
      // The private session's extensions open their tabs in the private window (main sends them there).
      const here = isPrivate
        ? request.workspaceId === PRIVATE_WORKSPACE
        : request.workspaceId === currentWorkspace()?.id;
      const app = await newWebTab(url || undefined, {
        workspaceId: isPrivate ? undefined : request.workspaceId,
        background: !request.active || !here,
      });
      bridge.reply(request.requestId, await contentsWhenReady(app.id));
      return;
    }
    const tabId = tabOfContents(request.tabId);
    if (!tabId || sessionWorkspace(appById(tabId)) !== request.workspaceId)
      return bridge.reply(request.requestId, null);
    if (request.action === "select") await selectApp(tabId);
    else await deleteApp(tabId);
    bridge.reply(request.requestId, request.tabId);
  } catch (err) {
    console.error("An extension's tab request failed:", err);
    bridge.reply(request.requestId, null);
  }
});

// --- Optional permissions (chrome.permissions.request) -----------------------------------

const describePermissions = (request: ExtensionPermissionRequest) => {
  const parts = [...request.permissions];
  for (const origin of request.origins)
    parts.push(origin === "<all_urls>" || origin === "*://*/*" ? "all websites" : origin);
  return parts.join(", ");
};

bridge.onPermissionRequest(async (request) => {
  const ok = await confirmDialog(`${request.name} asks for more access: ${describePermissions(request)}.`, {
    confirmLabel: "Allow",
  });
  bridge.reply(request.requestId, ok);
});
