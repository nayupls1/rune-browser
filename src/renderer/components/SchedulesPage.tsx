// Schedules: background runs of apps' tools and commands, and prompts for a
// tab's agent (each run a new chat in the tab), at a time, on a repeating
// schedule or on an event. Shows the current workspace's schedules
// (pause, edit, run now, delete), what's running, what's coming up and the
// past runs with their results. Updates live.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { AppTool, Schedule, ScheduleRun, ScheduleSpec, ScheduleTask, ScheduleTrigger } from "../../shared/api";
import { describeCron, parseCron } from "../../shared/cron";
import { topics } from "../../shared/hub";
import { DEFAULT_TIMEOUT_SEC, describeTrigger, scheduleProblem } from "../../shared/schedule";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { allApps, currentWorkspace } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button, EmptyState } from "./ui";

const appName = (id: string) => allApps().find((a) => a.id === id)?.name ?? "a deleted app";
const taskIcons: Record<ScheduleTask["type"], string> = { tool: "wrench", command: "terminal", prompt: "sparkles" };

/** "Notes · sync", "Notes · bun run x", "a new tab · “Summarize…”". */
function describeTask(task: ScheduleTask) {
  if (task.type === "tool") return `${appName(task.appId)} · ${task.tool}`;
  if (task.type === "command") return `${appName(task.appId)} · ${task.command}`;
  const where = task.appId
    ? appName(task.appId)
    : task.newTab?.kind === "web"
      ? `a new tab (${task.newTab.url})`
      : "a new app tab";
  const prompt = task.prompt.replace(/\s+/g, " ").trim();
  return `${where} · “${prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt}”`;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const statusIcons: Record<ScheduleRun["status"], string> = {
  running: "loader",
  ok: "circle-check",
  error: "circle-x",
  timeout: "timer-off",
  skipped: "skip-forward",
};

/** "in 5 minutes", "in 2 hours", "tomorrow"… */
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

export function SchedulesPage() {
  const workspace = () => currentWorkspace()?.id;
  const [schedules, { refetch: refetchSchedules }] = createResource(workspace, (id) => api.schedules(id));
  const [upcoming, { refetch: refetchUpcoming }] = createResource(workspace, (id) => api.upcomingRuns(id));
  const [runs, setRuns] = createSignal<ScheduleRun[]>([]);
  const [editing, setEditing] = createSignal<Schedule | "new" | null>(null);
  const [error, setError] = createSignal<string>();
  const mine = (run: ScheduleRun) => schedules()?.some((s) => s.id === run.scheduleId) ?? false;

  createEffect(on(workspace, (id) => void api.scheduleRuns({ workspace: id, limit: 100 }).then(setRuns)));
  onCleanup(
    watchTopic(topics.schedules, (msg) => {
      if (msg.type === "schedules-changed") {
        void refetchSchedules();
        void refetchUpcoming();
      } else if (msg.type === "schedule-run") {
        void refetchSchedules();
        if (!mine(msg.run)) return;
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
        <p {...stylex.attrs(styles.muted)}>Tools, commands and agent prompts that run on their own.</p>
        <Button variant="primary" onClick={() => setEditing("new")} data-new-schedule>
          + New schedule
        </Button>
      </div>
      <Show when={error()}>
        <p {...stylex.attrs(styles.error)}>{error()}</p>
      </Show>
      <Show when={editing()}>
        {(target) => (
          <ScheduleEditor
            schedule={target() === "new" ? null : (target() as Schedule)}
            onDone={() => setEditing(null)}
          />
        )}
      </Show>

      <section {...stylex.attrs(styles.section)}>
        <h2 {...stylex.attrs(styles.sectionTitle)}>In {currentWorkspace()?.name ?? "this workspace"}</h2>
        <div {...stylex.attrs(styles.list)}>
          <For
            each={schedules()}
            fallback={
              <EmptyState
                icon="calendar-clock"
                title="No schedules yet"
                hint={'Create one, or ask an app\'s agent ("check for new articles every morning").'}
              />
            }
          >
            {(s) => (
              <div {...stylex.attrs(styles.item)} data-schedule={s.id} data-paused={s.paused ? "yes" : "no"}>
                <Icon name={taskIcons[s.task.type]} size={16} {...stylex.attrs(styles.itemIcon)} />
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
                  <span {...stylex.attrs(styles.meta)}>
                    {describeTrigger(s.trigger, appName)} · {describeTask(s.task)}
                  </span>
                  <span {...stylex.attrs(styles.meta)}>
                    <Show
                      when={s.nextRunAt}
                      fallback={
                        s.paused ? "Paused" : s.trigger.type === "event" ? "Waits for the event" : "Won't run again"
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
                  onClick={() => setEditing(s)}
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
                      await confirmDialog(`Delete the schedule “${s.name}” and its runs?`, {
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

function RunRow(props: { run: ScheduleRun }) {
  const [open, setOpen] = createSignal(false);
  const bad = () => props.run.status === "error" || props.run.status === "timeout";
  return (
    <div {...stylex.attrs(styles.run)} data-run={props.run.id} data-run-status={props.run.status}>
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
      <Show when={open() && props.run.output}>
        <pre {...stylex.attrs(styles.output)}>{props.run.output}</pre>
      </Show>
    </div>
  );
}

const CRON_PRESETS: [string, string][] = [
  ["0 * * * *", "Every hour"],
  ["0 8 * * *", "Every day at 08:00"],
  ["0 8 * * 1-5", "Weekdays at 08:00"],
  ["0 9 * * 1", "Mondays at 09:00"],
  ["*/15 * * * *", "Every 15 minutes"],
];

/** A datetime-local value for an ISO time (local). */
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function ScheduleEditor(props: { schedule: Schedule | null; onDone: () => void }) {
  const s = props.schedule;
  const workspaceApps = () => allApps().filter((a) => a.kind === "app" && a.workspaceId === currentWorkspace()?.id);
  // A prompt can go to any tab, or to one it opens.
  const workspaceTabs = () => allApps().filter((a) => a.workspaceId === currentWorkspace()?.id);
  const [name, setName] = createSignal(s?.name ?? "");
  const [appId, setAppId] = createSignal(s?.task.appId ?? workspaceApps()[0]?.id ?? "");
  const [taskType, setTaskType] = createSignal<ScheduleTask["type"]>(s?.task.type ?? "tool");
  const [prompt, setPrompt] = createSignal(s?.task.type === "prompt" ? s.task.prompt : "");
  /** A tab's id, or "new:app" / "new:web". */
  const [target, setTarget] = createSignal(
    s?.task.type === "prompt"
      ? (s.task.appId ?? `new:${s.task.newTab?.kind ?? "app"}`)
      : (s?.task.appId ?? workspaceTabs()[0]?.id ?? "new:app"),
  );
  const [url, setUrl] = createSignal(s?.task.type === "prompt" ? (s.task.newTab?.url ?? "") : "");
  const isPrompt = () => taskType() === "prompt";
  const newWebTab = () => isPrompt() && target() === "new:web";
  /** The tab app events are about. */
  const eventApp = () => (isPrompt() ? target() : appId());
  const [tool, setTool] = createSignal(s?.task.type === "tool" ? s.task.tool : "");
  const [params, setParams] = createSignal(
    s?.task.type === "tool" && s.task.params ? JSON.stringify(s.task.params) : "",
  );
  const [command, setCommand] = createSignal(s?.task.type === "command" ? s.task.command : "");
  const [when, setWhen] = createSignal<ScheduleTrigger["type"]>(s?.trigger.type ?? "cron");
  const [at, setAt] = createSignal(
    s?.trigger.type === "once" ? localInput(s.trigger.at) : localInput(new Date(Date.now() + 3600_000).toISOString()),
  );
  const [cron, setCron] = createSignal(s?.trigger.type === "cron" ? s.trigger.cron : "0 8 * * *");
  const initialEvent = s?.trigger.type === "event" ? s.trigger.event : "rune.started";
  const [eventKind, setEventKind] = createSignal(
    initialEvent === "rune.started" ? "rune.started" : initialEvent.split(":")[0]!,
  );
  const [eventName, setEventName] = createSignal(
    initialEvent.startsWith("app:") ? initialEvent.split(":").slice(2).join(":") : "",
  );
  const [notify, setNotify] = createSignal<ScheduleSpec["notify"]>(s?.notify ?? "failure");
  const [timeout, setTimeout_] = createSignal(String(s?.timeoutSec ?? DEFAULT_TIMEOUT_SEC));
  const [error, setError] = createSignal<string>();
  const [tools] = createResource(appId, (id) =>
    id ? api.appTools(id).then((list) => list.filter((t: AppTool) => !t.path)) : Promise.resolve([]),
  );
  const isTool = () => taskType() === "tool";
  const isCommand = () => taskType() === "command";
  const cronText = () => {
    const parsed = parseCron(cron());
    return typeof parsed === "string" ? parsed : describeCron(cron());
  };

  const spec = (): ScheduleSpec | string => {
    let parsedParams: Record<string, unknown> | undefined;
    if (isTool() && params().trim()) {
      try {
        parsedParams = JSON.parse(params());
      } catch {
        return "The params aren't valid JSON";
      }
    }
    const trigger: ScheduleTrigger =
      when() === "once"
        ? { type: "once", at: new Date(at()).toISOString() }
        : when() === "cron"
          ? { type: "cron", cron: cron().trim() }
          : {
              type: "event",
              event:
                eventKind() === "rune.started"
                  ? "rune.started"
                  : eventKind() === "app"
                    ? `app:${eventApp()}:${eventName().trim()}`
                    : `${eventKind()}:${eventApp()}`,
            };
    const where = target();
    const task: ScheduleTask = isPrompt()
      ? where.startsWith("new:")
        ? {
            type: "prompt",
            prompt: prompt(),
            newTab: {
              kind: where === "new:web" ? "web" : "app",
              workspaceId: currentWorkspace()?.id ?? "",
              ...(where === "new:web" ? { url: url().trim() } : {}),
            },
          }
        : { type: "prompt", prompt: prompt(), appId: where }
      : isTool()
        ? { type: "tool", appId: appId(), tool: tool(), ...(parsedParams ? { params: parsedParams } : {}) }
        : { type: "command", appId: appId(), command: command() };
    if (isPrompt() && when() === "event" && eventKind() !== "rune.started" && where.startsWith("new:"))
      return "App events need an existing tab";
    return {
      name:
        name().trim() ||
        (isPrompt()
          ? prompt().trim().split(/\s+/).slice(0, 6).join(" ")
          : isTool()
            ? tool()
            : command().split(" ")[0]!) ||
        "",
      trigger,
      task,
      notify: notify(),
      timeoutSec: Math.round(Number(timeout()) || DEFAULT_TIMEOUT_SEC),
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
      <h2 {...stylex.attrs(styles.sectionTitle)}>{s ? `Edit “${s.name}”` : "New schedule"}</h2>
      <label {...stylex.attrs(styles.field)}>
        <span {...stylex.attrs(styles.label)}>Name</span>
        <input
          value={name()}
          placeholder="Fetch new articles"
          onInput={(e) => setName(e.currentTarget.value)}
          {...stylex.attrs(styles.input)}
          data-schedule-name
        />
      </label>
      <Show
        when={isPrompt()}
        fallback={
          <label {...stylex.attrs(styles.field)}>
            <span {...stylex.attrs(styles.label)}>App</span>
            <select
              value={appId()}
              onChange={(e) => setAppId(e.currentTarget.value)}
              {...stylex.attrs(styles.input)}
              data-schedule-app
            >
              <For each={workspaceApps()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
            </select>
          </label>
        }
      >
        <div {...stylex.attrs(styles.field)}>
          <span {...stylex.attrs(styles.label)}>In</span>
          <select
            value={target()}
            onChange={(e) => setTarget(e.currentTarget.value)}
            {...stylex.attrs(styles.input)}
            data-schedule-target
          >
            <For each={workspaceTabs()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
            <option value="new:app">A new app tab (opened on the first run)</option>
            <option value="new:web">A new web tab (opened on the first run)</option>
          </select>
          <Show when={newWebTab()}>
            <input
              value={url()}
              placeholder="https://example.com"
              onInput={(e) => setUrl(e.currentTarget.value)}
              {...stylex.attrs(styles.input)}
              data-schedule-url
            />
          </Show>
        </div>
      </Show>
      <div {...stylex.attrs(styles.field)}>
        <span {...stylex.attrs(styles.label)}>Does</span>
        <select
          value={taskType()}
          onChange={(e) => setTaskType(e.currentTarget.value as ScheduleTask["type"])}
          {...stylex.attrs(styles.input, styles.narrow)}
          data-schedule-task
        >
          <option value="prompt">Ask the agent</option>
          <option value="tool">Use a tool</option>
          <option value="command">Run a command</option>
        </select>
        <Show when={isPrompt()}>
          <span {...stylex.attrs(styles.meta)}>Each run is a new chat in the tab, as if you had sent the prompt.</span>
        </Show>
        <Show when={isTool()}>
          <select
            value={tool()}
            onChange={(e) => setTool(e.currentTarget.value)}
            {...stylex.attrs(styles.input)}
            data-schedule-tool
          >
            <option value="">Pick a tool…</option>
            <For each={tools()}>{(t) => <option value={t.id}>{`${t.id} — ${t.title}`}</option>}</For>
          </select>
        </Show>
        <Show when={isCommand()}>
          <input
            value={command()}
            placeholder="bun run scripts/sync.ts"
            onInput={(e) => setCommand(e.currentTarget.value)}
            {...stylex.attrs(styles.input, styles.mono)}
            data-schedule-command
          />
        </Show>
      </div>
      <Show when={isPrompt()}>
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
      </Show>
      <Show when={isTool()}>
        <label {...stylex.attrs(styles.field)}>
          <span {...stylex.attrs(styles.label)}>Params</span>
          <input
            value={params()}
            placeholder='{ "limit": 10 } (optional)'
            onInput={(e) => setParams(e.currentTarget.value)}
            {...stylex.attrs(styles.input, styles.mono)}
          />
        </label>
      </Show>
      <div {...stylex.attrs(styles.field)}>
        <span {...stylex.attrs(styles.label)}>When</span>
        <select
          value={when()}
          onChange={(e) => setWhen(e.currentTarget.value as ScheduleTrigger["type"])}
          {...stylex.attrs(styles.input, styles.narrow)}
          data-schedule-when
        >
          <option value="once">Once</option>
          <option value="cron">Repeating</option>
          <option value="event">On an event</option>
        </select>
        <Show when={when() === "once"}>
          <input
            type="datetime-local"
            value={at()}
            onInput={(e) => setAt(e.currentTarget.value)}
            {...stylex.attrs(styles.input)}
            data-schedule-at
          />
        </Show>
        <Show when={when() === "cron"}>
          <input
            value={cron()}
            onInput={(e) => setCron(e.currentTarget.value)}
            {...stylex.attrs(styles.input, styles.mono, styles.narrow)}
            data-schedule-cron
          />
          <span {...stylex.attrs(styles.meta)}>{cronText()}</span>
        </Show>
        <Show when={when() === "event"}>
          <select
            value={eventKind()}
            onChange={(e) => setEventKind(e.currentTarget.value)}
            {...stylex.attrs(styles.input)}
          >
            <option value="rune.started">Rune Browser starts</option>
            <option value="app.started">The app starts</option>
            <option value="app.crashed">The app crashes</option>
            <option value="app">The app sends an event…</option>
          </select>
          <Show when={eventKind() === "app"}>
            <input
              value={eventName()}
              placeholder="new-order"
              onInput={(e) => setEventName(e.currentTarget.value)}
              {...stylex.attrs(styles.input, styles.mono, styles.narrow)}
            />
          </Show>
        </Show>
      </div>
      <Show when={when() === "cron"}>
        <div {...stylex.attrs(styles.presets)}>
          <For each={CRON_PRESETS}>
            {([value, label]) => (
              <button type="button" onClick={() => setCron(value)} {...stylex.attrs(styles.preset)}>
                {label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div {...stylex.attrs(styles.field)}>
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
        <span {...stylex.attrs(styles.label)}>Time limit</span>
        <input
          type="number"
          min="5"
          max="1800"
          value={timeout()}
          onInput={(e) => setTimeout_(e.currentTarget.value)}
          {...stylex.attrs(styles.input, styles.tiny)}
        />
        <span {...stylex.attrs(styles.meta)}>seconds</span>
      </div>
      <Show when={error()}>
        <p {...stylex.attrs(styles.error)}>{error()}</p>
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
  presets: { display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 78 },
  preset: {
    height: 24,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: 11,
    cursor: "pointer",
  },
  actions: { display: "flex", gap: space.sm, paddingLeft: 78 },
});
