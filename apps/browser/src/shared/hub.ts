// The Rune Browser hub: one WebSocket between the renderer and the server. The server
// pushes chat events, site customization changes
// and provider status on topics; the renderer answers RPC requests (the agents
// use them to reach pages open in tabs).
import type {
  AppSummary,
  AuditEntry,
  ChatEvent,
  ContextSource,
  HistoryEntry,
  PermissionRequest,
  ProviderStatus,
  ScheduleRun,
  WorkspaceInfo,
} from "./api";
import type { BookmarkChange } from "./bookmarks";
import type { Settings } from "./settings";

export const topics = {
  /** A tab's chat events and attached code. */
  app: (appId: string) => `app:${appId}`,
  /** Site customizations for web tabs changed. */
  sites: "sites",
  /** Provider status (installed, signed in, models) changed. */
  providers: "providers",
  /** The list of tabs changed (created, renamed, moved, deleted). */
  apps: "apps",
  /** Workspaces were created, changed or deleted. */
  workspaces: "workspaces",
  /** Permission requests waiting for the user, and answers. */
  permissions: "permissions",
  /** New audit log entries; remembered permissions changed. */
  activity: "activity",
  /** New snapshots, restores. */
  history: "history",
  /** The settings were changed by the server (restored from history). */
  settings: "settings",
  /** Network rules or saved requests changed (refetch). */
  network: "network",
  /** Schedules changed, runs started and finished. */
  schedules: "schedules",
  /** Mods were installed, turned on or off, or removed (refetch). */
  mods: "mods",
  /** Browsing history changed: a page was visited, visits were deleted (refetch). */
  visits: "visits",
  /** Bookmarks were added, changed, moved, removed or imported. */
  bookmarks: "bookmarks",
} as const;

export const isValidTopic = (topic: unknown): topic is string =>
  typeof topic === "string" &&
  topic.length < 200 &&
  (/^app:[\w-]+$/.test(topic) || (Object.values(topics) as unknown[]).includes(topic));

export type ClientMessage =
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  /** A window's renderer: the tabs in its window (requests about them go there). */
  | { type: "tabs"; ids: string[] }
  | { type: "rpc-result"; id: number; result?: unknown; error?: string };

export type ServerMessage =
  | { type: "chat"; topic: string; appId: string; event: ChatEvent }
  /** The code attached to a tab for its agent changed; progress of cloning or pulling one. */
  | { type: "sources"; topic: string; appId: string; sources: ContextSource[] }
  | { type: "source-progress"; topic: string; appId: string; sourceId: string; phase: string; percent: number | null }
  | { type: "site"; topic: string; host: string }
  /** Page changes were added, changed or removed (refetch). */
  | { type: "page-changes"; topic: string }
  /** Schedules were added, changed or removed (refetch). */
  | { type: "schedules-changed"; topic: string }
  /** A run started or finished; notify: tell the user (it finished, and the schedule wants that). */
  | { type: "schedule-run"; topic: string; run: ScheduleRun; notify: boolean }
  | { type: "providers"; topic: string; providers: ProviderStatus[] }
  | { type: "app"; topic: string; app: AppSummary }
  | { type: "app-deleted"; topic: string; appId: string }
  | { type: "workspace"; topic: string; workspace: WorkspaceInfo }
  | { type: "workspace-deleted"; topic: string; workspaceId: string }
  | { type: "permission-request"; topic: string; request: PermissionRequest }
  | { type: "permission-resolved"; topic: string; id: string }
  | { type: "audit"; topic: string; entry: AuditEntry }
  /** Remembered permissions changed (refetch). */
  | { type: "permissions-changed"; topic: string }
  | { type: "snapshot"; topic: string; entry: HistoryEntry }
  /** Snapshots were restored or removed (refetch). */
  | { type: "history-changed"; topic: string; target: string }
  | { type: "settings"; topic: string; settings: Settings }
  | { type: "network-changed"; topic: string; what: "rules" | "requests" | "overrides" }
  | { type: "mods-changed"; topic: string }
  /** A workspace's browsing history changed (null: every workspace's). */
  | { type: "visits-changed"; topic: string; workspaceId: string | null }
  | { type: "bookmarks"; topic: string; change: BookmarkChange }
  | { type: "rpc"; id: number; method: string; params: unknown };

export type TopicMessage = Exclude<ServerMessage, { type: "rpc" }>;

type Handler = (msg: TopicMessage) => void;

/** A WebSocket to the Rune Browser hub that reconnects and re-subscribes on its own. */
export class Socket {
  private ws: WebSocket | undefined;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 0;
  private closed = false;
  private listeners = new Set<(connected: boolean) => void>();
  onRpc: ((method: string, params: unknown) => unknown) | undefined;
  connected = false;

  /** Connects once `ready` resolves (the server may still be starting), or right away. */
  constructor(
    private url: string,
    ready?: Promise<unknown>,
  ) {
    if (ready) ready.then(this.open.bind(this), this.open.bind(this));
    else this.open();
  }

  private open() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      // Subscribe before telling listeners, so what they refetch can't miss a change.
      for (const topic of this.handlers.keys()) this.raw({ type: "subscribe", topic });
      if (this.tabs) this.raw({ type: "tabs", ids: this.tabs });
      this.setConnected(true);
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      if (msg.type === "rpc") return void this.answer(msg.id, msg.method, msg.params);
      for (const fn of this.handlers.get(msg.topic) ?? []) fn(msg);
    };
    ws.onclose = () => {
      this.setConnected(false);
      if (this.closed) return;
      const delay = Math.min(250 * 2 ** this.retry++, 5000);
      setTimeout(() => this.open(), delay);
    };
  }

  private setConnected(value: boolean) {
    this.connected = value;
    for (const fn of this.listeners) fn(value);
  }

  /** Called with true/false whenever the connection opens or drops. */
  onConnection(fn: (connected: boolean) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private async answer(id: number, method: string, params: unknown) {
    try {
      if (!this.onRpc) throw new Error("This client doesn't handle requests");
      this.raw({ type: "rpc-result", id, result: await this.onRpc(method, params) });
    } catch (err) {
      this.raw({ type: "rpc-result", id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private raw(msg: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private tabs: string[] | undefined;
  /** A window's renderer: says which tabs its window has (again after a reconnect). */
  setTabs(ids: string[]) {
    this.tabs = ids;
    this.raw({ type: "tabs", ids });
  }

  subscribe(topic: string, fn: Handler): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
      this.raw({ type: "subscribe", topic });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.handlers.get(topic) === set) {
        this.handlers.delete(topic);
        this.raw({ type: "unsubscribe", topic });
      }
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
