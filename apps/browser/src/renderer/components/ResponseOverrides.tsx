// Response overrides in the UI: the popover a web tab opens from its address
// bar (every override that applies to the tab) and the list in Settings. The
// website agent makes them; here they're seen and removed.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ResponseOverride, ResponseOverrideSpec } from "../../shared/api";
import { describeOverride, scopeCovers, scopeName } from "../../shared/overrides";
import { api } from "../lib/api";
import { appById, workspaces } from "../lib/store";
import { responseOverrides } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";

/** The overrides that apply to a tab showing `url`. */
export const overridesFor = (tabId: string, workspaceId: string, url: string) =>
  responseOverrides().filter(
    (o) => (o.scope.type === "tab" || o.workspaceId === workspaceId) && scopeCovers(o.scope, url, (t) => t === tabId),
  );

const kindIcons: Record<ResponseOverrideSpec["kind"], string> = {
  respond: "file-braces",
  fail: "wifi-off",
  hang: "loader",
};

const until = (o: ResponseOverride) => {
  if (!o.expiresAt) return "";
  const minutes = Math.max(1, Math.round((Date.parse(o.expiresAt) - Date.now()) / 60_000));
  return ` · ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} left`;
};

/** One override: what it does, to which requests and where, and remove. */
function OverrideRow(props: { override: ResponseOverride; inSettings?: boolean }) {
  const o = () => props.override;
  const where = () => {
    const scope = o().scope;
    return scopeName(scope, scope.type === "tab" ? appById(scope.tabId)?.name : undefined);
  };
  const meta = () =>
    `${o().method ?? "Any"} ${o().pattern} · ${describeOverride(o())}${props.inSettings ? ` · ${where()}` : ""}${until(o())}`;
  return (
    <div {...stylex.attrs(styles.row)} data-response-override={o().id}>
      <Icon name={kindIcons[o().kind]} size={14} {...stylex.attrs(styles.rowIcon)} />
      <div {...stylex.attrs(styles.rowText)}>
        <span {...stylex.attrs(styles.rowTitle)}>{o().title}</span>
        <span {...stylex.attrs(styles.rowMeta)} title={meta()}>
          {meta()}
        </span>
      </div>
      <button
        type="button"
        title="Remove: the site's real answers again"
        onClick={() => void api.deleteResponseOverride(o().id)}
        {...stylex.attrs(styles.iconButton)}
        data-remove-response-override
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

/** What's overridden for the page open in a web tab. */
export function OverridesPopover(props: {
  tabId: string;
  workspaceId: string;
  url: string;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  let panel!: HTMLDivElement;
  const list = () => overridesFor(props.tabId, props.workspaceId, props.url);
  const [pos, setPos] = createSignal(props.position);

  onMount(() => {
    const rect = panel.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(props.position.x, window.innerWidth - rect.width - 8)), y: props.position.y });
    const onPointer = (e: PointerEvent) => {
      if (!panel.contains(e.target as Node) && !(e.target as Element).closest?.("[data-confirm-dialog]"))
        props.onClose();
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !document.querySelector("[data-confirm-dialog]") && props.onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  const removeAll = async () => {
    if (
      await confirmDialog(`Remove the ${list().length} response overrides on this page?`, {
        confirmLabel: "Remove all",
        danger: true,
      })
    )
      await Promise.all(list().map((o) => api.deleteResponseOverride(o.id)));
  };

  return (
    <Portal>
      <div
        ref={panel}
        {...stylex.attrs(styles.popover)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        data-response-overrides
      >
        <div {...stylex.attrs(styles.header)}>
          <span {...stylex.attrs(styles.title)}>Overridden responses</span>
          <Show when={list().length > 1}>
            <button
              type="button"
              onClick={() => void removeAll()}
              {...stylex.attrs(styles.textButton)}
              data-remove-all-overrides
            >
              Remove all
            </button>
          </Show>
          <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div {...stylex.attrs(styles.list)}>
          <For each={list()}>{(o) => <OverrideRow override={o} />}</For>
          <Show when={!list().length}>
            <p {...stylex.attrs(styles.empty)}>The site's answers aren't changed here anymore.</p>
          </Show>
        </div>
        <p {...stylex.attrs(styles.footer)}>
          The agent changed what this site returns, to show the page in other states. Reload after removing one to see
          the real page.
        </p>
      </div>
    </Portal>
  );
}

/** Every response override, for Settings. */
export function OverrideRows() {
  const byWorkspace = () =>
    workspaces
      .map((w) => ({ workspace: w, list: responseOverrides().filter((o) => o.workspaceId === w.id) }))
      .filter((g) => g.list.length);
  return (
    <Show
      when={responseOverrides().length}
      fallback={
        <p {...stylex.attrs(styles.empty)}>
          None. Ask the website agent to show a page empty, failing, slow or loading, and it changes what the site
          returns.
        </p>
      }
    >
      <div {...stylex.attrs(styles.settingsList)} data-override-rows>
        <For each={byWorkspace()}>
          {(group) => (
            <>
              <Show when={workspaces.length > 1}>
                <span {...stylex.attrs(styles.groupTitle)}>{group.workspace.name}</span>
              </Show>
              <For each={group.list}>{(o) => <OverrideRow override={o} inSettings />}</For>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}

const styles = stylex.create({
  popover: {
    position: "fixed",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    width: 380,
    maxHeight: 420,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    paddingLeft: space.md,
    paddingRight: 6,
  },
  title: { flex: 1, fontSize: font.xs, fontWeight: 600, color: colors.muted },
  list: { display: "flex", flexDirection: "column", overflowY: "auto", paddingInline: 6 },
  settingsList: { display: "flex", flexDirection: "column", gap: 2 },
  groupTitle: { marginTop: space.sm, paddingInline: 6, fontSize: font.xs, fontWeight: 600, color: colors.muted },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    paddingInline: 6,
    borderRadius: radius.sm,
  },
  rowIcon: { flexShrink: 0, color: colors.warning },
  rowText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: font.sm },
  rowMeta: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.muted, fontSize: 11 },
  empty: { margin: 0, padding: space.sm, color: colors.muted, fontSize: font.xs },
  footer: {
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    color: colors.muted,
    fontSize: 11,
  },
  textButton: {
    paddingBlock: 2,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.danger,
    fontFamily: "inherit",
    fontSize: font.xs,
    cursor: "pointer",
  },
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
});
