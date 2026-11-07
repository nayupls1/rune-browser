// Site permission prompts in this window (main/sitePermissions.ts decides):
// the prompts waiting in its web tabs, what each tab's page uses or was
// refused, the screen picker's requests, and notices that the OS hasn't given
// access. Answers are saved into the site's settings (Settings →
// Site settings), except in a private window, whose answers main keeps until
// the private windows close.
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SiteSettingKey } from "../../shared/browser";
import type {
  PromptAnswer,
  ScreenPick,
  ScreenPickRequest,
  SitePermissionPrompt,
  SitePermissionUsage,
  SystemPermissionNotice,
} from "../../shared/sitePermissions";
import { setSiteSetting } from "./browser";

const bridge = window.rune.web.permissions;

const [prompts, setPrompts] = createSignal<SitePermissionPrompt[]>([]);
const [usages, setUsages] = createStore<Record<number, SitePermissionUsage>>({});
const [notices, setNotices] = createSignal<SystemPermissionNotice[]>([]);
const [picks, setPicks] = createSignal<ScreenPickRequest[]>([]);

const addPrompt = (prompt: SitePermissionPrompt) =>
  setPrompts((list) => (list.some((p) => p.requestId === prompt.requestId) ? list : [...list, prompt]));

bridge.onPrompt(addPrompt);
bridge.onPromptDone((requestId) => setPrompts((list) => list.filter((p) => p.requestId !== requestId)));
bridge.onUsage((usage) => setUsages(usage.contentsId, reconcile(usage)));
bridge.onNotice((notice) =>
  setNotices((list) => [...list.filter((n) => n.contentsId !== notice.contentsId || n.kind !== notice.kind), notice]),
);
bridge.onScreenPick((request) => setPicks((list) => [...list, request]));
bridge.onScreenPickDone((requestId) => setPicks((list) => list.filter((p) => p.requestId !== requestId)));
// After the window reloaded: what's still waiting.
void bridge.pending().then((list) => list.forEach(addPrompt));

/** The prompt a tab shows (the oldest; the others wait). */
export const promptFor = (contentsId: number | null) =>
  contentsId === null ? undefined : prompts().find((p) => p.contentsId === contentsId);

export function answerPrompt(prompt: SitePermissionPrompt, answer: PromptAnswer) {
  setPrompts((list) => list.filter((p) => p.requestId !== prompt.requestId));
  // Remembered in the site's settings, before main hears it (so the settings it gets next have it).
  // Screen sharing is never allowed for good: it always asks with the picker.
  if (!prompt.private && (answer === "allow" || answer === "block"))
    for (const key of prompt.keys) if (answer === "block" || key !== "screen") setSiteSetting(prompt.site, key, answer);
  bridge.reply(prompt.requestId, answer);
}

export const usageOf = (contentsId: number | null) => (contentsId === null ? undefined : usages[contentsId]);

/** Reads a tab's usage (when its page first shows up in the window). */
export function loadUsage(contentsId: number) {
  void bridge.usage(contentsId).then((usage) => usage && setUsages(contentsId, reconcile(usage)));
}

export const stopUsing = (contentsId: number, keys: SiteSettingKey[]) => bridge.stop(contentsId, keys);

export const noticesFor = (contentsId: number | null) => notices().filter((n) => n.contentsId === contentsId);
export const dismissNotice = (notice: SystemPermissionNotice) => setNotices((list) => list.filter((n) => n !== notice));
export const openSystemSettings = (kind: SystemPermissionNotice["kind"]) => bridge.openSystemSettings(kind);

/** The screen picker on screen (one at a time). */
export const currentPick = () => picks()[0];
export function answerPick(request: ScreenPickRequest, pick: ScreenPick | null) {
  setPicks((list) => list.filter((p) => p.requestId !== request.requestId));
  bridge.pickScreen(request.requestId, pick);
}
