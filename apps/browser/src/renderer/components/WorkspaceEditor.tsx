// A workspace's name and icon, edited in one popover next to its icon in the workspace bar: right after "+"
// made it, from its menu (Rename, Change icon…), by double-clicking it, or from Settings. The icon applies as
// soon as it's picked; the name when Enter is pressed, Done is clicked or the popover is left (Escape leaves the
// name as it was).
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { WorkspaceInfo } from "../../shared/api";
import { openSettings, updateWorkspace, workspaces } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { IconChoices } from "./TabIcon";
import { toast } from "./Toast";

export interface WorkspaceEditing {
  id: string;
  /** What gets the focus: the name (Rename, a new workspace) or the icon search (Change icon…). */
  focus: "name" | "icon";
  /** Just made by "+": says so, and a name left empty keeps the one it has. */
  isNew?: boolean;
  /** What it opens next to (its icon in the bar); otherwise the bar's icon for it is looked up. */
  anchor?: DOMRect;
}

const [editing, setEditing] = createSignal<WorkspaceEditing>();
/** The workspace being edited, if any. */
export const workspaceEditing = editing;
/** Opens the editor for a workspace. */
export const editWorkspace = (request: WorkspaceEditing) => setEditing(request);
export const closeWorkspaceEditor = () => setEditing();

const GAP = 8;
const WIDTH = 328;

/** The editor, for whichever workspace is being edited (one per window). */
export function WorkspaceEditorHost() {
  return (
    <Show when={editing()} keyed>
      {(request) => (
        <Show when={workspaces.find((w) => w.id === request.id)}>
          {(workspace) => <WorkspaceEditor workspace={workspace()} request={request} onClose={closeWorkspaceEditor} />}
        </Show>
      )}
    </Show>
  );
}

function anchorOf(request: WorkspaceEditing) {
  if (request.anchor) return request.anchor;
  const button = document.querySelector(`[data-workspace-bar] [data-workspace="${CSS.escape(request.id)}"]`);
  return button?.getBoundingClientRect() ?? null;
}

function WorkspaceEditor(props: { workspace: WorkspaceInfo; request: WorkspaceEditing; onClose: () => void }) {
  let root!: HTMLDivElement;
  let nameInput!: HTMLInputElement;
  let searchInput: HTMLInputElement | undefined;
  const [pos, setPos] = createSignal({ x: -9999, y: -9999 });
  const [above, setAbove] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal(props.workspace.name);
  let closed = false;

  const icon = () => props.workspace.icon;
  const initial = () => (name().trim() || props.workspace.name).charAt(0).toUpperCase();

  const close = (saveName: boolean) => {
    if (closed) return;
    closed = true;
    const typed = (nameInput?.value ?? name()).trim();
    if (saveName && typed && typed !== props.workspace.name) {
      void updateWorkspace(props.workspace.id, { name: typed }).catch((err) =>
        toast({ message: err instanceof Error ? err.message : String(err), kind: "error" }),
      );
    }
    props.onClose();
  };

  const chooseIcon = async (value: string | null) => {
    setBusy(true);
    try {
      await updateWorkspace(props.workspace.id, { icon: value });
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const place = () => {
    const rect = root.getBoundingClientRect();
    const anchor = anchorOf(props.request);
    if (!anchor) {
      setPos({ x: (window.innerWidth - rect.width) / 2, y: Math.max(GAP, (window.innerHeight - rect.height) / 3) });
      return;
    }
    // Under the icon in the top bar; over it in the sidebar's bottom row.
    const fitsBelow = anchor.bottom + GAP + rect.height <= window.innerHeight - GAP;
    const up = !fitsBelow && anchor.top - GAP - rect.height >= GAP;
    setAbove(up);
    const x = anchor.left + anchor.width / 2 - rect.width / 2;
    setPos({
      x: Math.max(GAP, Math.min(x, window.innerWidth - rect.width - GAP)),
      y: up ? anchor.top - GAP - rect.height : Math.min(anchor.bottom + GAP, window.innerHeight - rect.height - GAP),
    });
  };

  onMount(() => {
    place();
    if (props.request.focus === "icon" && searchInput) searchInput.focus();
    else {
      nameInput.focus();
      nameInput.select();
    }
    const onPointer = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) close(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(false);
    };
    const onResize = () => place();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    });
  });

  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label={props.request.isNew ? "New workspace" : `Edit the workspace ${props.workspace.name}`}
        {...stylex.attrs(styles.root, above() && styles.rootAbove)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px`, width: `${WIDTH}px` }}
        // Events from a portal reach the component that opened it (the workspace's button).
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())}
        data-workspace-editor={props.workspace.id}
      >
        <div {...stylex.attrs(styles.title)}>{props.request.isNew ? "New workspace" : "Workspace"}</div>
        <div {...stylex.attrs(styles.identity)}>
          <button
            type="button"
            title="Search icons"
            onClick={() => searchInput?.focus()}
            {...stylex.attrs(styles.badge)}
            data-workspace-editor-icon
          >
            <Icon
              name={icon()}
              size={20}
              fallback={<span {...stylex.attrs(styles.badgeText)}>{icon() ?? initial()}</span>}
            />
          </button>
          <input
            ref={nameInput}
            value={name()}
            placeholder={props.workspace.name}
            aria-label="Workspace name"
            maxLength={100}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                close(true);
              }
            }}
            {...stylex.attrs(styles.name)}
            data-workspace-name
          />
        </div>
        <div {...stylex.attrs(styles.label)}>Icon</div>
        <IconChoices
          current={icon()}
          disabled={busy()}
          onChoose={(value) => void chooseIcon(value)}
          searchRef={(el) => (searchInput = el)}
        />
        <div {...stylex.attrs(styles.footer)}>
          <Show when={icon()}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void chooseIcon(null)}
              {...stylex.attrs(styles.action)}
              data-icon-reset
            >
              <Icon name="rotate-ccw" size={14} />
              Use its initial
            </button>
          </Show>
          <span {...stylex.attrs(styles.spacer)} />
          <button
            type="button"
            title="Default agent and instructions"
            onClick={() => {
              close(true);
              void openSettings("workspace");
            }}
            {...stylex.attrs(styles.action)}
            data-workspace-editor-settings
          >
            <Icon name="settings-2" size={14} />
            Settings
          </button>
          <button type="button" onClick={() => close(true)} {...stylex.attrs(styles.done)} data-workspace-editor-done>
            Done
          </button>
        </div>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  root: {
    position: "fixed",
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgb(0 0 0 / 0.16), 0 2px 8px rgb(0 0 0 / 0.08)",
    fontFamily: font.sans,
    fontSize: font.sm,
    color: colors.text,
    transformOrigin: "top center",
    animationName: stylex.keyframes({
      from: { opacity: 0, transform: "translateY(-4px) scale(0.98)" },
      to: { opacity: 1, transform: "none" },
    }),
    animationDuration: "120ms",
    animationTimingFunction: "ease-out",
  },
  rootAbove: { transformOrigin: "bottom center" },
  title: { fontSize: font.xs, fontWeight: 600, color: colors.muted, letterSpacing: "0.02em" },
  identity: { display: "flex", alignItems: "center", gap: space.sm },
  badge: {
    display: "grid",
    placeItems: "center",
    width: 40,
    height: 40,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: colors.accentSoft, ":hover": colors.surfaceHover },
    color: colors.accent,
    cursor: "pointer",
  },
  badgeText: { fontSize: 18, fontWeight: 600, lineHeight: 1 },
  name: {
    flex: 1,
    minWidth: 0,
    height: 40,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    color: colors.text,
    outline: "none",
    fontFamily: font.sans,
    fontSize: font.md,
    fontWeight: 500,
  },
  label: { marginTop: space.xs, fontSize: font.xs, fontWeight: 600, color: colors.muted },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  spacer: { flex: 1 },
  action: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.xs,
    cursor: { default: "pointer", ":disabled": "progress" },
  },
  done: {
    height: 28,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontFamily: font.sans,
    fontSize: font.xs,
    fontWeight: 600,
    cursor: "pointer",
  },
});
