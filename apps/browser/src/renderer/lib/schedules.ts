// Notifications for background runs: a notice in Rune Browser's normal windows, and
// one system notification when Rune Browser isn't focused (never when rendering offscreen).
import { topics } from "../../shared/hub";
import { toast } from "../components/Toast";
import { watchTopic } from "./realtime";

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
