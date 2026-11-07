// Shared tab context: tabs the user shares with their next message to a tab's
// agent, by mentioning them (@name in the composer) or by handing over an
// agent's reply ("Send to…" on a reply). Shown as chips above the composer
// until the message is sent. The server decides what the agent gets
// (agent/sharedTabs.ts); a web page's text is read here, and only for website
// agents (app builders never get web content: shareRefusal).
import { createStore, produce } from "solid-js/store";
import { shareRefusal, type PageContext, type SharedTab } from "../../shared/api";
import { appById, selectApp, sendPrompt, setAgentCollapsed } from "./store";
import { readPageScript } from "./pagestate";
import { wakePage } from "./webtabs";

/** A tab waiting to be shared with the next message; with a reply of its agent when handed over. */
export interface ShareRef {
  tabId: string;
  messageId?: number;
}

const [drafts, setDrafts] = createStore<Record<string, ShareRef[]>>({});

/** What will be shared with the next message to `tabId`'s agent. */
export const sharesOf = (tabId: string) => drafts[tabId] ?? [];

/** Why `sourceId` can't be shared with `recipientId`'s agent, or null. */
export function refusal(recipientId: string, sourceId: string) {
  const recipient = appById(recipientId);
  return recipient ? shareRefusal(recipient, appById(sourceId)) : "That tab doesn't exist anymore.";
}

/** Adds a tab (or one of its agent's replies) to the next message; returns why not when it can't be shared. */
export function addShare(recipientId: string, ref: ShareRef): string | null {
  const why = refusal(recipientId, ref.tabId);
  if (why) return why;
  setDrafts(
    produce((d) => {
      const list = (d[recipientId] ??= []);
      if (!list.some((r) => same(r, ref))) list.push(ref);
    }),
  );
  return null;
}

const same = (a: ShareRef, b: ShareRef) => a.tabId === b.tabId && a.messageId === b.messageId;

export const removeShare = (recipientId: string, ref: ShareRef) =>
  setDrafts(recipientId, (list) => (list ?? []).filter((r) => !same(r, ref)));

/** Hands an agent's reply over to another tab: opens it with the reply attached to its next message. */
export async function handOver(fromTabId: string, messageId: number, toTabId: string) {
  const why = addShare(toTabId, { tabId: fromTabId, messageId });
  if (why) return why;
  await selectApp(toTabId);
  setAgentCollapsed(toTabId, false);
  queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(`[data-agent-for="${toTabId}"] textarea`)?.focus());
  return null;
}

/** A tab's page as text (waking the tab up if it's unloaded); null without one. */
export async function readPage(tabId: string) {
  const handle = await wakePage(tabId);
  return ((await handle.eval(readPageScript)) as SharedTab["page"] | null) ?? null;
}

/** What's shared with a message to `recipientId`: pages are read now, for website agents only. */
async function gather(recipientId: string): Promise<SharedTab[]> {
  const recipient = appById(recipientId);
  const out: SharedTab[] = [];
  for (const ref of sharesOf(recipientId)) {
    const shared: SharedTab = {
      tabId: ref.tabId,
      ...(ref.messageId !== undefined ? { messageId: ref.messageId } : {}),
    };
    // A handed-over reply is what was asked for; a mentioned tab brings its page.
    if (recipient?.kind === "web" && ref.messageId === undefined) {
      const page = await readPage(ref.tabId).catch(() => null);
      if (page) shared.page = page;
    }
    out.push(shared);
  }
  return out;
}

/** Sends a message to a tab's agent with the tabs shared with it; they're cleared once it's sent. */
export async function sendWithShares(tabId: string, prompt: string, page?: PageContext) {
  const refs = sharesOf(tabId).map((r) => ({ ...r }));
  const shared = refs.length ? await gather(tabId) : undefined;
  if (await sendPrompt(tabId, prompt, page, shared))
    setDrafts(tabId, (list) => (list ?? []).filter((r) => !refs.some((sent) => same(sent, r))));
}
