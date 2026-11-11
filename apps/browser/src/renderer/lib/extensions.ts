// Chrome extensions, as the Rune Browser window sees them: the installed list, their
// toolbar buttons, and what they ask of the window. Extensions see the web tabs
// of their workspace as their tabs (by webContents id), so the tab list is
// reported whenever it changes; tabs they open, select or close go through the
// normal tab store.
import { createEffect, createRoot, createSignal } from "solid-js";
import type {
  BrowserSettingsChange,
  ExtensionInfo,
  ExtensionPermissionRequest,
  ExtensionPopupRequest,
  ExtensionTabs,
  TtsResult,
  TtsUtterance,
} from "../../shared/extensions";
import { withSiteSetting, type SiteSettingKey } from "../../shared/browser";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";
import { setDownloadsUi } from "./downloads";
import { updateSettings } from "./settings";
import { unloadTab } from "./unload";
import {
  apps,
  closeTab,
  closedTabsOf,
  restoreClosedTab,
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
      if (!opened.has(app.id)) continue;
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

// --- The side panel (chrome.sidePanel): an extension's page beside a workspace's tabs ---------------------

export interface SidePanel {
  workspaceId: string;
  extensionId: string;
  name: string;
  url: string;
}
const [sidePanels, setSidePanels] = createSignal<Record<string, SidePanel>>({});
/** The side panel open in a workspace, if any. */
export const sidePanelOf = (workspaceId: string | undefined) => (workspaceId ? sidePanels()[workspaceId] : undefined);
export function closeSidePanel(workspaceId: string) {
  setSidePanels(({ [workspaceId]: _, ...rest }) => rest);
}

// --- Text to speech (chrome.tts): the window's speech synthesis ---------------------------------------------

const speech = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);
function speak(u: TtsUtterance): Promise<TtsResult> {
  const synth = speech();
  if (!synth) return Promise.resolve({ type: "error", errorMessage: "Speech isn't available here." });
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(u.text);
    if (u.lang) utterance.lang = u.lang;
    if (u.voiceName) {
      const voice = synth.getVoices().find((v) => v.name === u.voiceName);
      if (voice) utterance.voice = voice;
    }
    if (u.rate !== undefined) utterance.rate = Math.min(10, Math.max(0.1, u.rate));
    if (u.pitch !== undefined) utterance.pitch = Math.min(2, Math.max(0, u.pitch));
    if (u.volume !== undefined) utterance.volume = Math.min(1, Math.max(0, u.volume));
    utterance.onend = () => resolve({ type: "end" });
    utterance.onerror = (e) =>
      resolve(
        e.error === "interrupted" || e.error === "canceled"
          ? { type: e.error === "canceled" ? "cancelled" : "interrupted" }
          : { type: "error", errorMessage: e.error },
      );
    synth.speak(utterance);
  });
}

/** The browser settings changed by an extension (contentSettings, privacy, fontSettings). */
function changeBrowserSettings(change: BrowserSettingsChange) {
  updateSettings((s) => {
    let browser = s.browser;
    if (change.kind === "site") browser = withSiteSetting(browser, change.site, change.key, change.value ?? undefined);
    else if (change.kind === "default")
      browser = { ...browser, defaults: { ...browser.defaults, [change.key]: change.value } };
    else if (change.kind === "clear") {
      const sites = Object.fromEntries(
        Object.entries(browser.sites).flatMap(([site, values]) => {
          const rest = Object.fromEntries(
            Object.entries(values).filter(([key]) => !change.keys.includes(key as SiteSettingKey)),
          );
          return Object.keys(rest).length ? [[site, rest]] : [];
        }),
      );
      browser = { ...browser, sites };
    } else if (change.kind === "privacy") {
      const { kind: _, ...privacy } = change;
      browser = { ...browser, privacy: { ...browser.privacy, ...privacy } };
    } else {
      const { kind: _, ...fonts } = change;
      browser = { ...browser, fonts: { ...browser.fonts, ...fonts } };
    }
    return { ...s, browser };
  });
}

/** The fonts installed here (fontSettings.getFontList). */
async function fontList() {
  try {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    const list = query ? await query() : [];
    return [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

bridge.onTabRequest(async (request) => {
  try {
    if (request.action === "closed") return bridge.reply(request.requestId, closedTabsOf(request.workspaceId));
    if (request.action === "restore") {
      const app = await restoreClosedTab(request.workspaceId, request.closedAt);
      return bridge.reply(request.requestId, app ? await contentsWhenReady(app.id) : null);
    }
    if (request.action === "settings") {
      changeBrowserSettings(request.change);
      return bridge.reply(request.requestId, true);
    }
    if (request.action === "speak") return bridge.reply(request.requestId, await speak(request.utterance));
    if (request.action === "tts") {
      const synth = speech();
      if (request.command === "voices")
        return bridge.reply(
          request.requestId,
          (synth?.getVoices() ?? []).map((v) => ({ voiceName: v.name, lang: v.lang, remote: !v.localService })),
        );
      if (request.command === "speaking") return bridge.reply(request.requestId, synth?.speaking ?? false);
      if (request.command === "stop") synth?.cancel();
      else if (request.command === "pause") synth?.pause();
      else synth?.resume();
      return bridge.reply(request.requestId, null);
    }
    if (request.action === "downloads-ui") {
      setDownloadsUi(request.enabled);
      return bridge.reply(request.requestId, null);
    }
    if (request.action === "confirm") {
      const ok = await confirmDialog(request.message, { confirmLabel: request.confirmLabel });
      return bridge.reply(request.requestId, ok);
    }
    if (request.action === "notice") {
      toast({ message: request.message, kind: "info" });
      return bridge.reply(request.requestId, null);
    }
    if (request.action === "font-list") return bridge.reply(request.requestId, await fontList());
    if (request.action === "side-panel") {
      const open = sidePanels()[request.workspaceId];
      if (!request.url || (request.toggle && open?.extensionId === request.extensionId)) {
        if (!request.url && open && open.extensionId !== request.extensionId)
          return bridge.reply(request.requestId, true);
        closeSidePanel(request.workspaceId);
      } else {
        const panel = {
          workspaceId: request.workspaceId,
          extensionId: request.extensionId,
          name: request.name,
          url: request.url,
        };
        setSidePanels((p) => ({ ...p, [request.workspaceId]: panel }));
      }
      return bridge.reply(request.requestId, true);
    }
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
    else if (request.action === "discard") return bridge.reply(request.requestId, await unloadTab(tabId));
    // Closed like a tab the user closes: Ctrl+Shift+T (and chrome.sessions) bring it back.
    else await closeTab(tabId);
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
