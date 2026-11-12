// Windows, as this one sees them (main/windows.ts opens and keeps them): new and
// private windows, moving tabs to another window (a tab's menu, or dragged out
// of the sidebar onto another window or anywhere outside), and reopening closed ones.
import { toast } from "../components/Toast";
import { api } from "./api";
import { appById, apps, moveTab, windowId } from "./store";
import { flushHistory } from "./tabHistory";

const failed = (what: string) => (err: unknown) =>
  toast({ message: `${what} failed: ${err instanceof Error ? err.message : String(err)}`, kind: "error" });

/** Ctrl+N: a new window, with a new tab. From a private window too it's a normal one, like in Chrome. */
export const newWindow = () => window.rune.window.open().catch(failed("Opening a window"));

/** Ctrl+Shift+N: a private window. */
export const newPrivateWindow = () => window.rune.window.open({ private: true }).catch(failed("Opening a window"));

/** "Move to new window", or a tab dropped outside every window: it opens there (where it was dropped, if the platform says). */
export async function moveToNewWindow(tabIds: string[], at?: { x: number; y: number }) {
  const opened = await window.rune.window.open({ tabIds, ...(at ? { at } : {}) }).catch(failed("Moving the tab"));
  if (opened === null) failed("Moving the tab")("it didn't open");
}

/** Moves tabs to another open window, which comes to the front. */
export async function moveToWindow(tabIds: string[], target: string) {
  try {
    for (const id of tabIds) {
      // The other window opens it with its back/forward history.
      await flushHistory(id);
      await api.moveToWindow(id, target);
    }
    window.rune.window.focus(target);
  } catch (err) {
    failed("Moving the tab")(err);
  }
}

/** A tab dragged in from another window: it moves here, next to the tab it was dropped on (or last). */
export async function takeTab(tabId: string, at?: { id: string; side: "before" | "after" }) {
  if (appById(tabId)) return;
  try {
    await api.moveToWindow(tabId, windowId);
  } catch (err) {
    return failed("Moving the tab here")(err);
  }
  // The hub tells this window about it; it's placed once it's here.
  for (let i = 0; i < 50 && !appById(tabId); i++) await new Promise((r) => setTimeout(r, 50));
  if (at && appById(tabId) && appById(at.id)) await moveTab(tabId, at.id, at.side);
}

/** The other windows of the same kind (private or not), to move a tab to. */
export const otherWindows = () => window.rune.window.others().catch(() => []);

// --- Dragging a tab out ------------------------------------------------------------------------

// Whether the pointer left the window during a drag: dragend's coordinates are 0 on some
// platforms (Wayland), so where the drag was last seen decides then.
let leftWindow = false;
document.addEventListener("dragover", () => (leftWindow = false));
document.addEventListener("dragenter", () => (leftWindow = false));
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) leftWindow = true;
});
document.addEventListener("dragstart", () => (leftWindow = false));

/** A tab's drag ended without a drop target: true if it was let go outside the window (it then tears off). */
export function droppedOutside(e: DragEvent) {
  if (e.dataTransfer?.dropEffect !== "none") return false;
  if (e.screenX || e.screenY) {
    const inside = e.clientX >= 0 && e.clientY >= 0 && e.clientX <= innerWidth && e.clientY <= innerHeight;
    return !inside;
  }
  return leftWindow;
}

/** Drags a tab out into a new window, unless it's the window's only tab (then there's nothing to tear off). */
export function tearOff(tabId: string, e: DragEvent) {
  if (apps.length < 2 || !droppedOutside(e)) return false;
  void moveToNewWindow([tabId], e.screenX || e.screenY ? { x: e.screenX, y: e.screenY } : undefined);
  return true;
}

/** Ctrl+Shift+T's other half, and the command bar's "Reopen closed window". */
export const reopenWindow = (id?: string) =>
  window.rune.window
    .reopen(id)
    .then((ok) => ok || toast({ message: "No closed window to reopen", kind: "info" }), failed("Reopening the window"));
