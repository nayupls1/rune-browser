// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one. Everything the server changes
// (agent output, app status, the tab and workspace lists) arrives on the hub.
// Opened tabs of every workspace stay loaded until they're unloaded for being
// idle (lib/unload.ts); the sidebar shows the current workspace's.
import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import type {
  AgentChoice,
  AppMode,
  AppSummary,
  ChatMessage,
  PageContext,
  ProjectInfo,
  ProviderStatus,
  RuntimeStatus,
  SharedTab,
  TabSplit,
  WorkspaceInfo,
} from "../../shared/api";
import type { WorkspaceSettings } from "../../shared/settings";
import { topics } from "../../shared/hub";
import { api } from "./api";
import { attachmentsOf, clearAttachments } from "./attachments";
import { onConnected, watchTopic } from "./realtime";
import { settings } from "./settings";

export interface TabState {
  loaded: boolean;
  messages: ChatMessage[];
  /** Assistant text currently being streamed. */
  draft: string;
  running: boolean;
  /** Who answers in this tab: provider, model and effort. */
  agent: AgentChoice;
  /** Apps: the project (null until the agent set one up) and how it runs. */
  project: ProjectInfo | null;
  runtime: RuntimeStatus | null;
}

/** Pseudo tab ids for Rune Browser's own pages, all shown in Settings (its sidebar lists them). */
export const SETTINGS_VIEW = "settings";
export const ACTIVITY_VIEW = "activity";
export const HISTORY_VIEW = "history";
export const SCHEDULES_VIEW = "schedules";
export const MODS_VIEW = "mods";
const settingsViews = [SETTINGS_VIEW, ACTIVITY_VIEW, HISTORY_VIEW, SCHEDULES_VIEW, MODS_VIEW];
/** Settings or one of the pages in it. */
export const isSettingsView = (id: string | null) => !!id && settingsViews.includes(id);

/** The category Settings shows (SettingsPage.tsx: settingsSections). */
const [settingsSection, setSettingsSection] = createSignal(
  sessionStorage.getItem("rune.settings-section") ?? "appearance",
);
export { settingsSection };
/** Opens Settings, at a category if given (the one last shown otherwise). */
export function openSettings(section?: string) {
  if (section) {
    setSettingsSection(section);
    sessionStorage.setItem("rune.settings-section", section);
  }
  return selectApp(SETTINGS_VIEW);
}

const [apps, setApps] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, TabState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [providers, setProviders] = createSignal<ProviderStatus[]>([]);
const [workspaces, setWorkspaces] = createStore<WorkspaceInfo[]>([]);
const [workspaceId, setWorkspaceId] = createSignal<string | null>(localStorage.getItem("rune.workspace"));

export { apps, providers, selectedId, states, workspaces };

export const appById = (id: string | null) => (id ? apps.find((a) => a.id === id) : undefined);
export const workspaceById = (id: string | null) => (id ? workspaces.find((w) => w.id === id) : undefined);
/** The workspace shown in the sidebar. */
export const currentWorkspace = () => workspaceById(workspaceId()) ?? workspaces[0];
const byPosition = (a: AppSummary, b: AppSummary) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
/** The tabs of the current workspace, in the user's order. */
export const workspaceTabs = () => apps.filter((a) => a.workspaceId === currentWorkspace()?.id).sort(byPosition);
export const isWebTab = (id: string | null) => appById(id)?.kind === "web";
/** Tabs (app or web) as opposed to the Settings page. */
export const isTab = (id: string | null): id is string => !!id && !isSettingsView(id);

// Tabs stay alive (pages, previews, scroll) once opened, until they're
// unloaded (lib/unload.ts) or deleted. Their chat state stays either way.
const [opened, setOpened] = createSignal<string[]>([]);
export const openTabs = () => apps.filter((a) => opened().includes(a.id));
/** When each tab was last on screen (or woken up), for unloading idle ones. */
const lastUsed = new Map<string, number>();
export const lastUsedAt = (id: string) => lastUsed.get(id);
export const markUsed = (id: string, at = Date.now()) => void lastUsed.set(id, at);
const markOpened = (id: string) => {
  if (!isTab(id)) return;
  markUsed(id);
  if (!opened().includes(id)) setOpened([...opened(), id]);
};
/** Whether a tab's page is mounted (unloaded and never opened tabs aren't). */
export const isLoaded = (id: string) => opened().includes(id);
/** Unmounts a tab's page (lib/unload.ts saves its state first). Opening it mounts it again. */
export const unmountTab = (id: string) => setOpened(opened().filter((x) => x !== id));

// Whether the agent sidebar is open, per tab. It's open by default only where
// it's needed: a new app tab, to describe the app. For apps with a project
// it's their mode: open exactly while the app is being edited (dev server),
// and closing it means done (built and started; Rune Browser starts them done).
// Other tabs (web pages) start closed and remember being opened, also across
// restarts, until it's closed again.
const OPEN_KEY = "rune.agentOpen";
localStorage.removeItem("rune.agentCollapsed"); // before: open by default, closed remembered
const [openChoice, setOpenChoice] = createSignal<Record<string, boolean>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    } catch {
      return {};
    }
  })(),
);
/** Open unless chosen otherwise: new app tabs (nothing built yet). */
const openByDefault = (id: string) => appById(id)?.kind === "app" && !states[id]?.project;

/** A mode switch asked for and not answered yet, shown already. */
const [pendingModes, setPendingModes] = createStore<Record<string, AppMode>>({});
const followsMode = (id: string) => appById(id)?.kind === "app" && !!states[id]?.project;
/** The app's mode, including a switch on its way. */
export const appMode = (id: string): AppMode => pendingModes[id] ?? states[id]?.runtime?.mode ?? "dev";

export const isAgentCollapsed = (id: string) =>
  followsMode(id) ? appMode(id) === "live" : !(openChoice()[id] ?? openByDefault(id));

/** Editing (dev server, agent open) or done (built and started, agent hidden). */
export async function setAppMode(id: string, mode: AppMode) {
  if (appMode(id) === mode && states[id]?.runtime?.state !== "stopped" && states[id]?.runtime?.state !== "crashed")
    return;
  setPendingModes(id, mode);
  try {
    setRuntime(id, await api.setMode(id, mode));
  } finally {
    if (pendingModes[id] === mode) setPendingModes(produce((p) => void delete p[id]));
  }
}

export function setAgentCollapsed(id: string, value: boolean) {
  if (followsMode(id))
    return void setAppMode(id, value ? "live" : "dev").catch((err) => console.error("Switching the mode failed:", err));
  const next = { ...openChoice() };
  if (!value === openByDefault(id)) delete next[id];
  else next[id] = !value;
  setOpenChoice(next);
  localStorage.setItem(OPEN_KEY, JSON.stringify(next));
}

export const toggleAgent = (id: string) => setAgentCollapsed(id, !isAgentCollapsed(id));

// --- Providers -------------------------------------------------------------------------

export const providerById = (id: string) => providers().find((p) => p.id === id);

export async function loadProviders() {
  setProviders(await api.providers());
}

export async function refreshProviders(id?: ProviderStatus["id"]) {
  setProviders(await api.refreshProviders(id));
}

watchTopic(topics.providers, (msg) => {
  if (msg.type === "providers") setProviders(msg.providers);
});

/** The agent new tabs start with: the workspace's default, else the one from Settings. */
export const defaultAgent = (workspace = currentWorkspace()): AgentChoice => {
  const { provider, model, effort } = workspace?.settings.agent ?? settings().agent;
  return { provider, model, effort };
};

export function setAgentChoice(id: string, choice: AgentChoice) {
  setStates(id, "agent", choice);
}

// --- Tabs ------------------------------------------------------------------------------

const emptyState = (): TabState => ({
  loaded: false,
  messages: [],
  draft: "",
  running: false,
  agent: defaultAgent(),
  project: null,
  runtime: null,
});

function upsertApp(app: AppSummary) {
  const i = apps.findIndex((a) => a.id === app.id);
  if (i === -1) setApps(apps.length, app);
  else setApps(i, reconcile(app));
}

/** After the selected tab went away (deleted, moved): its neighbour in the workspace, or nothing. */
function selectNeighbour(siblings: AppSummary[], index: number) {
  const next = siblings[Math.min(index, siblings.length - 1)];
  setSelectedId(null);
  if (next) void selectApp(next.id);
}

function forgetApp(id: string) {
  const index = workspaceTabs().findIndex((a) => a.id === id);
  if (!appById(id)) return;
  setApps((list) => list.filter((a) => a.id !== id));
  setOpened(opened().filter((x) => x !== id));
  lastUsed.delete(id);
  watchers.get(id)?.();
  watchers.delete(id);
  setStates(produce((s) => void delete s[id]));
  if (selectedId() === id) selectNeighbour(workspaceTabs(), index);
}

// The tab list changes from elsewhere too (the agent names apps, duplicates…).
watchTopic(topics.apps, (msg) => {
  if (msg.type === "app") upsertApp(msg.app);
  else if (msg.type === "app-deleted") forgetApp(msg.appId);
});
onConnected(
  () =>
    void api.listApps().then(
      (list) => setApps(reconcile(list)),
      () => {},
    ),
);

const addMessage = (id: string, message: ChatMessage) =>
  setStates(
    id,
    produce((s) => {
      if (s.messages.some((m) => m.id === message.id)) return;
      s.messages.push(message);
      if (message.role === "assistant") s.draft = "";
    }),
  );

// Agent output and app status for every loaded tab.
const watchers = new Map<string, () => void>();
function watch(id: string) {
  if (watchers.has(id)) return;
  const stopTopic = watchTopic(topics.app(id), (msg) => {
    if (!states[id]) return;
    if (msg.type === "runtime") {
      setStates(id, "runtime", msg.status);
      // The agent just set up the project.
      if (!states[id].project) void refreshDetail(id);
      return;
    }
    if (msg.type !== "chat") return;
    const event = msg.event;
    if (event.type === "started") setStates(id, { running: true, draft: "" });
    // A scheduled prompt started a chat: the current one went to the earlier chats.
    else if (event.type === "new-chat") setStates(id, { messages: [], draft: "" });
    else if (event.type === "message") addMessage(id, event.message);
    else if (event.type === "delta") setStates(id, "draft", (d) => d + event.text);
    else if (event.type === "done") {
      setStates(id, { running: false, draft: "" });
      // The agent may have set up the project.
      if (appById(id)?.kind === "app") void refreshDetail(id);
    }
  });
  // After a reconnect, refetch: what happened in between wasn't pushed.
  const stopReconnect = onConnected(() => void refreshDetail(id));
  watchers.set(id, () => (stopTopic(), stopReconnect()));
}

async function refreshDetail(id: string) {
  const detail = await api.getApp(id).catch(() => null);
  if (!detail || !states[id]) return;
  setStates(id, {
    messages: detail.messages,
    running: detail.running,
    project: detail.project,
    runtime: detail.runtime,
    ...(detail.running ? {} : { draft: "" }),
  });
}

export async function loadApps() {
  const [spaces, list] = await Promise.all([api.workspaces(), api.listApps()]);
  setWorkspaces(reconcile(spaces));
  setApps(reconcile(list));
  if (!selectedId()) await showWorkspace(currentWorkspace()!.id);
}

export async function selectApp(id: string) {
  // A tab of another workspace (e.g. from a link): its workspace comes along.
  const tab = appById(id);
  if (tab && tab.workspaceId !== currentWorkspace()?.id) setCurrentWorkspace(tab.workspaceId);
  if (tab) rememberTab(tab.workspaceId, id);
  setSelectedId(id);
  // A tab deleted meanwhile (from elsewhere) has nothing to open.
  await openTab(id).catch((err) => console.warn(`Opening tab ${id} failed:`, err));
}

/** Mounts a tab (its page or preview starts) and loads its chat, without selecting it: the other tabs of a split view. */
export async function openTab(id: string) {
  markOpened(id);
  if (!isTab(id) || states[id]?.loaded) return;
  watch(id);
  const detail = await api.getApp(id);
  setStates(id, {
    ...emptyState(),
    loaded: true,
    messages: detail.messages,
    running: detail.running,
    agent: detail.agent ?? defaultAgent(workspaceById(detail.workspaceId)),
    project: detail.project,
    runtime: detail.runtime,
  });
}

function showNewTab(app: AppSummary) {
  upsertApp(app);
  watch(app.id);
  setStates(app.id, { ...emptyState(), loaded: true });
  rememberTab(app.workspaceId, app.id);
  setSelectedId(app.id);
  markOpened(app.id);
}

export async function newApp() {
  const app = await api.createApp({ workspaceId: currentWorkspace()?.id });
  showNewTab(app);
  return app;
}

/**
 * Opens a web tab: the given URL (a website, an extension's page or a local file), or a
 * blank one, like a browser's new tab (the address bar takes the focus, empty).
 * In the current workspace unless another is given; a background tab opens
 * without being shown.
 */
export async function newWebTab(url?: string, options: { workspaceId?: string; background?: boolean } = {}) {
  const app = await api.createApp({
    kind: "web",
    url: url && /^(https?:\/\/|chrome-extension:\/\/|file:\/\/\/)/i.test(url) ? url : undefined,
    workspaceId: options.workspaceId ?? currentWorkspace()?.id,
  });
  if (!options.background) showNewTab(app);
  else {
    upsertApp(app);
    watch(app.id);
    setStates(app.id, { ...emptyState(), loaded: true });
    markOpened(app.id);
  }
  return app;
}

/** The tab last shown in a workspace. */
export const lastTabOf = (workspaceId: string) => lastTabs()[workspaceId];
/** Which tabs are mounted (their pages exist). */
export const openedIds = () => opened();

// Web tab navigation is saved (debounced) so tabs reopen where they were.
const pageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingPages = new Map<string, { url?: string; title?: string; favicon?: string | null }>();
export function updatePage(id: string, page: { url?: string; title?: string; favicon?: string | null }) {
  const app = appById(id);
  if (!app) return;
  const next = { ...pendingPages.get(id), ...page };
  pendingPages.set(id, next);
  // Show it right away; the server decides the name (renamed tabs keep theirs).
  setApps(
    (a) => a.id === id,
    produce((a) => {
      if (page.url !== undefined) a.url = page.url;
      if (page.favicon !== undefined) a.favicon = page.favicon;
    }),
  );
  clearTimeout(pageTimers.get(id));
  pageTimers.set(
    id,
    setTimeout(() => {
      pendingPages.delete(id);
      api.updatePage(id, next).then(upsertApp, () => {});
    }, 400),
  );
}

export async function renameApp(id: string, name: string) {
  upsertApp(await api.renameApp(id, name));
}

/** The tab's own icon (Lucide name, emoji or image data URL), or null for the default. */
export async function setTabIcon(id: string, icon: string | null) {
  upsertApp(await api.setTabIcon(id, icon));
}

/** Pinned tabs are kept loaded. */
export async function setTabPinned(id: string, pinned: boolean) {
  upsertApp(await api.setTabPinned(id, pinned));
}

export async function duplicateApp(id: string) {
  const copy = await api.duplicateApp(id);
  upsertApp(copy); // it goes last
  await selectApp(copy.id);
}

/** Starts a new chat in the tab; the current one is kept and can be opened again (ChatHistory). */
export async function newChat(id: string) {
  const { messages } = await api.newChat(id);
  setStates(id, { messages, draft: "" });
}

/** Makes an earlier chat the current one (the current one is kept). */
export async function openChat(id: string, chatId: number) {
  const { messages } = await api.openChat(id, chatId);
  setStates(id, { messages, draft: "" });
}

export async function deleteApp(id: string) {
  await api.deleteApp(id);
  forgetApp(id);
}

/** Web tabs closed lately, newest last (Ctrl+Shift+T opens the last one again). */
const recentlyClosed: { url: string; workspaceId: string }[] = [];

/**
 * Closes a tab, like in a browser. An app is kept with everything it has
 * (Saved apps in the New tab menu opens it again); a web tab goes, and
 * Ctrl+Shift+T brings it back.
 */
export async function closeTab(id: string) {
  const tab = appById(id);
  if (!tab) return;
  if (tab.kind === "app") await api.closeApp(id);
  else {
    if (tab.url) recentlyClosed.push({ url: tab.url, workspaceId: tab.workspaceId });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    await api.deleteApp(id);
  }
  forgetApp(id);
}

/** The web tab closed last, opened again. */
export async function reopenClosedTab() {
  const last = recentlyClosed.pop();
  if (last)
    await newWebTab(last.url, {
      workspaceId: workspaces.some((w) => w.id === last.workspaceId) ? last.workspaceId : currentWorkspace()?.id,
    });
}

/** Opens an app from the library (closed app tabs) in the current workspace. */
export async function reopenApp(id: string) {
  const workspace = currentWorkspace();
  if (!workspace) return;
  const tab = await api.reopenApp(id, workspace.id);
  upsertApp(tab);
  await selectApp(tab.id);
}

/** Puts the current workspace's tabs in this order: shown right away, then saved. */
export async function reorderTabs(ids: string[]) {
  const workspace = currentWorkspace();
  if (!workspace) return;
  setApps(
    produce((list) => {
      for (const tab of list) {
        const i = ids.indexOf(tab.id);
        if (i !== -1) tab.position = i;
      }
    }),
  );
  try {
    for (const tab of await api.reorderTabs(workspace.id, ids)) upsertApp(tab);
  } catch (err) {
    console.error("Saving the tab order failed:", err);
    setApps(reconcile(await api.listApps()));
  }
}

/** Moves tabs (in this order) before or after another one of their workspace. */
export function moveTabs(moving: string[], targetId: string, side: "before" | "after") {
  if (moving.includes(targetId)) return;
  const ids = workspaceTabs()
    .map((t) => t.id)
    .filter((x) => !moving.includes(x));
  const at = ids.indexOf(targetId);
  if (at === -1) return;
  ids.splice(side === "before" ? at : at + 1, 0, ...moving);
  return reorderTabs(ids);
}

export const moveTab = (id: string, targetId: string, side: "before" | "after") => moveTabs([id], targetId, side);

/** Moves a tab to another workspace. It closes here; web tabs reopen with that workspace's session. */
export async function moveApp(id: string, workspaceId: string) {
  const index = workspaceTabs().findIndex((a) => a.id === id);
  const moved = await api.moveApp(id, workspaceId);
  setOpened(opened().filter((x) => x !== id));
  upsertApp(moved);
  if (selectedId() === id) selectNeighbour(workspaceTabs(), index);
}

// --- Workspaces --------------------------------------------------------------------------

const WORKSPACE_TABS_KEY = "rune.workspaceTabs";
const lastTabs = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_TABS_KEY) ?? "{}");
  } catch {
    return {};
  }
};
function rememberTab(workspaceId: string, tabId: string) {
  localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify({ ...lastTabs(), [workspaceId]: tabId }));
}

function setCurrentWorkspace(id: string) {
  setWorkspaceId(id);
  localStorage.setItem("rune.workspace", id);
}

/** Switches the sidebar to a workspace and opens the tab you were last on there. Open tabs elsewhere keep running. */
export async function showWorkspace(id: string) {
  if (!workspaceById(id)) return;
  setCurrentWorkspace(id);
  const tabs = workspaceTabs();
  const last = lastTabs()[id];
  const tab = tabs.find((a) => a.id === last) ?? tabs[tabs.length - 1];
  if (tab) await selectApp(tab.id);
  else setSelectedId(null);
}

function upsertWorkspace(workspace: WorkspaceInfo) {
  const i = workspaces.findIndex((w) => w.id === workspace.id);
  if (i === -1) setWorkspaces(workspaces.length, workspace);
  else setWorkspaces(i, reconcile(workspace));
}

function forgetWorkspace(id: string) {
  if (!workspaceById(id)) return;
  const wasCurrent = currentWorkspace()?.id === id;
  for (const tab of apps.filter((a) => a.workspaceId === id)) forgetApp(tab.id);
  setWorkspaces((list) => list.filter((w) => w.id !== id));
  if (wasCurrent && workspaces[0]) void showWorkspace(workspaces[0].id);
}

/** Shows a workspace's splits right away (lib/splits.ts saves them). */
export function showSplits(workspaceId: string, splits: TabSplit[]) {
  setWorkspaces((w) => w.id === workspaceId, "splits", reconcile(splits));
}

// Settings being typed are saved shortly after; until then, echoes of older saves are ignored.
const workspaceSaves = new Map<string, ReturnType<typeof setTimeout>>();

/** Edits a workspace's settings: shown right away, saved shortly after. */
export function editWorkspaceSettings(id: string, update: (current: WorkspaceSettings) => WorkspaceSettings) {
  const workspace = workspaceById(id);
  if (!workspace) return;
  const next = update(structuredClone(unwrap(workspace.settings)));
  setWorkspaces((w) => w.id === id, "settings", reconcile(next));
  clearTimeout(workspaceSaves.get(id));
  workspaceSaves.set(
    id,
    setTimeout(() => {
      workspaceSaves.delete(id);
      api.updateWorkspace(id, { settings: next }).catch((err) => console.error("Saving the workspace failed:", err));
    }, 300),
  );
}

watchTopic(topics.workspaces, (msg) => {
  if (msg.type === "workspace") {
    const local = workspaceById(msg.workspace.id);
    upsertWorkspace(
      workspaceSaves.has(msg.workspace.id) && local
        ? { ...msg.workspace, settings: unwrap(local.settings) }
        : msg.workspace,
    );
  } else if (msg.type === "workspace-deleted") forgetWorkspace(msg.workspaceId);
});
onConnected(
  () =>
    void api.workspaces().then(
      (list) => setWorkspaces(reconcile(list)),
      () => {},
    ),
);

export async function createWorkspace(name: string) {
  const workspace = await api.createWorkspace(name);
  upsertWorkspace(workspace);
  await showWorkspace(workspace.id);
}

export async function updateWorkspace(
  id: string,
  fields: { name?: string; icon?: string | null; settings?: WorkspaceSettings },
) {
  upsertWorkspace(await api.updateWorkspace(id, fields));
}

/** Puts the workspaces in this order: shown right away, then saved. */
export async function reorderWorkspaces(ids: string[]) {
  const sorted = [...workspaces].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  setWorkspaces(
    reconcile(
      sorted.map((w) => unwrap(w)),
      { key: "id" },
    ),
  );
  try {
    setWorkspaces(reconcile(await api.reorderWorkspaces(ids), { key: "id" }));
  } catch (err) {
    console.error("Saving the workspace order failed:", err);
    setWorkspaces(reconcile(await api.workspaces(), { key: "id" }));
  }
}

/** Deletes a workspace with its tabs and their data, and clears its web tabs' cookies and storage. */
export async function deleteWorkspace(id: string) {
  await api.deleteWorkspace(id);
  forgetWorkspace(id);
  await window.rune.web
    .clearWorkspace(id)
    .catch((err) => console.error("Clearing the workspace's web data failed:", err));
}

// --- Agent -------------------------------------------------------------------------------

/** Sends a message to the tab's agent; false if it couldn't start (the error is shown in the chat). */
export async function sendPrompt(id: string, prompt: string, page?: PageContext, shared?: SharedTab[]) {
  setStates(id, { running: true, draft: "" });
  // Files pasted or dropped into the composer go with it.
  const files = attachmentsOf(id).map((a) => a.id);
  try {
    await api.chat(id, {
      prompt,
      agent: states[id]!.agent,
      page,
      ...(shared?.length ? { shared } : {}),
      ...(files.length ? { attachments: files } : {}),
    });
    if (files.length) clearAttachments(id);
    return true;
  } catch (err) {
    const message: ChatMessage = {
      id: -Date.now(),
      role: "error",
      content: err instanceof Error ? err.message : String(err),
      createdAt: new Date().toISOString(),
    };
    setStates(id, { running: false, draft: "" });
    setStates(id, "messages", (m) => [...m, message]);
    return false;
  }
}

export function stopAgent(id: string) {
  return api.stop(id);
}

// --- Apps --------------------------------------------------------------------------------

export function setRuntime(id: string, status: RuntimeStatus) {
  if (states[id]) setStates(id, "runtime", status);
}
