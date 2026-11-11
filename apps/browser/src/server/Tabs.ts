// The life of a tab beyond its row in the database: telling the renderer about
// changes, moving it between workspaces and windows, and deleting it with
// everything that belongs to it. Routes, the agent and the scheduler call these
// instead of stringing the steps together themselves.
import { Context, Effect, Layer } from "effect";
import type { AppSummary } from "../shared/api";
import { topics } from "../shared/hub";
import { Apps } from "./db/Apps";
import { Workspaces } from "./db/Workspaces";
import { Hub } from "./Hub";
import { Scheduler } from "./scheduler/Scheduler";
import { Permissions } from "./security/Permissions";
import { Sources } from "./sources/Sources";
import { ChatFiles } from "./agent/ChatFiles";
import { Jobs } from "./agent/Jobs";

export interface TabsShape {
  /** Tells the renderer about a changed tab (name, icon, workspace…). */
  readonly publish: (summary: AppSummary | null) => Effect.Effect<void>;
  /** A copy of a tab: its name, icon, address and agent settings (not its chat). */
  readonly copy: (tabId: string) => Effect.Effect<AppSummary | null>;
  /** Moves a tab to another workspace: it leaves its split. */
  readonly move: (tabId: string, workspaceId: string) => Effect.Effect<AppSummary | null>;
  /** Moves a tab to another window: it leaves its split (a split view is in one window). */
  readonly moveToWindow: (tabId: string, windowId: string) => Effect.Effect<AppSummary | null>;
  /** Deletes a tab with everything that belongs to it: its chats and their files, code, permissions and schedules' hold on it. Stop its agent first. */
  readonly remove: (tabId: string) => Effect.Effect<void>;
  /** Drops tabs that left a workspace from its splits. */
  readonly pruneSplits: (workspaceId: string) => Effect.Effect<void>;
}

export class Tabs extends Context.Service<Tabs, TabsShape>()("rune/Tabs") {}

export const make = Effect.gen(function* () {
  const apps = yield* Apps;
  const workspaces = yield* Workspaces;
  const sources = yield* Sources;
  const chatFiles = yield* ChatFiles;
  const jobs = yield* Jobs;
  const permissions = yield* Permissions;
  const scheduler = yield* Scheduler;
  const hub = yield* Hub;

  const publish = (summary: AppSummary | null) =>
    summary ? hub.publish({ type: "app", topic: topics.apps, app: summary }) : Effect.void;

  const pruneSplits = (workspaceId: string) =>
    Effect.gen(function* () {
      const space = yield* workspaces.get(workspaceId);
      if (!space?.splits.length) return;
      const updated = yield* workspaces.setSplits(workspaceId, space.splits);
      if (updated && JSON.stringify(updated.splits) !== JSON.stringify(space.splits)) {
        yield* hub.publish({ type: "workspace", topic: topics.workspaces, workspace: updated });
      }
    });

  const remove = (tabId: string) =>
    Effect.gen(function* () {
      const tab = yield* apps.get(tabId);
      yield* jobs.endTab(tabId);
      yield* sources.forgetTab(tabId);
      yield* chatFiles.forgetTab(tabId);
      yield* apps.remove(tabId);
      yield* permissions.forget(tabId);
      yield* scheduler.forgetTab(tabId, tab);
      if (tab) yield* pruneSplits(tab.workspaceId);
      yield* hub.publish({ type: "app-deleted", topic: topics.apps, appId: tabId });
    });

  return {
    publish,
    pruneSplits,
    remove,

    copy: (tabId) =>
      Effect.gen(function* () {
        const copy = yield* apps.duplicate(tabId);
        yield* publish(copy);
        return copy;
      }),

    move: (tabId, workspaceId) =>
      Effect.gen(function* () {
        const tab = yield* apps.get(tabId);
        if (!tab) return null;
        if (tab.workspaceId === workspaceId) return tab;
        const moved = yield* apps.move(tabId, workspaceId);
        yield* publish(moved);
        yield* pruneSplits(tab.workspaceId);
        return moved;
      }),

    moveToWindow: (tabId, windowId) =>
      Effect.gen(function* () {
        const tab = yield* apps.get(tabId);
        if (!tab) return null;
        if (tab.windowId === windowId) return tab;
        const moved = yield* apps.setWindow(tabId, windowId);
        const space = yield* workspaces.get(tab.workspaceId);
        if (space?.splits.some((s) => s.tabs.includes(tabId))) {
          const splits = space.splits.map((s) => {
            const i = s.tabs.indexOf(tabId);
            return i === -1
              ? s
              : { ...s, tabs: s.tabs.filter((_, j) => j !== i), sizes: s.sizes.filter((_, j) => j !== i) };
          });
          const updated = yield* workspaces.setSplits(tab.workspaceId, splits);
          if (updated) yield* hub.publish({ type: "workspace", topic: topics.workspaces, workspace: updated });
        }
        yield* publish(moved);
        return moved;
      }),
  } satisfies TabsShape;
});

export const layer = Layer.effect(Tabs, make);
