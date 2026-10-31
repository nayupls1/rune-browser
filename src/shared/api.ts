// Types shared between the Bun server, the Electron main/preload and the renderer.
import type { Hunk } from "./diff";
import type {
  BrowserProfile,
  ExtensionAction,
  ExtensionInfo,
  ExtensionPermissionRequest,
  ExtensionPopupRequest,
  ExtensionTabRequest,
  ExtensionTabs,
  ImportRequest,
  InstallResult,
} from "./extensions";
import type { WorkspaceSettings } from "./settings";
import type { UpdateChannel, UpdateInfo } from "./updates";

export interface HealthResponse {
  ok: true;
  uptime: number;
  bun: string;
  dataDir: string;
}

/** API exposed on `window.rune` by the preload script. */
/** A site's sign-in prompt (HTTP authentication) for the user. */
export interface AuthPrompt {
  requestId: string;
  url: string;
  host: string;
  realm: string;
  isProxy: boolean;
  /** The web tab's webContents. */
  contentsId: number;
}

export interface RuneBridge {
  /** The window without a title bar (renderer: lib/windowChrome.ts, components/WindowControls.tsx). */
  window: {
    platform: string;
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    toggleFullScreen: () => void;
    /** Quits Rune Browser (Ctrl+Shift+Q). */
    quit: () => void;
    onMaximized: (fn: (maximized: boolean) => void) => () => void;
  };
  /** Asks for a folder (a system dialog); null if none was picked. */
  pickFolder: (title: string) => Promise<string | null>;
  serverUrl: string;
  /** Sent with every request to the Rune Browser server (and the hub). */
  token: string;
  /**
   * Started with --safe-mode (or Ctrl+Alt+Shift+S): the theme and site
   * customizations are off, so a change that broke the UI can be undone.
   */
  safeMode: boolean;
  /** Rendered offscreen (e2e): nothing may show up on the user's screen, notifications included. */
  offscreen: boolean;
  /** Restarts Rune Browser, in safe mode or normally. */
  relaunch: (safeMode: boolean) => void;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  /** Updates of Rune Browser itself (main/updates.ts). */
  updates: {
    get: () => Promise<UpdateInfo>;
    /** Checks now (and downloads what it finds). */
    check: () => Promise<UpdateInfo>;
    setChannel: (channel: UpdateChannel) => Promise<UpdateInfo>;
    /** Restarts into the downloaded update. */
    install: () => void;
    onChanged: (fn: (info: UpdateInfo) => void) => () => void;
  };
  web: {
    /** Deletes the cookies and storage of a workspace's web tabs (the workspace was deleted). */
    clearWorkspace: (workspaceId: string) => Promise<void>;
    /** A page asked to open a link in a new window: open it in a new web tab (in the background for Ctrl+click). */
    onOpenTab: (fn: (url: string, background?: boolean) => void) => () => void;
    /** A keyboard shortcut pressed while a page had the focus, that the page passed on (main/shortcuts.ts). */
    onShortcut: (fn: (event: ShortcutEvent) => void) => () => void;
    /** The keys of every shortcut, for the keys pressed in pages (shared/shortcuts.ts). */
    setShortcuts: (bindings: Record<string, string[]>) => void;
    /** Opens DevTools on a page for the user, at a panel (F12, Ctrl+Shift+J, Ctrl+Shift+C). */
    openDevTools: (webContentsId: number, panel: "elements" | "console" | "sources" | "inspect") => void;
    /** Saves a page to a file the user picks (Ctrl+S). */
    savePage: (webContentsId: number) => Promise<void>;
    /** Screenshot of a page (web tab or app preview) as base64 JPEG. */
    capture: (webContentsId: number) => Promise<string>;
    /** Opens a URL in the system browser. */
    openExternal: (url: string) => void;
    /** Where a dropped or picked file is on disk ("" for files that aren't on disk). */
    pathForFile: (file: File) => string;
    /** Downloads a URL (a local file the browser can't show) in a workspace's session, like Chrome does. */
    download: (workspaceId: string, url: string) => void;
    /** DevTools for the agents on a page (web tab or app preview): see main/devtools.ts. */
    devtools: (webContentsId: number, command: DevtoolsCommand, params?: object) => Promise<unknown>;
    /** The traffic of web tabs and app previews (see main/network.ts). Agents only ever get it with reveal off. */
    network: {
      list: (webContentsId: number, filter?: NetworkFilter) => Promise<NetworkEntrySummary[]>;
      /** reveal: with credentials (only for the user's own eyes). */
      get: (webContentsId: number, id: string, reveal: boolean) => Promise<NetworkEntry | null>;
      clear: (webContentsId: number) => Promise<void>;
      /** Sends a captured request (or a saved one, in its workspace's session) again. */
      replay: (target: ReplayTarget, overrides: ReplayOverrides, reveal: boolean) => Promise<ReplayResult>;
      /** A captured request ready to be saved: its credentials sealed (only Rune Browser's main process can open them). */
      draft: (webContentsId: number, id: string) => Promise<RequestDraft>;
      setRules: (rules: NetworkRule[]) => void;
      /** The response overrides in effect; tab-scoped ones carry their tab's webContents (null: not open). */
      setOverrides: (overrides: (ResponseOverride & { webContentsId: number | null })[]) => void;
      setRecording: (enabled: boolean) => void;
      /** A tab's captured traffic changed (throttled). */
      onChanged: (fn: (webContentsId: number) => void) => () => void;
    };
    /** A site (or proxy) in a web tab asks for a username and password, and no extension filled them in. */
    onAuthPrompt: (fn: (request: AuthPrompt) => void) => () => void;
    /** The user's answer to an AuthPrompt (null: cancelled). */
    authReply: (requestId: string, value: { username: string; password: string } | null) => void;
  };
  /** Chrome extensions in web tabs (see main/extensions/). */
  extensions: {
    list: () => Promise<{ extensions: ExtensionInfo[]; autoUpdate: boolean }>;
    /** Resolves once the workspace's extensions are running (or after a few seconds), so pages load with them. */
    prepare: (workspaceId: string) => Promise<void>;
    /** The toolbar buttons in a workspace, as they are for a tab. */
    actions: (workspaceId: string, webContentsId: number | null) => Promise<ExtensionAction[]>;
    /** A toolbar button was clicked: its popup to show, or null when the extension handles the click. */
    click: (workspaceId: string, extensionId: string) => Promise<string | null>;
    /** The menu of a toolbar button (right click), shown by the main process. */
    actionMenu: (workspaceId: string, extensionId: string) => Promise<void>;
    detectBrowsers: () => Promise<BrowserProfile[]>;
    import: (request: ImportRequest) => Promise<InstallResult>;
    /** From a Chrome Web Store link or ID. */
    install: (input: string) => Promise<InstallResult>;
    /** Asks for a folder; null when none was picked. */
    loadUnpacked: () => Promise<InstallResult | null>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    /** Allows or blocks one of its permissions (the extension restarts with it). */
    setPermission: (id: string, permission: string, allowed: boolean) => Promise<void>;
    setPinned: (id: string, pinned: boolean) => Promise<void>;
    remove: (id: string) => Promise<void>;
    setAutoUpdate: (enabled: boolean) => Promise<void>;
    /** Checks for updates now; resolves with how many were updated. */
    update: () => Promise<number>;
    /** Which web tabs there are (extensions see them as their tabs). */
    setTabs: (tabs: ExtensionTabs) => void;
    /** Answers a tab or permission request. */
    reply: (requestId: string, value: unknown) => void;
    onChanged: (fn: () => void) => () => void;
    onActionsChanged: (fn: (workspaceId: string) => void) => () => void;
    onTabRequest: (fn: (request: ExtensionTabRequest) => void) => () => void;
    onPermissionRequest: (fn: (request: ExtensionPermissionRequest) => void) => () => void;
    onPopup: (fn: (request: ExtensionPopupRequest) => void) => () => void;
    /** "Manage extensions" in a toolbar button's menu. */
    onManage: (fn: () => void) => () => void;
  };
}

export const WEB_PARTITION = "persist:web";
/** Web tabs of each workspace get their own session (cookies, logins); the first workspace keeps the original one. */
export const webPartition = (workspaceId: string) =>
  workspaceId === DEFAULT_WORKSPACE ? WEB_PARTITION : `persist:web-${workspaceId}`;
export const WEB_PARTITION_PATTERN = /^persist:web(-[\w-]+)?$/;
/** Each app's preview gets its own session: apps all live on 127.0.0.1, and cookies don't separate ports. */
export const appPartition = (appId: string) => `persist:app-${appId}`;
export const APP_PARTITION_PATTERN = /^persist:app-[\w-]+$/;

/** A shortcut (shared/shortcuts.ts) pressed in a page: which one, and in which page. */
export interface ShortcutEvent {
  id: string;
  contentsId?: number;
}

// --- Providers ------------------------------------------------------------------

export const providerIds = ["claude", "codex", "opencode"] as const;
export type ProviderId = (typeof providerIds)[number];

/** Reasoning effort. Providers support different levels; each model lists its own. */
export type Effort = string;

export const effortLabels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export interface ProviderModel {
  /** What the provider expects (OpenCode: "provider/model"). */
  id: string;
  name: string;
  description?: string;
  /** Effort levels the model supports; empty if it has none. */
  efforts: Effort[];
  /** Grouping in the picker (OpenCode: the upstream provider). */
  group?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  enabled: boolean;
  /**
   * ready: usable. missing: not installed. signed-out: needs a login.
   * error: something else is wrong (see message). disabled: turned off in Settings.
   */
  state: "ready" | "missing" | "signed-out" | "error" | "disabled" | "checking";
  version: string | null;
  /** Binary that runs, for Settings. */
  binary: string | null;
  /** What's wrong or how to fix it. */
  message: string | null;
  models: ProviderModel[];
  /** The model used when none is picked. */
  defaultModel: string | null;
}

/**
 * The model apps' AI requests use unless Settings pick one: a fast, cheap one
 * where the provider has it (app requests are many and small), else the
 * provider's default.
 */
export const defaultAppModel = (status: Pick<ProviderStatus, "models" | "defaultModel">): string | null =>
  (status.models.find((m) => m.id === "haiku") ?? status.models.find((m) => /haiku/i.test(m.id)))?.id ??
  status.defaultModel;

export interface AgentChoice {
  provider: ProviderId;
  /** null: the provider's default model. */
  model: string | null;
  effort: Effort | null;
}

// --- Workspaces -------------------------------------------------------------------

/** The workspace existing tabs moved into when workspaces were introduced. */
export const DEFAULT_WORKSPACE = "default";

/**
 * A group of tabs with its own agent defaults and instructions, secrets shared
 * by its apps, and its own web session (logins).
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /** Lucide icon name or an emoji. */
  icon: string | null;
  settings: WorkspaceSettings;
  /** Tabs shown side by side. A tab is in at most one. */
  splits: TabSplit[];
  createdAt: string;
}

/** Tabs shown side by side ("row") or stacked ("column") in one view. */
export interface TabSplit {
  id: string;
  direction: "row" | "column";
  /** Left to right, or top to bottom. */
  tabs: string[];
  /** Each pane's share of the space; they add up to 1. */
  sizes: number[];
}

export const SPLIT_MAX_TABS = 4;

/**
 * A workspace's splits made consistent: only its own tabs, each in one split,
 * 2 to SPLIT_MAX_TABS per split, sizes matching (equal ones if they don't) and
 * adding up to 1.
 */
export function normalizeSplits(splits: readonly TabSplit[], tabIds: readonly string[]): TabSplit[] {
  const known = new Set(tabIds);
  const used = new Set<string>();
  const result: TabSplit[] = [];
  for (const split of splits) {
    const panes: { id: string; size: number | undefined }[] = [];
    split.tabs.forEach((id, i) => {
      if (panes.length < SPLIT_MAX_TABS && known.has(id) && !used.has(id) && !panes.some((p) => p.id === id))
        panes.push({ id, size: split.sizes[i] });
    });
    if (panes.length < 2) continue;
    for (const p of panes) used.add(p.id);
    const valid = panes.every((p) => typeof p.size === "number" && Number.isFinite(p.size) && p.size > 0);
    const sizes = valid ? panes.map((p) => p.size!) : panes.map(() => 1);
    const total = sizes.reduce((a, b) => a + b, 0);
    result.push({
      id: split.id,
      direction: split.direction === "column" ? "column" : "row",
      tabs: panes.map((p) => p.id),
      sizes: sizes.map((s) => s / total),
    });
  }
  return result;
}

// --- Apps and web tabs (one per sidebar tab) ------------------------------------

export type TabKind = "app" | "web";

export interface AppSummary {
  id: string;
  workspaceId: string;
  /** "app": a project built by the agent; "web": a browser tab. */
  kind: TabKind;
  name: string;
  /** Its own icon (see TabIcon): a Lucide icon name, an emoji or an image (data URL). Null: the default (web tabs: the site's favicon). */
  icon: string | null;
  /** Web tabs: current URL and favicon. */
  url: string | null;
  favicon: string | null;
  /** Kept loaded: not unloaded when it hasn't been used for a while. */
  pinned: boolean;
  /** Its place in the workspace's list (ties: creation order). */
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Closed apps (the library): when the tab was closed. Open tabs don't have it. */
  closedAt?: string;
}

/** A tab's own icon as an image: a base64 data URL. */
export const isImageIcon = (icon: string | null | undefined): icon is string =>
  !!icon && icon.startsWith("data:image/");
/** Image icons are small (the UI scales uploads to 64px); this bounds what the API takes. */
export const IMAGE_ICON_MAX = 150_000;
export const IMAGE_ICON_PATTERN =
  /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;
/** An emoji (or a few), shown as text. */
export const isEmojiIcon = (icon: string) =>
  icon.length <= 16 && /\p{Extended_Pictographic}/u.test(icon) && !/[\s<>]/.test(icon);

export interface AppDetail extends AppSummary {
  messages: ChatMessage[];
  running: boolean;
  /** Last provider/model/effort used for this tab (null = the defaults from Settings). */
  agent: AgentChoice | null;
  /** Apps only. */
  project: ProjectInfo | null;
  runtime: RuntimeStatus | null;
}

/** An app's project: its folder and rune.json. Null until the agent set one up. */
export interface ProjectInfo {
  dir: string;
  manifest: Manifest;
}

// --- Managed app data -----------------------------------------------------------

export interface DataColumn {
  name: string;
  /** SQLite's declared type ("" when none). */
  type: string;
  primaryKey: boolean;
}

export interface DataTable {
  name: string;
  rows: number;
  columns: DataColumn[];
}

/** What an app has stored (its database and files), for the Data panel. */
export interface DataOverview {
  tables: DataTable[];
  /** The database file (with its write-ahead log). */
  databaseBytes: number;
  files: { count: number; bytes: number };
  /** Set when the database exists but can't be read. */
  error: string | null;
}

/** A page of a table's rows. Blobs show as "<n bytes>", big integers as text. */
export interface DataRows {
  table: string;
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  /** Rows matching the filters. */
  total: number;
  offset: number;
  limit: number;
}

/** rune.json at the root of an app's project. */
export interface Manifest {
  /** The preset the project started from. */
  preset?: string;
  /** Install dependencies (run when package.json/lockfile changed). Default: "bun install" if there is a package.json. */
  install?: string;
  /** Dev server with live reload, listening on $PORT. */
  dev: string;
  /** Production build (optional). */
  build?: string;
  /** Serve the built app on $PORT. */
  start: string;
  /** What the app offers in Rune Browser's command bar and tool registry. */
  actions?: AppAction[];
  /** Which tools Rune Browser derives from the app's data: all (default), read (list/get) or none. */
  dataTools?: "all" | "read" | "none";
}

/**
 * A command an app offers in the command bar (rune.json "actions"). Either
 * opens the app at `path`, or has Rune Browser POST `{ input }` (JSON) to the
 * app's `endpoint`, whose JSON `{ message }` is shown as the result.
 */
export interface AppAction {
  /** Stable, e.g. "add-expense". */
  id: string;
  title: string;
  description?: string;
  path?: string;
  endpoint?: string;
  /** Asks for text first (this is the placeholder), sent as `input`. */
  input?: string;
  /** Named, typed arguments (for agents and other apps), sent as `params`. */
  params?: Record<string, ToolParam>;
}

export interface ToolParam {
  type: "string" | "number" | "integer" | "boolean" | "object";
  description?: string;
  required?: boolean;
}

/**
 * Something an app can do, in Rune Browser's tool registry: the app's own actions
 * (rune.json) and the basic ones Rune Browser derives from its data (list, get,
 * add, update, delete per table). An action with a data tool's id replaces it.
 */
export interface AppTool {
  /** Stable, e.g. "add-expense" or "list-notes". */
  id: string;
  title: string;
  description?: string;
  /** "data": derived from a table; "action": declared by the app. */
  source: "data" | "action";
  /** Only reads (data list/get). */
  readOnly: boolean;
  params: Record<string, ToolParam>;
  /** Actions: asks for text first (placeholder). */
  input?: string;
  /** Actions that open the app at a page (only the user can). */
  path?: string;
  /** Data tools: the table and what is done with it. */
  table?: string;
  op?: "list" | "get" | "add" | "update" | "delete";
}

/** An app's tools, with the app. */
export interface AppToolsInfo {
  appId: string;
  appName: string;
  appIcon: string | null;
  workspaceId: string;
  tools: AppTool[];
}

export interface ToolResult {
  ok: boolean;
  /** The app's HTTP status (actions), or Rune Browser's. */
  status: number;
  /** What happened, short (shown as a notice). */
  message: string;
  /** The result itself (rows, the app's JSON reply). */
  data?: unknown;
}

/** An app action with the app it belongs to (for the command bar). */
export interface AppActionInfo {
  appId: string;
  workspaceId: string;
  appName: string;
  appIcon: string | null;
  action: AppAction;
}

export interface AppActionResult {
  ok: boolean;
  /** The app's HTTP status. */
  status: number;
  /** The app's `message`, or the start of its response. */
  message: string;
}

/** dev: the agent is working on it (dev server, live reload). live: done (built, start command). */
export type AppMode = "dev" | "live";

export interface RuntimeStatus {
  mode: AppMode;
  state: "stopped" | "installing" | "building" | "starting" | "running" | "crashed";
  /** Where the preview is served (127.0.0.1:port) once running. */
  url: string | null;
  port: number | null;
  exitCode: number | null;
  /** Why it isn't running (crash, failed build…). */
  error: string | null;
  startedAt: string | null;
  /** How the app's processes are isolated. */
  sandbox: SandboxKind;
}

export type SandboxKind = "bwrap" | "none";

/**
 * Code attached to a tab for its agent: a folder of yours, used in place, or
 * a Git repository Rune Browser cloned (server: workspace/Sources.ts).
 */
export interface ContextSource {
  id: string;
  tabId: string;
  kind: "folder" | "git";
  name: string;
  /** Where its files are: the folder itself, or Rune Browser's clone. */
  path: string;
  /** The repository it was cloned from (git). */
  url: string | null;
  branch: string | null;
  /** cloning or pulling: busy; error: the last clone or pull failed. */
  state: "cloning" | "pulling" | "ready" | "error";
  error: string | null;
  addedAt: string;
  updatedAt: string;
}

/** What the agents' DevTools can do on a page (main/devtools.ts). */
export type DevtoolsCommand =
  | "console"
  | "metrics"
  | "trace"
  | "accessibility"
  | "styles"
  | "storage"
  | "coverage"
  | "emulate"
  | "screenshot"
  | "upload";

/** A shell app commands can run in (Settings → Apps). path: null for Bun's built-in shell. */
export interface ShellInfo {
  id: string;
  label: string;
  path: string | null;
}

/** What app processes run with on this machine (Settings → Apps). */
export interface SandboxInfo {
  platform: string;
  /** Whether bubblewrap works here, and what the settings resolve to. */
  bwrapAvailable: boolean;
  kind: SandboxKind;
  shells: ShellInfo[];
  /** The shell commands run in now: an id from `shells`, or "custom". */
  shell: { id: string; path: string | null };
  /** Folders the sandbox shows read-only besides the system (toolchains, your additions), and the PATH it gets. */
  readOnly: string[];
  path: string[];
}

export interface LogLine {
  /** Milliseconds since the epoch. */
  at: number;
  stream: "out" | "err" | "system";
  text: string;
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  /** Frontend / backend summary, e.g. "React · Bun API · SQLite". */
  stack: string;
}

// --- Chat ----------------------------------------------------------------------

export interface ChatRequest {
  prompt: string;
  agent?: Partial<AgentChoice>;
  /** Web tabs and app previews: the page and the elements the user picked. */
  page?: PageContext;
  /** Other tabs shared with the message (server: agent/sharedTabs.ts). */
  shared?: SharedTab[];
  /** Files uploaded for the message (POST /api/apps/:id/attachments), by id. */
  attachments?: string[];
}

/** A file given to the agent with a message: a pasted screenshot, a dropped file. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Where it is: in the chat's folder (attachments/), to open it in a tab. */
  path: string;
}

/** A file in a chat's folder (server: agent/ChatFiles.ts): what the user attached and what the agent made. */
export interface ChatFile {
  /** Its path in the chat's folder ("notes.md", "screenshots/home.jpg"). */
  name: string;
  /** Its absolute path, to open it in a tab. */
  path: string;
  mime: string;
  size: number;
  modifiedAt: string;
}

/** Another tab shared with a message: mentioned (@name), or one of its agent's replies handed over. */
export interface SharedTab {
  tabId: string;
  /** A reply of that tab's agent. */
  messageId?: number;
  /** What its page shows (only sent to website agents: they have no tools of their own). */
  page?: { url: string; title: string; text: string; selection?: string };
}

/**
 * Why `source` can't be shared with the agent of `recipient`, or null if it can.
 * Web pages and website agents' replies are untrusted: they only go to website
 * agents, never to an app builder (it has file and shell tools).
 */
export function shareRefusal(
  recipient: Pick<AppSummary, "id" | "kind" | "workspaceId">,
  source: Pick<AppSummary, "id" | "kind" | "workspaceId" | "name"> | null | undefined,
) {
  if (!source) return "That tab doesn't exist anymore.";
  if (source.id === recipient.id) return "That's this tab itself.";
  if (source.workspaceId !== recipient.workspaceId) return `“${source.name}” is in another workspace.`;
  if (recipient.kind === "app" && source.kind === "web") {
    return `“${source.name}” is a web page. Web pages (and what a website agent made of them) can't be shared with the app builder, which has file and shell tools: describe what you need from it in your own words instead.`;
  }
  return null;
}

/** An element picked in a page, as described by the picker script. */
export interface ElementInfo {
  /** Unique-ish CSS selector for the element. */
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

export interface PageContext {
  url: string;
  title: string;
  selection: ElementInfo[];
}

/** An earlier chat of a tab, kept when a new one was started. */
export interface ChatSummary {
  id: number;
  /** Its first message, shortened. */
  title: string;
  messages: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  /**
   * tool: one tool call of the agent (JSON: ToolActivity).
   * context: what the user pointed at (picked elements) with their message.
   * secret: the agent asks the user for a secret (JSON: { name, description }).
   * attachments: files sent with the next message (JSON: Attachment[]).
   * files: files of the chat's folder the agent shows the user (JSON: ChatFile[]).
   */
  role: "user" | "assistant" | "tool" | "error" | "context" | "secret" | "attachments" | "files";
  content: string;
  createdAt: string;
}

/** What a tool call did, for its icon and for summing up a run of calls ("Ran 2 commands, read 3 files"). */
export type ToolKind =
  | "read"
  | "edit"
  | "create"
  | "command"
  | "search"
  | "web"
  | "page"
  | "browse"
  | "screenshot"
  | "inspect"
  | "code"
  | "performance"
  | "network"
  | "plan"
  | "agent"
  | "app"
  | "customize"
  | "schedule"
  | "snapshot"
  | "secret"
  | "source"
  | "tab"
  | "other";

/** A tool call of the agent: the content of a `tool` chat message. */
export interface ToolActivity {
  kind: ToolKind;
  /** One line: "Edited src/App.tsx". */
  title: string;
  /** More, shown when the row is opened: the whole command, the arguments. */
  detail?: string;
  failed?: boolean;
  /** Files it saved in the chat's folder (a screenshot, a script's result). */
  files?: ChatFile[];
}

/** A `tool` message's activity (a plain line if it isn't JSON). */
export function parseToolActivity(content: string): ToolActivity {
  try {
    const parsed = JSON.parse(content) as ToolActivity;
    if (parsed && typeof parsed.title === "string") return parsed;
  } catch {}
  return { kind: "other", title: content };
}

/** Pushed on the hub topic `app:<id>` while the agent works. */
export type ChatEvent =
  | { type: "started" }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "done" }
  /** A new chat started (a scheduled prompt): the current messages went to the tab's earlier chats. */
  | { type: "new-chat" };

// --- Web tabs -----------------------------------------------------------------------

/** CSS/JS the website agent made for a site, applied whenever it loads. */
export interface SiteOverride {
  host: string;
  css: string;
  js: string;
  enabled: boolean;
  updatedAt: string;
}

/** Where a page change applies: one page (host + path), a site (host) or a pattern ("*.example.com/*"). */
export interface PageScope {
  type: "page" | "site" | "pattern";
  value: string;
}

export type PageChangeAction = "hide" | "style" | "text" | "attribute" | "insert" | "button" | "css" | "script";

/**
 * One change to web pages (made by the website agent, or the user): hide,
 * restyle or rewrite elements, add elements or buttons, or a stylesheet or
 * script. Each can be turned off or removed on its own.
 */
export interface PageChangeSpec {
  /** What it does, for people ("Hide the cookie banner"). */
  title: string;
  scope: PageScope;
  action: PageChangeAction;
  /** The elements it applies to (all actions but css and script). */
  selector?: string;
  /**
   * style: CSS declarations; text: the new text; attribute: its value;
   * insert: HTML; button: its label; css: a stylesheet; script: JavaScript.
   */
  value?: string;
  /** attribute: its name. */
  name?: string;
  /** insert and button: where, relative to each matched element (default "after"). */
  position?: "before" | "after" | "prepend" | "append";
  /** button: JavaScript run on click, with `event` and `button`. */
  onClick?: string;
}

export interface PageChange extends PageChangeSpec {
  id: string;
  enabled: boolean;
  createdBy: "agent" | "user";
  /** The mod it came with (removed with it). */
  modId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Schedules --------------------------------------------------------------------

/**
 * When a schedule runs: once at a time, on a cron expression (local time),
 * or on an event: "rune.started", "app.started:<appId>",
 * "app.crashed:<appId>", or one an app sends ("app:<appId>:<name>").
 */
export type ScheduleTrigger =
  { type: "once"; at: string } | { type: "cron"; cron: string } | { type: "event"; event: string };

/**
 * What a schedule does: use one of an app's tools, run a command in its
 * sandbox, or ask a tab's agent something (each run is a new chat in the tab).
 * A prompt runs in an existing tab (`appId`), or in one it opens on its first
 * run (`newTab`; the schedule then keeps using that tab).
 */
export type ScheduleTask =
  | { type: "tool"; appId: string; tool: string; params?: Record<string, unknown>; input?: string }
  | { type: "command"; appId: string; command: string }
  | { type: "prompt"; prompt: string; appId?: string; newTab?: { kind: TabKind; workspaceId: string; url?: string } };

export interface ScheduleSpec {
  name: string;
  trigger: ScheduleTrigger;
  task: ScheduleTask;
  /** When to tell the user about a finished run. */
  notify: "always" | "failure" | "never";
  /** A run is stopped after this long. */
  timeoutSec: number;
}

export interface Schedule extends ScheduleSpec {
  id: string;
  /** The task's tab's workspace. */
  workspaceId: string;
  paused: boolean;
  createdBy: "user" | "agent";
  /** The next time it runs (null: paused, an event, or a one-off that ran). */
  nextRunAt: string | null;
  running: boolean;
  lastRun: ScheduleRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: number;
  scheduleId: string;
  scheduleName: string;
  /** What started it. */
  trigger: "time" | "event" | "manual";
  status: "running" | "ok" | "error" | "timeout" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  /** What happened, short. */
  message: string;
  /** The tool's result or the command's output (the end of it). */
  output: string | null;
}

// --- Secrets ----------------------------------------------------------------------

/** "global", "workspace:<id>" (shared by the workspace's apps), or the id of the app tab the secret belongs to. */
export type SecretScope = "global" | `workspace:${string}` | (string & {});

export const workspaceScope = (workspaceId: string) => `workspace:${workspaceId}` as const;
export const workspaceOfScope = (scope: string) =>
  scope.startsWith("workspace:") ? scope.slice("workspace:".length) : null;

/** A secret without its value: values never leave the server once saved. */
export interface SecretInfo {
  id: string;
  scope: SecretScope;
  /** Environment variable name, e.g. STRIPE_KEY. */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Last time an app was started with it. */
  lastUsedAt: string | null;
}

export interface SecretsOverview {
  /**
   * keychain: the encryption key is protected by the OS keychain.
   * file: by file permissions only (no keychain available).
   * locked: the key can't be unlocked, secrets can't be used.
   */
  protection: "keychain" | "file" | "locked";
  secrets: SecretInfo[];
}

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Names Rune Browser sets itself (or that would break app processes). */
export const isReservedSecretName = (name: string) =>
  /^(RUNE_|BUN_|NODE_|NPM_|LD_|DYLD_)/.test(name) ||
  [
    "PORT",
    "HOST",
    "APP_URL",
    "DATABASE_PATH",
    "DATABASE_URL",
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "NO_COLOR",
    "SHELL",
    "USER",
  ].includes(name);

// --- Network (web tabs' traffic) ---------------------------------------------------

export interface NetworkEntrySummary {
  id: string;
  method: string;
  url: string;
  /** Chrome's resource type: Document, XHR, Fetch, Script, Image… */
  type: string;
  /** null while it's pending (or when it failed). */
  status: number | null;
  mimeType: string;
  /** Bytes received over the network. */
  size: number;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number | null;
  error: string | null;
  /** The pattern of the rule that blocked or changed it. */
  rule: string | null;
  /** The title of the response override that answered it instead of the site (or changed the answer). */
  override: string | null;
  /** The response body was kept (structured data only). */
  hasBody: boolean;
}

export interface NetworkEntry extends NetworkEntrySummary {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  /** Why there's no response body (not structured data, too large, dropped to save memory). */
  bodyNote: string | null;
  /** Credentials (cookies, tokens, passwords) were replaced with "[redacted]". */
  redacted: boolean;
}

export interface NetworkFilter {
  /** Text in the URL, method, type or status. */
  query?: string;
  /** data: fetch/XHR and other structured responses only. */
  kind?: "data" | "all";
  limit?: number;
}

export type ReplayTarget = { webContentsId: number; id: string } | { workspaceId: string; draft: RequestDraft };

export interface ReplayOverrides {
  url?: string;
  method?: string;
  /** Headers to set; null removes one. */
  headers?: Record<string, string | null>;
  body?: string | null;
}

export interface ReplayResult {
  url: string;
  status: number;
  statusText: string;
  mimeType: string;
  headers: Record<string, string>;
  /** Text responses only, up to 512 kB. */
  body: string | null;
  truncated: boolean;
  size: number;
  durationMs: number;
  redacted: boolean;
}

/** A captured request, prepared to be saved. */
export interface RequestDraft {
  method: string;
  url: string;
  /** Without cookies (the session sends its own) and credentials (sealed). */
  headers: Record<string, string>;
  body: string | null;
  /** Credential headers (Authorization…), encrypted with a key only Rune Browser's main process uses. */
  sealed: string | null;
}

/** A request kept to be sent again later with the workspace's session, without opening the site. */
export interface SavedRequest {
  id: string;
  workspaceId: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** It carries credentials besides the session's cookies (sealed, never shown). */
  hasCredentials: boolean;
  createdAt: string;
}

/** Blocks or changes web tabs' requests. */
export interface NetworkRule {
  id: string;
  /** null: every workspace. */
  workspaceId: string | null;
  /** "*" wildcards over the whole URL ("*://*.doubleclick.net/*"), or text the URL contains. */
  pattern: string;
  action: "block" | "modify";
  /** modify: request headers to set (null removes one). */
  requestHeaders: Record<string, string | null>;
  /** modify: response headers to set (null removes one). */
  responseHeaders: Record<string, string | null>;
  enabled: boolean;
  createdAt: string;
}

/** Where a response override applies, within its workspace. */
export type OverrideScope =
  /** One tab (goes away with it). */
  | { type: "tab"; tabId: string }
  /** Pages of one site (the page's host, wherever its requests go). */
  | { type: "site"; host: string }
  /** Every web tab of the workspace. */
  | { type: "workspace" };

/** How a request fails (Chrome's network error reasons). */
export type OverrideFailure =
  "Failed" | "TimedOut" | "ConnectionRefused" | "InternetDisconnected" | "NameNotResolved" | "Aborted";

/** What a response override does (see shared/overrides.ts). */
export interface ResponseOverrideSpec {
  /** What it's for: "Empty feed", "Server error on save". */
  title: string;
  scope: OverrideScope;
  /** Requests it answers: "*" wildcards over the whole URL, or text the URL contains (as network rules). */
  pattern: string;
  /** null: every method. */
  method: string | null;
  /**
   * respond: what comes back (status, headers, body; what isn't set comes from the site);
   * fail: the request fails as if the network did; hang: it never answers (loading forever).
   */
  kind: "respond" | "fail" | "hang";
  /** respond: null keeps the site's. */
  status: number | null;
  /** respond: headers to set (null removes one). */
  headers: Record<string, string | null>;
  /** respond: null keeps the site's. */
  body: string | null;
  /** fail: how. */
  failure: OverrideFailure;
  /** respond and fail: the answer comes this much later (a slow response). */
  delayMs: number;
  /** It goes away by itself then; null: when it's removed (or its tab closes). */
  expiresAt: string | null;
}

/** Changes what a site's requests return in a workspace's web tabs, without the site. Made by the website agent; the user sees and removes them. */
export interface ResponseOverride extends ResponseOverrideSpec {
  id: string;
  workspaceId: string;
  createdAt: string;
}

// --- Permissions and audit log ----------------------------------------------------

/**
 * app.ai: an app's server uses AI (resource: "").
 * app.secret: an app uses a global secret (resource: its name).
 * agent.site: the website agent customizes a site (subject "website-agent", resource: the host).
 * agent.network: the website agent sends requests to a site with the user's session (resource: the host).
 * agent.override: the website agent changes what a site's requests return (resource: the host of the tab's page).
 * app.data: an app reads another app's data (resource: that app's id).
 */
export type PermissionAction =
  | "app.ai"
  | "app.secret"
  | "agent.site"
  | "agent.network"
  | "agent.override"
  | "app.data"
  | "app.endpoints"
  | "app.tool"
  | "agent.schedule"
  | "agent.tab"
  | "agent.browse"
  | "agent.confirm"
  | "agent.source";

export interface PermissionGrant {
  id: number;
  /** An app id, "workspace:<id>" (every app in it), or "website-agent". */
  subject: string;
  subjectName: string;
  /** The workspace the subject is in (or is); null for the website agent. */
  workspaceId: string | null;
  action: PermissionAction;
  resource: string;
  decision: "allow" | "deny";
  createdAt: string;
}

/** Something waiting for the user's answer. */
export interface PermissionRequest {
  id: string;
  subject: string;
  subjectName: string;
  /** The app's workspace (its answer can be remembered for the whole workspace); null for the website agent. */
  workspace: { id: string; name: string } | null;
  action: PermissionAction;
  resource: string;
  title: string;
  detail: string;
  /** Confirms one action: there's no remembering the answer. */
  once?: boolean;
  /** The change it wants to make, as a unified diff (an agent editing code). */
  diff?: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  /** Who did it. */
  actor: "user" | "agent" | "app" | "rune";
  /** e.g. "Claude Code (haiku)", the app's name, "You". */
  actorLabel: string;
  /** The tab it happened in, if any. */
  tabId: string | null;
  /** The workspace of that tab (or of the workspace secret), if any. */
  workspaceId: string | null;
  /** e.g. "tool.run_command", "secret.create", "ai.request", "permission.allow". */
  action: string;
  /** What was affected (file, secret name, host…). Never secret values. */
  target: string | null;
  detail: string | null;
  outcome: "ok" | "denied" | "error";
}

// --- History (snapshots) ------------------------------------------------------------

/**
 * What a snapshot covers. app:<id>: the app's project files and its data
 * (SQLite databases). sites: the website agent's site customizations.
 * settings: Rune Browser's settings and the workspaces' settings.
 */
export type HistoryTarget = `app:${string}` | "sites" | "settings";

export const appTarget = (appId: string) => `app:${appId}` as const;
export const appOfTarget = (target: string) => (target.startsWith("app:") ? target.slice(4) : null);

/** Row counts of a database's tables, before and after (null: the table didn't exist). */
export type TableChanges = Record<string, [number | null, number | null]>;

export interface HistoryEntry {
  id: number;
  target: HistoryTarget;
  /** App targets: the tab and its workspace. */
  tabId: string | null;
  workspaceId: string | null;
  at: string;
  /** Who made the change. */
  actor: AuditEntry["actor"];
  actorLabel: string;
  /** What happened, e.g. the prompt the agent worked on. */
  summary: string;
  /** Files compared with the previous snapshot of the same target (all "added" for the first). */
  added: string[];
  modified: string[];
  removed: string[];
  /** Databases whose tables changed: path → table → row counts. */
  data: Record<string, TableChanges>;
  /** The first snapshot of its target (nothing to undo). */
  first: boolean;
}

export interface HistoryFile {
  path: string;
  status: "added" | "modified" | "removed";
  /** text: hunks below. data: a database (tables). binary / large: no line diff. */
  kind: "text" | "binary" | "data" | "large";
  hunks?: Hunk[];
  /** Lines added and removed (text). */
  linesAdded?: number;
  linesRemoved?: number;
  tables?: TableChanges;
}

export interface HistoryDetail {
  entry: HistoryEntry;
  files: HistoryFile[];
}
