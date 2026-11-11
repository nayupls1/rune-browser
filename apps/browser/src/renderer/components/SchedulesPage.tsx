// Scheduled tasks: prompts for an agent that run on their own (each run a new
// chat in the task's tab, as if the user had sent it), once, repeating or
// when Rune Browser starts. Shows every task (pause, edit, run now, delete), what's running,
// what's coming up and the past runs with the agent's replies. The times are
// picked in words (every weekday at 9:00), not as cron expressions. Updates live.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import {
  effortLabels,
  type AgentChoice,
  type Schedule,
  type ScheduleRun,
  type ScheduleSpec,
  type ScheduleTarget,
  type ScheduleTrigger,
} from "../../shared/api";
import {
  cronToRepeat,
  describeRepeat,
  HOUR_STEPS,
  MINUTE_STEPS,
  parseCron,
  repeatToCron,
  WEEKDAYS,
  type Repeat,
} from "../../shared/cron";
import { topics } from "../../shared/hub";
import { DEFAULT_TIMEOUT_SEC, describeTrigger, nameFromPrompt, nextRun, scheduleProblem } from "../../shared/schedule";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { scheduleDraft, setScheduleDraft } from "../lib/schedules";
import {
  allApps,
  currentWorkspace,
  defaultAgent,
  providerById,
  selectApp,
  setAgentCollapsed,
  workspaceById,
  workspaces,
} from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { AgentPicker, choiceModel } from "./AgentPicker";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button, EmptyState } from "./ui";

const tabById = (id: string | null) => (id ? allApps().find((a) => a.id === id) : undefined);
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** "Notes", "a new tab at news.example"; with the workspace when there are several. */
function describeTarget(target: ScheduleTarget, workspaceId: string) {
  const tab = tabById(target.tabId);
  const where = target.tabId
    ? (tab?.name ?? "a closed tab")
    : target.url
      ? `a new tab at ${host(target.url)}`
      : "a new tab";
  const space = workspaces.length > 1 ? workspaceById(workspaceId)?.name : undefined;
  return space ? `${where} in ${space}` : where;
}

/** "Sonnet 4.5 · High", "Codex default". */
export function describeAgent(agent: AgentChoice) {
  const name =
    choiceModel(agent)?.name.replace(/^Claude /, "") ??
    agent.model ??
    `${providerById(agent.provider)?.label ?? agent.provider} default`;
  return agent.effort ? `${name} · ${effortLabels[agent.effort] ?? agent.effort}` : name;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const statusIcons: Record<ScheduleRun["status"], string> = {
  running: "loader",
  ok: "circle-check",
  error: "circle-x",
  timeout: "timer-off",
  skipped: "skip-forward",
};

/** "in 5 min", "in 2 h", "in 3 days"… */
function relative(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`;
  return `in ${Math.round(minutes / 1440)} days`;
}

const duration = (run: ScheduleRun) => {
  if (!run.finishedAt) return "";
  const s = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
  return s < 1 ? "<1 s" : s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
};

/** Opens the tab a run's chat is in, with its agent sidebar. */
const openChat = (tabId: string) => {
  setAgentCollapsed(tabId, false);
  void selectApp(tabId);
};

type Editing = { schedule: Schedule | null; draft: ScheduleSpec | null };

export function SchedulesPage() {
  const [schedules, { refetch: refetchSchedules }] = createResource(() => api.schedules());
  const [upcoming, { refetch: refetchUpcoming }] = createResource(() => api.upcomingRuns());
  const [runs, setRuns] = createSignal<ScheduleRun[]>([]);
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [error, setError] = createSignal<string>();

  void api.scheduleRuns({ limit: 100 }).then(setRuns);
  // /schedule in a chat: its request, ready to be given a time.
  createEffect(
    on(scheduleDraft, (draft) => {
      if (!draft) return;
      setEditing({ schedule: null, draft });
      setScheduleDraft(null);
    }),
  );
  onCleanup(
    watchTopic(topics.schedules, (msg) => {
      if (msg.type === "schedules-changed") {
        void refetchSchedules();
        void refetchUpcoming();
      } else if (msg.type === "schedule-run") {
        void refetchSchedules();
        setRuns((list) => [msg.run, ...list.filter((r) => r.id !== msg.run.id)].sort((a, b) => b.id - a.id));
      }
    }),
  );

  const act = async (fn: () => Promise<unknown>) => {
    setError();
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const running = () => runs().filter((r) => r.status === "running");
  const past = () => runs().filter((r) => r.status !== "running");

  return (
    <div {...stylex.attrs(styles.page)} data-schedules>
      <div {...stylex.attrs(styles.titleRow)}>
        <p {...stylex.attrs(styles.muted)}>
          Prompts for an agent that run on their own. Each run is a new chat, as if you had sent the prompt.
        </p>
        <Button variant="primary" onClick={() => setEditing({ schedule: null, draft: null })} data-new-schedule>
          + New task
        </Button>
      </div>
      <Show when={error()}>
        <p {...stylex.attrs(styles.error)}>{error()}</p>
      </Show>
      <Show when={editing()} keyed>
        {(target) => <ScheduleEditor schedule={target.schedule} draft={target.draft} onDone={() => setEditing(null)} />}
      </Show>

      <section {...stylex.attrs(styles.section)}>
        <h2 {...stylex.attrs(styles.sectionTitle)}>Scheduled tasks</h2>
        <div {...stylex.attrs(styles.list)}>
          <For
            each={schedules()}
            fallback={
              <EmptyState
                icon="calendar-clock"
                title="No scheduled tasks yet"
                hint="Create one, or type /schedule in a chat to repeat what you asked."
              />
            }
          >
            {(s) => (
              <div {...stylex.attrs(styles.item)} data-schedule={s.id} data-paused={s.paused ? "yes" : "no"}>
                <Icon name="sparkles" size={16} {...stylex.attrs(styles.itemIcon)} />
                <div {...stylex.attrs(styles.itemText)}>
                  <span {...stylex.attrs(styles.itemTitle)}>
                    {s.name}
                    <Show when={s.paused}>
                      <span {...stylex.attrs(styles.badge)}>paused</span>
                    </Show>
                    <Show when={s.running}>
                      <span {...stylex.attrs(styles.badge, styles.badgeRunning)}>running</span>
                    </Show>
                  </span>
                  <span {...stylex.attrs(styles.meta)} data-schedule-meta>
                    {describeTrigger(s.trigger)} · {describeTarget(s.target, s.workspaceId)}
                    <Show when={s.agent}>{(agent) => <> · {describeAgent(agent())}</>}</Show>
                  </span>
                  <span {...stylex.attrs(styles.meta)}>
                    <Show
                      when={s.nextRunAt}
                      fallback={
                        s.paused
                          ? "Paused"
                          : s.trigger.type === "event"
                            ? "Runs when Rune Browser starts"
                            : "Won't run again"
                      }
                    >
                      Next {relative(s.nextRunAt!)} ({when(s.nextRunAt!)})
                    </Show>
                    <Show when={s.lastRun}>
                      {(last) => (
                        <>
                          {" "}
                          · last: {last().status}
                          {last().message ? ` (${last().message.slice(0, 80)})` : ""}
                        </>
                      )}
                    </Show>
                  </span>
                </div>
                <button
                  type="button"
                  title={s.paused ? "Resume" : "Pause"}
                  onClick={() => void act(() => api.updateSchedule(s.id, { paused: !s.paused }))}
                  {...stylex.attrs(styles.iconButton)}
                  data-pause-schedule
                >
                  <Icon name={s.paused ? "play" : "pause"} size={15} />
                </button>
                <button
                  type="button"
                  title="Run now"
                  onClick={() => void act(() => api.runSchedule(s.id))}
                  {...stylex.attrs(styles.iconButton)}
                  data-run-schedule
                >
                  <Icon name="zap" size={15} />
                </button>
                <button
                  type="button"
                  title="Edit"
                  onClick={() => setEditing({ schedule: s, draft: null })}
                  {...stylex.attrs(styles.iconButton)}
                  data-edit-schedule
                >
                  <Icon name="pencil" size={15} />
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={async () => {
                    if (
                      await confirmDialog(`Delete the task “${s.name}” and its runs?`, {
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    ) {
                      await act(() => api.deleteSchedule(s.id));
                    }
                  }}
                  {...stylex.attrs(styles.iconButton)}
                  data-delete-schedule
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            )}
          </For>
        </div>
      </section>

      <Show when={running().length}>
        <section {...stylex.attrs(styles.section)}>
          <h2 {...stylex.attrs(styles.sectionTitle)}>Running</h2>
          <div {...stylex.attrs(styles.list)}>
            <For each={running()}>{(run) => <RunRow run={run} />}</For>
          </div>
        </section>
      </Show>

      <Show when={upcoming()?.length}>
        <section {...stylex.attrs(styles.section)}>
          <h2 {...stylex.attrs(styles.sectionTitle)}>Coming up</h2>
          <div {...stylex.attrs(styles.list)} data-upcoming>
            <For each={upcoming()}>
              {(u) => (
                <div {...stylex.attrs(styles.item)}>
                  <Icon name="clock" size={14} {...stylex.attrs(styles.itemIcon)} />
                  <span {...stylex.attrs(styles.itemTitle)}>{u.name}</span>
                  <span {...stylex.attrs(styles.meta)}>
                    {when(u.at)} · {relative(u.at)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>

      <section {...stylex.attrs(styles.section)}>
        <h2 {...stylex.attrs(styles.sectionTitle)}>Past runs</h2>
        <div {...stylex.attrs(styles.list)} data-past-runs>
          <For each={past()} fallback={<p {...stylex.attrs(styles.empty)}>Nothing has run yet.</p>}>
            {(run) => <RunRow run={run} />}
          </For>
        </div>
      </section>
    </div>
  );
}

/** A run: how it went, the agent's reply (kept when its tab is gone), and its chat while the tab is open. */
function RunRow(props: { run: ScheduleRun }) {
  const [open, setOpen] = createSignal(false);
  const bad = () => props.run.status === "error" || props.run.status === "timeout";
  const chatTab = () => tabById(props.run.tabId);
  return (
    <div {...stylex.attrs(styles.run)} data-run={props.run.id} data-run-status={props.run.status}>
      <div {...stylex.attrs(styles.runRow)}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={!props.run.output}
          {...stylex.attrs(styles.runHead)}
        >
          <Icon
            name={statusIcons[props.run.status]}
            size={15}
            {...stylex.attrs(styles.runIcon, bad() && styles.runIconBad)}
          />
          <span {...stylex.attrs(styles.itemTitle)}>{props.run.scheduleName}</span>
          <span {...stylex.attrs(styles.meta, styles.runMessage)}>{props.run.message || props.run.status}</span>
          <span {...stylex.attrs(styles.meta)}>
            {props.run.trigger === "manual" ? "run by you" : props.run.trigger === "event" ? "on event" : "on time"} ·{" "}
            {when(props.run.startedAt)}
            {props.run.finishedAt ? ` · ${duration(props.run)}` : ""}
          </span>
        </button>
        <Show when={chatTab()}>
          {(tab) => (
            <button
              type="button"
              title={`Open the chat in ${tab().name}`}
              onClick={() => openChat(tab().id)}
              {...stylex.attrs(styles.iconButton)}
              data-open-run-chat
            >
              <Icon name="message-circle" size={15} />
            </button>
          )}
        </Show>
      </div>
      <Show when={open() && props.run.output}>
        <pre {...stylex.attrs(styles.output)}>{props.run.output}</pre>
      </Show>
    </div>
  );
}

type When = "once" | Repeat["every"] | "event" | "custom";

const WHEN_OPTIONS: [When, string][] = [
  ["once", "Once"],
  ["day", "Every day"],
  ["weekdays", "Every weekday"],
  ["week", "Every week"],
  ["month", "Every month"],
  ["hours", "Every few hours"],
  ["minutes", "Every few minutes"],
  ["event", "When Rune Browser starts"],
];
/** The week as people read it: Monday first. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const TIME_LIMITS = [1, 2, 5, 10, 15, 20, 30].map((m) => m * 60);

/** A datetime-local value for an ISO time (local). */
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** "9:00" ⇄ the time input's "09:00". */
const timeInput = (time: string) => time.padStart(5, "0");
const fromTimeInput = (value: string) => value.replace(/^0(\d)/, "$1") || "9:00";

function ScheduleEditor(props: { schedule: Schedule | null; draft: ScheduleSpec | null; onDone: () => void }) {
  const s = props.schedule;
  const initial = s ?? props.draft;
  const [prompt, setPrompt] = createSignal(initial?.prompt ?? "");
  const [name, setName] = createSignal(s?.name ?? "");

  // When: a repeat in words (stored as a cron expression), once, or an event.
  const repeat = initial?.trigger.type === "cron" ? cronToRepeat(initial.trigger.cron) : null;
  const [mode, setMode] = createSignal<When>(
    !initial ? "day" : initial.trigger.type === "cron" ? (repeat?.every ?? "custom") : initial.trigger.type,
  );
  const [time, setTime] = createSignal(repeat && "time" in repeat ? repeat.time : "9:00");
  const [days, setDays] = createSignal<number[]>(repeat?.every === "week" ? repeat.days : [1]);
  const [monthDay, setMonthDay] = createSignal(repeat?.every === "month" ? repeat.day : 1);
  const [hours, setHours] = createSignal(repeat?.every === "hours" ? repeat.n : 2);
  const hourMinute = repeat?.every === "hours" ? repeat.minute : 0;
  const [minutes, setMinutes] = createSignal(repeat?.every === "minutes" ? repeat.n : 15);
  const [cron, setCron] = createSignal(initial?.trigger.type === "cron" ? initial.trigger.cron : "0 9 * * *");
  const [at, setAt] = createSignal(
    initial?.trigger.type === "once"
      ? localInput(initial.trigger.at)
      : localInput(new Date(Date.now() + 3600_000).toISOString()),
  );
  // Where: a tab of the workspace, or a new one opened on the first run (and kept).
  const [workspaceId, setWorkspaceId] = createSignal(
    (s?.workspaceId ?? initial?.target.workspaceId) || (currentWorkspace()?.id ?? ""),
  );
  const tabsOf = () => allApps().filter((a) => a.workspaceId === workspaceId() && !a.private);
  /** A tab's id, or "new" (a new tab opened on the first run). */
  const [target, setTarget] = createSignal(initial?.target.tabId ?? "new");
  const keptTab = initial?.target.tabId && !tabById(initial.target.tabId) ? initial.target.tabId : null;
  const [url, setUrl] = createSignal(initial?.target.url ?? "");
  const newTab = () => target() === "new";

  // Who answers: the workspace's default agent, or a model picked for the task.
  const [agent, setAgent] = createSignal<AgentChoice | null>(initial?.agent ?? null);
  const shownAgent = () => agent() ?? defaultAgent(workspaceById(workspaceId()));
  const usesDefault = () => !agent();

  const [notify, setNotify] = createSignal<ScheduleSpec["notify"]>(initial?.notify ?? "failure");
  const [timeout, setTimeout_] = createSignal(initial?.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
  const limits = () => [...new Set([...TIME_LIMITS, timeout()])].sort((a, b) => a - b);
  const [error, setError] = createSignal<string>();

  const currentRepeat = (): Repeat | null => {
    const m = mode();
    if (m === "minutes") return { every: "minutes", n: minutes() };
    if (m === "hours") return { every: "hours", n: hours(), minute: hourMinute };
    if (m === "day" || m === "weekdays") return { every: m, time: time() };
    if (m === "week") return { every: "week", days: days(), time: time() };
    if (m === "month") return { every: "month", day: monthDay(), time: time() };
    return null;
  };
  const trigger = (): ScheduleTrigger => {
    const r = currentRepeat();
    if (r) return { type: "cron", cron: repeatToCron(r) };
    if (mode() === "custom") return { type: "cron", cron: cron().trim() };
    if (mode() === "once") return { type: "once", at: new Date(at()).toISOString() };
    return { type: "event", event: "rune.started" };
  };
  /** The schedule read back in words, with its next run. */
  const summary = () => {
    const t = trigger();
    if (t.type === "cron" && typeof parseCron(t.cron) === "string") return parseCron(t.cron) as string;
    if (mode() === "week" && !days().length) return "Pick at least one day";
    const r = currentRepeat();
    const words = r ? describeRepeat(r) : describeTrigger(t);
    const next = nextRun(t, new Date());
    return next ? `${words} · next ${when(next)} (${relative(next)})` : words;
  };
  const toggleDay = (d: number) => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));

  const spec = (): ScheduleSpec | string => {
    if (mode() === "week" && !days().length) return "Pick at least one day";
    const where = target();
    return {
      name: name().trim() || nameFromPrompt(prompt()),
      trigger: trigger(),
      prompt: prompt(),
      target: newTab()
        ? { workspaceId: workspaceId(), tabId: null, url: url().trim() || null }
        : { workspaceId: workspaceId(), tabId: where, url: initial?.target.url ?? null },
      agent: agent(),
      notify: notify(),
      timeoutSec: timeout(),
    };
  };

  const save = async (e: Event) => {
    e.preventDefault();
    const value = spec();
    const problem = typeof value === "string" ? value : scheduleProblem(value);
    if (problem) return setError(problem);
    try {
      if (s) await api.updateSchedule(s.id, { spec: value as ScheduleSpec });
      else await api.createSchedule(value as ScheduleSpec);
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form onSubmit={save} {...stylex.attrs(styles.editor)} data-schedule-editor>
      <h2 {...stylex.attrs(styles.sectionTitle)}>{s ? `Edit “${s.name}”` : "New scheduled task"}</h2>
      <label {...stylex.attrs(styles.field, styles.top)}>
        <span {...stylex.attrs(styles.label)}>Prompt</span>
        <textarea
          value={prompt()}
          rows={4}
          placeholder="Check the news sites I follow and summarize what's new since yesterday."
          onInput={(e) => setPrompt(e.currentTarget.value)}
          {...stylex.attrs(styles.input, styles.textarea)}
          data-schedule-prompt
        />
      </label>
      <label {...stylex.attrs(styles.field)}>
        <span {...stylex.attrs(styles.label)}>Name</span>
        <input
          value={name()}
          placeholder={nameFromPrompt(prompt()) || "Morning news"}
          onInput={(e) => setName(e.currentTarget.value)}
          {...stylex.attrs(styles.input)}
          data-schedule-name
        />
      </label>

      <div {...stylex.attrs(styles.field, styles.wrap)}>
        <span {...stylex.attrs(styles.label)}>When</span>
        <select
          value={mode()}
          onChange={(e) => setMode(e.currentTarget.value as When)}
          {...stylex.attrs(styles.input, styles.narrow)}
          data-schedule-when
        >
          <For each={WHEN_OPTIONS}>{([value, label]) => <option value={value}>{label}</option>}</For>
          <Show when={repeat === null && initial?.trigger.type === "cron"}>
            <option value="custom">Custom</option>
          </Show>
        </select>
        <Show when={mode() === "once"}>
          <input
            type="datetime-local"
            value={at()}
            onInput={(e) => setAt(e.currentTarget.value)}
            {...stylex.attrs(styles.input, styles.auto)}
            data-schedule-at
          />
        </Show>
        <Show when={mode() === "month"}>
          <span {...stylex.attrs(styles.meta)}>on the</span>
          <select
            value={monthDay()}
            onChange={(e) => setMonthDay(Number(e.currentTarget.value))}
            {...stylex.attrs(styles.input, styles.tiny)}
            data-schedule-monthday
          >
            <For each={Array.from({ length: 28 }, (_, i) => i + 1)}>{(d) => <option value={d}>{d}</option>}</For>
          </select>
        </Show>
        <Show when={mode() === "day" || mode() === "weekdays" || mode() === "week" || mode() === "month"}>
          <span {...stylex.attrs(styles.meta)}>at</span>
          <input
            type="time"
            value={timeInput(time())}
            onInput={(e) => setTime(fromTimeInput(e.currentTarget.value))}
            {...stylex.attrs(styles.input, styles.time)}
            data-schedule-time
          />
        </Show>
        <Show when={mode() === "hours"}>
          <select
            value={hours()}
            onChange={(e) => setHours(Number(e.currentTarget.value))}
            {...stylex.attrs(styles.input, styles.auto)}
            data-schedule-hours
          >
            <For each={HOUR_STEPS}>
              {(n) => <option value={n}>{n === 1 ? "every hour" : `every ${n} hours`}</option>}
            </For>
          </select>
        </Show>
        <Show when={mode() === "minutes"}>
          <select
            value={minutes()}
            onChange={(e) => setMinutes(Number(e.currentTarget.value))}
            {...stylex.attrs(styles.input, styles.auto)}
            data-schedule-minutes
          >
            <For each={MINUTE_STEPS}>{(n) => <option value={n}>{`every ${n} minutes`}</option>}</For>
          </select>
        </Show>
        <Show when={mode() === "custom"}>
          <input
            value={cron()}
            onInput={(e) => setCron(e.currentTarget.value)}
            {...stylex.attrs(styles.input, styles.mono, styles.narrow)}
            data-schedule-cron
          />
        </Show>
      </div>
      <Show when={mode() === "week"}>
        <div {...stylex.attrs(styles.days)} role="group" aria-label="Days of the week">
          <For each={WEEK}>
            {(d) => {
              const on = () => days().includes(d);
              return (
                <button
                  type="button"
                  aria-pressed={on()}
                  onClick={() => toggleDay(d)}
                  {...stylex.attrs(styles.day, on() && styles.dayOn)}
                  data-schedule-day={d}
                >
                  {WEEKDAYS[d]!.slice(0, 3)}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <p {...stylex.attrs(styles.summary)} data-schedule-summary>
        <Icon name="calendar-clock" size={13} />
        {summary()}
      </p>

      <div {...stylex.attrs(styles.field, styles.wrap)}>
        <span {...stylex.attrs(styles.label)}>Runs in</span>
        <Show when={workspaces.length > 1}>
          <select
            value={workspaceId()}
            onChange={(e) => {
              setWorkspaceId(e.currentTarget.value);
              if (!newTab()) setTarget("new");
            }}
            {...stylex.attrs(styles.input, styles.auto)}
            data-schedule-workspace
          >
            <For each={workspaces}>{(w) => <option value={w.id}>{w.name}</option>}</For>
          </select>
        </Show>
        <select
          value={target()}
          onChange={(e) => setTarget(e.currentTarget.value)}
          {...stylex.attrs(styles.input)}
          data-schedule-target
        >
          <option value="new">A new tab (opened on the first run)</option>
          <For each={tabsOf()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
          <Show when={keptTab}>{(id) => <option value={id()}>Its tab (closed)</option>}</Show>
        </select>
      </div>
      <Show when={newTab()}>
        <div {...stylex.attrs(styles.field)}>
          <span {...stylex.attrs(styles.label)} />
          <input
            value={url()}
            placeholder="At a website (optional): https://example.com"
            onInput={(e) => setUrl(e.currentTarget.value)}
            {...stylex.attrs(styles.input)}
            data-schedule-url
          />
        </div>
      </Show>

      <div {...stylex.attrs(styles.field)} data-schedule-agent>
        <span {...stylex.attrs(styles.label)}>Model</span>
        <AgentPicker choice={shownAgent()} onChange={setAgent} />
        <Show
          when={usesDefault()}
          fallback={
            <button
              type="button"
              onClick={() => setAgent(null)}
              {...stylex.attrs(styles.link)}
              data-schedule-default-agent
            >
              Use the default
            </button>
          }
        >
          <span {...stylex.attrs(styles.meta)}>The workspace's default</span>
        </Show>
      </div>

      <div {...stylex.attrs(styles.field, styles.wrap)}>
        <span {...stylex.attrs(styles.label)}>Notify</span>
        <select
          value={notify()}
          onChange={(e) => setNotify(e.currentTarget.value as ScheduleSpec["notify"])}
          {...stylex.attrs(styles.input, styles.narrow)}
        >
          <option value="failure">When it fails</option>
          <option value="always">After every run</option>
          <option value="never">Never</option>
        </select>
        <span {...stylex.attrs(styles.meta)}>Stop after</span>
        <select
          value={timeout()}
          onChange={(e) => setTimeout_(Number(e.currentTarget.value))}
          {...stylex.attrs(styles.input, styles.auto)}
          data-schedule-timeout
        >
          <For each={limits()}>
            {(sec) => <option value={sec}>{sec % 60 ? `${sec} seconds` : `${sec / 60} min`}</option>}
          </For>
        </select>
      </div>
      <Show when={error()}>
        <p {...stylex.attrs(styles.error)} data-schedule-error>
          {error()}
        </p>
      </Show>
      <div {...stylex.attrs(styles.actions)}>
        <Button variant="primary" type="submit" data-save-schedule>
          {s ? "Save" : "Create"}
        </Button>
        <Button type="button" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const styles = stylex.create({
  page: {
    boxSizing: "border-box",
    maxWidth: 760,
    marginInline: "auto",
    paddingTop: 32,
    paddingInline: 40,
    paddingBottom: 96,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  titleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.md },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  error: { margin: 0, color: colors.danger, fontSize: font.sm },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionTitle: { margin: 0, fontSize: font.md, fontWeight: 600 },
  list: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  empty: { margin: 0, padding: space.lg, color: colors.muted, textAlign: "center", fontSize: font.sm },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  itemIcon: { flexShrink: 0, color: colors.accent },
  itemText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  itemTitle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: font.sm,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  meta: { color: colors.muted, fontSize: font.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: {
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
  },
  badgeRunning: { color: colors.accent },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  run: {
    display: "flex",
    flexDirection: "column",
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  runHead: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderStyle: "none",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "default" },
  },
  runIcon: { flexShrink: 0, color: colors.success },
  runIconBad: { color: colors.danger },
  runMessage: { flex: 1, minWidth: 0 },
  output: {
    margin: 0,
    marginInline: space.lg,
    marginBottom: space.sm,
    maxHeight: 240,
    overflow: "auto",
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    fontFamily: font.mono,
    fontSize: 11,
    whiteSpace: "pre-wrap",
  },
  editor: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  field: { display: "flex", alignItems: "center", gap: space.sm },
  label: { width: 70, flexShrink: 0, color: colors.muted, fontSize: font.xs },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    height: 32,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    outline: "none",
    backgroundColor: colors.bg,
    color: colors.text,
    fontSize: font.sm,
  },
  narrow: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", width: 170 },
  tiny: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", width: 80 },
  mono: { fontFamily: font.mono, fontSize: font.xs },
  top: { alignItems: "flex-start" },
  textarea: {
    height: "auto",
    minHeight: 84,
    paddingBlock: space.sm,
    resize: "vertical",
    fontFamily: "inherit",
    lineHeight: 1.45,
  },
  wrap: { flexWrap: "wrap", rowGap: space.sm },
  auto: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", width: "auto" },
  time: { flexGrow: 0, flexShrink: 0, flexBasis: "auto", width: 110 },
  days: { display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 78 },
  day: {
    minWidth: 44,
    height: 28,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
  dayOn: {
    borderColor: colors.accent,
    backgroundColor: { default: colors.accent, ":hover": colors.accent },
    color: colors.accentText,
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0,
    paddingLeft: 78,
    color: colors.text,
    fontSize: font.xs,
  },
  link: {
    padding: 0,
    borderStyle: "none",
    backgroundColor: "transparent",
    color: { default: colors.accent, ":hover": colors.text },
    fontSize: font.xs,
    cursor: "pointer",
  },
  runRow: { display: "flex", alignItems: "center", paddingRight: space.sm },
  actions: { display: "flex", gap: space.sm, paddingLeft: 78 },
});
