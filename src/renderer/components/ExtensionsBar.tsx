// A web tab's extensions button, in the sidebar's top row like Zen Browser's:
// one menu with every extension (the pinned ones first, with their badges).
// Choosing one opens its popup (its page in a <webview> of the workspace's
// session, sized by the page) or tells the extension it was clicked.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { webPartition } from "../../shared/api";
import type { ExtensionAction } from "../../shared/extensions";
import {
  actionsVersion,
  extensionById,
  extensionList,
  popupRequest,
  setPopupRequest,
  showExtensionSettings,
} from "../lib/extensions";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

const bridge = window.rune.extensions;

interface Popup {
  extensionId: string;
  url: string;
  anchor: DOMRect;
}

export function ExtensionsBar(props: {
  workspaceId: string;
  tabId: () => number | null;
  active: boolean;
  onImport: () => void;
}) {
  const [actions, setActions] = createSignal<ExtensionAction[]>([]);
  const [popup, setPopup] = createSignal<Popup | null>(null);
  const [menu, setMenu] = createSignal<DOMRect | null>(null);
  let menuButton: HTMLButtonElement | undefined;

  createEffect(() => {
    actionsVersion(props.workspaceId);
    extensionList();
    const tabId = props.tabId();
    void bridge.actions(props.workspaceId, tabId).then(setActions, () => setActions([]));
  });

  // Without extensions there's no button (the ⋯ menu leads to Settings → Extensions).
  const anchor = () =>
    (menuButton?.isConnected ? menuButton : document.querySelector("[data-more-menu]"))?.getBoundingClientRect() ??
    new DOMRect(12, 8, 0, 32);

  async function activate(action: ExtensionAction, anchor: DOMRect) {
    setMenu(null);
    if (popup()?.extensionId === action.extensionId) return setPopup(null);
    const url = await bridge.click(props.workspaceId, action.extensionId);
    setPopup(url ? { extensionId: action.extensionId, url, anchor } : null);
  }

  // A popup asked for by a shortcut or the extension itself, in the tab on screen.
  createEffect(
    on(popupRequest, (request) => {
      if (!request || !props.active || request.workspaceId !== props.workspaceId) return;
      setPopupRequest(null);
      setMenu(null);
      setPopup({ extensionId: request.extensionId, url: request.url, anchor: anchor() });
    }),
  );
  createEffect(() => {
    if (!props.active) setPopup(null);
  });

  const menuOpen = () => menu() !== null;
  const showing = () => popup() !== null;

  return (
    <>
      <Show when={extensionList().length}>
        <button
          type="button"
          ref={menuButton}
          title="Extensions"
          onClick={(e) => setMenu(menu() ? null : e.currentTarget.getBoundingClientRect())}
          {...stylex.attrs(styles.button, menuOpen() && styles.buttonOn, showing() && styles.buttonOn)}
          data-extensions-menu
        >
          <Icon name="puzzle" size={16} />
        </button>
      </Show>
      <Show when={menu()}>
        {(anchor) => (
          <ExtensionsMenu
            anchor={anchor()}
            actions={actions()}
            onActivate={(a) => void activate(a, anchor())}
            onActionMenu={(id) => void bridge.actionMenu(props.workspaceId, id)}
            onImport={() => {
              setMenu(null);
              props.onImport();
            }}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
      <Show when={popup()}>
        {(p) => <ExtensionPopup popup={p()} workspaceId={props.workspaceId} onClose={() => setPopup(null)} />}
      </Show>
    </>
  );
}

function ActionIcon(props: { action: ExtensionAction; size?: number }) {
  return (
    <span {...stylex.attrs(styles.iconWrap)}>
      <Show when={props.action.icon} fallback={<Icon name="puzzle" size={props.size ?? 16} />}>
        <img
          src={props.action.icon!}
          alt=""
          width={props.size ?? 18}
          height={props.size ?? 18}
          {...stylex.attrs(styles.icon)}
        />
      </Show>
      <Show when={props.action.badge}>
        <span
          {...stylex.attrs(styles.badge)}
          style={{
            "background-color": props.action.badgeColor || undefined,
            color: props.action.badgeTextColor ?? undefined,
          }}
          data-extension-badge
        >
          {props.action.badge.slice(0, 4)}
        </span>
      </Show>
    </span>
  );
}

/** Its menu, like Chrome's ⋮: its own items, pin, options, manage. */
function MoreButton(props: { extensionId: string; onActionMenu: (extensionId: string) => void }) {
  return (
    <button
      type="button"
      title="More: options, pin, manage"
      onClick={() => props.onActionMenu(props.extensionId)}
      {...stylex.attrs(styles.pin)}
      data-extension-more={props.extensionId}
    >
      <Icon name="ellipsis-vertical" size={14} />
    </button>
  );
}

/** Closes a popover on Escape, a click elsewhere, or focus moving away (into a page). */
function useDismiss(el: () => HTMLElement, onClose: () => void, ignore?: () => HTMLElement | undefined) {
  onMount(() => {
    const outside = (target: EventTarget | null) =>
      !el().contains(target as Node) && !ignore?.()?.contains(target as Node);
    const onPointer = (e: PointerEvent) => outside(e.target) && onClose();
    const onFocus = (e: FocusEvent) => outside(e.target) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
    });
  });
}

function ExtensionsMenu(props: {
  anchor: DOMRect;
  actions: ExtensionAction[];
  onActivate: (a: ExtensionAction) => void;
  onActionMenu: (extensionId: string) => void;
  onImport: () => void;
  onClose: () => void;
}) {
  let el!: HTMLDivElement;
  useDismiss(() => el, props.onClose);
  const left = () => Math.max(8, Math.min(props.anchor.left, window.innerWidth - 308));
  const pinnedFirst = () =>
    [...props.actions].sort(
      (a, b) => Number(!extensionById(a.extensionId)?.pinned) - Number(!extensionById(b.extensionId)?.pinned),
    );
  const others = () => extensionList().filter((e) => e.enabled && !props.actions.some((a) => a.extensionId === e.id));
  return (
    <Portal>
      <div
        ref={el}
        role="menu"
        {...stylex.attrs(styles.menu)}
        style={{ left: `${left()}px`, top: `${props.anchor.bottom + 6}px` }}
        data-extensions-list
      >
        <Show
          when={extensionList().length}
          fallback={
            <div {...stylex.attrs(styles.empty)}>
              <p {...stylex.attrs(styles.emptyText)}>
                No extensions yet. Bring over the ones from your browser, with their settings.
              </p>
              <button type="button" onClick={props.onImport} {...stylex.attrs(styles.cta)} data-extensions-import>
                <Icon name="download" size={14} />
                Import from your browser
              </button>
            </div>
          }
        >
          <For each={pinnedFirst()}>
            {(action) => {
              const info = () => extensionById(action.extensionId);
              const isPinned = () => info()?.pinned === true;
              return (
                <div {...stylex.attrs(styles.item)}>
                  <button
                    type="button"
                    disabled={!action.enabled}
                    onClick={() => props.onActivate(action)}
                    // Its own menu items (chrome.contextMenus, "action" context).
                    onContextMenu={(e) => {
                      e.preventDefault();
                      props.onActionMenu(action.extensionId);
                    }}
                    {...stylex.attrs(styles.itemMain)}
                    data-extension-item={action.extensionId}
                  >
                    <ActionIcon action={action} size={16} />
                    <span {...stylex.attrs(styles.itemName)}>{info()?.name ?? action.title}</span>
                  </button>
                  <button
                    type="button"
                    title={isPinned() ? "Unpin" : "Pin to the top of this menu"}
                    aria-pressed={isPinned()}
                    onClick={() => void bridge.setPinned(action.extensionId, !isPinned())}
                    {...stylex.attrs(styles.pin, isPinned() && styles.pinOn)}
                    data-extension-pin={action.extensionId}
                  >
                    <Icon name="pin" size={14} />
                  </button>
                  <MoreButton extensionId={action.extensionId} onActionMenu={props.onActionMenu} />
                </div>
              );
            }}
          </For>
          <For each={others()}>
            {(info) => (
              <div {...stylex.attrs(styles.item)}>
                <span {...stylex.attrs(styles.itemMain, styles.itemStatic)}>
                  <Show when={info.icon} fallback={<Icon name="puzzle" size={16} />}>
                    <img src={info.icon!} alt="" width={16} height={16} {...stylex.attrs(styles.icon)} />
                  </Show>
                  <span {...stylex.attrs(styles.itemName)}>{info.name}</span>
                </span>
                <MoreButton extensionId={info.id} onActionMenu={props.onActionMenu} />
              </div>
            )}
          </For>
        </Show>
        <div {...stylex.attrs(styles.separator)} />
        <button
          type="button"
          onClick={() => {
            props.onClose();
            showExtensionSettings();
          }}
          {...stylex.attrs(styles.itemMain, styles.footer)}
          data-extensions-manage
        >
          <Icon name="settings" size={14} />
          Manage extensions
        </button>
      </div>
    </Portal>
  );
}

/** The size a popup page wants (like Chrome: its content's, within 25×25 and 800×600). */
const measureScript = `(() => {
  const d = document.documentElement;
  const before = d.style.width;
  d.style.width = "max-content";
  const width = Math.ceil(d.getBoundingClientRect().width);
  d.style.width = before;
  const height = Math.ceil(Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0));
  return [width, height];
})()`;

function ExtensionPopup(props: { popup: Popup; workspaceId: string; onClose: () => void }) {
  let el!: HTMLDivElement;
  let view: Electron.WebviewTag | undefined;
  let ready = false;
  const [size, setSize] = createSignal<[number, number] | null>(null);
  useDismiss(() => el, props.onClose);
  const left = () => Math.max(8, Math.min(props.popup.anchor.left, window.innerWidth - (size()?.[0] ?? 25) - 10));
  const measure = () => {
    if (!view || !ready) return;
    view
      .executeJavaScript(measureScript)
      .then((wanted: [number, number]) => {
        const next: [number, number] = [Math.min(800, Math.max(25, wanted[0])), Math.min(600, Math.max(25, wanted[1]))];
        const current = size();
        if (!current || current[0] !== next[0] || current[1] !== next[1]) setSize(next);
      })
      .catch(() => {});
  };
  // Popups change size as they go (lists load, sections open).
  const timer = setInterval(measure, 250);
  onCleanup(() => clearInterval(timer));
  const attach = (v: Electron.WebviewTag) => {
    view = v;
    // window.close() in the popup.
    v.addEventListener("close", () => props.onClose());
    v.addEventListener("dom-ready", () => {
      ready = true;
      v.focus();
      measure();
    });
  };
  onCleanup(() => view?.remove());
  return (
    <Portal>
      <div
        ref={el}
        {...stylex.attrs(styles.popup)}
        style={{ left: `${left()}px`, top: `${props.popup.anchor.bottom + 6}px` }}
        data-extension-popup={props.popup.extensionId}
      >
        <webview
          ref={attach}
          src={props.popup.url}
          partition={webPartition(props.workspaceId)}
          {...stylex.attrs(styles.popupView)}
          style={{ width: `${size()?.[0] ?? 25}px`, height: `${size()?.[1] ?? 25}px` }}
        />
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  button: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 30,
    height: 30,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text },
    opacity: { default: 1, ":disabled": 0.4 },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  buttonOn: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    color: { default: colors.accent, ":hover": colors.accent },
  },
  // Room for its badge before the name.
  iconWrap: { position: "relative", display: "grid", placeItems: "center", marginRight: 6 },
  icon: { display: "block", objectFit: "contain" },
  badge: {
    position: "absolute",
    right: -8,
    bottom: -6,
    minWidth: 14,
    height: 14,
    paddingInline: 3,
    borderRadius: 4,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontFamily: font.sans,
    fontSize: 9,
    fontWeight: 700,
    lineHeight: "14px",
    textAlign: "center",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  menu: {
    position: "fixed",
    zIndex: 1500,
    width: 300,
    maxHeight: "70vh",
    overflowY: "auto",
    padding: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
    fontFamily: font.sans,
    fontSize: font.sm,
    color: colors.text,
  },
  item: { display: "flex", alignItems: "center", gap: 2 },
  itemMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 32,
    paddingInline: space.sm,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
  },
  itemStatic: {
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    color: colors.muted,
    cursor: "default",
  },
  itemName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pin: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
  pinOn: { color: colors.accent },
  separator: { height: 1, marginBlock: space.xs, backgroundColor: colors.border },
  footer: { color: colors.muted, width: "100%" },
  empty: { display: "flex", flexDirection: "column", gap: space.sm, padding: space.sm },
  emptyText: { margin: 0, color: colors.muted, lineHeight: 1.5 },
  cta: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    height: 32,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontFamily: font.sans,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  popup: {
    position: "fixed",
    zIndex: 1500,
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "#ffffff",
    boxShadow: "0 10px 30px rgb(0 0 0 / 0.22)",
  },
  popupView: { display: "flex" },
});
