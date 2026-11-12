// rune://task-manager (Shift+Esc), like Chrome's task manager: every process of
// Rune Browser's (the browser, the GPU, utilities, each window, tab and extension
// page) with its memory footprint, CPU and process ID, and "End process" for the
// ones that run web tabs (they then show their crash page). Only Rune Browser's
// window asks; pages and agents can't.
import { app, ipcMain, session as electronSession, webContents, type Session, type WebContents } from "electron";
import { readFileSync } from "node:fs";
import type { ProcessInfo, TaskInfo, TaskKind } from "../shared/internalPages";
import type { AppWindows } from "./windows";

export function setupTaskManager(options: {
  windows: AppWindows;
  /** A web tab session's workspace. */
  workspaceOf: (s: Session) => string | undefined;
}) {
  const { windows } = options;
  /** Web tabs' favicons, as their pages say (the renderer knows only its own window's tabs). */
  const favicons = new WeakMap<WebContents, string>();
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    contents.on("page-favicon-updated", (_e, icons) => {
      const icon = icons.find((url) => /^(https?|data):/i.test(url));
      if (icon) favicons.set(contents, icon);
    });
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) favicons.delete(contents);
    });
  });

  const extensionName = (contents: WebContents, url: string) => {
    const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)?.[1];
    return (id && contents.session.extensions?.getExtension(id)?.name) || contents.getTitle() || url;
  };

  function taskOf(contents: WebContents): TaskInfo {
    const url = contents.getURL();
    if (windows.isUi(contents)) return { kind: "window", title: contents.getTitle() };
    if (/^chrome-extension:/i.test(url)) return { kind: "extension", title: extensionName(contents, url), url };
    if (/^devtools:/i.test(url)) return { kind: "devtools", title: contents.getTitle() || "DevTools" };
    if (contents.getType() === "webview") {
      const workspaceId = options.workspaceOf(contents.session);
      return {
        kind: "tab",
        title: contents.getTitle() || url,
        url,
        contentsId: contents.id,
        favicon: favicons.get(contents) ?? null,
        ...(workspaceId ? { workspaceId } : {}),
      };
    }
    return { kind: "page", title: contents.getTitle() || url, url };
  }

  /**
   * Service workers (extensions' and sites'), by Chromium's id of the process they run in. They have no
   * webContents to ask for their OS process, so only Linux, whose renderers' command lines carry that id,
   * can say which process is theirs; elsewhere such a process is a "Renderer".
   */
  function workerTasks(sessions: Set<Session>): (pid: number) => TaskInfo[] {
    if (process.platform !== "linux") return () => [];
    const byProcess = new Map<number, TaskInfo[]>();
    for (const s of sessions) {
      let running: Record<number, Electron.ServiceWorkerInfo> = {};
      try {
        running = s.serviceWorkers.getAllRunning();
      } catch {}
      for (const info of Object.values(running)) {
        const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(info.scope)?.[1];
        const task: TaskInfo = id
          ? { kind: "extension", title: s.extensions?.getExtension(id)?.name || id, url: info.scope }
          : { kind: "other", title: `Service worker: ${info.scope}`, url: info.scope };
        const list = byProcess.get(info.renderProcessId) ?? [];
        if (!list.some((t) => t.title === task.title)) byProcess.set(info.renderProcessId, [...list, task]);
      }
    }
    return (pid) => {
      try {
        const id = /--renderer-client-id=(\d+)/.exec(readFileSync(`/proc/${pid}/cmdline`, "latin1"))?.[1];
        return id ? (byProcess.get(Number(id)) ?? []) : [];
      } catch {
        return [];
      }
    };
  }

  function snapshot(): ProcessInfo[] {
    const tasks = new Map<number, TaskInfo[]>();
    const sessions = new Set<Session>([electronSession.defaultSession]);
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      sessions.add(contents.session);
      let pid = 0;
      try {
        pid = contents.getOSProcessId();
      } catch {}
      if (!pid) continue;
      tasks.set(pid, [...(tasks.get(pid) ?? []), taskOf(contents)]);
    }
    const workersIn = workerTasks(sessions);
    return app.getAppMetrics().map((m): ProcessInfo => {
      const own = tasks.get(m.pid) ?? [];
      const workers = m.type === "Tab" && !own.length ? workersIn(m.pid) : [];
      const named = (kind: TaskKind, title: string): TaskInfo[] => [{ kind, title }];
      const list =
        m.type === "Browser"
          ? named("browser", "Browser")
          : m.type === "GPU"
            ? named("gpu", "GPU Process")
            : m.type === "Utility"
              ? named("utility", m.name || m.serviceName || "Utility")
              : own.length
                ? own
                : workers.length
                  ? workers
                  : // A renderer with no page of its own: a service worker (outside Linux), or a spare one.
                    named("other", m.type === "Tab" ? "Renderer" : m.type);
      const memory = (m.memory.privateBytes ?? m.memory.workingSetSize) * 1024;
      return {
        pid: m.pid,
        kind: list[0]!.kind,
        tasks: list,
        memory,
        cpu: m.cpu.percentCPUUsage,
        canEnd: m.type === "Tab" && own.length > 0 && own.every((t) => t.kind === "tab"),
      };
    });
  }

  ipcMain.handle("rune:task-manager-list", (event) => (windows.isUi(event.sender) ? snapshot() : null));
  // Ends a process that runs web tabs only (Chrome's End process): its tabs show that they crashed.
  ipcMain.handle("rune:task-manager-end", (event, pid: unknown) => {
    if (!windows.isUi(event.sender) || typeof pid !== "number") return false;
    const all = webContents.getAllWebContents().filter((c) => {
      if (c.isDestroyed()) return false;
      try {
        return c.getOSProcessId() === pid;
      } catch {
        return false;
      }
    });
    if (!all.length || !all.every((c) => c.getType() === "webview" && taskOf(c).kind === "tab")) return false;
    // Killed, like Chrome's End process (not forcefullyCrashRenderer: on Linux that makes the page crash as
    // hung and wait for its crash dump, which can take seconds).
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
    return true;
  });
}
