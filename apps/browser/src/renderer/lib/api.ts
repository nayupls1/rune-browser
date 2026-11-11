// The Rune Browser server's HTTP API. Every request carries the token Electron gave
// this window; agent output and other changes arrive on the hub (realtime.ts).
import type { Settings } from "../../shared/settings";
import type { Endpoint, EndpointHost } from "../../shared/endpoints";
import type { Visit, VisitSuggestion } from "../../shared/visits";
import type { TabHistory } from "../../shared/tabHistory";
import type { GalleryResult, InstalledMod, Mod, ModExtension, ModReview } from "../../shared/mods";
import type {
  ChatFile,
  JobInfo,
  PathInfo,
  TabSplit,
  AppDetail,
  AppSummary,
  AuditEntry,
  PermissionGrant,
  PermissionRequest,
  ChatRequest,
  ChatMessage,
  ChatSummary,
  Attachment,
  ContextSource,
  HealthResponse,
  HistoryDetail,
  HistoryEntry,
  NetworkRule,
  ProviderId,
  ProviderStatus,
  ReplayOverrides,
  ReplayResult,
  RequestDraft,
  SavedRequest,
  SiteOverride,
  Schedule,
  ScheduleRun,
  ScheduleSpec,
  PageChange,
  PageChangeSpec,
  ResponseOverride,
  WorkspaceInfo,
} from "../../shared/api";
import type { WorkspaceSettings } from "../../shared/settings";

const url = (path: string) => `${window.rune.serverUrl}${path}`;
/** The server starts with the window: requests wait until it's up (a few hundred ms at launch, then never). */
export const serverReady = window.rune.serverReady();

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await serverReady;
  const res = await fetch(url(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${window.rune.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => request<HealthResponse>("/api/health"),

  providers: () => request<ProviderStatus[]>("/api/providers"),
  refreshProviders: (id?: ProviderId) => post<ProviderStatus[]>("/api/providers/refresh", id ? { id } : {}),

  getSettings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),

  listApps: () => request<AppSummary[]>("/api/apps"),
  createApp: (body: { url?: string; workspaceId?: string; windowId?: string } = {}) =>
    post<AppSummary>("/api/apps", body),
  moveApp: (id: string, workspaceId: string) => post<AppSummary>(`/api/apps/${id}/move`, { workspaceId }),
  moveToWindow: (id: string, windowId: string) => post<AppSummary>(`/api/apps/${id}/window`, { windowId }),
  setTabIcon: (id: string, icon: string | null) =>
    request<AppSummary>(`/api/apps/${id}/icon`, { method: "PUT", body: JSON.stringify({ icon }) }),
  setTabPinned: (id: string, pinned: boolean) =>
    request<AppSummary>(`/api/apps/${id}/pinned`, { method: "PUT", body: JSON.stringify({ pinned }) }),
  setSplits: (workspaceId: string, splits: TabSplit[]) =>
    request<WorkspaceInfo>(`/api/workspaces/${workspaceId}/splits`, {
      method: "PUT",
      body: JSON.stringify({ splits }),
    }),
  reorderTabs: (workspaceId: string, ids: string[]) =>
    request<AppSummary[]>(`/api/workspaces/${workspaceId}/order`, { method: "PUT", body: JSON.stringify({ ids }) }),

  workspaces: () => request<WorkspaceInfo[]>("/api/workspaces"),
  reorderWorkspaces: (ids: string[]) =>
    request<WorkspaceInfo[]>("/api/workspaces/order", { method: "PUT", body: JSON.stringify({ ids }) }),
  createWorkspace: (name: string) => post<WorkspaceInfo>("/api/workspaces", { name }),
  updateWorkspace: (id: string, fields: { name?: string; icon?: string | null; settings?: WorkspaceSettings }) =>
    request<WorkspaceInfo>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),
  getApp: (id: string) => request<AppDetail>(`/api/apps/${id}`),
  renameApp: (id: string, name: string) =>
    request<AppSummary>(`/api/apps/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteApp: (id: string) => request<void>(`/api/apps/${id}`, { method: "DELETE" }),
  /** Tab cleanup (lib/cleanup.ts): tabs on screen now, the idle ones, and closing one (409 if it's in use after all). */
  tabsUsed: (ids: string[]) => request<void>("/api/apps/used", { method: "POST", body: JSON.stringify({ ids }) }),
  idleTabs: () => request<string[]>("/api/apps/idle"),
  cleanUpTab: (id: string) => request<{ closed: true }>(`/api/apps/${id}/clean-up`, { method: "POST" }),
  duplicateApp: (id: string) => post<AppSummary>(`/api/apps/${id}/duplicate`),
  updatePage: (id: string, page: { url?: string; title?: string; favicon?: string | null }) =>
    request<AppSummary>(`/api/apps/${id}/page`, { method: "PATCH", body: JSON.stringify(page) }),
  /** A web tab's back/forward history (shared/tabHistory.ts); private tabs keep none. */
  tabHistory: (id: string) => request<{ history: TabHistory | null }>(`/api/apps/${id}/history`),
  setTabHistory: (id: string, history: TabHistory | null) =>
    request<void>(`/api/apps/${id}/history`, { method: "PUT", body: JSON.stringify({ history }) }),

  /** Starts an agent turn; its output arrives on the hub (topic app:<id>). */
  chat: (id: string, body: ChatRequest) => post<{ ok: true }>(`/api/apps/${id}/chat`, body),
  stop: (id: string) => post<void>(`/api/apps/${id}/stop`),
  stopJob: (id: string, jobId: string) => post<JobInfo[]>(`/api/apps/${id}/jobs/${encodeURIComponent(jobId)}/stop`),
  clearChat: (id: string) => request<void>(`/api/apps/${id}/messages`, { method: "DELETE" }),
  chats: (id: string) => request<ChatSummary[]>(`/api/apps/${id}/chats`),
  chatMessages: (id: string, chatId: number) => request<ChatMessage[]>(`/api/apps/${id}/chats/${chatId}`),
  newChat: (id: string) => post<{ messages: ChatMessage[]; chats: ChatSummary[] }>(`/api/apps/${id}/chats`),
  openChat: (id: string, chatId: number) =>
    post<{ messages: ChatMessage[]; chats: ChatSummary[] }>(`/api/apps/${id}/chats/${chatId}/open`),
  deleteChat: (id: string, chatId: number) => request<void>(`/api/apps/${id}/chats/${chatId}`, { method: "DELETE" }),

  uploadAttachment: (id: string, file: { name: string; mime: string; data: string }) =>
    post<Attachment>(`/api/apps/${id}/attachments`, file),
  chatFiles: (id: string) => request<{ dir: string; files: ChatFile[] }>(`/api/apps/${id}/files`),
  lookupPaths: (id: string, paths: string[]) => post<PathInfo[]>(`/api/apps/${id}/files/lookup`, { paths }),
  sources: (id: string) => request<ContextSource[]>(`/api/apps/${id}/sources`),
  addSource: (id: string, source: { folder: string } | { git: string; branch?: string }) =>
    post<ContextSource>(`/api/apps/${id}/sources`, source),
  removeSource: (id: string, sourceId: string) =>
    request<void>(`/api/apps/${id}/sources/${sourceId}`, { method: "DELETE" }),
  pullSource: (id: string, sourceId: string) => post<ContextSource>(`/api/apps/${id}/sources/${sourceId}/pull`),
  /** The API map (shared/endpoints.ts): a workspace's hosts, a host's endpoints. */
  endpointHosts: (workspaceId: string) =>
    request<EndpointHost[]>(`/api/endpoints?workspace=${encodeURIComponent(workspaceId)}`),
  endpoints: (workspaceId: string, host: string) =>
    request<Endpoint[]>(
      `/api/endpoints/hosts/${encodeURIComponent(host)}?workspace=${encodeURIComponent(workspaceId)}`,
    ),
  deleteEndpointHost: (workspaceId: string, host: string) =>
    request<void>(`/api/endpoints/hosts/${encodeURIComponent(host)}?workspace=${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    }),
  deleteEndpointSite: (workspaceId: string, site: string) =>
    request<void>(`/api/endpoints/sites/${encodeURIComponent(site)}?workspace=${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    }),

  /** Browsing history (shared/visits.ts): a workspace's visits (every workspace's with null), newest first. */
  visits: (query: { workspaceId: string | null; search?: string; before?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (query.workspaceId) params.set("workspace", query.workspaceId);
    if (query.search) params.set("search", query.search);
    if (query.before) params.set("before", String(query.before));
    if (query.limit) params.set("limit", String(query.limit));
    return request<Visit[]>(`/api/visits?${params}`);
  },
  suggestVisits: (workspaceId: string, q: string, limit = 5) =>
    request<VisitSuggestion[]>(
      `/api/visits/suggest?workspace=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  deleteVisits: (workspaceId: string | null, ids: number[]) =>
    post<{ removed: number }>(
      `/api/visits/delete${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
      { ids },
    ),
  /** The sites (origins) visited since a time (ISO), in a workspace or all. */
  visitedOrigins: (workspaceId: string | null, since: string) => {
    const params = new URLSearchParams({ since });
    if (workspaceId) params.set("workspace", workspaceId);
    return request<string[]>(`/api/visits/origins?${params}`);
  },
  /** Deletes the history since a time (ISO), or all of it (null). */
  clearVisits: (workspaceId: string | null, since: string | null) =>
    post<{ removed: number }>(
      `/api/visits/clear${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
      { since },
    ),

  permissions: () => request<PermissionGrant[]>("/api/permissions"),
  revokePermission: (id: number) => request<void>(`/api/permissions/${id}`, { method: "DELETE" }),
  pendingPermissions: () => request<PermissionRequest[]>("/api/permissions/pending"),
  /** remember: for this tab (or agent), or for every tab in its workspace. */
  answerPermission: (id: string, allow: boolean, remember: boolean | "workspace") =>
    post<void>(`/api/permissions/pending/${id}`, { allow, remember }),

  audit: (filter: { tab?: string; workspace?: string; actor?: string; before?: number; limit?: number } = {}) => {
    const params = new URLSearchParams(
      Object.entries(filter)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    );
    return request<AuditEntry[]>(`/api/audit${params.size ? `?${params}` : ""}`);
  },

  history: (filter: { target?: string; before?: number; limit?: number } = {}) => {
    const params = new URLSearchParams(
      Object.entries(filter)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    );
    return request<HistoryEntry[]>(`/api/history${params.size ? `?${params}` : ""}`);
  },
  historyDetail: (id: number) => request<HistoryDetail>(`/api/history/${id}`),
  /** A snapshot right now; undefined if nothing changed since the last one. */
  saveSnapshot: (target: string) => post<HistoryEntry | undefined>("/api/history", { target }),
  restoreSnapshot: (id: number) => post<void>(`/api/history/${id}/restore`),
  restoreAll: (id: number) => post<{ restored: string[] }>(`/api/history/${id}/restore-all`),
  undoSnapshot: (id: number) => post<{ note: string | null }>(`/api/history/${id}/undo`),

  networkRules: () => request<NetworkRule[]>("/api/network/rules"),
  addNetworkRule: (rule: Omit<NetworkRule, "id" | "createdAt" | "enabled"> & { enabled?: boolean }) =>
    post<NetworkRule>("/api/network/rules", rule),
  updateNetworkRule: (id: string, fields: Partial<Omit<NetworkRule, "id" | "createdAt">>) =>
    request<NetworkRule>(`/api/network/rules/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteNetworkRule: (id: string) => request<void>(`/api/network/rules/${id}`, { method: "DELETE" }),
  savedRequests: (workspaceId?: string) =>
    request<SavedRequest[]>(
      `/api/network/requests${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
    ),
  saveRequest: (workspaceId: string, name: string, draft: RequestDraft) =>
    post<SavedRequest>("/api/network/requests", { workspaceId, name, draft }),
  deleteSavedRequest: (id: string) => request<void>(`/api/network/requests/${id}`, { method: "DELETE" }),
  /** Sends a saved request with its workspace's session (credentials stay in Rune Browser's main process). */
  sendSavedRequest: (id: string, overrides?: ReplayOverrides) =>
    post<ReplayResult>(`/api/network/requests/${id}/send`, overrides ? { overrides } : {}),

  responseOverrides: () => request<ResponseOverride[]>("/api/response-overrides"),
  deleteResponseOverride: (id: string) => request<void>(`/api/response-overrides/${id}`, { method: "DELETE" }),

  listSites: () => request<SiteOverride[]>("/api/sites"),
  getSite: (host: string) => request<SiteOverride | null>(`/api/sites/${encodeURIComponent(host)}`),
  saveSite: (host: string, fields: Partial<Pick<SiteOverride, "css" | "js" | "enabled">>) =>
    request<SiteOverride>(`/api/sites/${encodeURIComponent(host)}`, { method: "PUT", body: JSON.stringify(fields) }),
  deleteSite: (host: string) => request<void>(`/api/sites/${encodeURIComponent(host)}`, { method: "DELETE" }),
  schedules: (workspace?: string) =>
    request<Schedule[]>(`/api/schedules${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`),
  scheduleRuns: (filter: { schedule?: string; workspace?: string; before?: number; limit?: number } = {}) => {
    const params = new URLSearchParams(
      Object.entries(filter)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    );
    return request<ScheduleRun[]>(`/api/schedules/runs${params.size ? `?${params}` : ""}`);
  },
  upcomingRuns: (workspace?: string) =>
    request<{ scheduleId: string; name: string; at: string }[]>(
      `/api/schedules/upcoming${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
    ),
  createSchedule: (spec: ScheduleSpec) => post<Schedule>("/api/schedules", spec),
  updateSchedule: (id: string, fields: { spec?: ScheduleSpec; paused?: boolean }) =>
    request<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteSchedule: (id: string) => request<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runSchedule: (id: string) => post<ScheduleRun>(`/api/schedules/${encodeURIComponent(id)}/run`, {}),
  pageChanges: () => request<PageChange[]>("/api/page-changes"),

  mods: () => request<InstalledMod[]>("/api/mods"),
  modGallery: () => request<GalleryResult>("/api/mods/gallery"),
  /** What installing a mod (JSON, a share code or a link) does, before deciding. */
  reviewMod: (input: ModSource) =>
    post<{ mod: Mod; review: ModReview; installed: InstalledMod | null; source: string }>("/api/mods/review", input),
  installMod: (input: ModSource & { source?: string }) => post<InstalledMod>("/api/mods", input),
  setModEnabled: (id: string, enabled: boolean) =>
    request<InstalledMod>(`/api/mods/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  removeMod: (id: string) => request<InstalledMod>(`/api/mods/${id}`, { method: "DELETE" }),
  recordModExtensions: (id: string, installed: string[]) =>
    post<InstalledMod>(`/api/mods/${id}/extensions`, { installed }),
  packageMod: (input: {
    name: string;
    description: string;
    author: string;
    pageChangeIds: string[];
    theme: boolean;
    extensions: ModExtension[];
  }) => post<Mod>("/api/mods/package", input),
  addPageChange: (spec: PageChangeSpec) => post<PageChange>("/api/page-changes", spec),
  updatePageChange: (id: string, fields: { enabled?: boolean; change?: PageChangeSpec }) =>
    request<PageChange>(`/api/page-changes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),
  deletePageChange: (id: string) => request<void>(`/api/page-changes/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** A mod to review or install: its JSON, a share code or a link. */
export type ModSource = { mod: unknown } | { code: string } | { url: string };
