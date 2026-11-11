// Downloads, like Chromium's: every session's downloads (web tabs, Rune
// Browser's own windows) go to the downloads folder under a name
// that doesn't overwrite anything, or where the user picks when "ask where to
// save" is on (Settings → General → Downloads, main/browser.ts). Risky ones (a
// file type that runs code, a site without HTTPS) are saved under a name that
// can't run until the user keeps them. Progress goes to the windows
// (components/Downloads.tsx) and the taskbar; the list is kept in the profile
// (downloads.json). Private windows' downloads are never written down, only
// private windows see them, and they're forgotten when the last one closes.
import {
  app,
  dialog,
  ipcMain,
  session,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  canRetry,
  downloadDanger,
  keptUrl,
  MAX_DOWNLOADS,
  needsDecision,
  restoreDownloads,
  safeFilename,
  savedDownload,
  uniqueFilename,
  type DownloadAction,
  type DownloadInfo,
  type DownloadsChange,
} from "../shared/downloads";
import { PRIVATE_WORKSPACE } from "../shared/api";
import type { AppWindows } from "./windows";

/** How often progress goes to the window. */
const PUBLISH_MS = 200;
const SAVE_MS = 500;
/** Tests run offscreen: opening a file or its folder would open a window on the screen. */
const quiet = process.env.RUNE_OFFSCREEN === "1";

export function setupDownloads(options: {
  windows: AppWindows;
  /** Where downloads go (Settings → General → Downloads). */
  folder: () => string;
  /** Whether every download asks where to save. */
  ask: () => boolean;
  /** The web tabs' workspace a session belongs to. */
  workspaceOf: (s: Session) => string | undefined;
  /** A session's partition ("" for Rune Browser's own). */
  partitionOf: (s: Session) => string | undefined;
  /** The session of a partition, set up like when it was first used. */
  sessionFor: (partition: string) => Session;
  /** Pages that never download anything (headless tabs: main/headless.ts). */
  noDownloads?: (contents: WebContents) => boolean;
}) {
  const { windows } = options;
  const file = join(app.getPath("userData"), "downloads.json");
  /** Newest first. */
  let list: DownloadInfo[] = load();
  const items = new Map<string, DownloadItem>();
  /** Files downloads are being saved to, so two at once don't get the same name. */
  const reserved = new Set<string>();
  /** Where kept risky downloads go once they finish (picked in a dialog while they ran). */
  const keepTargets = new Map<string, string>();
  /** Downloads that ask where to save whatever the setting ("Save link as…"), by address. */
  const askNext = new Set<string>();
  /** Downloads an extension started (chrome.downloads.download), by address: the name it asked for, and who waits for its id. */
  const requested = new Map<string, { filename?: string; conflict?: string; resolve: (id: string) => void }[]>();
  /** Extensions following the downloads (chrome.downloads' events). */
  const watchers = new Set<(kind: "created" | "changed" | "erased", d: DownloadInfo) => void>();
  const notify = (kind: "created" | "changed" | "erased", d: DownloadInfo) => {
    for (const watcher of watchers) {
      try {
        watcher(kind, d);
      } catch (err) {
        console.warn("Telling extensions about a download failed:", err);
      }
    }
  };

  function load(): DownloadInfo[] {
    try {
      return restoreDownloads(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return [];
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      // Private windows' downloads are never written down.
      writeFileSync(`${file}.tmp`, JSON.stringify(list.filter((d) => !isPrivate(d)).map(savedDownload)));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.warn("Saving the downloads list failed:", err);
    }
  }
  const save = () => (saveTimer ??= setTimeout(saveNow, SAVE_MS));
  app.on("will-quit", () => saveTimer && saveNow());

  /** What the window gets: with the live speed, and whether a finished file is still there. */
  function view(d: DownloadInfo): DownloadInfo {
    const item = items.get(d.id);
    const file = d.unconfirmedPath && !d.kept ? d.unconfirmedPath : d.path;
    return {
      ...d,
      ...(item
        ? { speed: item.isPaused() ? 0 : Math.max(0, item.getCurrentBytesPerSecond()), canResume: item.canResume() }
        : {}),
      ...(d.state === "completed" ? { exists: !!file && existsSync(file) } : {}),
    };
  }

  /** A private window's download: only private windows see it, and it's forgotten when the last one closes. */
  const isPrivate = (d: DownloadInfo) => d.workspaceId === PRIVATE_WORKSPACE;
  /** The downloads a window shows: a private window its own, the others the rest. */
  const shownIn = (win: BrowserWindow | undefined) => {
    const inPrivate = windows.isPrivate(win);
    return (d: DownloadInfo) => isPrivate(d) === inPrivate;
  };

  const changed = new Set<string>();
  const removed = new Set<string>();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  function publishNow() {
    publishTimer = undefined;
    const updated = list.filter((d) => changed.has(d.id)).map(view);
    const gone = [...removed];
    if (watchers.size) for (const d of updated) notify("changed", d);
    changed.clear();
    removed.clear();
    for (const win of windows.all()) {
      if (win.isDestroyed()) continue;
      const change: DownloadsChange = { updated: updated.filter(shownIn(win)), removed: gone };
      if (change.updated.length || change.removed.length) win.webContents.send("rune:downloads-changed", change);
      showProgress(win);
    }
  }
  /** Tells the window (throttled) and saves the list, unless it's only progress. */
  function publish(d: DownloadInfo, persist = true) {
    // Removed from the list (and maybe downloading again): nothing to tell.
    if (!list.includes(d)) return;
    changed.add(d.id);
    removed.delete(d.id);
    publishTimer ??= setTimeout(publishNow, PUBLISH_MS);
    if (persist) save();
  }
  function drop(ids: string[]) {
    if (!ids.length) return;
    const gone = new Set(ids);
    for (const d of list) if (gone.has(d.id)) notify("erased", d);
    list = list.filter((d) => !gone.has(d.id));
    for (const id of ids) {
      changed.delete(id);
      removed.add(id);
    }
    publishTimer ??= setTimeout(publishNow, PUBLISH_MS);
    save();
  }

  /** The taskbar (or dock) icon shows how far a window's running downloads are, like Chrome's. */
  function showProgress(win: BrowserWindow) {
    const shown = shownIn(win);
    const running = list.filter((d) => d.state === "progressing" && items.has(d.id) && shown(d));
    if (!running.length) return win.setProgressBar(-1);
    const total = running.reduce((n, d) => n + d.totalBytes, 0);
    const received = running.reduce((n, d) => n + d.receivedBytes, 0);
    const unknown = running.some((d) => !d.totalBytes);
    win.setProgressBar(unknown || !total ? 2 : received / total, {
      mode: running.every((d) => d.paused) ? "paused" : unknown ? "indeterminate" : "normal",
    });
  }

  const downloadsDir = () => {
    const dir = options.folder();
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  /** A name in the folder that no file (or running download) has. */
  const freeName = (dir: string, name: string) =>
    uniqueFilename(name, (n) => reserved.has(join(dir, n)) || existsSync(join(dir, n)));

  const find = (id: string) => list.find((d) => d.id === id);

  function started(s: Session, item: DownloadItem, contents: WebContents | undefined) {
    const chain = item.getURLChain();
    const url = chain[0] || item.getURL();
    const pageUrl = contents && !contents.isDestroyed() ? contents.getURL() || null : null;
    const filename = safeFilename(item.getFilename());
    const danger =
      downloadDanger({ filename, url: item.getURL(), initiator: item.getInitiatorOrigin(), pageUrl }) ??
      downloadDanger({ filename, url });
    const asking = askNext.delete(url) || askNext.delete(item.getURL()) || options.ask();
    // Started by an extension, maybe under a name of its own (in the downloads folder, like Chrome's).
    const waiting = requested.get(url) ?? requested.get(item.getURL());
    const request = waiting?.shift();
    if (waiting && !waiting.length) requested.delete(url) || requested.delete(item.getURL());
    let dir = downloadsDir();
    let wantedName = filename;
    if (request?.filename) {
      const parts = request.filename.split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
      if (parts.length) {
        wantedName = safeFilename(parts.pop()!);
        if (parts.length) {
          const sub = join(dir, ...parts.map(safeFilename));
          try {
            mkdirSync(sub, { recursive: true });
            dir = sub;
          } catch {
            // the downloads folder then
          }
        }
      }
    }
    const nameIn = (folder: string, name: string) =>
      request?.conflict === "overwrite" && !reserved.has(join(folder, name)) ? name : freeName(folder, name);
    let path = "";
    let unconfirmedPath: string | null = null;
    if (danger) {
      // Like Chromium's "Unconfirmed 123456.crdownload": nothing runs it by accident before it's kept.
      unconfirmedPath = join(dir, `Unconfirmed ${randomInt(100_000, 1_000_000)}.download`);
      item.setSavePath(unconfirmedPath);
      reserved.add(unconfirmedPath);
    } else if (asking) {
      item.setSaveDialogOptions({ defaultPath: join(dir, freeName(dir, wantedName)) });
    } else {
      path = join(dir, nameIn(dir, wantedName));
      item.setSavePath(path);
      reserved.add(path);
    }
    const d: DownloadInfo = {
      id: randomUUID(),
      url: keptUrl(url),
      pageUrl: pageUrl && /^(https?|file):/i.test(pageUrl) ? keptUrl(pageUrl) : null,
      // The name it's saved under ("report (1).pdf"); risky ones get theirs when they're kept.
      filename: path ? basename(path) : wantedName,
      path,
      mime: item.getMimeType(),
      totalBytes: Math.max(0, item.getTotalBytes()),
      receivedBytes: 0,
      state: "progressing",
      paused: false,
      danger,
      unconfirmedPath,
      kept: false,
      discarded: false,
      error: null,
      workspaceId: options.workspaceOf(s) ?? null,
      partition: options.partitionOf(s) ?? "",
      startedAt: Date.now(),
      endedAt: null,
    };
    list = [d, ...list];
    // The oldest finished ones make room.
    if (list.length > MAX_DOWNLOADS) {
      const old = list.filter((x) => x.state !== "progressing" && !needsDecision(x)).slice(MAX_DOWNLOADS - list.length);
      void forget(old);
    }
    items.set(d.id, item);
    request?.resolve(d.id);
    notify("created", view(d));

    item.on("updated", (_event, state) => {
      d.receivedBytes = item.getReceivedBytes();
      d.totalBytes = Math.max(0, item.getTotalBytes());
      // The save dialog was answered.
      if (!d.path && !d.unconfirmedPath && item.getSavePath()) {
        d.path = item.getSavePath();
        d.filename = basename(d.path);
        reserved.add(d.path);
      }
      const paused = item.isPaused();
      // Interrupted here means it can go on (resume) where it stopped, like after losing the connection.
      const state_ = state === "interrupted" ? "interrupted" : "progressing";
      const persist = paused !== d.paused || state_ !== d.state;
      d.paused = paused;
      d.state = state_;
      d.error = state === "interrupted" ? "Network error" : null;
      publish(d, persist);
    });

    item.once("done", (_event, state) => {
      items.delete(d.id);
      reserved.delete(d.path);
      if (d.unconfirmedPath) reserved.delete(d.unconfirmedPath);
      d.receivedBytes = item.getReceivedBytes();
      d.totalBytes = Math.max(0, item.getTotalBytes()) || (state === "completed" ? d.receivedBytes : 0);
      if (!d.path && !d.unconfirmedPath && item.getSavePath()) {
        d.path = item.getSavePath();
        d.filename = basename(d.path);
      }
      // The save dialog was cancelled: nothing was downloaded, like in Chromium.
      if (state === "cancelled" && !d.path && !d.unconfirmedPath) return drop([d.id]);
      d.state = state;
      d.paused = false;
      d.endedAt = Date.now();
      d.error = state === "interrupted" ? (d.error ?? "Couldn't finish downloading") : null;
      if (state === "completed" && d.kept && d.unconfirmedPath) void confirm(d);
      else publish(d);
      if (state === "completed" && !d.danger && process.platform === "darwin") app.dock?.downloadFinished(d.path);
    });
    publish(d);
  }

  /** A kept risky download gets its real name (or goes where the user picked). */
  async function confirm(d: DownloadInfo): Promise<string | null> {
    const from = d.unconfirmedPath!;
    const dir = dirname(from);
    const target = keepTargets.get(d.id) ?? join(dir, freeName(dir, d.filename));
    keepTargets.delete(d.id);
    try {
      await rename(from, target).catch(async (err: NodeJS.ErrnoException) => {
        // Another drive: copy it over.
        if (err.code !== "EXDEV") throw err;
        await copyFile(from, target);
        await rm(from, { force: true });
      });
      d.path = target;
      d.filename = basename(target);
      d.unconfirmedPath = null;
      d.error = null;
      publish(d);
      return null;
    } catch (err) {
      // Not kept after all: it waits for Keep or Discard again, saying why.
      d.kept = false;
      d.error = `Couldn't save the file: ${err instanceof Error ? err.message : String(err)}`;
      publish(d);
      return d.error;
    }
  }

  async function keep(d: DownloadInfo): Promise<string | null> {
    if (!needsDecision(d)) return null;
    // Asking where to save: now, before it's kept.
    if (options.ask()) {
      const win = windows.current();
      const dir = downloadsDir();
      const picked = await (win
        ? dialog.showSaveDialog(win, { defaultPath: join(dir, freeName(dir, d.filename)) })
        : dialog.showSaveDialog({ defaultPath: join(dir, freeName(dir, d.filename)) }));
      if (picked.canceled || !picked.filePath || !needsDecision(d)) return null;
      keepTargets.set(d.id, picked.filePath);
    }
    d.kept = true;
    if (d.state === "completed") return confirm(d);
    publish(d);
    return null;
  }

  async function discard(d: DownloadInfo) {
    if (!needsDecision(d)) return;
    d.discarded = true;
    const item = items.get(d.id);
    if (item) item.cancel();
    else d.state = "cancelled";
    if (d.unconfirmedPath) await rm(d.unconfirmedPath, { force: true }).catch(() => {});
    publish(d);
  }

  const shownFile = (d: DownloadInfo) => (d.unconfirmedPath && !d.kept ? null : d.path);

  async function act(id: string, action: DownloadAction): Promise<string | null> {
    const d = find(id);
    if (!d) return "This download is gone";
    const item = items.get(id);
    switch (action) {
      case "pause":
      case "resume":
        if (item && action === "pause") item.pause();
        else if (item?.canResume()) item.resume();
        // Gone since (failed or cancelled): resuming starts it again. Pausing does nothing then.
        else if (!item && action === "resume" && (d.state === "interrupted" || d.state === "cancelled"))
          return act(id, "retry");
        if (item) {
          d.paused = item.isPaused();
          publish(d);
        }
        return null;
      case "cancel":
        item?.cancel();
        return null;
      case "keep":
        return keep(d);
      case "discard":
        await discard(d);
        return null;
      case "open": {
        const path = shownFile(d);
        if (!path || d.state !== "completed" || needsDecision(d)) return "The file isn't ready";
        if (!existsSync(path)) return "The file was moved or deleted";
        if (quiet) return null;
        return (await shell.openPath(path)) || null;
      }
      case "show": {
        const path = shownFile(d);
        if (quiet) return null;
        if (path && existsSync(path)) shell.showItemInFolder(path);
        else await shell.openPath(path ? dirname(path) : downloadsDir());
        return null;
      }
      case "retry": {
        if (item?.canResume()) {
          item.resume();
          return null;
        }
        if (!canRetry(d)) return "This download can't be retried";
        item?.cancel();
        await forget([d]);
        options.sessionFor(d.partition).downloadURL(d.url);
        return null;
      }
      case "remove": {
        if (item) item.cancel();
        await forget([d]);
        return null;
      }
    }
  }

  /** Takes downloads off the list. A risky file that never got its name (not kept, or it failed) is of no use: it goes too. */
  async function forget(downloads: DownloadInfo[]) {
    drop(downloads.map((d) => d.id));
    for (const d of downloads) if (d.unconfirmedPath) await rm(d.unconfirmedPath, { force: true }).catch(() => {});
  }

  const hooked = new WeakSet<Session>();
  function hook(s: Session) {
    if (hooked.has(s)) return;
    hooked.add(s);
    s.on("will-download", (event, item, contents) => {
      if (contents && options.noDownloads?.(contents)) return event.preventDefault();
      started(s, item, contents);
    });
  }
  hook(session.defaultSession);
  app.on("session-created", hook);

  /** The downloads the window that sent a message may see and change (none if it isn't Rune Browser's UI). */
  const senderShows = (event: IpcMainInvokeEvent) =>
    windows.isUi(event.sender) ? shownIn(windows.of(event.sender)) : () => false;
  ipcMain.handle("rune:downloads-list", (event) => list.filter(senderShows(event)).map(view));
  ipcMain.handle("rune:downloads-act", (event, id: unknown, action: unknown) => {
    const d = typeof id === "string" ? find(id) : undefined;
    if (!d || !senderShows(event)(d) || typeof action !== "string") return "Not allowed";
    return act(d.id, action as DownloadAction);
  });
  // Like Chromium's "Clear all": what's still running or waiting for an OK stays. Clear browsing data
  // ("Download history") only clears what started in its time range, from its workspaces.
  ipcMain.handle("rune:downloads-clear", (event, which: unknown) => {
    const shown = senderShows(event);
    const w = (which ?? {}) as { since?: unknown; workspaceIds?: unknown };
    const since = typeof w.since === "number" ? w.since : 0;
    const from = Array.isArray(w.workspaceIds) ? new Set(w.workspaceIds) : null;
    // A kept risky file still getting its name stays too.
    return forget(
      list.filter(
        (d) =>
          shown(d) &&
          d.startedAt >= since &&
          (!from || (d.workspaceId !== null && from.has(d.workspaceId))) &&
          d.state !== "progressing" &&
          !needsDecision(d) &&
          !(d.kept && d.unconfirmedPath),
      ),
    );
  });

  // The last private window closed: its downloads leave the list, like Chrome's incognito ones (what
  // finished stays on disk; what was still downloading stops).
  app.on("browser-window-created", (_event, win) =>
    win.once("closed", () =>
      setTimeout(() => {
        if (windows.all().some((w) => !w.isDestroyed() && windows.isPrivate(w))) return;
        const gone = list.filter(isPrivate);
        for (const d of gone) items.get(d.id)?.cancel();
        if (gone.length) void forget(gone);
      }, 0),
    ),
  );

  return {
    /** "Save link as…": downloads it, asking where to save. */
    saveAs(contents: WebContents, url: string) {
      askNext.add(url);
      contents.downloadURL(url);
    },

    // --- For extensions (chrome.downloads, chrome.browsingData) ----------------------------------

    /** A workspace's downloads, newest first, as the window sees them. */
    list: (workspaceId: string) => list.filter((d) => d.workspaceId === workspaceId).map(view),
    get: (id: string) => {
      const d = find(id);
      return d ? view(d) : undefined;
    },
    act,
    /**
     * Downloads a URL in a session, like chrome.downloads.download: under a name in the downloads folder,
     * asking where to save, or replacing a file with the same name. Resolves with the download's id once it starts.
     */
    download(
      s: Session,
      url: string,
      o: { filename?: string; saveAs?: boolean; conflictAction?: string; headers?: Record<string, string> },
    ) {
      return new Promise<string>((resolve, reject) => {
        const entry = { filename: o.filename, conflict: o.conflictAction, resolve };
        const queue = requested.get(url) ?? [];
        queue.push(entry);
        requested.set(url, queue);
        if (o.saveAs) askNext.add(url);
        const timer = setTimeout(() => {
          const q = requested.get(url);
          const i = q?.indexOf(entry) ?? -1;
          if (q && i !== -1) q.splice(i, 1);
          if (q && !q.length) requested.delete(url);
          reject(new Error("The download didn't start."));
        }, 30_000);
        entry.resolve = (id) => {
          clearTimeout(timer);
          resolve(id);
        };
        s.downloadURL(url, o.headers && Object.keys(o.headers).length ? { headers: o.headers } : undefined);
      });
    },
    /** Takes finished downloads off the list (chrome.downloads.erase), the file stays. */
    erase: (ids: string[]) => forget(list.filter((d) => ids.includes(d.id) && d.state !== "progressing")),
    /** Deletes a finished download's file (chrome.downloads.removeFile). */
    async removeFile(id: string) {
      const d = find(id);
      if (!d || d.state !== "completed") throw new Error("The download isn't finished.");
      const path = shownFile(d);
      if (!path || !existsSync(path)) throw new Error("The file was moved or deleted.");
      await rm(path, { force: true });
      publish(d);
    },
    /** Clears what started since a time from workspaces' lists, like Clear browsing data's "Download history". */
    clear: (since: number, workspaceIds: string[]) =>
      forget(
        list.filter(
          (d) =>
            d.startedAt >= since &&
            d.workspaceId !== null &&
            workspaceIds.includes(d.workspaceId) &&
            d.state !== "progressing" &&
            !needsDecision(d) &&
            !(d.kept && d.unconfirmedPath),
        ),
      ),
    /** The file a download is saved to ("" until it has one). */
    fileOf: (id: string) => {
      const d = find(id);
      return d ? (shownFile(d) ?? "") : "";
    },
    /** Opens the downloads folder (chrome.downloads.showDefaultFolder). */
    showFolder: () => {
      if (!quiet) void shell.openPath(downloadsDir());
    },
    /** Follows the downloads; returns a function that stops. */
    watch(fn: (kind: "created" | "changed" | "erased", d: DownloadInfo) => void) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
}

export type DownloadsControl = ReturnType<typeof setupDownloads>;
