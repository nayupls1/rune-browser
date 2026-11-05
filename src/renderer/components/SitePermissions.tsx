// Site permission prompts in the UI (lib/sitePermissions.ts): the prompt a
// web tab shows when its site asks for something, like Chromium's (allow
// while visiting, allow this time, never allow); what the address bar's site
// settings button shows while a page uses the camera, microphone, location or
// screen (with Stop in its popover, components/SiteInfo.tsx); and the screen
// picker. The choices are the site's settings (Settings → Browser → Site
// settings).
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { siteSettings, type SiteSettingKey } from "../../shared/browser";
import {
  permissionSite,
  promptInfo,
  type ScreenPickRequest,
  type ScreenSource,
  type SitePermissionPrompt,
  type SystemPermissionNotice,
} from "../../shared/sitePermissions";
import {
  answerPick,
  answerPrompt,
  currentPick,
  dismissNotice,
  noticesFor,
  openSystemSettings,
  promptFor,
  stopUsing,
  usageOf,
} from "../lib/sitePermissions";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button, Checkbox } from "./ui";

// --- The prompt ------------------------------------------------------------------------------

/** Over the top left of a web tab's page: its site's prompt, and notices that the OS hasn't given access. */
export function PermissionPrompt(props: { contentsId: number | null }) {
  return (
    <div {...stylex.attrs(styles.promptArea)}>
      <For each={noticesFor(props.contentsId)}>{(notice) => <SystemNotice notice={notice} />}</For>
      <Show when={promptFor(props.contentsId)} keyed>
        {(prompt) => <PromptCard prompt={prompt} />}
      </Show>
    </div>
  );
}

function PromptCard(props: { prompt: SitePermissionPrompt }) {
  const once = () => props.prompt.keys.every((k) => promptInfo(k).once);
  const answer = (value: "allow" | "once" | "block" | "dismiss") => answerPrompt(props.prompt, value);
  return (
    <div
      role="dialog"
      aria-label={`${props.prompt.site} wants to use something`}
      {...stylex.attrs(styles.card)}
      data-permission-prompt={props.prompt.keys.join(" ")}
    >
      <div {...stylex.attrs(styles.cardHeader)}>
        <span {...stylex.attrs(styles.cardTitle)}>
          <strong>{props.prompt.site}</strong> wants to
        </span>
        <button
          type="button"
          title="Not now (the site can ask again)"
          onClick={() => answer("dismiss")}
          {...stylex.attrs(styles.iconButton)}
          data-permission-answer="dismiss"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <ul {...stylex.attrs(styles.wants)}>
        <For each={props.prompt.keys}>
          {(key) => (
            <li {...stylex.attrs(styles.want)}>
              <Icon name={siteSettings[key].icon} size={16} {...stylex.attrs(styles.wantIcon)} />
              {siteSettings[key].about}
            </li>
          )}
        </For>
      </ul>
      <Show when={props.prompt.private}>
        <p {...stylex.attrs(styles.privateNote)}>In this private window, your choice lasts until its windows close.</p>
      </Show>
      <div {...stylex.attrs(styles.answers)}>
        <Button onClick={() => answer("allow")} xstyle={styles.answer} data-permission-answer="allow">
          Allow while visiting the site
        </Button>
        <Show when={once()}>
          <Button onClick={() => answer("once")} xstyle={styles.answer} data-permission-answer="once">
            Allow this time
          </Button>
        </Show>
        <Button onClick={() => answer("block")} xstyle={styles.answer} data-permission-answer="block">
          Never allow
        </Button>
      </div>
    </div>
  );
}

const deviceNames: Record<SystemPermissionNotice["kind"], string> = {
  camera: "your camera",
  microphone: "your microphone",
  screen: "your screen",
  location: "your location",
};

function SystemNotice(props: { notice: SystemPermissionNotice }) {
  const canOpen = () => ["darwin", "win32"].includes(window.rune.window.platform);
  return (
    <div role="alert" {...stylex.attrs(styles.card, styles.notice)} data-permission-notice={props.notice.kind}>
      <Icon name="shield-alert" size={16} {...stylex.attrs(styles.noticeIcon)} />
      <div {...stylex.attrs(styles.noticeText)}>
        <span>
          Rune Browser can't use {deviceNames[props.notice.kind]}: your computer hasn't given it access. Allow it in{" "}
          {props.notice.where}, then reload the page.
        </span>
        <Show when={canOpen()}>
          <Button onClick={() => openSystemSettings(props.notice.kind)} xstyle={styles.noticeButton}>
            Open {props.notice.where}
          </Button>
        </Show>
      </div>
      <button
        type="button"
        title="Close"
        onClick={() => dismissNotice(props.notice)}
        {...stylex.attrs(styles.iconButton)}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

// --- The address bar ---------------------------------------------------------------------------

/** What main reported for a tab, while it's about the site in its address bar. */
export function siteUsage(contentsId: number | null, url: string) {
  const usage = usageOf(contentsId);
  const site = permissionSite(url);
  return usage && site && usage.site === site ? usage : undefined;
}

/**
 * Inside the site settings button of a web tab's address field: what the
 * page uses right now (camera, microphone, location, screen), else what it
 * was refused, else the settings icon.
 */
export function SiteStatusIcon(props: { contentsId: number | null; url: string; fallback?: JSX.Element }) {
  const usage = () => siteUsage(props.contentsId, props.url);
  const inUse = () => usage()?.inUse ?? [];
  const blocked = () => usage()?.blocked ?? [];
  return (
    <Switch fallback={props.fallback ?? <Icon name="sliders-horizontal" size={13} />}>
      <Match when={inUse().length}>
        <For each={inUse()}>{(key) => <Icon name={siteSettings[key].icon} size={13} />}</For>
      </Match>
      <Match when={blocked()[0]}>
        {(key) => <Icon name={promptInfo(key()).offIcon ?? "shield-alert"} size={13} />}
      </Match>
    </Switch>
  );
}

/** The button's tooltip for what the page uses or was refused (undefined: nothing). */
export function siteStatusTitle(contentsId: number | null, url: string) {
  const usage = siteUsage(contentsId, url);
  const names = (keys: readonly SiteSettingKey[]) => keys.map((k) => siteSettings[k].label.toLowerCase()).join(", ");
  if (usage?.inUse.length) return `This page is using ${names(usage.inUse)}: see and stop it, and the site's settings`;
  if (usage?.blocked.length) return `This page was blocked from using ${names(usage.blocked)}`;
  return undefined;
}

/** In the site's settings popover: what the page uses right now, each with Stop. */
export function InUseRows(props: { contentsId: number | null; url: string }) {
  const inUse = () => siteUsage(props.contentsId, props.url)?.inUse ?? [];
  return (
    <For each={props.contentsId === null ? [] : inUse()}>
      {(key) => (
        <div {...stylex.attrs(styles.liveRow)} data-in-use={key}>
          <Icon name={siteSettings[key].icon} size={14} {...stylex.attrs(styles.liveIcon)} />
          <span {...stylex.attrs(styles.liveLabel)}>Using your {siteSettings[key].label.toLowerCase()}</span>
          <Button
            onClick={() => void stopUsing(props.contentsId!, [key])}
            xstyle={styles.stop}
            data-stop-permission={key}
          >
            Stop
          </Button>
        </div>
      )}
    </For>
  );
}

/** What's different for a permission on the page in a tab than its site's settings say ("" if nothing). */
export function permissionNote(contentsId: number | null, url: string, key: SiteSettingKey) {
  const usage = siteUsage(contentsId, url);
  if (!usage) return "";
  if (usage.once.includes(key)) return "Allowed this time";
  const held = usage.held[key];
  if (held) return `${held === "allow" ? "Allowed" : "Blocked"} until the private windows close`;
  return usage.blocked.includes(key) ? "Blocked on this page" : "";
}

// --- Screen sharing ------------------------------------------------------------------------------

/** Mount once at the app root: the picker for a site's screen sharing (one at a time). */
export function ScreenPickHost() {
  return (
    <Show when={currentPick()} keyed>
      {(request) => <ScreenPicker request={request} />}
    </Show>
  );
}

const sourceTabs: [ScreenSource["type"], string][] = [
  ["screen", "Entire screen"],
  ["window", "Window"],
  ["tab", "Tab"],
];

function ScreenPicker(props: { request: ScreenPickRequest }) {
  const available = () => sourceTabs.filter(([type]) => props.request.sources.some((s) => s.type === type));
  const [type, setType] = createSignal<ScreenSource["type"]>(available()[0]?.[0] ?? "screen");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [audio, setAudio] = createSignal(true);
  const shown = () => props.request.sources.filter((s) => s.type === type());
  const chosen = () => props.request.sources.find((s) => s.id === selected());
  // Tabs share their sound; screens only on Windows (the system's).
  const audioPossible = () =>
    props.request.audio &&
    (props.request.systemPicker || chosen()?.type === "tab" || window.rune.window.platform === "win32");
  const noDesktop = () => !!props.request.error && !props.request.sources.some((s) => s.type !== "tab");
  const close = (share: boolean) =>
    answerPick(
      props.request,
      share
        ? { sourceId: props.request.systemPicker ? "system" : selected()!, audio: audioPossible() && audio() }
        : null,
    );
  const cannotShare = () => !props.request.systemPicker && !selected();
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close(false);
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });
  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Share your screen"
          {...stylex.attrs(styles.dialog)}
          data-screen-picker
        >
          <h2 {...stylex.attrs(styles.dialogTitle)}>Share your screen</h2>
          <p {...stylex.attrs(styles.dialogText)}>
            <strong>{props.request.site}</strong> will be able to see what you share
            {props.request.systemPicker ? ". You choose what in the next window." : "."}
          </p>
          <Show when={!props.request.systemPicker}>
            <Show when={available().length > 1}>
              <div {...stylex.attrs(styles.segmented)} role="tablist">
                <For each={available()}>
                  {([value, label]) => {
                    const active = () => type() === value;
                    return (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active()}
                        onClick={() => {
                          setType(value);
                          setSelected(null);
                        }}
                        {...stylex.attrs(styles.segment, active() && styles.segmentActive)}
                        data-screen-type={value}
                      >
                        {label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
            <Show when={noDesktop()}>
              <p {...stylex.attrs(styles.dialogText, styles.muted)}>
                Rune Browser couldn't list your screens and windows ({props.request.error}).
              </p>
            </Show>
            <div {...stylex.attrs(styles.sources)}>
              <For each={shown()}>
                {(source) => {
                  const active = () => selected() === source.id;
                  return (
                    <button
                      type="button"
                      onClick={() => setSelected(source.id)}
                      onDblClick={() => {
                        setSelected(source.id);
                        close(true);
                      }}
                      aria-pressed={active()}
                      {...stylex.attrs(styles.source, active() && styles.sourceActive)}
                      data-screen-source={source.id}
                    >
                      <Show when={source.thumbnail} fallback={<div {...stylex.attrs(styles.thumb)} />}>
                        <img src={source.thumbnail} alt="" {...stylex.attrs(styles.thumb)} />
                      </Show>
                      <span {...stylex.attrs(styles.sourceName)} title={source.name}>
                        {source.name}
                      </span>
                    </button>
                  );
                }}
              </For>
              <Show when={!shown().length}>
                <p {...stylex.attrs(styles.dialogText, styles.muted)}>Nothing to share here.</p>
              </Show>
            </div>
          </Show>
          <div {...stylex.attrs(styles.dialogActions)}>
            <Show when={audioPossible()}>
              <label {...stylex.attrs(styles.audio)}>
                <Checkbox checked={audio()} onChange={(e) => setAudio(e.currentTarget.checked)} data-screen-audio />
                {chosen()?.type === "tab" ? "Also share tab audio" : "Also share system audio"}
              </label>
            </Show>
            <span {...stylex.attrs(styles.spacer)} />
            <Button onClick={() => close(false)} data-screen-cancel>
              Cancel
            </Button>
            <Button variant="primary" disabled={cannotShare()} onClick={() => close(true)} data-screen-share>
              {props.request.systemPicker ? "Choose…" : "Share"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  privateNote: { margin: 0, color: colors.muted, fontSize: font.xs },
  liveRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    marginBottom: 2,
    paddingBlock: 4,
    paddingInline: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    fontSize: font.sm,
  },
  liveLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  promptArea: {
    position: "absolute",
    top: space.sm,
    left: space.sm,
    zIndex: 6,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: 340,
    maxWidth: "calc(100% - 16px)",
    pointerEvents: "none",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.2)",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    pointerEvents: "auto",
  },
  cardHeader: { display: "flex", alignItems: "center", gap: space.sm },
  cardTitle: { flex: 1, minWidth: 0, overflowWrap: "anywhere" },
  wants: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
  want: { display: "flex", alignItems: "center", gap: space.sm },
  wantIcon: { flexShrink: 0, color: colors.muted },
  answers: { display: "flex", flexDirection: "column", gap: 6, marginTop: space.xs },
  answer: { width: "100%", justifyContent: "center" },
  notice: { flexDirection: "row", alignItems: "flex-start" },
  noticeIcon: { flexShrink: 0, marginTop: 2, color: colors.warning },
  noticeText: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.sm,
    flex: 1,
    lineHeight: 1.4,
  },
  noticeButton: { fontSize: font.xs },
  liveIcon: { flexShrink: 0, color: colors.accent },
  stop: { paddingBlock: 2, paddingInline: space.sm, fontSize: font.xs },
  spacer: { flex: 1 },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 26,
    height: 26,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "grid",
    placeItems: "center",
    padding: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.35)",
  },
  dialog: {
    width: "min(640px, 100%)",
    maxHeight: "100%",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    boxShadow: "0 20px 50px rgb(0 0 0 / 0.25)",
  },
  dialogTitle: { margin: 0, fontSize: font.lg, fontWeight: 600 },
  dialogText: { margin: 0, fontSize: font.sm, lineHeight: 1.5, overflowWrap: "anywhere" },
  muted: { color: colors.muted },
  segmented: {
    display: "inline-flex",
    alignSelf: "flex-start",
    gap: 2,
    padding: 2,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceHover,
  },
  segment: {
    paddingBlock: 4,
    paddingInline: space.md,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.muted,
    fontFamily: "inherit",
    fontSize: font.sm,
    cursor: "pointer",
  },
  segmentActive: { backgroundColor: colors.surface, color: colors.text, boxShadow: "0 1px 2px rgb(0 0 0 / 0.12)" },
  sources: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: space.sm,
    overflowY: "auto",
    maxHeight: 360,
    minHeight: 120,
  },
  source: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 6,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.md,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: "inherit",
    fontSize: font.xs,
    textAlign: "left",
    cursor: "pointer",
  },
  sourceActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  thumb: {
    width: "100%",
    aspectRatio: "16 / 9",
    objectFit: "contain",
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
  },
  sourceName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  dialogActions: { display: "flex", alignItems: "center", gap: space.sm },
  audio: { display: "flex", alignItems: "center", gap: 6, fontSize: font.sm },
});
