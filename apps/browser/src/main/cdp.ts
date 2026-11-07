// One DevTools protocol connection per page, shared by what uses it (network
// recording, the agents' DevTools): attached when the first one needs it,
// detached when the last one is done.
import type { WebContents } from "electron";

const users = new Map<number, Set<string>>();

/** Attaches to the page for `user`; false if it can't be (the page is gone, or another debugger refuses). */
export function acquire(contents: WebContents, user: string): boolean {
  if (contents.isDestroyed()) return false;
  const dbg = contents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
  } catch (err) {
    console.warn(`Can't attach to a page (${user}):`, err);
    return false;
  }
  let set = users.get(contents.id);
  if (!set) {
    set = new Set();
    users.set(contents.id, set);
    const id = contents.id;
    contents.once("destroyed", () => users.delete(id));
    dbg.once("detach", () => users.delete(id));
  }
  set.add(user);
  return true;
}

/** `user` is done with the page; the connection closes when nobody else uses it. */
export function release(contents: WebContents, user: string) {
  const set = users.get(contents.id);
  set?.delete(user);
  if (set && set.size) return;
  users.delete(contents.id);
  try {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  } catch {
    // already gone
  }
}

/** Sends a command over the page's connection. */
export const send = <T = any>(contents: WebContents, method: string, params: object = {}) =>
  contents.debugger.sendCommand(method, params) as Promise<T>;
