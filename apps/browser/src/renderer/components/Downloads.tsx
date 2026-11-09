// Downloads, like Chromium's: the button in the sidebar's top row (a ring
// while files download, a dot when one finished or failed), its panel with
// this run's downloads, and the Downloads page (Ctrl+J) that lists all of
// them by day, searchable. Risky files wait there for Keep or Discard.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  canRetry,
  downloadProgress,
  downloadSite,
  downloadStatus,
  groupByDay,
  matchesDownload,
  needsDecision,
  type DownloadInfo,
} from "../../shared/downloads";
import {
  act,
  clearDownloads,
  downloads,
  openDownloadsPage,
  panelOpen,
  recentDownloads,
  runningDownloads,
  showPanel,
  unseen,
  downloadsUi,
} from "../lib/downloads";
import { withKeys } from "../lib/shortcuts";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button, EmptyState } from "./ui";

/** How many downloads the panel shows. */
const PANEL_ITEMS = 6;

function stateOf(d: DownloadInfo) {
  if (needsDecision(d)) return "warning";
  if (d.discarded) return "discarded";
  if (d.state === "progressing") return d.paused ? "paused" : "progressing";
  if (d.state === "completed" && d.exists === false) return "deleted";
  return d.state;
}

const iconOf = (d: DownloadInfo) => {
  const state = stateOf(d);
  if (state === "warning") return "triangle-alert";
  if (state === "interrupted") return "circle-alert";
  if (state === "cancelled" || state === "discarded" || state === "deleted") return "file-x";
  if (state === "completed") return "file-check";
  return "file-down";
};

/** One download with what can be done with it. */
function DownloadRow(props: { download: DownloadInfo; compact?: boolean }) {
  const d = () => props.download;
  const state = () => stateOf(d());
  const running = () => d().state === "progressing";
  const openable = () => state() === "completed";
  const warning = () => state() === "warning";
  const failed = () => state() === "interrupted";
  const dimmed = () => ["cancelled", "discarded", "deleted"].includes(state());
  const progress = () => downloadProgress(d());
  const indeterminate = () => progress() === null;
  const resumable = () => (running() && d().paused) || (failed() && !!d().canResume);
  const retryable = () => !running() && !warning() && !d().discarded && canRetry(d()) && state() !== "completed";
  const removable = () => !running() || warning();
  const compact = () => !!props.compact;
  return (
    <li
      {...stylex.attrs(styles.row, compact() && styles.rowCompact, warning() && styles.rowWarning)}
      data-download={d().id}
      data-download-state={state()}
    >
      <span
        {...stylex.attrs(
          styles.fileIcon,
          warning() && styles.iconWarning,
          failed() && styles.iconFailed,
          dimmed() && styles.iconDimmed,
        )}
      >
        <Icon name={iconOf(d())} size={compact() ? 16 : 20} />
      </span>
      <div {...stylex.attrs(styles.body)}>
        <Show
          when={openable()}
          fallback={
            <span {...stylex.attrs(styles.name, dimmed() && styles.nameDimmed)} title={d().filename}>
              {d().filename}
            </span>
          }
        >
          <button
            type="button"
            title={`Open ${d().filename}`}
            onClick={() => void act(d(), "open")}
            {...stylex.attrs(styles.name, styles.nameLink)}
            data-download-open
          >
            {d().filename}
          </button>
        </Show>
        <Show when={!compact()}>
          <span {...stylex.attrs(styles.site)} title={d().url}>
            {downloadSite(d())}
          </span>
        </Show>
        <span {...stylex.attrs(styles.status, warning() && styles.statusWarning, failed() && styles.statusFailed)}>
          {downloadStatus(d())}
        </span>
        <Show when={running() && !warning()}>
          <div {...stylex.attrs(styles.bar)}>
            <div
              {...stylex.attrs(styles.barFill, indeterminate() && styles.barIndeterminate)}
              style={{ width: indeterminate() ? "30%" : `${Math.round(progress()! * 100)}%` }}
            />
          </div>
        </Show>
        <Show when={warning()}>
          <div {...stylex.attrs(styles.decision)}>
            <Button variant="primary" onClick={() => void act(d(), "discard")} data-download-action="discard">
              Discard
            </Button>
            <Button onClick={() => void act(d(), "keep")} data-download-action="keep">
              Keep anyway
            </Button>
          </div>
        </Show>
      </div>
      <div {...stylex.attrs(styles.actions)}>
        <Show when={running() && !warning() && !d().paused}>
          <IconAction icon="pause" label="Pause" onClick={() => void act(d(), "pause")} action="pause" />
        </Show>
        <Show when={resumable()}>
          <IconAction icon="play" label="Resume" onClick={() => void act(d(), "resume")} action="resume" />
        </Show>
        <Show when={running() && !warning()}>
          <IconAction icon="circle-x" label="Cancel" onClick={() => void act(d(), "cancel")} action="cancel" />
        </Show>
        <Show when={retryable()}>
          <IconAction icon="rotate-cw" label="Retry" onClick={() => void act(d(), "retry")} action="retry" />
        </Show>
        <Show when={openable()}>
          <IconAction icon="folder-open" label="Show in folder" onClick={() => void act(d(), "show")} action="show" />
        </Show>
        <Show when={removable() && !compact()}>
          <IconAction icon="x" label="Remove from list" onClick={() => void act(d(), "remove")} action="remove" />
        </Show>
      </div>
    </li>
  );
}

function IconAction(props: { icon: string; label: string; action: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      {...stylex.attrs(styles.iconButton)}
      data-download-action={props.action}
    >
      <Icon name={props.icon} size={15} />
    </button>
  );
}

/** The Downloads page (in Settings' pages, Ctrl+J). */
export function DownloadsPage() {
  const [query, setQuery] = createSignal("");
  const matching = () => downloads.filter((d) => matchesDownload(d, query()));
  const groups = () => groupByDay(matching());
  const clearable = () => downloads.some((d) => d.state !== "progressing" && !needsDecision(d));
  onMount(() => showPanel(false));
  return (
    <div {...stylex.attrs(styles.page)} data-downloads-page>
      <div {...stylex.attrs(styles.toolbar)}>
        <label {...stylex.attrs(styles.search)}>
          <Icon name="search" size={14} {...stylex.attrs(styles.searchIcon)} />
          <input
            type="search"
            placeholder="Search downloads"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            {...stylex.attrs(styles.searchInput)}
            data-downloads-search
          />
        </label>
        <Button variant="ghost" disabled={!clearable()} onClick={() => void clearDownloads()} data-downloads-clear>
          Clear all
        </Button>
      </div>
      <Show
        when={groups().length}
        fallback={
          <EmptyState
            icon={query().trim() ? "search-x" : "download"}
            title={query().trim() ? "No downloads match your search" : "No downloads yet"}
            hint={query().trim() ? undefined : "Files you download appear here."}
            data-downloads-empty
          />
        }
      >
        <For each={groups()}>
          {(group) => (
            <section {...stylex.attrs(styles.group)} data-downloads-day={group.label}>
              <h2 {...stylex.attrs(styles.day)}>{group.label}</h2>
              <ul {...stylex.attrs(styles.list)}>
                <For each={group.items}>{(d) => <DownloadRow download={d} />}</For>
              </ul>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

/** The downloads button in the sidebar's top row: shown once something was downloaded in this run. */
export function DownloadsButton() {
  const running = () => runningDownloads();
  const progress = () => {
    const list = running();
    const total = list.reduce((n, d) => n + d.totalBytes, 0);
    if (!list.length || list.some((d) => !d.totalBytes) || !total) return null;
    return list.reduce((n, d) => n + d.receivedBytes, 0) / total;
  };
  const busy = () => running().length > 0;
  const waiting = () => recentDownloads().some(needsDecision);
  const hasUnseen = () => unseen() > 0 && !busy();
  const spinning = () => busy() && progress() === null;
  const ring = 2 * Math.PI * 12;
  return (
    <Show when={recentDownloads().length && downloadsUi()}>
      <button
        type="button"
        title={withKeys("Downloads", "open.downloads")}
        aria-expanded={panelOpen()}
        onClick={() => showPanel(!panelOpen())}
        {...stylex.attrs(styles.navButton, panelOpen() && styles.navButtonOn, waiting() && styles.navButtonWarning)}
        data-downloads-button
      >
        <Icon name={waiting() ? "triangle-alert" : "download"} size={15} />
        <Show when={busy()}>
          <svg viewBox="0 0 28 28" {...stylex.attrs(styles.ring, spinning() && styles.ringSpinning)} aria-hidden="true">
            <circle cx="14" cy="14" r="12" {...stylex.attrs(styles.ringTrack)} />
            <circle
              cx="14"
              cy="14"
              r="12"
              {...stylex.attrs(styles.ringFill)}
              stroke-dasharray={`${ring}`}
              stroke-dashoffset={`${ring * (1 - (progress() ?? 0.25))}`}
            />
          </svg>
        </Show>
        <Show when={hasUnseen()}>
          <span {...stylex.attrs(styles.dot)} data-downloads-unseen />
        </Show>
      </button>
    </Show>
  );
}

/** This run's downloads, under the button (or the window's corner while it isn't shown). Mount once. */
export function DownloadsPanel() {
  return (
    <Show when={panelOpen()}>
      <Panel />
    </Show>
  );
}

function Panel() {
  let panel!: HTMLDivElement;
  const anchor = document.querySelector<HTMLElement>("[data-downloads-button]")?.getBoundingClientRect();
  const position = () => ({
    left: `${Math.max(8, anchor ? anchor.left - 8 : 12)}px`,
    top: `${anchor ? anchor.bottom + 6 : 48}px`,
  });
  const items = () => recentDownloads().slice(0, PANEL_ITEMS);
  const more = () => recentDownloads().length - items().length;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!panel.contains(target) && !target?.closest("[data-downloads-button]")) showPanel(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && showPanel(false);
    // Clicks in a page don't reach this document; the page taking the focus does.
    const onFocus = (e: FocusEvent) => (e.target as Element | null)?.tagName === "WEBVIEW" && showPanel(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    });
  });
  return (
    <Portal>
      <div
        ref={panel}
        role="dialog"
        aria-label="Downloads"
        {...stylex.attrs(styles.panel)}
        style={position()}
        data-downloads-panel
      >
        <div {...stylex.attrs(styles.panelHeader)}>
          <strong>Downloads</strong>
          <button
            type="button"
            aria-label="Close"
            onClick={() => showPanel(false)}
            {...stylex.attrs(styles.iconButton)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <ul {...stylex.attrs(styles.panelList)}>
          <For each={items()} fallback={<li {...stylex.attrs(styles.panelEmpty)}>Nothing downloaded yet.</li>}>
            {(d) => <DownloadRow download={d} compact />}
          </For>
        </ul>
        <button
          type="button"
          onClick={() => void openDownloadsPage()}
          {...stylex.attrs(styles.panelFooter)}
          data-downloads-all
        >
          <span>All downloads{more() > 0 ? ` (${more()} more)` : ""}</span>
          <Icon name="arrow-right" size={14} />
        </button>
      </div>
    </Portal>
  );
}

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });
const slide = stylex.keyframes({ from: { transform: "translateX(-100%)" }, to: { transform: "translateX(340%)" } });

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
  toolbar: { display: "flex", alignItems: "center", gap: space.sm },
  search: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 34,
    paddingInline: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus-within": colors.accent },
    backgroundColor: colors.surface,
  },
  searchIcon: { flexShrink: 0, color: colors.muted },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.xxl,
    color: colors.muted,
    fontSize: font.sm,
  },
  group: { display: "flex", flexDirection: "column", gap: space.sm },
  day: { margin: 0, fontSize: font.sm, fontWeight: 600, color: colors.muted },
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
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  rowCompact: { gap: space.sm, paddingBlock: space.sm, paddingInline: space.sm },
  rowWarning: { backgroundColor: `color-mix(in srgb, ${colors.warning} 8%, transparent)` },
  fileIcon: { display: "grid", placeItems: "center", flexShrink: 0, marginTop: 2, color: colors.accent },
  iconWarning: { color: colors.warning },
  iconFailed: { color: colors.danger },
  iconDimmed: { color: colors.muted },
  body: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
    fontWeight: 600,
    color: colors.text,
  },
  nameLink: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: font.sans,
    textAlign: "left",
    cursor: "pointer",
    textDecoration: { default: "none", ":hover": "underline" },
  },
  nameDimmed: { color: colors.muted, textDecoration: "line-through" },
  site: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: font.xs, color: colors.muted },
  status: { fontSize: font.xs, color: colors.muted },
  statusWarning: { color: colors.warning, fontWeight: 500 },
  statusFailed: { color: colors.danger },
  bar: {
    position: "relative",
    height: 4,
    marginTop: 4,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    transition: "width 200ms linear",
  },
  barIndeterminate: {
    animationName: slide,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  decision: { display: "flex", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  actions: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0 },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  navButton: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  navButtonOn: { backgroundColor: colors.surfaceHover, color: colors.text },
  navButtonWarning: { color: { default: colors.warning, ":hover": colors.warning } },
  ring: { position: "absolute", inset: 1, width: 28, height: 28, transform: "rotate(-90deg)", pointerEvents: "none" },
  ringSpinning: {
    animationName: spin,
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  ringTrack: { fill: "none", stroke: colors.border, strokeWidth: 2 },
  ringFill: {
    fill: "none",
    stroke: colors.accent,
    strokeWidth: 2,
    strokeLinecap: "round",
    transition: "stroke-dashoffset 200ms linear",
  },
  dot: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.success,
    boxShadow: `0 0 0 2px ${colors.sidebar}`,
  },
  panel: {
    position: "fixed",
    zIndex: 1600,
    width: 360,
    maxWidth: "calc(100vw - 16px)",
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: "0 12px 32px rgb(0 0 0 / 0.18)",
    fontFamily: font.sans,
    fontSize: font.sm,
    overflow: "hidden",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBlock: space.xs,
    paddingLeft: space.md,
    paddingRight: space.xs,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  panelList: { margin: 0, padding: 0, listStyle: "none", maxHeight: 420, overflowY: "auto" },
  panelEmpty: { padding: space.lg, color: colors.muted, textAlign: "center" },
  panelFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: 38,
    paddingInline: space.md,
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
});
