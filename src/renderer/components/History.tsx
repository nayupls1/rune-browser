// History in the UI: the timeline of snapshots (who changed what, when), each
// with its files and line diffs, and the two ways back: undo just that change,
// or restore everything to that version. Used by the History page and the
// app tab's history panel.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { appOfTarget, type HistoryEntry, type HistoryFile } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { apps, currentWorkspace, workspaces } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button } from "./ui";

const PAGE = 50;

const actorIcons: Record<HistoryEntry["actor"], string> = {
  agent: "bot",
  user: "user",
  app: "app-window",
  rune: "camera",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The name of what a snapshot covers. */
export const targetName = (target: string) => {
  const appId = appOfTarget(target);
  if (appId) return apps.find((a) => a.id === appId)?.name ?? "A deleted app";
  return target === "sites" ? "Site customizations" : "Settings";
};

/** The snapshots of a target (or of everything in the workspace), newest first, live. */
export function HistoryList(props: {
  target?: string;
  workspaceId?: string;
  showTarget?: boolean;
  empty?: string;
  /** Offer "restore everything to here" (the History page): for the workspace's apps, or all of them (""). */
  restoreAllIn?: string;
}) {
  const [entries, setEntries] = createSignal<HistoryEntry[]>([]);
  const [more, setMore] = createSignal(false);
  const [open, setOpen] = createSignal<number | null>(null);
  const matches = (e: HistoryEntry) =>
    (!props.target || e.target === props.target) &&
    (!props.workspaceId || !e.workspaceId || e.workspaceId === props.workspaceId);

  const load = async (before?: number) => {
    const page = await api.history({ target: props.target, workspace: props.workspaceId, before, limit: PAGE });
    setEntries((list) => (before ? [...list, ...page] : page));
    setMore(page.length === PAGE);
  };
  createEffect(on([() => props.target, () => props.workspaceId], () => void load()));
  onCleanup(
    watchTopic(topics.history, (msg) => {
      if (msg.type === "snapshot" && matches(msg.entry)) {
        // A snapshot folded into the previous one comes again with the same id.
        setEntries((list) => [msg.entry, ...list.filter((e) => e.id !== msg.entry.id)].sort((a, b) => b.id - a.id));
      } else if (msg.type === "history-changed" && (!props.target || msg.target === props.target)) void load();
    }),
  );

  return (
    <div {...stylex.attrs(styles.list)} data-history>
      <For each={entries()} fallback={<p {...stylex.attrs(styles.empty)}>{props.empty ?? "No changes yet."}</p>}>
        {(entry) => (
          <Entry
            entry={entry}
            restoreAllIn={props.restoreAllIn}
            showTarget={!!props.showTarget}
            open={open() === entry.id}
            onToggle={() => setOpen((id) => (id === entry.id ? null : entry.id))}
          />
        )}
      </For>
      <Show when={more()}>
        <button type="button" onClick={() => void load(entries().at(-1)?.id)} {...stylex.attrs(styles.more)}>
          Show older
        </button>
      </Show>
    </div>
  );
}

function Stats(props: { entry: HistoryEntry }) {
  const files = () => {
    const dbs = new Set(Object.keys(props.entry.data));
    const count = (paths: string[]) => paths.filter((p) => !dbs.has(p)).length;
    return {
      added: count(props.entry.added),
      modified: count(props.entry.modified),
      removed: count(props.entry.removed),
    };
  };
  const tables = () =>
    Object.values(props.entry.data).flatMap((t) =>
      Object.entries(t).map(([name, [before, after]]) => {
        const delta = (after ?? 0) - (before ?? 0);
        return after === null
          ? `${name} removed`
          : before === null
            ? `${name} new`
            : `${name} ${delta > 0 ? "+" : ""}${delta}`;
      }),
    );
  const dataChanged = () => Object.keys(props.entry.data).length > 0;
  return (
    <span {...stylex.attrs(styles.stats)}>
      <Show when={files().added}>
        <span {...stylex.attrs(styles.added)}>+{files().added}</span>
      </Show>
      <Show when={files().modified}>
        <span {...stylex.attrs(styles.modified)}>~{files().modified}</span>
      </Show>
      <Show when={files().removed}>
        <span {...stylex.attrs(styles.removed)}>−{files().removed}</span>
      </Show>
      <Show when={dataChanged()}>
        <span {...stylex.attrs(styles.dataChip)} title="The app's data changed">
          <Icon name="database" size={11} />
          {tables().length ? tables().slice(0, 3).join(", ") : "data"}
        </span>
      </Show>
    </span>
  );
}

function Entry(props: {
  entry: HistoryEntry;
  showTarget: boolean;
  open: boolean;
  onToggle: () => void;
  restoreAllIn?: string;
}) {
  const [detail] = createResource(
    () => (props.open ? props.entry.id : undefined),
    (id) => api.historyDetail(id),
  );
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<{ text: string; error: boolean }>();
  const isApp = () => !!appOfTarget(props.entry.target);
  // The app's data only goes back when asked: whatever was added since would be lost.
  const [withData, setWithData] = createSignal(false);
  const hasData = () => isApp();

  const run = async (fn: () => Promise<string | null | void>) => {
    setBusy(true);
    setMessage();
    try {
      const note = await fn();
      setMessage(note ? { text: note, error: false } : undefined);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const undo = () =>
    run(async () => {
      const data = hasData() && withData();
      const ok = await confirmDialog(
        `Undo “${props.entry.summary}”? Only what changed in this step is reverted${isApp() ? (data ? ", including the app's data." : "; the app's data stays as it is.") : "."}`,
        { confirmLabel: "Undo", danger: data },
      );
      if (!ok) return;
      return (await api.undoSnapshot(props.entry.id, data)).note;
    });

  const restore = () =>
    run(async () => {
      const data = hasData() && withData();
      const ok = await confirmDialog(
        `Restore ${targetName(props.entry.target)} to how it was on ${when(props.entry.at)}?${isApp() ? (data ? " The app's data goes back too: what was added since is lost." : " The app's current data stays as it is.") : ""} You can undo this.`,
        { confirmLabel: "Restore", danger: data },
      );
      if (ok) await api.restoreSnapshot(props.entry.id, data);
    });

  const restoreAll = () =>
    run(async () => {
      const data = withData();
      const scope = props.restoreAllIn
        ? (workspaces.find((w) => w.id === props.restoreAllIn)?.name ?? "this workspace")
        : "all workspaces";
      const ok = await confirmDialog(
        `Put everything back to how it was on ${when(props.entry.at)}? Rune Browser's settings, the site customizations and the apps in ${scope} go back to that moment${data ? ", their data too (what was added since is lost)" : "; the apps' data stays as it is"}. Apps made since stay as they are. Each can be undone on its own.`,
        { confirmLabel: "Restore everything", danger: true },
      );
      if (!ok) return;
      const { restored } = await api.restoreAll(props.entry.id, data, props.restoreAllIn || undefined);
      return restored.length
        ? `Restored ${restored.map(targetName).join(", ")}.`
        : "Everything already was the way it was then.";
    });

  return (
    <div {...stylex.attrs(styles.entry)} data-snapshot={props.entry.id}>
      <button type="button" onClick={props.onToggle} aria-expanded={props.open} {...stylex.attrs(styles.head)}>
        <span {...stylex.attrs(styles.actor)}>
          <Icon name={actorIcons[props.entry.actor]} size={13} />
        </span>
        <span {...stylex.attrs(styles.headText)}>
          <span {...stylex.attrs(styles.summary)}>{props.entry.summary}</span>
          <span {...stylex.attrs(styles.meta)}>
            {props.entry.actorLabel}
            <Show when={props.showTarget}> · {targetName(props.entry.target)}</Show> · {when(props.entry.at)}
          </span>
        </span>
        <Stats entry={props.entry} />
        <Icon name={props.open ? "chevron-up" : "chevron-down"} size={14} {...stylex.attrs(styles.chevron)} />
      </button>
      <Show when={props.open}>
        <div {...stylex.attrs(styles.body)}>
          <div {...stylex.attrs(styles.actions)}>
            <Show when={!props.entry.first}>
              <Button onClick={() => void undo()} disabled={busy()} data-undo>
                <Icon name="undo-2" size={14} />
                Undo this change
              </Button>
            </Show>
            <Button onClick={() => void restore()} disabled={busy()} data-restore>
              <Icon name="archive-arrow-up" size={14} />
              Restore this version
            </Button>
            <Show when={props.restoreAllIn !== undefined}>
              <Button
                onClick={() => void restoreAll()}
                disabled={busy()}
                title="Settings, site customizations and every app back to this moment"
                data-restore-all
              >
                <Icon name="rewind" size={14} />
                Restore everything to here
              </Button>
            </Show>
            <Show when={hasData()}>
              <label {...stylex.attrs(styles.check)}>
                <input type="checkbox" checked={withData()} onChange={(e) => setWithData(e.currentTarget.checked)} />
                also its data
              </label>
            </Show>
          </div>
          <Show when={message()}>
            {(m) => (
              <p {...stylex.attrs(styles.message, m().error && styles.messageError)} role="status">
                {m().text}
              </p>
            )}
          </Show>
          <Show when={detail()} fallback={<p {...stylex.attrs(styles.empty)}>Loading…</p>}>
            {(d) => (
              <Show when={d().files.length} fallback={<p {...stylex.attrs(styles.empty)}>No file changes.</p>}>
                <For each={d().files}>{(file) => <FileDiff file={file} open={d().files.length <= 4} />}</For>
              </Show>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

const statusLabels: Record<HistoryFile["status"], string> = { added: "added", modified: "changed", removed: "deleted" };

function FileDiff(props: { file: HistoryFile; open: boolean }) {
  const [open, setOpen] = createSignal(props.open);
  const expandable = () => props.file.kind === "text" && !!props.file.hunks?.length;
  const isOpen = () => open() && expandable();
  const isAdded = () => props.file.status === "added";
  const isRemoved = () => props.file.status === "removed";
  return (
    <div {...stylex.attrs(styles.file)} data-history-file={props.file.path}>
      <button
        type="button"
        disabled={!expandable()}
        onClick={() => setOpen((o) => !o)}
        {...stylex.attrs(styles.fileHead)}
      >
        <Icon name={props.file.kind === "data" ? "database" : "file"} size={13} {...stylex.attrs(styles.fileIcon)} />
        <code {...stylex.attrs(styles.path)}>{props.file.path}</code>
        <span {...stylex.attrs(styles.fileStatus, isAdded() && styles.added, isRemoved() && styles.removed)}>
          {statusLabels[props.file.status]}
        </span>
        <Show when={props.file.kind === "text"}>
          <span {...stylex.attrs(styles.lineStats)}>
            <span {...stylex.attrs(styles.added)}>+{props.file.linesAdded}</span>{" "}
            <span {...stylex.attrs(styles.removed)}>−{props.file.linesRemoved}</span>
          </span>
        </Show>
        <Show when={props.file.kind === "binary" || props.file.kind === "large"}>
          <span {...stylex.attrs(styles.lineStats)}>
            {props.file.kind === "binary" ? "binary" : "too large to show"}
          </span>
        </Show>
      </button>
      <Show when={props.file.kind === "data"}>
        <div {...stylex.attrs(styles.tables)}>
          <Show
            when={Object.keys(props.file.tables ?? {}).length}
            fallback={<span>Rows were changed (the number of rows stayed the same).</span>}
          >
            <For each={Object.entries(props.file.tables ?? {})}>
              {([name, [before, after]]) => (
                <span>
                  <code>{name}</code>: {before === null ? "new table" : `${before} rows`} →{" "}
                  {after === null ? "removed" : `${after} rows`}
                </span>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <Show when={isOpen()}>
        <div {...stylex.attrs(styles.diff)}>
          <For each={props.file.hunks}>
            {(hunk) => (
              <>
                <div {...stylex.attrs(styles.hunkHead)}>
                  @@ −{hunk.oldStart} +{hunk.newStart} @@
                </div>
                <For each={hunk.lines}>
                  {(line) => {
                    const plus = () => line.type === "+";
                    const minus = () => line.type === "-";
                    return (
                      <div {...stylex.attrs(styles.line, plus() && styles.linePlus, minus() && styles.lineMinus)}>
                        <span {...stylex.attrs(styles.sign)}>{line.type}</span>
                        {line.text}
                      </div>
                    );
                  }}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** The History page (sidebar): everything in the current workspace, or one thing. */
export function HistoryPage() {
  const [target, setTarget] = createSignal("");
  const [everywhere, setEverywhere] = createSignal(false);
  const workspace = () => (everywhere() ? undefined : currentWorkspace()?.id);
  const appTabs = () => apps.filter((a) => a.kind === "app" && (!workspace() || a.workspaceId === workspace()));
  return (
    <div {...stylex.attrs(styles.page)} data-history-page>
      <header {...stylex.attrs(styles.header)}>
        <h1 {...stylex.attrs(styles.title)}>
          <Icon name="file-clock" size={24} {...stylex.attrs(styles.accent)} />
          History
        </h1>
        <p {...stylex.attrs(styles.muted)}>
          Every change agents and you make is saved: apps with their data, site customizations and settings. Undo a
          single change, or restore an earlier version.
        </p>
      </header>
      <div {...stylex.attrs(styles.filters)}>
        <select
          value={everywhere() ? "all" : "current"}
          onChange={(e) => {
            setEverywhere(e.currentTarget.value === "all");
            setTarget("");
          }}
          {...stylex.attrs(styles.select)}
        >
          <option value="current">{currentWorkspace()?.name ?? "This workspace"}</option>
          <Show when={workspaces.length > 1}>
            <option value="all">All workspaces</option>
          </Show>
        </select>
        <select
          value={target()}
          onChange={(e) => setTarget(e.currentTarget.value)}
          {...stylex.attrs(styles.select)}
          data-history-target
        >
          <option value="">Everything</option>
          <option value="settings">Settings</option>
          <option value="sites">Site customizations</option>
          <For each={appTabs()}>{(a) => <option value={`app:${a.id}`}>{a.name}</option>}</For>
        </select>
      </div>
      <div {...stylex.attrs(styles.card)}>
        <HistoryList
          target={target() || undefined}
          workspaceId={workspace()}
          showTarget={!target()}
          restoreAllIn={workspace() ?? ""}
        />
      </div>
    </div>
  );
}

/** The app tab's history: its snapshots, and saving one by hand. */
export function HistoryPanel(props: { appId: string; onClose: () => void }) {
  const [saved, setSaved] = createSignal<string>();
  const save = async () => {
    const entry = await api.saveSnapshot(`app:${props.appId}`);
    setSaved(entry ? "Saved." : "Nothing changed since the last snapshot.");
    setTimeout(() => setSaved(), 3000);
  };
  return (
    <div {...stylex.attrs(styles.panel)} data-history-panel>
      <div {...stylex.attrs(styles.panelHeader)}>
        <Icon name="file-clock" size={14} />
        <span {...stylex.attrs(styles.panelTitle)}>History</span>
        <Show when={saved()}>
          <span {...stylex.attrs(styles.meta)}>{saved()}</span>
        </Show>
        <button type="button" onClick={() => void save()} {...stylex.attrs(styles.linkButton)} data-save-snapshot>
          Save a snapshot
        </button>
        <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div {...stylex.attrs(styles.panelBody)}>
        <HistoryList
          target={`app:${props.appId}`}
          empty="No snapshots yet: they're saved when the agent works on the app."
        />
      </div>
    </div>
  );
}

const styles = stylex.create({
  page: {
    maxWidth: 900,
    marginInline: "auto",
    paddingBlock: space.xxl,
    paddingInline: space.xl,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  header: { display: "flex", flexDirection: "column", gap: space.xs },
  title: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    fontSize: font.xxl,
    fontWeight: 650,
    letterSpacing: "-0.02em",
  },
  accent: { color: colors.accent },
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
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  list: { display: "flex", flexDirection: "column" },
  empty: { margin: 0, padding: space.lg, color: colors.muted, fontSize: font.sm, textAlign: "center" },
  entry: { borderTopWidth: { default: 1, ":first-child": 0 }, borderTopStyle: "solid", borderTopColor: colors.border },
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    width: "100%",
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    textAlign: "left",
    cursor: "pointer",
  },
  actor: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    flexShrink: 0,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  headText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
  summary: { fontSize: font.sm, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { color: colors.muted, fontSize: font.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  stats: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0, fontFamily: font.mono, fontSize: font.xs },
  added: { color: colors.success },
  modified: { color: colors.warning },
  removed: { color: colors.danger },
  dataChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: 220,
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontFamily: font.sans,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  chevron: { flexShrink: 0, color: colors.muted },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingInline: space.lg,
    paddingBottom: space.md,
    paddingTop: space.xs,
  },
  actions: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  check: { display: "flex", alignItems: "center", gap: 6, color: colors.muted, fontSize: font.sm, cursor: "pointer" },
  message: { margin: 0, fontSize: font.sm, color: colors.muted },
  messageError: { color: colors.danger },
  file: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    overflow: "hidden",
  },
  fileHead: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    paddingBlock: 6,
    paddingInline: space.sm,
    borderWidth: 0,
    backgroundColor: colors.bg,
    color: colors.text,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "default" },
  },
  fileIcon: { flexShrink: 0, color: colors.muted },
  path: { flex: 1, minWidth: 0, fontFamily: font.mono, fontSize: font.xs, overflowWrap: "anywhere" },
  fileStatus: { flexShrink: 0, color: colors.muted, fontSize: font.xs },
  lineStats: { flexShrink: 0, color: colors.muted, fontFamily: font.mono, fontSize: font.xs },
  tables: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    paddingBlock: 6,
    paddingInline: space.md,
    color: colors.muted,
    fontSize: font.xs,
  },
  diff: { maxHeight: 420, overflow: "auto", fontFamily: font.mono, fontSize: 12, lineHeight: 1.5 },
  hunkHead: { paddingInline: space.sm, backgroundColor: colors.surfaceHover, color: colors.muted },
  line: { whiteSpace: "pre", paddingRight: space.sm, minWidth: "fit-content" },
  linePlus: { backgroundColor: "color-mix(in oklab, transparent, #16a34a 16%)" },
  lineMinus: { backgroundColor: "color-mix(in oklab, transparent, #dc2626 16%)" },
  sign: { display: "inline-block", width: 18, textAlign: "center", color: colors.muted, userSelect: "none" },
  more: {
    alignSelf: "center",
    marginBlock: space.sm,
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
  panel: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "45%",
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 34,
    flexShrink: 0,
    paddingInline: space.md,
    color: colors.muted,
  },
  panelTitle: { flex: 1, fontSize: font.xs, fontWeight: 600 },
  panelBody: { overflowY: "auto", borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: colors.border },
  linkButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontSize: font.xs,
    cursor: "pointer",
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
});
