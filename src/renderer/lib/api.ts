// The Rune Browser server's HTTP API. Every request carries the token Electron gave
// this window; agent output and app status arrive on the hub (realtime.ts).
import type { Settings } from "../../shared/settings";
import type { Endpoint, EndpointHost } from "../../shared/endpoints";
import type { GalleryResult, InstalledMod, Mod, ModExtension, ModReview } from "../../shared/mods";
import type {
  ChatFile,
  TabSplit,
  AppActionInfo,
  AppActionResult,
  AppTool,
  AppDetail,
  AppMode,
  AppSummary,
  AuditEntry,
  DataOverview,
  DataRows,
  ToolResult,
  PermissionAction,
  PermissionGrant,
  PermissionRequest,
  SecretInfo,
  SecretsOverview,
  ChatRequest,
  ChatMessage,
  ChatSummary,
  Attachment,
  ContextSource,
  HealthResponse,
  HistoryDetail,
  HistoryEntry,
  LogLine,
  NetworkRule,
  PresetInfo,
  ProjectInfo,
  ProviderId,
  ProviderStatus,
  ReplayOverrides,
  ReplayResult,
  RequestDraft,
  RuntimeStatus,
  SandboxInfo,
  SavedRequest,
  SiteOverride,
  Schedule,
  ScheduleRun,
  ScheduleSpec,
  PageChange,
  PageChangeSpec,
  ResponseOverride,
  TabKind,
  WorkspaceInfo,
} from "../../shared/api";
import type { WorkspaceSettings } from "../../shared/settings";

const url = (path: string) => `${window.rune.serverUrl}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
  presets: () => request<PresetInfo[]>("/api/presets"),
  sandbox: () => request<SandboxInfo>("/api/sandbox"),

  getSettings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),

  listApps: () => request<AppSummary[]>("/api/apps"),
  createApp: (body: { kind?: TabKind; url?: string; workspaceId?: string } = {}) => post<AppSummary>("/api/apps", body),
  moveApp: (id: string, workspaceId: string) => post<AppSummary>(`/api/apps/${id}/move`, { workspaceId }),
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
  closeApp: (id: string) => post<AppSummary | { deleted: true }>(`/api/apps/${id}/close`),
  library: () => request<AppSummary[]>("/api/library"),
  reopenApp: (id: string, workspaceId: string) => post<AppSummary>(`/api/apps/${id}/reopen`, { workspaceId }),
  duplicateApp: (id: string) => post<AppSummary>(`/api/apps/${id}/duplicate`),
  updatePage: (id: string, page: { url?: string; title?: string; favicon?: string | null }) =>
    request<AppSummary>(`/api/apps/${id}/page`, { method: "PATCH", body: JSON.stringify(page) }),

  /** Starts an agent turn; its output arrives on the hub (topic app:<id>). */
  chat: (id: string, body: ChatRequest) => post<{ ok: true }>(`/api/apps/${id}/chat`, body),
  stop: (id: string) => post<void>(`/api/apps/${id}/stop`),
  clearChat: (id: string) => request<void>(`/api/apps/${id}/messages`, { method: "DELETE" }),
  chats: (id: string) => request<ChatSummary[]>(`/api/apps/${id}/chats`),
  chatMessages: (id: string, chatId: number) => request<ChatMessage[]>(`/api/apps/${id}/chats/${chatId}`),
  newChat: (id: string) => post<{ messages: ChatMessage[]; chats: ChatSummary[] }>(`/api/apps/${id}/chats`),
  openChat: (id: string, chatId: number) =>
    post<{ messages: ChatMessage[]; chats: ChatSummary[] }>(`/api/apps/${id}/chats/${chatId}/open`),
  deleteChat: (id: string, chatId: number) => request<void>(`/api/apps/${id}/chats/${chatId}`, { method: "DELETE" }),

  runtime: (id: string) => request<{ status: RuntimeStatus; logs: LogLine[] }>(`/api/apps/${id}/runtime`),
  controlRuntime: (id: string, action: "start" | "stop" | "restart") =>
    post<RuntimeStatus>(`/api/apps/${id}/runtime`, { action }),
  setMode: (id: string, mode: AppMode) => post<RuntimeStatus>(`/api/apps/${id}/mode`, { mode }),
  importApp: (id: string, source: { git: string; branch?: string } | { folder: string }) =>
    post<{ project: ProjectInfo | null }>(`/api/apps/${id}/import`, source),
  uploadAttachment: (id: string, file: { name: string; mime: string; data: string }) =>
    post<Attachment>(`/api/apps/${id}/attachments`, file),
  chatFiles: (id: string) => request<{ dir: string; files: ChatFile[] }>(`/api/apps/${id}/files`),
  sources: (id: string) => request<ContextSource[]>(`/api/apps/${id}/sources`),
  addSource: (id: string, source: { folder: string } | { git: string; branch?: string }) =>
    post<ContextSource>(`/api/apps/${id}/sources`, source),
  removeSource: (id: string, sourceId: string) =>
    request<void>(`/api/apps/${id}/sources/${sourceId}`, { method: "DELETE" }),
  pullSource: (id: string, sourceId: string) => post<ContextSource>(`/api/apps/${id}/sources/${sourceId}/pull`),
  cancelImport: (id: string) => request<void>(`/api/apps/${id}/import`, { method: "DELETE" }),
  createProject: (id: string, preset: string, name?: string) =>
    post<ProjectInfo>(`/api/apps/${id}/project`, { preset, name }),

  secrets: (scope?: string) =>
    request<SecretsOverview>(`/api/secrets${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  /** Creates or replaces a secret. The value is never sent back. */
  saveSecret: (scope: string, name: string, value: string) =>
    request<SecretInfo>("/api/secrets", { method: "PUT", body: JSON.stringify({ scope, name, value }) }),
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
  deleteSecret: (id: string) => request<void>(`/api/secrets/${id}`, { method: "DELETE" }),

  permissions: () => request<PermissionGrant[]>("/api/permissions"),
  setPermission: (subject: string, action: PermissionAction, resource: string, decision: "allow" | "deny") =>
    request<void>("/api/permissions", { method: "PUT", body: JSON.stringify({ subject, action, resource, decision }) }),
  revokePermission: (id: number) => request<void>(`/api/permissions/${id}`, { method: "DELETE" }),
  pendingPermissions: () => request<PermissionRequest[]>("/api/permissions/pending"),
  /** remember: for this app (or agent), or for every app in its workspace. */
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

  appData: (id: string) => request<DataOverview>(`/api/apps/${id}/data`),
  appDataRows: (id: string, table: string, query: { offset?: number; limit?: number; search?: string } = {}) => {
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    );
    return request<DataRows>(
      `/api/apps/${id}/data/tables/${encodeURIComponent(table)}${params.size ? `?${params}` : ""}`,
    );
  },
  /** The app's data as a .tar.gz, with the file name the server suggests. */
  exportAppData: async (id: string) => {
    const res = await fetch(url(`/api/apps/${id}/data/export`), {
      headers: { Authorization: `Bearer ${window.rune.token}` },
    });
    if (!res.ok)
      throw new Error(
        ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`,
      );
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "app-data.tar.gz";
    return { blob: await res.blob(), name };
  },
  deleteAppData: (id: string) => request<void>(`/api/apps/${id}/data`, { method: "DELETE" }),

  history: (filter: { target?: string; workspace?: string; before?: number; limit?: number } = {}) => {
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
  /** data: also put the app's data back (else its current data is kept). */
  restoreSnapshot: (id: number, data: boolean) => post<void>(`/api/history/${id}/restore`, { data }),
  restoreAll: (id: number, data: boolean, workspaceId?: string) =>
    post<{ restored: string[] }>(`/api/history/${id}/restore-all`, { data, workspaceId }),
  undoSnapshot: (id: number, data = false) => post<{ note: string | null }>(`/api/history/${id}/undo`, { data }),

  /** Every app's command bar actions. */
  actions: () => request<AppActionInfo[]>("/api/actions"),
  runAction: (id: string, actionId: string, input?: string) =>
    post<AppActionResult>(
      `/api/apps/${id}/actions/${encodeURIComponent(actionId)}`,
      input === undefined ? {} : { input },
    ),
  /** An app's tools in the registry (its actions and the ones from its data). */
  appTools: (id: string) => request<AppTool[]>(`/api/apps/${id}/tools`),
  callTool: (id: string, toolId: string, args: { params?: Record<string, unknown>; input?: string }) =>
    post<ToolResult>(`/api/apps/${id}/tools/${encodeURIComponent(toolId)}`, args),

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
