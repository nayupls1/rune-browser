// Tab cleanup: tabs nobody has used for a while (Settings → Tabs, or a
// workspace's own setting) are closed, after they were unloaded (lib/unload.ts):
// tabs sleep first and close later. Closed tabs stay in History and in recently
// closed tabs (Ctrl+Shift+T).
//
// The server keeps when each tab was last on screen (this window tells it, so it
// survives restarts) and says which tabs are idle long enough, leaving out
// pinned and private tabs, tabs whose agent is working or runs a background job,
// and tabs a scheduled task runs in (GET /api/apps/idle). This window leaves out
// what only it knows: tabs on screen, playing sound, or holding typed input (in
// the page, kept from an unloaded page, or unsent in the agent's composer). The
// server checks again before it closes one.
import { createEffect, createRoot, on } from "solid-js";
import { hasDraft } from "../components/Composer";
import { api } from "./api";
import { peekSavedPage } from "./pagestate";
import { settings } from "./settings";
import { visibleTabs } from "./splits";
import { appById, closeIdleTab, isLoaded, isPrivate, workspaces } from "./store";
import { isAudible, pageOf } from "./webtabs";

const SWEEP_MS = 5 * 60_000;
/** Tabs on screen are reported this often (and when they come and go). */
const REPORT_MS = 60_000;

/** Whether any workspace closes idle tabs at all (else there's nothing to ask the server). */
const enabled = () =>
  settings().tabs.closeAfterHours > 0 || workspaces.some((w) => (w.settings.closeAfterHours ?? 0) > 0);

/** Whether a tab holds input the user typed and would lose. */
async function hasInput(id: string) {
  if (hasDraft(id)) return true;
  if (!isLoaded(id)) return !!peekSavedPage(id)?.fields.length;
  const page = await pageOf(id)
    ?.saveState()
    .catch(() => null);
  return !!page?.fields.length;
}

/** Closes this window's idle tabs; returns which. */
export async function cleanUp() {
  if (isPrivate || !enabled()) return [];
  const idle = await api.idleTabs().catch(() => [] as string[]);
  const closed: string[] = [];
  for (const id of idle) {
    // Only this window's tabs, and not while it's on screen or playing sound.
    if (!appById(id) || visibleTabs().includes(id) || isAudible(id) || pageOf(id)?.busy()) continue;
    if (await hasInput(id)) continue;
    if (await closeIdleTab(id)) closed.push(id);
  }
  return closed;
}

const report = (ids: string[]) => {
  const tabs = ids.filter((id) => appById(id));
  if (tabs.length && !isPrivate) void api.tabsUsed(tabs).catch(() => {});
};

/** Starts reporting the tabs on screen and closing idle ones (once, from App). */
export function startCleanup() {
  createRoot(() => {
    // A tab counts as used while it's on screen and when it leaves the screen.
    createEffect(on(visibleTabs, (now, before) => report([...new Set([...now, ...(before ?? [])])])));
  });
  setInterval(() => report(visibleTabs()), REPORT_MS);
  setInterval(() => void cleanUp(), SWEEP_MS);
}

// For the e2e checks: run tab cleanup now.
declare global {
  interface Window {
    __runeCleanup?: () => Promise<string[]>;
  }
}
window.__runeCleanup = cleanUp;
