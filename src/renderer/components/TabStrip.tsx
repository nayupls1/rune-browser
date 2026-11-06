// Horizontal tabs: one bar along the top of the window, minimal like Helium's: the window's buttons,
// back, forward and reload, a compact address, then the tabs right next to it (pinned ones as icons,
// New tab after them), and at the end the workspaces, the agent and the ⋯ menu. The same tabs as the
// vertical sidebar's (components/Sidebar.tsx), in a row: the same menus, dragging (to reorder, into a
// split view, out to a new window) and drops. Tabs shrink as more are opened, down to a minimum; past
// that they scroll.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { displayUrl } from "../../shared/visits";
import { openDropped, dropTarget, hasDroppable, setDropTarget } from "../lib/drops";
import { shortcutLabel, withKeys } from "../lib/shortcuts";
import { appById, isLoaded, isPrivate, newApp, newWebTab, selectedId } from "../lib/store";
import { takeTab } from "../lib/windows";
import { colors, font, radius, space } from "../theme.stylex";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import {
  entries,
  isForeignTabDrag,
  Item,
  layoutMenuItem,
  NewTabMenu,
  SettingsLink,
  SplitGroup,
  tabFromElsewhere,
  tiles,
  WorkspaceBar,
  WorkspaceName,
} from "./Sidebar";
import { AddressBar, AgentButton, MoreMenu, NavButtons } from "./TopBar";
import { WindowControls } from "./WindowControls";

/** Its height (App.tsx keeps the room for it, as a number there). */
const TOP_AREA_HEIGHT = 46;

const privateWindow = () => isPrivate;

export function TopArea() {
  return (
    // It drags the window (double-click maximizes); its tabs, buttons and address don't.
    <div
      {...stylex.attrs(styles.root, privateWindow() && styles.rootPrivate)}
      // The tab on screen's chrome: its navigation, address, agent and ⋯ menu are all in here.
      data-tab-chrome={selectedId() ?? ""}
      data-horizontal-tabs
      data-titlebar
      data-private-window={isPrivate ? "" : undefined}
    >
      <WindowControls />
      <Show when={isPrivate}>
        <span
          {...stylex.attrs(styles.privateBadge)}
          title="Private window: its history, cookies and site data are gone when it closes, and agents don't see it"
          data-private-badge
        >
          <Icon name="hat-glasses" size={14} />
        </span>
      </Show>
      <NavButtons />
      <AddressBar inline />
      <TabStrip />
      {/* A private window has no workspaces, and no agents. */}
      <Show when={!isPrivate} fallback={<SettingsLink />}>
        <WorkspaceName />
        <WorkspaceBar inline />
        <AgentButton />
      </Show>
      <MoreMenu />
    </div>
  );
}

/** The tabs, New tab after them, and the free room up to the bar's end. */
function TabStrip() {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [newMenu, setNewMenu] = createSignal<MenuPosition>();
  let scroller!: HTMLUListElement;
  let newButton!: HTMLButtonElement;

  // The tab on screen is always in view (a new one, or one picked elsewhere).
  createEffect(
    on(selectedId, (id) =>
      requestAnimationFrame(() => {
        const tab = id && scroller.querySelector(`[data-app-id="${CSS.escape(id)}"]`);
        if (!tab) return;
        const bar = scroller.getBoundingClientRect();
        const r = tab.getBoundingClientRect();
        if (r.left < bar.left) scroller.scrollLeft -= bar.left - r.left + 8;
        else if (r.right > bar.right) scroller.scrollLeft += r.right - bar.right + 8;
      }),
    ),
  );

  const menuItems = (): (MenuItem | "separator")[] => [
    { label: "New tab", icon: "plus", hint: shortcutLabel("tab.new"), onSelect: () => void newWebTab() },
    // Apps are built by agents, which private windows don't have.
    ...(isPrivate ? [] : [{ label: "New app", icon: "sparkles", onSelect: () => newApp() }]),
    "separator",
    layoutMenuItem(),
  ];

  return (
    <div
      {...stylex.attrs(styles.strip)}
      data-tab-strip
      onContextMenu={(e) => {
        // Its own menu only off the tabs and buttons (they have theirs).
        if ((e.target as Element).closest("[data-app-id], [data-split-group], button, input")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      // A tab from another window, or files, links and text from outside, dropped off the tabs: a new tab, last.
      onDragOver={(e) => {
        if (isForeignTabDrag(e.dataTransfer)) {
          e.preventDefault();
          e.dataTransfer!.dropEffect = "move";
          return;
        }
        if (!hasDroppable(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        setDropTarget({ kind: "list" });
      }}
      onDrop={(e) => {
        const tab = tabFromElsewhere(e.dataTransfer);
        if (tab) {
          e.preventDefault();
          return void takeTab(tab);
        }
        if (!hasDroppable(e.dataTransfer)) return;
        e.preventDefault();
        setDropTarget(null);
        openDropped(e.dataTransfer!);
      }}
    >
      <Show when={tiles().length}>
        <ul {...stylex.attrs(styles.tiles)} data-pinned-tiles>
          <For each={tiles()}>{(app) => <Item app={app} tile horizontal />}</For>
        </ul>
      </Show>
      <ul
        ref={scroller}
        {...stylex.attrs(styles.tabs)}
        // The wheel scrolls the tabs sideways.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.scrollLeft += e.deltaY;
        }}
        data-tab-list
      >
        <For each={entries()}>
          {(key) => (
            <Show
              when={key.startsWith("split:")}
              fallback={<Show when={appById(key)}>{(app) => <Item app={app()} horizontal />}</Show>}
            >
              <SplitGroup splitId={key.slice(6)} horizontal />
            </Show>
          )}
        </For>
        <Show when={dropTarget()?.kind === "list"}>
          <li {...stylex.attrs(styles.dropSlot)} title="Open in a new tab" data-drop-slot>
            <Icon name="plus" size={15} />
          </li>
        </Show>
      </ul>
      <button
        type="button"
        ref={newButton}
        title={`${withKeys("New tab", "tab.new")} · right-click for more`}
        aria-label="New tab"
        onClick={() => void newWebTab()}
        onContextMenu={(e) => {
          e.preventDefault();
          const r = newButton.getBoundingClientRect();
          setNewMenu({ x: r.left, y: r.bottom + 4 });
        }}
        {...stylex.attrs(styles.newTab)}
        data-new-tab
      >
        <Icon name="plus" size={16} />
      </button>
      <span {...stylex.attrs(styles.spacer)} />
      <Show when={menu()}>
        {(position) => <ContextMenu items={menuItems()} position={position()} onClose={() => setMenu()} />}
      </Show>
      <Show when={newMenu()}>
        {(position) => <NewTabMenu position={position()} anchor={newButton} onClose={() => setNewMenu()} />}
      </Show>
      <HoverCard scroller={() => scroller} />
    </div>
  );
}

/**
 * A card under the tab the pointer rests on, like Chrome's: its name in full, its address and
 * whether it's loaded. Once one is showing, moving along the tabs shows theirs right away.
 */
function HoverCard(props: { scroller: () => HTMLElement }) {
  const [shown, setShown] = createSignal<{ id: string; left: number; top: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    setShown();
  };
  const strip = () => props.scroller().closest<HTMLElement>("[data-tab-strip]")!;
  const onOver = (e: PointerEvent) => {
    const tab = (e.target as Element).closest<HTMLElement>("[data-app-id]");
    if (!tab || tab.querySelector("input")) return hide();
    const id = tab.dataset.appId!;
    if (shown()?.id === id) return;
    const show = () => {
      const r = tab.getBoundingClientRect();
      setShown({ id, left: Math.max(4, Math.min(r.left, window.innerWidth - CARD_WIDTH - 4)), top: r.bottom + 6 });
    };
    clearTimeout(timer);
    if (shown()) show();
    else timer = setTimeout(show, 500);
  };
  // Not while something else happens there: a click, a drag, a menu.
  onMount(() => {
    const el = strip();
    el.addEventListener("pointerover", onOver);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("pointerdown", hide, true);
    el.addEventListener("dragstart", hide, true);
    el.addEventListener("contextmenu", hide, true);
    onCleanup(() => {
      el.removeEventListener("pointerover", onOver);
      el.removeEventListener("pointerleave", hide);
      el.removeEventListener("pointerdown", hide, true);
      el.removeEventListener("dragstart", hide, true);
      el.removeEventListener("contextmenu", hide, true);
    });
  });
  onCleanup(() => clearTimeout(timer));
  // The tab went (closed, moved), or the window lost the pointer.
  createEffect(() => shown() && !appById(shown()!.id) && hide());
  window.addEventListener("blur", hide);
  onCleanup(() => window.removeEventListener("blur", hide));

  return (
    <Show when={shown() && appById(shown()!.id) && shown()} keyed>
      {(at) => {
        const tab = () => appById(at.id);
        const address = () => {
          const t = tab();
          if (!t) return "";
          return t.url ? displayUrl(t.url) : t.kind === "app" ? "App" : "New tab";
        };
        return (
          <Portal>
            <div
              {...stylex.attrs(styles.card)}
              style={{ left: `${at.left}px`, top: `${at.top}px` }}
              role="tooltip"
              data-tab-card={at.id}
            >
              <span {...stylex.attrs(styles.cardTitle)}>{tab()?.name}</span>
              <span {...stylex.attrs(styles.cardDetail)}>{address()}</span>
              <Show when={!isLoaded(at.id) && selectedId() !== at.id}>
                <span {...stylex.attrs(styles.cardNote)}>
                  <Icon name="moon" size={12} />
                  Not loaded: opens where you left it
                </span>
              </Show>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

const CARD_WIDTH = 260;

const styles = stylex.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: TOP_AREA_HEIGHT,
    display: "flex",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
    paddingInline: space.sm,
    backgroundColor: colors.sidebar,
  },
  // A private window's top is tinted, like its sidebar, so it's never mistaken for a normal one.
  rootPrivate: { backgroundImage: "linear-gradient(rgb(76 29 149 / 0.12), rgb(76 29 149 / 0.12))" },
  strip: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flex: 1,
    minWidth: 0,
    height: "100%",
    paddingLeft: 4,
  },
  privateBadge: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: "#2e1f5e",
    color: "#e4dcff",
  },
  tiles: { listStyle: "none", display: "flex", gap: 4, flexShrink: 0, margin: 0, padding: 0, paddingRight: 4 },
  tabs: {
    listStyle: "none",
    display: "flex",
    alignItems: "center",
    gap: 4,
    flex: "0 1 auto",
    minWidth: 0,
    height: "100%",
    margin: 0,
    // Room for the selected tab's ring and the drop line.
    paddingInline: 2,
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "none",
  },
  dropSlot: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 38,
    height: 30,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    pointerEvents: "none",
  },
  newTab: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 30,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: 8,
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in oklab, ${colors.text} 7%, transparent)`,
    },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  // The rest of the bar drags the window.
  spacer: { flex: 1, minWidth: 24, alignSelf: "stretch" },
  card: {
    position: "fixed",
    // Over the floating sidebar and the page, like every menu.
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    width: CARD_WIDTH,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.08)",
    color: colors.text,
    fontFamily: font.sans,
    pointerEvents: "none",
  },
  // At most about three lines of a long title.
  cardTitle: { maxHeight: "4.2em", overflow: "hidden", fontSize: font.sm, fontWeight: 600, overflowWrap: "anywhere" },
  cardDetail: {
    fontSize: font.xs,
    color: colors.muted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardNote: { display: "flex", alignItems: "center", gap: 4, marginTop: 2, fontSize: font.xs, color: colors.muted },
});
