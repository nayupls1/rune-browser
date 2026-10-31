// Local files in web tabs: files dropped on Rune Browser (lib/drops.ts) and
// the files of a chat's folder (attachments, what the agent made; server:
// agent/ChatFiles.ts), which open from their chips in the chat. A file the
// browser can show (PDF, image, video, audio, text, page) opens in a tab;
// anything else is downloaded, like Chrome does.
import { createStore } from "solid-js/store";
import { DEFAULT_WORKSPACE, type ChatFile } from "../../shared/api";
import { fileNameOf, fileUrl, isViewableFile } from "../../shared/web";
import { api } from "./api";
import { appById, currentWorkspace, newWebTab, selectApp } from "./store";
import { pageOf } from "./webtabs";

/**
 * Opens a URL (a local file's, a website's) in a web tab: in `tabId` if it's
 * a web tab, else in a new one (in the background with `background`).
 */
export async function openUrl(url: string, options: { tabId?: string; background?: boolean } = {}) {
  const tab = options.tabId ? appById(options.tabId) : undefined;
  if (tab?.kind === "web") {
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
  else window.rune.web.download(currentWorkspace()?.id ?? DEFAULT_WORKSPACE, url);
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
