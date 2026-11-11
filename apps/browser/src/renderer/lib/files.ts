// Local files in web tabs: files dropped on Rune Browser (lib/drops.ts) and
// the files of a chat's folder (attachments, what the agent made; server:
// agent/ChatFiles.ts), which open from their chips in the chat. A file the
// browser can show (PDF, image, video, audio, text, page) opens in a tab;
// anything else is downloaded, like Chrome does.
import { createStore } from "solid-js/store";
import { DEFAULT_WORKSPACE, PRIVATE_WORKSPACE, type ChatFile, type PathInfo } from "../../shared/api";
import { fileNameOf, fileUrl, isViewableFile } from "../../shared/web";
import { api } from "./api";
import { appById, currentWorkspace, isPrivate, newWebTab, selectApp } from "./store";
import { pageOf } from "./webtabs";
import { openInternalPage } from "./internalPages";

/**
 * Opens a URL (a local file's, a website's) in a web tab: in `tabId` if it's
 * a web tab, else in a new one (in the background with `background`).
 */
export async function openUrl(url: string, options: { tabId?: string; background?: boolean } = {}) {
  if (openInternalPage(url)) return;
  const tab = options.tabId ? appById(options.tabId) : undefined;
  if (tab) {
    await selectApp(tab.id);
    const page = pageOf(tab.id);
    if (page) {
      void page.navigate(url).catch(() => {});
      return;
    }
  }
  await newWebTab(url, { background: options.background });
}

/** Opens a local file: shown in a tab if the browser can show it, else downloaded. */
export async function openFile(path: string, options: { tabId?: string; background?: boolean; mime?: string } = {}) {
  const url = fileUrl(path);
  if (isViewableFile(fileNameOf(path), options.mime)) await openUrl(url, options);
  else window.rune.web.download(isPrivate ? PRIVATE_WORKSPACE : (currentWorkspace()?.id ?? DEFAULT_WORKSPACE), url);
}

/** Ctrl+O: files picked from the system's dialog open in new tabs, the first shown one in front (like Chrome). */
export async function pickAndOpenFiles() {
  let shown = false;
  for (const path of await window.rune.pickFiles()) {
    await openFile(path, { background: shown });
    shown ||= isViewableFile(fileNameOf(path));
  }
}

/** Where the chat can show a chat file (an <img> src: carries the window's token). */
export const chatFileUrl = (tabId: string, path: string) =>
  `${window.rune.serverUrl}/api/apps/${tabId}/files/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(window.rune.token)}`;

// --- A chat's folder ---------------------------------------------------------------------
// What's in each tab's chat folder, so file paths the agent mentions in its
// replies become chips. Refreshed when a turn ends and when the chat changes.

const [folders, setFolders] = createStore<Record<string, { dir: string; files: ChatFile[] }>>({});

export async function refreshChatFiles(tabId: string) {
  const listed = await api.chatFiles(tabId).catch(() => null);
  if (listed) setFolders(tabId, listed);
  // What the chat's file links point to may have changed too (the agent made or deleted files).
  for (const key of lookups.keys()) if (key.startsWith(`${tabId}\n`)) lookups.delete(key);
}

/** A file of the tab's chat folder that `text` names (its path in the folder, or its absolute path). */
export function chatFileNamed(tabId: string, text: string): ChatFile | undefined {
  const folder = folders[tabId];
  const wanted = text.trim().replace(/^\.\//, "");
  if (!folder || !wanted || wanted.length > 500) return undefined;
  const sep = folder.dir.includes("\\") ? "\\" : "/";
  const relative = wanted.startsWith(folder.dir + sep)
    ? wanted.slice(folder.dir.length + 1).replace(/\\/g, "/")
    : wanted.replace(/^file:\/\//, "");
  return folder.files.find((f) => f.name === relative || f.path === wanted);
}

// --- Paths the agent links ([name](<path>)) --------------------------------------------------
// Looked up on the server, which only says what a path is inside the tab's
// chat folders (POST /api/apps/:id/files/lookup). The
// chips of one reply are looked up together, and remembered until the chat's
// files change.

const lookups = new Map<string, Promise<PathInfo>>();
let queued: { tabId: string; path: string; resolve: (info: PathInfo) => void }[] = [];

const unknownPath = (path: string): PathInfo => ({ input: path, kind: "outside", path: null, name: fileNameOf(path) });

function flushLookups() {
  const batch = queued;
  queued = [];
  const byTab = new Map<string, typeof batch>();
  for (const q of batch) byTab.set(q.tabId, [...(byTab.get(q.tabId) ?? []), q]);
  for (const [tabId, list] of byTab) {
    const paths = [...new Set(list.map((q) => q.path))];
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      void api
        .lookupPaths(tabId, chunk)
        .catch(() => chunk.map(unknownPath))
        .then((infos) => {
          for (const q of list)
            if (chunk.includes(q.path)) q.resolve(infos[chunk.indexOf(q.path)] ?? unknownPath(q.path));
        });
    }
  }
}

/** What a path the agent linked in the tab's chat is: a file, a folder, missing, or outside what the chat may show. */
export function lookupPath(tabId: string, path: string): Promise<PathInfo> {
  const key = `${tabId}\n${path}`;
  let found = lookups.get(key);
  if (!found) {
    found = new Promise((resolve) => {
      if (!queued.length) queueMicrotask(flushLookups);
      queued.push({ tabId, path, resolve });
    });
    lookups.set(key, found);
  }
  return found;
}

/**
 * Opens a file or folder from the chat: a file Rune Browser can show in a tab, anything else (and folders) in the
 * system's app. Only documents, media and archives open with their app; anything else is shown in its folder. Returns a message when it couldn't open it
 * as asked.
 */
export async function openLocal(
  target: { path: string; kind: "file" | "folder"; mime?: string },
  options: { background?: boolean; withSystemApp?: boolean } = {},
): Promise<string | null> {
  if (target.kind === "file" && !options.withSystemApp && isViewableFile(fileNameOf(target.path), target.mime)) {
    await openFile(target.path, { mime: target.mime, background: options.background });
    return null;
  }
  const result = await window.rune.openPath(target.path, "open");
  if (result === "opened") return null;
  if (result === "revealed")
    return `${fileNameOf(target.path)} is shown in its folder: the chat only opens documents, media and archives with their app.`;
  return `Couldn't open ${fileNameOf(target.path)}: ${result}`;
}

/** Shows a file or folder in the system's file manager. */
export async function revealLocal(path: string): Promise<string | null> {
  const result = await window.rune.openPath(path, "reveal");
  return result === "revealed" || result === "opened" ? null : `Couldn't show ${fileNameOf(path)}: ${result}`;
}
