// The running side of extensions in web tab sessions: which extension pages
// and service workers are alive and what events they listen to, delivering
// events to them (starting a stopped service worker when its event comes, like
// Chrome), and the state Rune Browser keeps for each extension in each workspace
// (toolbar button, context menu items, what it was told at install).
import type { ServiceWorkerMain, Session, WebContents, WebFrameMain } from "electron";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./registry";

export interface Context {
  key: string;
  extensionId: string;
  session: Session;
  /** Events it has listeners for. */
  events: Set<string>;
  /** A page (web tab, popup, iframe) or the service worker. */
  frame: WebFrameMain | null;
  contents: WebContents | null;
  worker: ServiceWorkerMain | null;
  send: (name: string, args: unknown[]) => void;
  alive: () => boolean;
}

export interface ActionState {
  title: string;
  /** data: URL or chrome-extension:// URL of an image. */
  icon: string | null;
  badge: string;
  badgeColor: [number, number, number, number];
  badgeTextColor: [number, number, number, number] | null;
  /** chrome-extension:// URL, or "" for none. */
  popup: string;
  enabled: boolean;
}

export interface MenuItem {
  id: string | number;
  parentId?: string | number;
  title?: string;
  type?: "normal" | "checkbox" | "radio" | "separator";
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  contexts?: string[];
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
}

export type Lifecycle =
  | { event: "runtime.onInstalled"; details: { reason: "install" | "update"; previousVersion?: string } }
  | { event: "runtime.onStartup"; details: null };

interface StoredState {
  version?: string;
  menus?: MenuItem[];
  seeded?: boolean;
  /** chrome.sidePanel: the page it set, and whether its toolbar button opens it (shown as its popup). */
  sidePanel?: { path?: string; openOnAction?: boolean };
}

/** What Rune Browser keeps for one extension in one workspace's session. */
export class ExtensionState {
  action: ActionState;
  tabActions = new Map<number, Partial<ActionState>>();
  menus: MenuItem[];
  /** Events its service worker listened for (it's started for them when it's stopped). */
  backgroundEvents = new Set<string>();
  lifecycle: Lifecycle | null = null;
  /** Installed or updated: the manifest's rulesets get turned on (once). */
  resetRulesets = false;
  stored: StoredState;

  constructor(
    private file: string,
    initial: ActionState,
  ) {
    this.action = initial;
    this.stored = readJson<StoredState>(file) ?? {};
    this.menus = Array.isArray(this.stored.menus) ? this.stored.menus : [];
  }

  save() {
    this.stored.menus = this.menus;
    try {
      writeJson(this.file, this.stored);
    } catch (err) {
      console.warn("Couldn't save an extension's state:", err);
    }
  }

  actionFor(tabId: number | null): ActionState {
    const tab = tabId === null ? undefined : this.tabActions.get(tabId);
    return tab ? { ...this.action, ...tab } : this.action;
  }

  static remove(file: string) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

/** The folder in a session's storage where Rune Browser keeps extensions' state. */
export const STATE_FOLDER = "Rune Browser Extensions";

/** Where a session keeps Rune Browser's state for an extension. */
export const stateFile = (s: Session, id: string) => join(s.storagePath ?? "", STATE_FOLDER, `${id}.json`);

export class Contexts {
  private all = new Map<string, Context>();
  /** Waiting for a started worker to listen for an event. */
  private waiters = new Set<{ ctx: (c: Context) => boolean; resolve: (c: Context) => void }>();

  add(ctx: Context) {
    const previous = this.all.get(ctx.key);
    // A page that reloaded starts over.
    if (previous) previous.events.clear();
    this.all.set(ctx.key, previous ? Object.assign(previous, { ...ctx, events: previous.events }) : ctx);
    return this.all.get(ctx.key)!;
  }

  get(key: string) {
    return this.all.get(key);
  }

  remove(key: string) {
    this.all.delete(key);
  }

  /** Forgets the contexts that are gone. */
  prune() {
    for (const [key, ctx] of this.all) if (!ctx.alive()) this.all.delete(key);
  }

  of(session: Session, extensionId: string) {
    this.prune();
    return [...this.all.values()].filter((c) => c.session === session && c.extensionId === extensionId);
  }

  inSession(session: Session) {
    this.prune();
    return [...this.all.values()].filter((c) => c.session === session);
  }

  removeWhere(fn: (c: Context) => boolean) {
    for (const [key, ctx] of this.all) if (fn(ctx)) this.all.delete(key);
  }

  listened(ctx: Context, event: string) {
    ctx.events.add(event);
    for (const w of [...this.waiters]) {
      if (!w.ctx(ctx)) continue;
      this.waiters.delete(w);
      w.resolve(ctx);
    }
  }

  /** The next context matching, as soon as one is there (or null after a while). */
  waitFor(fn: (c: Context) => boolean, ms: number): Promise<Context | null> {
    const existing = [...this.all.values()].find((c) => c.alive() && fn(c));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter = { ctx: fn, resolve: (c: Context | null) => resolve(c) };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (this.waiters.delete(waiter)) resolve(null);
      }, ms);
    });
  }
}

const startedWorkers = new WeakMap<ServiceWorkerMain, { end: () => void; timer: ReturnType<typeof setTimeout> }>();
const runningWorkers = new WeakSet<ServiceWorkerMain>();

/** Follows a worker's running status (keepAlive only touches running ones: Electron crashes otherwise). */
export function workerStatus(worker: ServiceWorkerMain, status: string) {
  if (status === "running") return void runningWorkers.add(worker);
  runningWorkers.delete(worker);
  const task = startedWorkers.get(worker);
  if (!task) return;
  clearTimeout(task.timer);
  startedWorkers.delete(worker);
}

/** An event keeps a service worker alive for a while, like in Chrome. */
export function keepAlive(worker: ServiceWorkerMain) {
  if (worker.isDestroyed() || !runningWorkers.has(worker)) return;
  const current = startedWorkers.get(worker);
  if (current) {
    clearTimeout(current.timer);
    current.timer = setTimeout(current.end, 30_000);
    return;
  }
  let task: { end: () => void };
  try {
    task = worker.startTask();
  } catch {
    return;
  }
  const end = () => {
    startedWorkers.delete(worker);
    if (!worker.isDestroyed() && runningWorkers.has(worker)) task.end();
  };
  startedWorkers.set(worker, { end, timer: setTimeout(end, 30_000) });
}

/**
 * Delivers an event to an extension's pages and service worker in a session.
 * With `wake`, a stopped service worker that listened for it before is
 * started and gets it once it listens again. Resolves with how many got it.
 */
export async function dispatch(
  contexts: Contexts,
  state: ExtensionState | undefined,
  session: Session,
  extensionId: string,
  event: string,
  args: unknown[],
  wake = true,
) {
  const targets = contexts.of(session, extensionId).filter((c) => c.events.has(event));
  for (const ctx of targets) {
    if (ctx.worker) keepAlive(ctx.worker);
    ctx.send(event, args);
  }
  if (!wake || targets.some((c) => c.worker) || !state?.backgroundEvents.has(event)) return targets.length;
  const scope = `chrome-extension://${extensionId}/`;
  try {
    await session.serviceWorkers.startWorkerForScope(scope);
  } catch {
    return targets.length;
  }
  const ctx = await contexts.waitFor(
    (c) => c.worker !== null && c.session === session && c.extensionId === extensionId && c.events.has(event),
    5000,
  );
  if (!ctx) return targets.length;
  if (ctx.worker) keepAlive(ctx.worker);
  ctx.send(event, args);
  return targets.length + 1;
}
