// Schedules: checking them and describing them, for the server and the UI.
import type { ScheduleSpec, ScheduleTask, ScheduleTrigger } from "./api";
import { describeCron, parseCron, shortestGapMinutes } from "./cron";

/** Recurring schedules run at most this often. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_TIMEOUT_SEC = 1800;
export const DEFAULT_TIMEOUT_SEC = 300;
export const MAX_PROMPT = 20_000;

/** The tab a schedule's task runs in (null: a prompt that opens one on its first run). */
export const taskTab = (task: ScheduleTask): string | null => task.appId ?? null;

const EVENT = /^(rune\.started|app\.(started|crashed):[\w-]+|app:[\w-]+:[\w.-]{1,64})$/;

/** What's wrong with a schedule, if anything. */
export function scheduleProblem(spec: ScheduleSpec, now = new Date()): string | null {
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
    if (!EVENT.test(t.event ?? ""))
      return 'Events are "rune.started", "app.started:<app>", "app.crashed:<app>" or "app:<app>:<name>"';
  } else return "trigger.type must be once, cron or event";
  const task = spec.task;
  if (task?.type === "prompt") {
    if (!task.prompt?.trim()) return "What should the agent do?";
    if (task.prompt.length > MAX_PROMPT) return "The prompt is too long";
    if (!task.appId && !task.newTab) return "Which tab?";
    if (task.appId && task.newTab) return "Either a tab or a new tab, not both";
    if (task.newTab) {
      if (task.newTab.kind !== "app" && task.newTab.kind !== "web") return "newTab.kind must be app or web";
      if (!task.newTab.workspaceId) return "Which workspace?";
      if (task.newTab.kind === "web" && !/^https?:\/\/\S+$/i.test(task.newTab.url ?? ""))
        return "Which website? Give an http(s) address";
    }
  } else if (!task?.appId) return "Which app?";
  else if (task.type === "tool") {
    if (!task.tool?.trim()) return "Which tool?";
  } else if (task.type === "command") {
    if (!task.command?.trim()) return "Which command?";
    if (task.command.length > 2000) return "The command is too long";
  } else return "task.type must be tool, command or prompt";
  if (!["always", "failure", "never"].includes(spec.notify)) return "notify must be always, failure or never";
  if (!Number.isInteger(spec.timeoutSec) || spec.timeoutSec < 5 || spec.timeoutSec > MAX_TIMEOUT_SEC)
    return `The timeout must be 5 to ${MAX_TIMEOUT_SEC} seconds`;
  return null;
}

/** "Every day at 08:00", "Once on …", "When Rune Browser starts"… */
export function describeTrigger(trigger: ScheduleTrigger, appName: (id: string) => string = (id) => id) {
  if (trigger.type === "cron") return describeCron(trigger.cron);
  if (trigger.type === "once")
    return `Once, ${new Date(trigger.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  const e = trigger.event;
  if (e === "rune.started") return "When Rune Browser starts";
  const [kind, rest] = [e.slice(0, e.indexOf(":")), e.slice(e.indexOf(":") + 1)];
  if (kind === "app.started") return `When ${appName(rest)} starts`;
  if (kind === "app.crashed") return `When ${appName(rest)} crashes`;
  const [app, ...name] = rest.split(":");
  return `When ${appName(app!)} sends “${name.join(":")}”`;
}
