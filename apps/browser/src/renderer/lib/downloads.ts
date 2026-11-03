// Downloads as the main process runs them (main/downloads.ts): the list, live
// progress, and what's signalled without opening the page: a notice when one
// finishes or fails, a dot on the downloads button until they're looked at,
// and the downloads panel opening by itself when a risky file needs an OK.
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { canRetry, needsDecision, type DownloadAction, type DownloadInfo } from "../../shared/downloads";
import { toast } from "../components/Toast";
import { DOWNLOADS_VIEW, selectApp, selectedId } from "./store";

const bridge = window.rune.downloads;

/** Newest first. */
const [downloads, setDownloads] = createStore<DownloadInfo[]>([]);
export { downloads };

/** When this run started: the downloads button shows what was downloaded since. */
const startedAt = Date.now();

const [panelOpen, setPanelOpen] = createSignal(false);
/** Finished or failed downloads nobody has looked at yet (the button's dot). */
const [unseen, setUnseen] = createSignal(0);
export { panelOpen, unseen };

export function showPanel(open: boolean) {
  setPanelOpen(open);
  if (open) setUnseen(0);
}

/** This run's downloads, and what's still running or waiting for an OK from before. */
export const recentDownloads = () =>
  downloads.filter((d) => d.startedAt >= startedAt || d.state === "progressing" || needsDecision(d));

export const runningDownloads = () => downloads.filter((d) => d.state === "progressing" && !d.paused);

const sortByStart = (list: DownloadInfo[]) => [...list].sort((a, b) => b.startedAt - a.startedAt);

function apply(next: DownloadInfo[]) {
  setDownloads(reconcile(sortByStart(next), { key: "id" }));
}

export async function act(d: DownloadInfo, action: DownloadAction) {
  const problem = await bridge.act(d.id, action);
  if (problem) toast({ title: d.filename, message: problem, kind: "error" });
}

export const clearDownloads = () => bridge.clear();

export const openDownloadsPage = () => {
  showPanel(false);
  setUnseen(0);
  return selectApp(DOWNLOADS_VIEW);
};

/** Tells the user about what changed, unless they're looking at the page. */
function signal(before: DownloadInfo | undefined, d: DownloadInfo) {
  const onPage = selectedId() === DOWNLOADS_VIEW;
  if (needsDecision(d) && (!before || !needsDecision(before))) {
    // Risky: it waits for the user's OK, in the panel.
    if (!onPage) showPanel(true);
    return;
  }
  const finished = d.state === "completed" && before?.state !== "completed" && !needsDecision(d);
  const failed = d.state === "interrupted" && before?.state !== "interrupted";
  if (!finished && !failed) return;
  if (onPage || panelOpen()) return;
  setUnseen((n) => n + 1);
  if (finished)
    toast({
      title: "Downloaded",
      message: d.filename,
      kind: "success",
      action: { label: "Show in folder", run: () => void act(d, "show") },
    });
  else
    toast({
      title: "Download failed",
      message: `${d.filename}: ${d.error ?? "Couldn't finish downloading"}`,
      kind: "error",
      action: canRetry(d) ? { label: "Retry", run: () => void act(d, "retry") } : undefined,
    });
}

bridge.onChanged((change) => {
  const before = new Map(downloads.map((d) => [d.id, { ...d }]));
  const gone = new Set(change.removed);
  const updated = new Map(change.updated.map((d) => [d.id, d]));
  const next = downloads.filter((d) => !gone.has(d.id) && !updated.has(d.id)).map((d) => ({ ...d }));
  apply([...next, ...change.updated]);
  for (const d of updated.values()) signal(before.get(d.id), d);
});

export const loadDownloads = () => bridge.list().then(apply);
void loadDownloads();
