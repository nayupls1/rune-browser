// Snapshots in the UI: the timeline (who changed what, when), each with its
// files and line diffs, and the two ways back: undo just that change, or
// restore everything to that version: the Snapshots page. Browsing history is
// BrowsingHistory.tsx.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { HistoryEntry, HistoryFile } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button } from "./ui";

const PAGE = 50;

// Snapshots from before apps were removed may have "app" as their actor: they get the fallback.
const actorIcons: Record<string, string> = {
  agent: "bot",
  user: "user",
  rune: "camera",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The name of what a snapshot covers. */
const targetName = (target: string) => (target === "sites" ? "Site customizations" : "Settings");

/** The snapshots of a target (or of everything), newest first, live. */
function HistoryList(props: { target?: string; showTarget?: boolean }) {
  const [entries, setEntries] = createSignal<HistoryEntry[]>([]);
  const [more, setMore] = createSignal(false);
  const [open, setOpen] = createSignal<number | null>(null);
  const matches = (e: HistoryEntry) => !props.target || e.target === props.target;

  const load = async (before?: number) => {
    const page = await api.history({ target: props.target, before, limit: PAGE });
    setEntries((list) => (before ? [...list, ...page] : page));
    setMore(page.length === PAGE);
  };
  createEffect(
    on(
      () => props.target,
      () => void load(),
    ),
  );
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
      <For each={entries()} fallback={<p {...stylex.attrs(styles.empty)}>No changes yet.</p>}>
        {(entry) => (
          <Entry
            entry={entry}
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
  return (
    <span {...stylex.attrs(styles.stats)}>
      <Show when={props.entry.added.length}>
        <span {...stylex.attrs(styles.added)}>+{props.entry.added.length}</span>
      </Show>
      <Show when={props.entry.modified.length}>
        <span {...stylex.attrs(styles.modified)}>~{props.entry.modified.length}</span>
      </Show>
      <Show when={props.entry.removed.length}>
        <span {...stylex.attrs(styles.removed)}>−{props.entry.removed.length}</span>
      </Show>
    </span>
  );
}

function Entry(props: { entry: HistoryEntry; showTarget: boolean; open: boolean; onToggle: () => void }) {
  const [detail] = createResource(
    () => (props.open ? props.entry.id : undefined),
    (id) => api.historyDetail(id),
  );
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<{ text: string; error: boolean }>();

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
      const ok = await confirmDialog(`Undo “${props.entry.summary}”? Only what changed in this step is reverted.`, {
        confirmLabel: "Undo",
      });
      if (!ok) return;
      return (await api.undoSnapshot(props.entry.id)).note;
    });

  const restore = () =>
    run(async () => {
      const ok = await confirmDialog(
        `Restore ${targetName(props.entry.target)} to how it was on ${when(props.entry.at)}? You can undo this.`,
        { confirmLabel: "Restore" },
      );
      if (ok) await api.restoreSnapshot(props.entry.id);
    });

  const restoreAll = () =>
    run(async () => {
      const ok = await confirmDialog(
        `Put everything back to how it was on ${when(props.entry.at)}? Rune Browser's settings and the site customizations go back to that moment. Each can be undone on its own.`,
        { confirmLabel: "Restore everything", danger: true },
      );
      if (!ok) return;
      const { restored } = await api.restoreAll(props.entry.id);
      return restored.length
        ? `Restored ${restored.map(targetName).join(", ")}.`
        : "Everything already was the way it was then.";
    });

  return (
    <div {...stylex.attrs(styles.entry)} data-snapshot={props.entry.id}>
      <button type="button" onClick={props.onToggle} aria-expanded={props.open} {...stylex.attrs(styles.head)}>
        <span {...stylex.attrs(styles.actor)}>
          <Icon name={actorIcons[props.entry.actor] ?? "circle"} size={13} />
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
            <Button
              onClick={() => void restoreAll()}
              disabled={busy()}
              title="Settings and site customizations back to this moment"
              data-restore-all
            >
              <Icon name="rewind" size={14} />
              Restore everything to here
            </Button>
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
        <Icon name="file" size={13} {...stylex.attrs(styles.fileIcon)} />
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

/** The Snapshots page (Settings): everything, or one thing. */
export function HistoryPage() {
  const [target, setTarget] = createSignal("");
  return (
    <div {...stylex.attrs(styles.page)} data-history-page>
      <div {...stylex.attrs(styles.filters)}>
        <select
          value={target()}
          onChange={(e) => setTarget(e.currentTarget.value)}
          {...stylex.attrs(styles.select)}
          data-history-target
        >
          <option value="">Everything</option>
          <option value="settings">Settings</option>
          <option value="sites">Site customizations</option>
        </select>
      </div>
      <div {...stylex.attrs(styles.card)}>
        <HistoryList target={target() || undefined} showTarget={!target()} />
      </div>
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
  diff: { maxHeight: 420, overflow: "auto", fontFamily: font.mono, fontSize: 12, lineHeight: 1.5 },
  hunkHead: { paddingInline: space.sm, backgroundColor: colors.surfaceHover, color: colors.muted },
  line: { whiteSpace: "pre", paddingRight: space.sm, minWidth: "fit-content" },
  linePlus: { backgroundColor: `color-mix(in oklab, transparent, ${colors.success} 16%)` },
  lineMinus: { backgroundColor: `color-mix(in oklab, transparent, ${colors.danger} 16%)` },
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
});
