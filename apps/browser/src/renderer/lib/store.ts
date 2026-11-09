// Global UI state. Lives outside components so an agent run keeps streaming
// into its tab while you look at another one. Everything the server changes
// (agent output, app status, the tab and workspace lists) arrives on the hub.
// Opened tabs of every workspace stay loaded until they're unloaded for being
// idle (lib/unload.ts); the sidebar shows the current workspace's. Each window
// has its own tabs (AppSummary.windowId): `apps` are this window's, the other
// windows' are only known by name (allApps).
import { createEffect, createRoot, createSignal } from "solid-js";
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
import { FLAGS_VIEW, GPU_VIEW, URLS_VIEW, VERSION_VIEW } from "../../shared/internalPages";
import { PRIVATE_WORKSPACE } from "../../shared/api";
import { api } from "./api";
import { attachmentsOf, clearAttachments } from "./attachments";
import { onConnected, reportTabs, watchTopic } from "./realtime";
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
/** Browsing history (Ctrl+H). */
export const HISTORY_VIEW = "history";
/** Snapshots of apps, customizations and settings, to undo changes. */
export const SNAPSHOTS_VIEW = "snapshots";
export const SCHEDULES_VIEW = "schedules";
export const MODS_VIEW = "mods";
export const BOOKMARKS_VIEW = "bookmarks";
/** rune://version, rune://gpu, rune://flags and rune://rune-urls (shared/internalPages.ts). */
export { FLAGS_VIEW, GPU_VIEW, URLS_VIEW, VERSION_VIEW };
export const DOWNLOADS_VIEW = "downloads";
const settingsViews = [
  SETTINGS_VIEW,
  ACTIVITY_VIEW,
  HISTORY_VIEW,
  SNAPSHOTS_VIEW,
  SCHEDULES_VIEW,
  MODS_VIEW,
  BOOKMARKS_VIEW,
  VERSION_VIEW,
  GPU_VIEW,
  FLAGS_VIEW,
  URLS_VIEW,
  DOWNLOADS_VIEW,
];
/** Settings or one of the pages in it. */
export const isSettingsView = (id: string | null) => !!id && settingsViews.includes(id);

/** The category Settings shows (SettingsPage.tsx: settingsSections). */
const [settingsSection, setSettingsSection] = createSignal(
  sessionStorage.getItem("rune.settings-section") ?? "general",
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

/** This window, and whether it's private (no agents, no apps, nothing kept). */
export const windowId = window.rune.window.id;
export const isPrivate = window.rune.window.private;

const [apps, setApps] = createStore<AppSummary[]>([]);
/** The other windows' tabs (a private window's only in that window): names for History, Activity, schedules. */
const [others, setOthers] = createStore<AppSummary[]>([]);
const [states, setStates] = createStore<Record<string, TabState>>({});
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [providers, setProviders] = createSignal<ProviderStatus[]>([]);
const [workspaces, setWorkspaces] = createStore<WorkspaceInfo[]>([]);
const [workspaceId, setWorkspaceId] = createSignal<string | null>(
  localStorage.getItem(`rune.workspace:${window.rune.window.id}`) ?? localStorage.getItem("rune.workspace"),
);

export { apps, providers, selectedId, states, workspaces };

export const appById = (id: string | null) => (id ? apps.find((a) => a.id === id) : undefined);
/** Every open tab this window may know about: its own and the other normal windows'. */
export const allApps = () => [...apps, ...others];
const isMine = (app: AppSummary) => app.windowId === windowId;
/** The session a web tab's page uses: its workspace's, or the private windows' one. */
export const sessionWorkspace = (app: Pick<AppSummary, "workspaceId" | "private"> | undefined) =>
  app?.private ? PRIVATE_WORKSPACE : (app?.workspaceId ?? currentWorkspace()?.id ?? "default");
export const workspaceById = (id: string | null) => (id ? workspaces.find((w) => w.id === id) : undefined);
/** The workspace shown in the sidebar. */
export const currentWorkspace = () => workspaceById(workspaceId()) ?? workspaces[0];
const byPosition = (a: AppSummary, b: AppSummary) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
/** The tabs of the current workspace, in the user's order (a private window has no workspaces: all its tabs). */
export const workspaceTabs = () =>
  apps.filter((a) => isPrivate || a.workspaceId === currentWorkspace()?.id).sort(byPosition);
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

// Private windows have no agent.
export const isAgentCollapsed = (id: string) =>
  isPrivate || (followsMode(id) ? appMode(id) === "live" : !(openChoice()[id] ?? openByDefault(id)));

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
  if (isPrivate) return;
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

/** A tab that came from the server: this window's, or another one's (it may have just moved there). */
function upsertApp(app: AppSummary) {
  if (!isMine(app)) {
    if (appById(app.id)) leaveWindow(app.id);
    const j = others.findIndex((a) => a.id === app.id);
    if (app.private) {
      if (j !== -1) setOthers((list) => list.filter((a) => a.id !== app.id));
    } else if (j === -1) setOthers(others.length, app);
    else setOthers(j, reconcile(app));
    return;
  }
  // Moved here from another window (dragged in, "Move to window"): it's shown.
  const movedIn = others.some((a) => a.id === app.id);
  if (movedIn) setOthers((list) => list.filter((a) => a.id !== app.id));
  const i = apps.findIndex((a) => a.id === app.id);
  if (i === -1) setApps(apps.length, app);
  else setApps(i, reconcile(app));
  if (movedIn) void selectApp(app.id);
}

/**
 * Tab list changes pushed by the hub, newest per tab (null: deleted), with when they came. A full list
 * fetched before one of them is older than it: without this, a tab created (or renamed, or closed) while
 * the list was on its way would be undone when the list lands, e.g. one opened right as the window starts.
 */
const pushed = new Map<string, { at: number; app: AppSummary | null }>();
function notePush(id: string, app: AppSummary | null) {
  const at = performance.now();
  pushed.set(id, { at, app });
  for (const [key, p] of pushed) if (at - p.at > 60_000) pushed.delete(key);
}

/** All open tabs from the server, as of `since` (when the request went out): this window's, and the others'. */
function setAllApps(fetched: AppSummary[], since: number) {
  const newer = [...pushed].filter(([, p]) => p.at >= since);
  const list = fetched
    .filter((t) => !newer.some(([id, p]) => id === t.id && !p.app))
    .map((t) => newer.find(([id]) => id === t.id)?.[1].app ?? t);
  for (const [id, p] of newer) if (p.app && !list.some((t) => t.id === id)) list.push(p.app);
  for (const tab of [...apps]) {
    const now = list.find((t) => t.id === tab.id);
    if (!now) forgetApp(tab.id);
    else if (!isMine(now)) leaveWindow(tab.id);
  }
  setApps(reconcile(list.filter(isMine)));
  setOthers(reconcile(list.filter((t) => !isMine(t) && !t.private)));
}

/**
 * A tab went to another window: it closes here (its page goes, its chat stays on
 * the server). A window whose last tab left closes too, like in Chrome.
 */
function leaveWindow(id: string) {
  const index = workspaceTabs().findIndex((a) => a.id === id);
  setApps((list) => list.filter((a) => a.id !== id));
  setOpened(opened().filter((x) => x !== id));
  lastUsed.delete(id);
  watchers.get(id)?.();
  watchers.delete(id);
  setStates(produce((s) => void delete s[id]));
  if (!apps.length) return window.rune.window.discard();
  if (selectedId() === id) selectNeighbour(workspaceTabs(), index);
}

/** After the selected tab went away (deleted, moved): its neighbour in the workspace, or nothing. */
function selectNeighbour(siblings: AppSummary[], index: number) {
  const next = siblings[Math.min(index, siblings.length - 1)];
  setSelectedId(null);
  if (next) void selectApp(next.id);
}

function forgetApp(id: string) {
  setOthers((list) => list.filter((a) => a.id !== id));
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

// The server asks this window about its own tabs only (agents' page tools).
createRoot(() => createEffect(() => reportTabs(apps.map((a) => a.id))));

// The tab list changes from elsewhere too (the agent names apps, duplicates…).
watchTopic(topics.apps, (msg) => {
  if (msg.type === "app") {
    notePush(msg.app.id, msg.app);
    upsertApp(msg.app);
  } else if (msg.type === "app-deleted") {
    notePush(msg.appId, null);
    forgetApp(msg.appId);
  }
});
onConnected(() => {
  const since = performance.now();
  void api.listApps().then(
    (list) => setAllApps(list, since),
    () => {},
  );
});

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
  const since = performance.now();
  const [spaces, list] = await Promise.all([api.workspaces(), api.listApps()]);
  setWorkspaces(reconcile(spaces));
  setAllApps(list, since);
  // A window that has tabs in another workspace only (a tab dragged out into it) shows that one.
  if (!workspaceTabs().length && apps[0]) setCurrentWorkspace(apps[0].workspaceId);
  if (!selectedId()) await showWorkspace(currentWorkspace()!.id);
  // A new window (Ctrl+N) starts with a new tab; the first one at launch does what On startup says (App.tsx).
  const intent = await window.rune.window.takeIntent().catch(() => null);
  if (intent === "new-tab") await newWebTab();
  return intent;
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
  // One of another workspace (opened from history): its workspace comes along, like selectApp.
  if (app.workspaceId !== currentWorkspace()?.id) setCurrentWorkspace(app.workspaceId);
  watch(app.id);
  setStates(app.id, { ...emptyState(), loaded: true });
  rememberTab(app.workspaceId, app.id);
  setSelectedId(app.id);
  markOpened(app.id);
}

export async function newApp() {
  // Apps are built by agents, which private windows don't have: a normal window gets it.
  if (isPrivate) throw new Error("Private windows have web tabs only");
  const app = await api.createApp({ workspaceId: currentWorkspace()?.id, windowId });
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
    windowId,
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
  let pending = pendingPages.get(id);
  // Another page: what's waiting belongs to the last one, so it goes first (history records each
  // page with its own title). Unless the last page had no title yet: it was a redirect.
  if (pending?.title && page.url !== undefined && page.url !== (pending.url ?? app.url)) {
    // Not shown: the tab is already on the next page.
    api.updatePage(id, pending).catch(() => {});
    pending = undefined;
  }
  const next = { ...pending, ...page };
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

/** Web tabs closed lately in this window, newest last (Ctrl+Shift+T opens the last one again). */
const recentlyClosed: { url: string; title: string; workspaceId: string; at: number }[] = [];

/** A workspace's web tabs closed lately in this window, newest first (chrome.sessions.getRecentlyClosed). */
export const closedTabsOf = (workspaceId: string) =>
  recentlyClosed.filter((c) => c.workspaceId === workspaceId).reverse();

/** Opens one of them again (the latest without `at`), like chrome.sessions.restore; the new tab, or null. */
export async function restoreClosedTab(workspaceId: string, at: number | null) {
  const i = recentlyClosed.findLastIndex((c) => c.workspaceId === workspaceId && (at === null || c.at === at));
  if (i === -1) return null;
  const [closed] = recentlyClosed.splice(i, 1);
  return newWebTab(closed!.url, { workspaceId: closed!.workspaceId });
}

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
    // A private window doesn't remember what it closed: nothing of it is kept.
    if (tab.url && !isPrivate)
      recentlyClosed.push({ url: tab.url, title: tab.name, workspaceId: tab.workspaceId, at: Date.now() });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    await api.deleteApp(id);
  }
  forgetApp(id);
}

/** What was closed last, opened again: a web tab of this window, or a window (with its tabs), like Chrome's Ctrl+Shift+T. */
export async function reopenClosedTab() {
  const last = recentlyClosed.at(-1);
  const closedWindow = isPrivate ? undefined : (await window.rune.window.closed().catch(() => []))[0];
  if (closedWindow && (!last || closedWindow.closedAt > last.at))
    return void (await window.rune.window.reopen(closedWindow.id));
  if (!last) return;
  recentlyClosed.pop();
  await newWebTab(last.url, {
    workspaceId: workspaces.some((w) => w.id === last.workspaceId) ? last.workspaceId : currentWorkspace()?.id,
  });
}

/** Opens an app from the library (closed app tabs) in the current workspace. */
export async function reopenApp(id: string) {
  const workspace = currentWorkspace();
  if (!workspace) return;
  const tab = await api.reopenApp(id, workspace.id, windowId);
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
    const since = performance.now();
    setAllApps(await api.listApps(), since);
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

// Each window has its own workspace on screen and last tab in each (kept for when it comes back).
const WORKSPACE_KEY = `rune.workspace:${windowId}`;
const WORKSPACE_TABS_KEY = `rune.workspaceTabs:${windowId}`;
const lastTabs = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_TABS_KEY) ?? "{}");
  } catch {
    return {};
  }
};
function rememberTab(workspaceId: string, tabId: string) {
  // A private window keeps nothing, not even which tab it was on.
  if (isPrivate) return;
  localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify({ ...lastTabs(), [workspaceId]: tabId }));
}

function setCurrentWorkspace(id: string) {
  setWorkspaceId(id);
  if (isPrivate) return;
  localStorage.setItem(WORKSPACE_KEY, id);
  // New windows start in the workspace used last.
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
  return workspace;
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
