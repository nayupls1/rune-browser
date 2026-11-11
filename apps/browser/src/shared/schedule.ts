// Scheduled tasks: checking them, describing them and when they run next, for the server and the UI.
import { providerIds, type AppSummary, type ScheduleSpec, type ScheduleTarget, type ScheduleTrigger } from "./api";
import { describeCron, nextCron, parseCron, shortestGapMinutes } from "./cron";

/** Recurring schedules run at most this often. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_TIMEOUT_SEC = 1800;
export const DEFAULT_TIMEOUT_SEC = 300;
export const MAX_PROMPT = 20_000;

const WEBSITE = /^https?:\/\/\S+$/i;

/**
 * Where a task runs once its tab is closed: a new tab in the same workspace,
 * opened on its next run (at the address the old one was on, if it was on a
 * website).
 */
export function targetWithoutTab(
  target: ScheduleTarget,
  tab: Pick<AppSummary, "workspaceId" | "url"> | null,
): ScheduleTarget {
  if (!tab) return { ...target, tabId: null };
  const url = tab.url && WEBSITE.test(tab.url) ? tab.url : target.url;
  return { workspaceId: tab.workspaceId, tabId: null, url };
}

/** The events a task can run on. */
export const SCHEDULE_EVENTS = ["rune.started"] as const;

/** What's wrong with a scheduled task, if anything. */
export function scheduleProblem(spec: ScheduleSpec, now = new Date()): string | null {
  if (!spec.prompt?.trim()) return "What should the agent do?";
  if (spec.prompt.length > MAX_PROMPT) return "The prompt is too long";
  if (!spec.name?.trim()) return "Give it a name";
  if (spec.name.length > 100) return "The name is too long";
  const t = spec.trigger;
  if (t?.type === "once") {
    const at = Date.parse(t.at);
    if (Number.isNaN(at)) return "When? Give a date and time";
    if (at < now.getTime() - 60_000) return "That time has passed";
  } else if (t?.type === "cron") {
    const cron = parseCron(t.cron);
    if (typeof cron === "string") return cron;
    if (shortestGapMinutes(cron, now) < MIN_INTERVAL_MINUTES)
      return `Recurring schedules run at most every ${MIN_INTERVAL_MINUTES} minutes`;
  } else if (t?.type === "event") {
    if (!(SCHEDULE_EVENTS as readonly string[]).includes(t.event ?? ""))
      return `Events are ${SCHEDULE_EVENTS.map((e) => `"${e}"`).join(", ")}`;
  } else return "trigger.type must be once, cron or event";
  const target = spec.target;
  if (!target?.workspaceId) return "Which workspace?";
  if (target.url !== null && !WEBSITE.test(target.url ?? "")) return "Which website? Give an http(s) address";
  const agent = spec.agent;
  if (agent !== null) {
    if (!agent || !providerIds.includes(agent.provider)) return `agent.provider must be ${providerIds.join(", ")}`;
    if (agent.model !== null && (typeof agent.model !== "string" || !agent.model || agent.model.length > 200))
      return "Which model?";
    if (agent.effort !== null && (typeof agent.effort !== "string" || !agent.effort || agent.effort.length > 40))
      return "Which reasoning effort?";
  }
  if (!["always", "failure", "never"].includes(spec.notify)) return "notify must be always, failure or never";
  if (!Number.isInteger(spec.timeoutSec) || spec.timeoutSec < 5 || spec.timeoutSec > MAX_TIMEOUT_SEC)
    return `The time limit must be 5 to ${MAX_TIMEOUT_SEC} seconds`;
  return null;
}

/** When a task runs next, after `from` (null: on events only, or a one-off that's due no more). */
export function nextRun(trigger: ScheduleTrigger, from: Date, ran = false): string | null {
  if (trigger.type === "once")
    return ran || Date.parse(trigger.at) < from.getTime() - 60_000 ? null : new Date(trigger.at).toISOString();
  if (trigger.type === "cron") {
    const cron = parseCron(trigger.cron);
    return typeof cron === "string" ? null : (nextCron(cron, from)?.toISOString() ?? null);
  }
  return null;
}

/** A short name for a prompt: its first few words. */
export const nameFromPrompt = (prompt: string) => {
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 60 ? `${words.slice(0, 59)}…` : words;
};

/** "Every weekday at 9:00", "Once, Nov 12, 2026, 9:00 AM", "When Rune Browser starts"… */
export function describeTrigger(trigger: ScheduleTrigger) {
  if (trigger.type === "cron") return describeCron(trigger.cron);
  if (trigger.type === "once")
    return `Once, ${new Date(trigger.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  return trigger.event === "rune.started" ? "When Rune Browser starts" : `On “${trigger.event}”`;
}
