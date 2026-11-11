// Scheduled tasks in the UI: notifications for background runs (a notice in
// Rune Browser's normal windows, and one system notification when Rune Browser
// isn't focused, never when rendering offscreen), and /schedule, which turns a
// chat into a scheduled task.
import { createSignal } from "solid-js";
import type { ScheduleSpec } from "../../shared/api";
import { topics } from "../../shared/hub";
import { DEFAULT_TIMEOUT_SEC, nameFromPrompt } from "../../shared/schedule";
import { toast } from "../components/Toast";
import { watchTopic } from "./realtime";
import { appById, SCHEDULES_VIEW, selectApp, states } from "./store";

/** A task to set up, prefilled (by /schedule): the Schedules page opens its editor with it. */
const [scheduleDraft, setScheduleDraft] = createSignal<ScheduleSpec | null>(null);
export { scheduleDraft, setScheduleDraft };

/** The request a tab's chat makes, if it's one /schedule can turn into a task: one message and one reply. */
export function schedulableRequest(appId: string): string | null {
  const state = states[appId];
  const tab = appById(appId);
  if (!state || !tab || tab.private || state.running) return null;
  const asked = state.messages.filter((m) => m.role === "user");
  const replies = state.messages.filter((m) => m.role === "assistant" && m.content.trim());
  return asked.length === 1 && replies.length >= 1 && asked[0]!.content.trim() ? asked[0]!.content.trim() : null;
}

/**
 * /schedule: the chat's request as a scheduled task, set up on the Schedules
 * page (the user picks when it runs). It runs in this tab, with the chat's
 * model and effort.
 */
export function scheduleChat(appId: string): boolean {
  const prompt = schedulableRequest(appId);
  const tab = appById(appId);
  if (!prompt || !tab) return false;
  const { provider, model, effort } = states[appId]!.agent;
  setScheduleDraft({
    name: nameFromPrompt(prompt),
    prompt,
    trigger: { type: "cron", cron: "0 9 * * *" },
    target: { workspaceId: tab.workspaceId, tabId: tab.id, url: null },
    agent: { provider, model, effort },
    notify: "failure",
    timeoutSec: DEFAULT_TIMEOUT_SEC,
  });
  void selectApp(SCHEDULES_VIEW);
  return true;
}

const titles: Record<string, string> = { ok: "Finished", error: "Failed", timeout: "Timed out", skipped: "Skipped" };

watchTopic(topics.schedules, (msg) => {
  if (msg.type !== "schedule-run" || !msg.notify || window.rune.window.private) return;
  const { run } = msg;
  const title = `${run.scheduleName}: ${titles[run.status] ?? run.status}`;
  toast({ title, message: run.message || "Done", kind: run.status === "ok" ? "success" : "error" });
  if (window.rune.offscreen || document.hasFocus() || typeof Notification === "undefined") return;
  // Every window hears it: the first to take the lock notifies, and holds it while the others hear it too.
  void navigator.locks?.request(`rune-notify-${run.id}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    try {
      new Notification(title, { body: run.message, silent: run.status === "ok" });
    } catch {
      // not supported here
    }
    await new Promise((r) => setTimeout(r, 10_000));
  });
});
