// Types shared between the Bun server, the Electron main/preload and the renderer.
import type { BookmarkChange } from "./bookmarks";
import type { BrowserSettings, ImportedBrowserSettings, SiteSettingKey } from "./browser";
import type { Hunk } from "./diff";
import type { DefaultBrowserStatus } from "./defaultBrowser";
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
import type { FlagsInfo } from "./flags";
import type { GpuReport, VersionInfo } from "./internalPages";
import type { WorkspaceSettings } from "./settings";
import type { TabHistory } from "./tabHistory";
import type {
  PromptAnswer,
  ScreenPick,
  ScreenPickRequest,
  SitePermissionPrompt,
  SitePermissionUsage,
  SystemPermissionNotice,
} from "./sitePermissions";
import type { UpdateChannel, UpdateInfo } from "./updates";
import type { DownloadAction, DownloadInfo, DownloadsChange } from "./downloads";

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

/** A web tab's page whose certificate isn't valid (main/web.ts), for its error page's details. */
export interface CertificateProblem {
  url: string;
  /** Chromium's error ("net::ERR_CERT_AUTHORITY_INVALID"). */
  error: string;
  subject: string;
  issuer: string;
  /** Milliseconds since the epoch. */
  validFrom: number;
  validUntil: number;
  /** "sha256/…" */
  fingerprint: string;
}

export interface RuneBridge {
  /** The window without a title bar (renderer: lib/windowChrome.ts, components/WindowControls.tsx). */
  window: {
    platform: string;
    minimize: () => void;
    toggleMaximize: () => void;
    /** macOS: shows or hides the traffic lights (they go with a hidden sidebar). */
    setButtonsVisible: (visible: boolean) => void;
    close: () => void;
    /** Closes the window without keeping it to reopen (its last tab went to another window). */
    discard: () => void;
    toggleFullScreen: () => void;
    /** Quits Rune Browser (Ctrl+Shift+Q). */
    quit: () => void;
    onMaximized: (fn: (maximized: boolean) => void) => () => void;
    /** This window's id (shared/windows.ts) and whether it's private. */
    id: string;
    private: boolean;
    /** What this window was opened for, asked once when it starts: a new tab (Ctrl+N), or nothing (its tabs are there). */
    takeIntent: () => Promise<"new-tab" | "startup" | null>;
    /** Opens a window: with these tabs moved into it (dragged out, "Move to new window"), else with a new tab. */
    open: (options?: { private?: boolean; tabIds?: string[]; at?: { x: number; y: number } }) => Promise<string | null>;
    /** The other open windows (not private ones from a normal window, nor the other way around), to move tabs to. */
    others: () => Promise<{ id: string; title: string }[]>;
    /** Brings a window to the front. */
    focus: (windowId: string) => void;
    /** Windows closed lately, newest first (reopened with their tabs). */
    closed: () => Promise<{ id: string; closedAt: number; tabs: number }[]>;
    /** Opens the window closed last again (or this one); false if there's none. */
    reopen: (windowId?: string) => Promise<boolean>;
  };
  /** Asks for a folder (a system dialog); null if none was picked. */
  pickFolder: (title: string) => Promise<string | null>;
  /** Files to open (Ctrl+O): their paths, none if cancelled. */
  pickFiles: () => Promise<string[]>;
  /**
   * Opens a local file or folder in the system's app ("open"), or shows it in its folder ("reveal"); programs and
   * scripts are always only shown. "opened", "revealed", or why not.
   */
  openPath: (path: string, how: "open" | "reveal") => Promise<string>;
  serverUrl: string;
  /** Sent with every request to the Rune Browser server (and the hub). */
  token: string;
  /** Resolves once the server is up and knows this window: it starts with the window, and takes a moment. */
  serverReady: () => Promise<void>;
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
  /** What Rune Browser's internal pages show (rune://version, rune://gpu, rune://flags; main/internals.ts). */
  internals: {
    version: () => Promise<VersionInfo>;
    gpu: () => Promise<GpuReport>;
    flags: () => Promise<FlagsInfo>;
    /** Sets a flag ("default" resets it); takes effect after a relaunch. */
    setFlag: (id: string, value: string) => Promise<FlagsInfo>;
    resetFlags: () => Promise<FlagsInfo>;
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
  /** Rune Browser as the system's default browser (main/defaultBrowser.ts). */
  defaultBrowser: {
    get: () => Promise<DefaultBrowserStatus>;
    /** Makes it the default (or opens the system's settings for it, on Windows); the status after. */
    make: () => Promise<DefaultBrowserStatus>;
  };
  /** The browser settings in web tabs (main/browser.ts). */
  browser: {
    /** The settings changed: they apply to web tabs. */
    setSettings: (settings: BrowserSettings) => void;
    /**
     * Clears cookies and site data and/or the cache of these workspaces' web tabs (extensions keep theirs):
     * all of it, or with `origins` only those sites' (the ones visited in a time range).
     */
    clearData: (
      workspaceIds: string[],
      what: { cookies: boolean; cache: boolean; origins?: string[] },
    ) => Promise<void>;
    /** The sites with cookies in a workspace. */
    siteData: (workspaceId: string) => Promise<{ site: string; cookies: number }[]>;
    /** Clears a site's cookies and data (its subdomains' too) in these workspaces. */
    clearSite: (workspaceIds: string[], site: string) => Promise<void>;
    /** The settings other browsers' profiles have (Import). */
    detectImports: () => Promise<{ key: string; browser: string; profile: string; found: ImportedBrowserSettings }[]>;
    /** The system's languages, spell check's dictionaries and the Downloads folder. */
    info: () => Promise<{ systemLanguages: string[]; spellcheckLanguages: string[]; downloadsFolder: string } | null>;
  };
  /** Downloads of every session (main/downloads.ts). */
  downloads: {
    /** Newest first. */
    list: () => Promise<DownloadInfo[]>;
    /** Resolves to a problem to show, or null. */
    act: (id: string, action: DownloadAction) => Promise<string | null>;
    /**
     * Removes what's finished from the list (the files stay). Clear browsing data's "Download history" passes
     * which: started since a time (ms), from these workspaces (null: from anywhere).
     */
    clear: (which?: { since: number | null; workspaceIds: string[] | null }) => Promise<void>;
    onChanged: (fn: (change: DownloadsChange) => void) => () => void;
  };
  web: {
    /** Deletes the cookies and storage of a workspace's web tabs (the workspace was deleted). */
    clearWorkspace: (workspaceId: string) => Promise<void>;
    /** A page asked to open a link in a new window: open it in a new web tab (in the background for Ctrl+click). */
    onOpenTab: (fn: (url: string, background?: boolean) => void) => () => void;
    /** Links and files from other apps (Rune Browser as the default browser): each in a new tab. */
    onOpenLinks: (fn: (urls: string[]) => void) => () => void;
    /** The window is ready for those links (the ones Rune Browser was started with come then). */
    linksReady: () => void;
    /** A keyboard shortcut pressed while a page had the focus, that the page passed on (main/shortcuts.ts). */
    onShortcut: (fn: (event: ShortcutEvent) => void) => () => void;
    /** The keys of every shortcut, for the keys pressed in pages (shared/shortcuts.ts). */
    setShortcuts: (bindings: Record<string, string[]>) => void;
    /** Opens DevTools on a page for the user, at a panel (F12, Ctrl+Shift+J, Ctrl+Shift+C). */
    openDevTools: (webContentsId: number, panel: "elements" | "console" | "sources" | "inspect") => void;
    /** Saves a page to a file the user picks (Ctrl+S). */
    savePage: (webContentsId: number) => Promise<void>;
    /** Screenshot of a web tab's page as base64 JPEG. */
    capture: (webContentsId: number) => Promise<string>;
    /** Opens a URL in the system browser. */
    openExternal: (url: string) => void;
    /** Where a dropped or picked file is on disk ("" for files that aren't on disk). */
    pathForFile: (file: File) => string;
    /** Downloads a URL (a local file the browser can't show) in a workspace's session, like Chrome does. */
    download: (workspaceId: string, url: string) => void;
    /** DevTools for the agents on a web tab's page: see main/devtools.ts. */
    devtools: (webContentsId: number, command: DevtoolsCommand, params?: object) => Promise<unknown>;
    /** The traffic of web tabs (see main/network.ts). Agents only ever get it with reveal off. */
    network: {
      list: (webContentsId: number, filter?: NetworkFilter) => Promise<NetworkEntrySummary[]>;
      /** reveal: with credentials (only for the user's own eyes). */
      get: (webContentsId: number, id: string, reveal: boolean) => Promise<NetworkEntry | null>;
      clear: (webContentsId: number) => Promise<void>;
      /**
       * A captured request an agent uses (always redacted): it's kept in the log
       * until the agent's chat ends. If it's gone, why.
       */
      use: (webContentsId: number, id: string, chat: string) => Promise<NetworkUse>;
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
    /** Sites asking for the camera, microphone, location, notifications… (main/sitePermissions.ts). */
    permissions: {
      /** Prompts waiting in this window (after it reloaded). */
      pending: () => Promise<SitePermissionPrompt[]>;
      usage: (webContentsId: number) => Promise<SitePermissionUsage | null>;
      /** The user's answer ("allow" and "block" are saved into the site's settings by the window, unless it's private). */
      reply: (requestId: string, answer: PromptAnswer) => void;
      /** Stops a tab's camera, microphone, screen sharing or location. */
      stop: (webContentsId: number, keys: SiteSettingKey[]) => Promise<void>;
      /** The screen picker's answer (null: cancelled). */
      pickScreen: (requestId: string, pick: ScreenPick | null) => void;
      /** Opens where the OS lets Rune Browser use a device. */
      openSystemSettings: (kind: SystemPermissionNotice["kind"]) => void;
      onPrompt: (fn: (prompt: SitePermissionPrompt) => void) => () => void;
      onPromptDone: (fn: (requestId: string) => void) => () => void;
      onUsage: (fn: (usage: SitePermissionUsage) => void) => () => void;
      onNotice: (fn: (notice: SystemPermissionNotice) => void) => () => void;
      onScreenPick: (fn: (request: ScreenPickRequest) => void) => () => void;
      onScreenPickDone: (fn: (requestId: string) => void) => () => void;
    };
    /** Which http:// pages web tabs open without a warning (shared/insecure.ts). */
    setInsecurePolicy: (policy: { enabled: boolean; allowed: readonly string[] }) => void;
    /** A web tab's page went (or was redirected) to an insecure page, and was held back. */
    onInsecure: (fn: (event: { contentsId: number; url: string }) => void) => () => void;
    /** A page started or stopped making sound (the tab's audio indicator). */
    onAudio: (fn: (event: { contentsId: number; audible: boolean }) => void) => () => void;
    /** Why a tab's page at `url` has no valid certificate (null: it's not that). */
    certificateProblem: (webContentsId: number, url: string) => Promise<CertificateProblem | null>;
    /** A web tab's back/forward history as the page has it now (shared/tabHistory.ts); null if it's gone. */
    navigationHistory: (webContentsId: number) => Promise<TabHistory | null>;
    /**
     * Has the next web tab created with `about:blank#rune-restore=<token>` start with this history instead of a
     * page (main/web.ts); false if it can't (nothing to restore).
     */
    restoreHistory: (token: string, history: TabHistory) => Promise<boolean>;
    /** The user goes on to a site whose certificate isn't valid (until Rune Browser quits); false if it can't. */
    proceedAnyway: (webContentsId: number, url: string) => Promise<boolean>;
    /** The search engine Settings picked, for "Search … for" in a page's menu. */
    setSearchEngine: (engine: { label: string; url: string }) => void;
    /** Headless tabs: pages the website agent loads in the background (main/headless.ts). */
    headless: {
      open: (request: HeadlessOpenRequest) => Promise<HeadlessPage>;
      navigate: (id: string, url: string, hosts?: string[]) => Promise<HeadlessPage>;
      eval: (id: string, code: string) => Promise<unknown>;
      close: (id: string) => Promise<boolean>;
      /** Closes the ones a tab's agent opened (its turn ended); how many. */
      closeTab: (tabId: string) => Promise<number>;
      list: () => Promise<HeadlessInfo[]>;
      onChanged: (fn: (list: HeadlessInfo[]) => void) => () => void;
    };
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
    /** Lets it run in private windows too. */
    setAllowPrivate: (id: string, allowed: boolean) => Promise<void>;
    /** Allows or blocks one of its permissions (the extension restarts with it). */
    setPermission: (id: string, permission: string, allowed: boolean) => Promise<void>;
    /** Gives or takes back one of the optional sites it asks for. */
    setSiteAccess: (id: string, pattern: string, allowed: boolean) => Promise<void>;
    setPinned: (id: string, pinned: boolean) => Promise<void>;
    remove: (id: string) => Promise<void>;
    setAutoUpdate: (enabled: boolean) => Promise<void>;
    /** Checks for updates now; resolves with how many were updated. */
    update: () => Promise<number>;
    /** Which web tabs there are (extensions see them as their tabs). */
    setTabs: (tabs: ExtensionTabs) => void;
    /** Answers a tab or permission request. */
    reply: (requestId: string, value: unknown) => void;
    /** Passes on bookmark changes from the server, for extensions' chrome.bookmarks events. */
    bookmarksChanged: (change: BookmarkChange) => void;
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
  workspaceId === PRIVATE_WORKSPACE
    ? PRIVATE_PARTITION
    : workspaceId === DEFAULT_WORKSPACE
      ? WEB_PARTITION
      : `persist:web-${workspaceId}`;
export const WEB_PARTITION_PATTERN = /^persist:(web(-[\w-]+)?|private-web)$/;
/**
 * Private windows' web tabs: one session, wiped when the last private window closes and whenever
 * Rune Browser starts. (Electron runs no extensions in a session kept in memory only.) It stands
 * in for a workspace wherever web sessions are per workspace.
 */
export const PRIVATE_WORKSPACE = "private";
export const PRIVATE_PARTITION = "persist:private-web";
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
 * A group of tabs with its own agent defaults and instructions, and its own
 * web session (logins).
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

// --- Tabs ---------------------------------------------------------------------------

export interface AppSummary {
  id: string;
  workspaceId: string;
  name: string;
  /** Its own icon (see TabIcon): a Lucide icon name, an emoji or an image (data URL). Null: the default (web tabs: the site's favicon). */
  icon: string | null;
  /** The current URL and favicon. */
  url: string | null;
  favicon: string | null;
  /** Kept loaded: not unloaded when it hasn't been used for a while. */
  pinned: boolean;
  /** Its place in the workspace's list (ties: creation order). */
  position: number;
  createdAt: string;
  updatedAt: string;
  /** The window it's in (shared/windows.ts); null until it's given one. */
  windowId: string | null;
  /** In a private window: a tab whose pages keep nothing, which agents don't see. */
  private: boolean;
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
  /** The current chat's background jobs (running and ended ones). */
  jobs: JobInfo[];
  /** Last provider/model/effort used for this tab (null = the defaults from Settings). */
  agent: AgentChoice | null;
}

/**
 * Code attached to a tab for its agent: a folder of yours, used in place, or
 * a Git repository Rune Browser cloned (server: sources/Sources.ts).
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

// --- Chat ----------------------------------------------------------------------

export interface ChatRequest {
  prompt: string;
  agent?: Partial<AgentChoice>;
  /** The page and the elements the user picked. */
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

/**
 * A path the agent linked in the chat (`[name](<path>)`), looked up for its chip
 * (POST /api/apps/:id/files/lookup): only inside the tab's chat folders; anything
 * else is "outside", without saying whether it exists.
 */
export interface PathInfo {
  /** The path as the agent wrote it. */
  input: string;
  kind: "file" | "folder" | "missing" | "outside";
  /** Its absolute path (null when outside). */
  path: string | null;
  name: string;
  mime?: string;
  size?: number;
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
 * Only tabs of the same workspace can be shared, and never private ones.
 */
export function shareRefusal(
  recipient: Pick<AppSummary, "id" | "workspaceId">,
  source: Pick<AppSummary, "id" | "workspaceId" | "name" | "private"> | null | undefined,
) {
  // Agents don't see private windows at all, not even their tabs' names.
  if (!source || source.private) return "That tab doesn't exist anymore.";
  if (source.id === recipient.id) return "That's this tab itself.";
  if (source.workspaceId !== recipient.workspaceId) return `“${source.name}” is in another workspace.`;
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
   * attachments: files sent with the next message (JSON: Attachment[]).
   * files: files of the chat's folder the agent shows the user (JSON: ChatFile[]).
   */
  role: "user" | "assistant" | "tool" | "error" | "context" | "attachments" | "files";
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
  | "customize"
  | "snapshot"
  | "source"
  | "tab"
  | "other";

/** A tool call of the agent: the content of a `tool` chat message. */
export interface ToolActivity {
  kind: ToolKind;
  /** One line: "Customized example.com". */
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
  | { type: "new-chat" }
  /** The chat's background jobs changed (started, progressed, ended). */
  | { type: "jobs"; jobs: JobInfo[] };

/**
 * Long-running work an agent started in the background (server: agent/Jobs.ts): a request for
 * each item in a list, or a page script. It belongs to the chat it was started in and ends when
 * that chat or its tab is closed; the user sees it above the composer and can stop it.
 */
export interface JobInfo {
  /** "j1", "j2"… (per tab). */
  id: string;
  kind: "requests" | "script";
  /** What it does, in a few words: "request #981 × 39", "Page script". */
  title: string;
  state: "running" | "done" | "failed" | "canceled";
  /** How far it got, when it knows: items done out of total. */
  done: number | null;
  total: number | null;
  /** The last progress note it gave ("page 3 of 12"). */
  note: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Where its results went in the chat's folder, once saved. */
  file: ChatFile | null;
  error: string | null;
}

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
 * or on an event ("rune.started": when Rune Browser starts).
 */
export type ScheduleTrigger =
  { type: "once"; at: string } | { type: "cron"; cron: string } | { type: "event"; event: string };

/**
 * Where a scheduled task runs: a tab of a workspace, or a new tab it opens on
 * its next run (and then keeps). When its tab is closed, the task stays:
 * `tabId` is cleared and the next run opens a new tab at the address the old
 * one was on.
 */
export interface ScheduleTarget {
  workspaceId: string;
  /** The tab it runs in (null: it opens one on its next run). */
  tabId: string | null;
  /** The website a new tab opens (null: an empty tab). */
  url: string | null;
}

/**
 * A scheduled task: a prompt for an agent, sent on its own (each run is a new
 * chat in its tab, as if the user had sent it).
 */
export interface ScheduleSpec {
  name: string;
  trigger: ScheduleTrigger;
  prompt: string;
  target: ScheduleTarget;
  /** Who answers: provider, model and effort (null: the workspace's default agent). */
  agent: AgentChoice | null;
  /** When to tell the user about a finished run. */
  notify: "always" | "failure" | "never";
  /** A run is stopped after this long. */
  timeoutSec: number;
}

export interface Schedule extends ScheduleSpec {
  id: string;
  /** The workspace it runs in: its tab's, else its target's. */
  workspaceId: string;
  paused: boolean;
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
  /** The agent's reply (the end of it), kept when its tab is gone. */
  output: string | null;
  /** The tab the run's chat is in (null: it didn't get that far). */
  tabId: string | null;
}

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

/** A captured request an agent asked for, or why it's no longer in the log. */
export type NetworkUse = { entry: NetworkEntry } | { gone: string };

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

// --- Headless tabs -----------------------------------------------------------------------

/** Opening a headless tab (main/headless.ts). */
export interface HeadlessOpenRequest {
  /** The tab whose agent opened it (it's listed there). */
  tabId: string;
  /** The workspace whose logins it uses, with `logins`. */
  workspaceId: string;
  url: string;
  /** With the workspace's logins (cookies); else in an empty session that forgets everything. */
  logins: boolean;
  /** With logins: the hosts the user allowed; the page can't go to others. */
  hosts?: string[];
}

/** Where a headless tab is after loading something. */
export interface HeadlessPage {
  id: string;
  url: string;
  title: string;
  /** A navigation that was stopped: not a website (this computer, the local network), or with logins a site the user didn't allow. */
  blocked?: { url: string; reason: "not-a-website" | "not-allowed" };
  /** Why loading failed (no such site, no connection), if it did. */
  error?: string;
}

/** An open headless tab, as the agent's tab lists it. */
export interface HeadlessInfo {
  id: string;
  tabId: string;
  url: string;
  title: string;
  logins: boolean;
  openedAt: number;
}

// --- Permissions and audit log ----------------------------------------------------

/**
 * agent.site: the website agent customizes a site (subject "website-agent", resource: the host).
 * agent.network: the website agent sends requests to a site with the user's session (resource: the host).
 * agent.override: the website agent changes what a site's requests return (resource: the host of the tab's page).
 * agent.headless: the website agent loads a site in a headless tab with the user's logins (resource: the host).
 * agent.browse / agent.confirm: the website agent uses a site for the user, and each action with consequences.
 * agent.tab: an agent reads another tab (subject: its tab, resource: the other tab).
 * agent.source: an agent changes code attached to its tab (subject: its tab, resource: the source).
 */
export type PermissionAction =
  | "agent.site"
  | "agent.network"
  | "agent.override"
  | "agent.tab"
  | "agent.browse"
  | "agent.headless"
  | "agent.confirm"
  | "agent.source";

/** A permission subject standing for every tab of a workspace: an answer remembered for all of them. */
export const workspaceScope = (workspaceId: string) => `workspace:${workspaceId}` as const;
export const workspaceOfScope = (scope: string) =>
  scope.startsWith("workspace:") ? scope.slice("workspace:".length) : null;

export interface PermissionGrant {
  id: number;
  /** A tab id, "workspace:<id>" (every tab in it), or "website-agent". */
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
  /** The tab's workspace (its answer can be remembered for the whole workspace); null for the website agent. */
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
  actor: "user" | "agent" | "rune";
  /** e.g. "Website agent · Claude Code (haiku)", "You". */
  actorLabel: string;
  /** The tab it happened in, if any. */
  tabId: string | null;
  /** The workspace of that tab, if any. */
  workspaceId: string | null;
  /** e.g. "tool.get_page", "site.save", "permission.allow". */
  action: string;
  /** What was affected (file, host…). */
  target: string | null;
  detail: string | null;
  outcome: "ok" | "denied" | "error";
}

// --- History (snapshots) ------------------------------------------------------------

/**
 * What a snapshot covers. sites: the site customizations and page changes.
 * settings: Rune Browser's settings and the workspaces' settings.
 */
export type HistoryTarget = "sites" | "settings";

export interface HistoryEntry {
  id: number;
  target: HistoryTarget;
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
  /** The first snapshot of its target (nothing to undo). */
  first: boolean;
}

export interface HistoryFile {
  path: string;
  status: "added" | "modified" | "removed";
  /** text: hunks below. binary / large: no line diff. */
  kind: "text" | "binary" | "large";
  hunks?: Hunk[];
  /** Lines added and removed (text). */
  linesAdded?: number;
  linesRemoved?: number;
}

export interface HistoryDetail {
  entry: HistoryEntry;
  files: HistoryFile[];
}
