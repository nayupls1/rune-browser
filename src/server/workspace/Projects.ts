// The life of an app tab, whatever made it: the agent (create_project, or a
// rune.json it wrote itself), the user (a template, or a project of their
// own imported from a folder or cloned from Git) or a copy of another app. Every app goes through the same steps here, and the three concerns stay
// apart:
//   building:   the project's files and manifest (Workspace), its data (AppData)
//   running:    its processes, in dev or live mode (Runtime)
//   displaying: the renderer, which only sees AppDetail and the hub's messages
// Routes, agent tools, the scheduler and history call these instead of
// stringing the steps together themselves.
import { Context, Effect, Layer } from "effect";
import { appTarget, type AppSummary, type ProjectInfo, type ToolActivity } from "../../shared/api";
import { topics } from "../../shared/hub";
import { Apps } from "../db/Apps";
import { Settings } from "../db/Settings";
import { Workspaces } from "../db/Workspaces";
import { History, type By } from "../history/History";
import { Hub } from "../Hub";
import { Scheduler } from "../scheduler/Scheduler";
import { Permissions } from "../security/Permissions";
import { Secrets } from "../security/Secrets";
import { AppData } from "./AppData";
import { Runtime } from "./Runtime";
import { Sources } from "./Sources";
import { ChatFiles } from "../agent/ChatFiles";
import { Workspace, type ImportProgress, type ImportSource, type WorkspaceError } from "./Workspace";

export interface ProjectsShape {
  /** Tells the renderer about a changed tab (name, icon, workspace…). */
  readonly publish: (summary: AppSummary | null) => Effect.Effect<void>;
  /**
   * Sets up an app's project from a preset (by the user or the agent), names
   * the app, records the first snapshot and starts it for editing.
   */
  readonly create: (
    appId: string,
    preset: string,
    options: { name?: string; by: Omit<By, "summary"> },
  ) => Effect.Effect<ProjectInfo, WorkspaceError>;
  /**
   * Brings in an existing project (cloned from Git or copied from a folder) as
   * the app's project: named after it, first snapshot, started for editing. If
   * Rune Browser can't tell how to run it, the chat says so (the agent sets it up).
   */
  readonly importApp: (appId: string, source: ImportSource) => Effect.Effect<ProjectInfo | null, WorkspaceError>;
  /** A copy of a tab: an app's project comes along (not its data, chat or secrets), as a first snapshot of the copy. */
  readonly copy: (appId: string) => Effect.Effect<AppSummary | null>;
  /** Moves a tab to another workspace: it leaves its split, and a running app restarts with the new workspace's secrets. */
  readonly move: (appId: string, workspaceId: string) => Effect.Effect<AppSummary | null>;
  /** Closes an app's tab: the app stops and goes to the library, with everything it has, to be opened again. */
  readonly close: (appId: string) => Effect.Effect<AppSummary | null>;
  /** Opens a closed app again in a workspace. */
  readonly reopen: (appId: string, workspaceId: string) => Effect.Effect<AppSummary | null>;
  /** Deletes a tab with everything that belongs to it: its project, data, secrets, permissions, history and schedules. Stop its agent first. */
  readonly remove: (appId: string) => Effect.Effect<void>;
  /** The tab was opened: its app starts (in its mode) if Settings say so. */
  readonly opened: (appId: string) => Effect.Effect<void>;
  /** An agent turn starts: the agent works against the dev server (live updates in the preview). */
  readonly editing: (appId: string) => Effect.Effect<void>;
  /** An agent turn ended: published (built and started) if Settings say so. */
  readonly edited: (appId: string) => Effect.Effect<void>;
  /** Drops tabs that left a workspace from its splits. */
  readonly pruneSplits: (workspaceId: string) => Effect.Effect<void>;
}

export class Projects extends Context.Service<Projects, ProjectsShape>()("rune/Projects") {}

export const make = Effect.gen(function* () {
  const apps = yield* Apps;
  const workspaces = yield* Workspaces;
  const settings = yield* Settings;
  const workspace = yield* Workspace;
  const runtime = yield* Runtime;
  const sources = yield* Sources;
  const chatFiles = yield* ChatFiles;
  const appData = yield* AppData;
  const history = yield* History;
  const secrets = yield* Secrets;
  const permissions = yield* Permissions;
  const scheduler = yield* Scheduler;
  const hub = yield* Hub;

  // A built app opens finished, with the agent sidebar closed (editing is one click or Ctrl+J away).
  yield* apps.finishEditing();

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

  const isApp = (appId: string) => apps.get(appId).pipe(Effect.map((app) => app?.kind === "app"));

  return {
    publish,
    pruneSplits,

    create: (appId, preset, { name, by }) =>
      Effect.gen(function* () {
        const app = yield* apps.get(appId);
        const appName = name ?? (app && app.name !== "New app" ? app.name : "My app");
        const project = yield* workspace.scaffold(appId, preset, appName);
        if (name) yield* publish(yield* apps.setInfo(appId, { name }));
        yield* history.record(appTarget(appId), { ...by, summary: `Started from the ${preset} template` });
        yield* runtime.setMode(appId, "dev");
        return project;
      }),

    importApp: (appId, source) =>
      Effect.gen(function* () {
        const progress = (p: ImportProgress) =>
          hub.publishUnsafe({
            type: "import-progress",
            topic: topics.app(appId),
            appId,
            phase: p.phase,
            percent: p.percent,
          });
        const { project, name } = yield* workspace.importFrom(appId, source, progress);
        const from = source.kind === "git" ? source.url : source.path;
        const app = yield* apps.get(appId);
        if (app && app.name === "New app" && name)
          yield* publish(yield* apps.setInfo(appId, { name: name.slice(0, 80) }));
        yield* history.record(appTarget(appId), {
          actor: "user",
          actorLabel: "You",
          summary: `Imported from ${from.slice(0, 200)}`,
        });
        if (project) yield* runtime.setMode(appId, "dev");
        const note: ToolActivity = {
          kind: "app",
          title: `Imported from ${from}`,
          detail: project
            ? `Rune Browser runs it with \`${project.manifest.dev}\` (from its package.json); apps listen on $PORT. Ask the agent to change anything.`
            : "Rune Browser couldn't tell how to run it (no rune.json, and package.json has no dev or start script): ask the agent to set it up.",
        };
        const message = yield* apps.addMessage(appId, "tool", JSON.stringify(note));
        yield* hub.publish({ type: "chat", topic: topics.app(appId), appId, event: { type: "message", message } });
        return project;
      }),

    copy: (appId) =>
      Effect.gen(function* () {
        const copy = yield* apps.duplicate(appId);
        if (!copy) return null;
        if (copy.kind === "app") {
          yield* workspace.duplicate(appId, copy.id);
          const original = yield* apps.get(appId);
          if (yield* workspace.info(copy.id)) {
            yield* history.record(appTarget(copy.id), {
              actor: "user",
              actorLabel: "You",
              summary: `Copied from ${original?.name ?? "another app"}`,
            });
          }
        }
        yield* publish(copy);
        return copy;
      }),

    move: (appId, workspaceId) =>
      Effect.gen(function* () {
        const app = yield* apps.get(appId);
        if (!app) return null;
        if (app.workspaceId === workspaceId) return app;
        const moved = yield* apps.move(appId, workspaceId);
        yield* publish(moved);
        yield* pruneSplits(app.workspaceId);
        if (app.kind === "app") yield* runtime.refresh(appId);
        return moved;
      }),

    close: (appId) =>
      Effect.gen(function* () {
        const tab = yield* apps.get(appId);
        if (!tab || tab.kind !== "app") return null;
        yield* runtime.stop(appId);
        const closed = yield* apps.close(appId);
        yield* pruneSplits(tab.workspaceId);
        yield* hub.publish({ type: "app-deleted", topic: topics.apps, appId });
        return closed;
      }),

    reopen: (appId, workspaceId) =>
      Effect.gen(function* () {
        const tab = yield* apps.get(appId);
        if (!tab?.closedAt) return tab ?? null;
        const opened = yield* apps.reopen(appId, workspaceId);
        yield* publish(opened);
        return opened;
      }),

    remove: (appId) =>
      Effect.gen(function* () {
        const tab = yield* apps.get(appId);
        yield* runtime.forget(appId);
        yield* sources.forgetTab(appId);
        yield* chatFiles.forgetTab(appId);
        yield* apps.remove(appId);
        yield* workspace.remove(appId);
        yield* appData.remove(appId);
        yield* secrets.removeScope(appId);
        yield* permissions.forget(appId);
        yield* history.forget(appTarget(appId));
        yield* scheduler.forgetApp(appId);
        if (tab) yield* pruneSplits(tab.workspaceId);
        yield* hub.publish({ type: "app-deleted", topic: topics.apps, appId });
      }),

    opened: (appId) =>
      Effect.gen(function* () {
        if (!(yield* isApp(appId)) || !(yield* workspace.info(appId))) return;
        if ((yield* settings.get()).apps.autoStart) yield* Effect.forkDetach(runtime.ensure(appId));
      }),

    editing: (appId) =>
      Effect.gen(function* () {
        const app = yield* apps.get(appId);
        if (app?.kind !== "app" || !(yield* workspace.info(appId))) return;
        yield* Effect.forkDetach(app.mode === "live" ? runtime.setMode(appId, "dev") : runtime.ensure(appId));
      }),

    edited: (appId) =>
      Effect.gen(function* () {
        if (!(yield* isApp(appId)) || !(yield* workspace.info(appId))) return;
        if ((yield* settings.get()).apps.autoPublish) yield* Effect.forkDetach(runtime.setMode(appId, "live"));
      }),
  } satisfies ProjectsShape;
});

export const layer = Layer.effect(Projects, make);
