// The chat's running background jobs (server: agent/Jobs.ts), above the
// composer: what each one does, how far it got, and a button to stop it.
// When a job ends, it leaves this bar and its end is a line in the chat, with
// the file its results went into.
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import type { JobInfo } from "../../shared/api";
import { states, stopJob } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const progressText = (job: JobInfo) =>
  [job.total !== null ? `${job.done ?? 0} of ${job.total}` : job.done !== null ? `${job.done} done` : "", job.note]
    .filter(Boolean)
    .join(" · ");

/** 0–100 when the job knows its total. */
const percent = (job: JobInfo) => (job.total ? Math.min(100, Math.round(((job.done ?? 0) / job.total) * 100)) : null);

export function JobsBar(props: { appId: string }) {
  const running = () => (states[props.appId]?.jobs ?? []).filter((j) => j.state === "running");
  return (
    <Show when={running().length}>
      <div {...stylex.attrs(styles.bar)} data-jobs>
        <For each={running()}>{(job) => <JobRow appId={props.appId} job={job} />}</For>
      </div>
    </Show>
  );
}

function JobRow(props: { appId: string; job: JobInfo }) {
  const known = () => percent(props.job) !== null;
  const stop = () =>
    void stopJob(props.appId, props.job.id).catch((err) =>
      toast({ kind: "error", message: `Couldn't stop the job: ${err instanceof Error ? err.message : err}` }),
    );
  return (
    <div
      {...stylex.attrs(styles.row)}
      title={`Background job ${props.job.id}, started by the agent at ${new Date(props.job.startedAt).toLocaleTimeString()}. It ends when this chat or tab is closed.`}
      data-job={props.job.id}
    >
      <span {...stylex.attrs(styles.icon)}>
        <Icon name={props.job.kind === "requests" ? "send" : "square-code"} size={13} />
      </span>
      <span {...stylex.attrs(styles.text)}>
        <span {...stylex.attrs(styles.title)}>{props.job.title}</span>
        <span {...stylex.attrs(styles.track)}>
          <Show when={known()} fallback={<span {...stylex.attrs(styles.fill, styles.fillUnknown)} />}>
            <span {...stylex.attrs(styles.fill)} style={{ width: `${percent(props.job)}%` }} />
          </Show>
        </span>
        <span {...stylex.attrs(styles.progress)} data-job-progress>
          {progressText(props.job)}
        </span>
      </span>
      <button
        type="button"
        title="Stop this job (what it has so far is saved)"
        aria-label={`Stop ${props.job.title}`}
        onClick={stop}
        {...stylex.attrs(styles.stop)}
        data-job-stop={props.job.id}
      >
        <Icon name="square" size={10} fill="currentColor" />
        Stop
      </button>
    </div>
  );
}

const slide = stylex.keyframes({
  from: { transform: "translateX(-100%)" },
  to: { transform: "translateX(250%)" },
});

const styles = stylex.create({
  bar: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    marginBottom: space.sm,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    paddingBlock: 6,
    paddingLeft: 8,
    paddingRight: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    fontFamily: font.sans,
  },
  icon: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    flexShrink: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  text: {
    display: "grid",
    gridTemplateColumns: "minmax(40px, 1fr) auto",
    alignItems: "center",
    columnGap: space.sm,
    rowGap: 3,
    flex: 1,
    minWidth: 0,
  },
  title: {
    gridColumn: "1 / -1",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
    fontWeight: 500,
    color: colors.text,
  },
  progress: {
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: font.xs,
    color: colors.muted,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  track: {
    position: "relative",
    height: 3,
    overflow: "hidden",
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  fill: {
    position: "absolute",
    insetBlock: 0,
    left: 0,
    borderRadius: 2,
    backgroundColor: colors.accent,
    transitionProperty: "width",
    transitionDuration: "200ms",
  },
  fillUnknown: {
    width: "40%",
    animationName: slide,
    animationDuration: "1.4s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  stop: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    paddingBlock: 3,
    paddingInline: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.danger },
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.danger },
    fontFamily: font.sans,
    fontSize: font.xs,
    cursor: "pointer",
  },
});
