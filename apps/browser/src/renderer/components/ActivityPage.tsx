// The audit log: everything agents and the user did, newest first.
// Shows the current workspace (plus what belongs to none, like settings),
// filterable by tab and by who did it. New entries appear live.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { AuditEntry } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { allApps, currentWorkspace, workspaces } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

const PAGE = 100;

// Entries from before apps were removed may have "app" as their actor: they get the fallback.
const actorIcons: Record<string, string> = {
  user: "user",
  agent: "bot",
  rune: "shield",
};

const actions: Record<string, string> = {
  "agent.turn": "Started working",
  "agent.native": "Used its own tool",
  "permission.allow": "Allowed",
  "permission.deny": "Denied",
  "permission.revoke": "Revoked a permission",
  "permission.timeout": "Request expired",
  "tab.move": "Moved the tab to",
  "history.restore": "Restored an earlier version:",
  "history.undo": "Undid a change:",
  "workspace.delete": "Deleted the workspace",
  "schedule.run": "Ran the schedule",
  "schedule.create": "Created the schedule",
  "schedule.delete": "Deleted the schedule",
};

const describe = (action: string) =>
  actions[action] ?? (action.startsWith("tool.") ? `Used ${action.slice(5).replaceAll("_", " ")}` : action);

export function ActivityPage() {
  const [entries, setEntries] = createSignal<AuditEntry[]>([]);
  const [tab, setTab] = createSignal("");
  const [actor, setActor] = createSignal<"" | AuditEntry["actor"]>("");
  const [everywhere, setEverywhere] = createSignal(false);
  const [more, setMore] = createSignal(false);
  const workspace = () => (everywhere() ? undefined : currentWorkspace()?.id);
  const matches = (e: AuditEntry) =>
    (!tab() || e.tabId === tab()) &&
    (!actor() || e.actor === actor()) &&
    (!workspace() || !e.workspaceId || e.workspaceId === workspace());
  const tabs = () => allApps().filter((a) => !workspace() || a.workspaceId === workspace());

  const load = async (before?: number) => {
    const page = await api.audit({
      tab: tab() || undefined,
      workspace: workspace(),
      actor: actor() || undefined,
      before,
      limit: PAGE,
    });
    setEntries((list) => (before ? [...list, ...page] : page));
    setMore(page.length === PAGE);
  };
  createEffect(on([tab, actor, workspace], () => void load()));

  onCleanup(
    watchTopic(topics.activity, (msg) => {
      if (msg.type === "audit" && matches(msg.entry)) setEntries((list) => [msg.entry, ...list]);
    }),
  );

  const tabName = (id: string | null) => (id ? (allApps().find((a) => a.id === id)?.name ?? "Deleted tab") : null);

  return (
    <div {...stylex.attrs(styles.page)} data-activity>
      <div {...stylex.attrs(styles.filters)}>
        <select
          value={everywhere() ? "all" : "current"}
          onChange={(e) => {
            setEverywhere(e.currentTarget.value === "all");
            setTab("");
          }}
          {...stylex.attrs(styles.select)}
          data-activity-workspace
        >
          <option value="current">{currentWorkspace()?.name ?? "This workspace"}</option>
          <Show when={workspaces.length > 1}>
            <option value="all">All workspaces</option>
          </Show>
        </select>
        <select
          value={tab()}
          onChange={(e) => setTab(e.currentTarget.value)}
          {...stylex.attrs(styles.select)}
          data-activity-tab
        >
          <option value="">All tabs</option>
          <For each={tabs()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
        </select>
        <select
          value={actor()}
          onChange={(e) => setActor(e.currentTarget.value as "" | AuditEntry["actor"])}
          {...stylex.attrs(styles.select)}
        >
          <option value="">Everyone</option>
          <option value="agent">Agents</option>
          <option value="user">You</option>
          <option value="rune">Rune Browser</option>
        </select>
      </div>
      <ol {...stylex.attrs(styles.list)}>
        <For each={entries()} fallback={<li {...stylex.attrs(styles.empty)}>Nothing yet.</li>}>
          {(entry) => {
            const denied = () => entry.outcome === "denied";
            const failed = () => entry.outcome === "error";
            return (
              <li {...stylex.attrs(styles.entry)} data-audit-action={entry.action}>
                <span {...stylex.attrs(styles.icon, denied() && styles.iconDenied, failed() && styles.iconError)}>
                  <Icon name={actorIcons[entry.actor] ?? "circle"} size={14} />
                </span>
                <div {...stylex.attrs(styles.body)}>
                  <div {...stylex.attrs(styles.line)}>
                    <strong>{entry.actorLabel}</strong>
                    <span>{describe(entry.action)}</span>
                    <Show when={entry.target}>
                      <code {...stylex.attrs(styles.target)}>{entry.target}</code>
                    </Show>
                    <Show when={denied()}>
                      <span {...stylex.attrs(styles.badge, styles.badgeDenied)}>denied</span>
                    </Show>
                    <Show when={failed()}>
                      <span {...stylex.attrs(styles.badge, styles.badgeError)}>failed</span>
                    </Show>
                  </div>
                  <div {...stylex.attrs(styles.meta)}>
                    {new Date(entry.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}
                    <Show when={tabName(entry.tabId)}>{(name) => <> · {name()}</>}</Show>
                    <Show when={entry.detail}> · {entry.detail}</Show>
                  </div>
                </div>
              </li>
            );
          }}
        </For>
      </ol>
      <Show when={more()}>
        <button type="button" onClick={() => void load(entries().at(-1)?.id)} {...stylex.attrs(styles.more)}>
          Show older
        </button>
      </Show>
    </div>
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
  muted: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  filters: { display: "flex", gap: space.sm },
  select: {
    height: 32,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: font.sm,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  empty: { padding: space.lg, color: colors.muted, textAlign: "center" },
  entry: {
    display: "flex",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  icon: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    flexShrink: 0,
    marginTop: 2,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  iconDenied: { color: colors.warning },
  iconError: { color: colors.danger },
  body: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
  line: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 6, fontSize: font.sm },
  target: { fontFamily: font.mono, fontSize: font.xs, color: colors.muted, overflowWrap: "anywhere" },
  badge: { paddingInline: 6, borderRadius: radius.full, fontSize: 11, fontWeight: 600 },
  badgeDenied: { backgroundColor: colors.surfaceHover, color: colors.warning },
  badgeError: { backgroundColor: colors.surfaceHover, color: colors.danger },
  meta: { color: colors.muted, fontSize: font.xs, overflowWrap: "anywhere" },
  more: {
    alignSelf: "center",
    paddingBlock: 6,
    paddingInline: space.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
  },
});
