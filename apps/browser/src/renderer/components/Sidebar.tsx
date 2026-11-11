import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { AppSummary, WorkspaceInfo } from "../../shared/api";
import {
  appById,
  newChat,
  createWorkspace,
  currentWorkspace,
  duplicateApp,
  isLoaded,
  moveApp,
  moveTab,
  moveTabs,
  newWebTab,
  renameApp,
  selectApp,
  selectedId,
  setTabPinned,
  apps,
  deleteWorkspace,
  isSettingsView,
  openSettings,
  reorderWorkspaces,
  showWorkspace,
  states,
  updateWorkspace,
  workspaces,
  workspaceTabs,
  closeTab,
  isPrivate,
} from "../lib/store";
import {
  draggedSplit,
  draggedTab,
  isHorizontal,
  isSidebarHidden,
  setTabLayout,
  setDraggedSplit,
  setDraggedTab,
  setSidebarHidden,
  setSidebarPeek,
  sidebarPeek,
  TAB_DRAG_TYPE,
  setSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  sidebarWidth,
} from "../lib/layout";
import { canUnload, unloadTab } from "../lib/unload";
import { isAudible, isMuted, toggleMuted } from "../lib/webtabs";
import { dropTarget, hasDroppable, openDropped, setDropTarget } from "../lib/drops";
import { fullAccess } from "../lib/access";
import {
  evenSplit,
  placeInSplit,
  removeFromSplit,
  rotateSplit,
  splitOf,
  splitWith,
  unsplit,
  visibleTabs,
} from "../lib/splits";
import { colors, font, radius, space } from "../theme.stylex";
import { AddressBar, addressOpen, AgentButton, MoreMenu, NavRow } from "./TopBar";
import { confirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { IconPicker, TabIcon } from "./TabIcon";
import { toast } from "./Toast";
import { Button } from "./ui";
import { editWorkspace, workspaceEditing } from "./WorkspaceEditor";
import { shortcutLabel, withKeys } from "../lib/shortcuts";
import { TabHoverCard } from "./TabHoverCard";
import {
  moveToNewWindow,
  moveToWindow,
  newPrivateWindow,
  newWindow,
  otherWindows,
  takeTab,
  tearOff,
} from "../lib/windows";

/**
 * What the list shows, in the tabs' order: tab ids, and "split:<id>" for a
 * split view, which takes the place of its first tab and lists its tabs in it.
 */
export const entries = () => {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const tab of workspaceTabs()) {
    if (isTile(tab)) continue;
    const split = splitOf(tab.id);
    if (!split) list.push(tab.id);
    else if (!seen.has(split.id)) {
      seen.add(split.id);
      list.push(`split:${split.id}`);
    }
  }
  return list;
};

/** Pinned tabs show as tiles above the list (not in a split view). */
const isTile = (tab: AppSummary) => tab.pinned && !splitOf(tab.id);
export const tiles = () => workspaceTabs().filter(isTile);

/** Text fields take dropped text themselves. */
export const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("input, textarea, [contenteditable]");

const privateWindow = () => isPrivate;

/** The strip at the window's left edge that brings a hidden sidebar in. */
const EDGE_WIDTH = 8;

/** Menus and popovers (portaled); one next to the sidebar is one of its own. */
const POPOVERS = [
  "[data-context-menu]",
  "[data-extensions-list]",
  "[data-extension-popup]",
  "[data-downloads-panel]",
  "[data-site-info]",
  "[data-page-changes]",
  "[data-response-overrides]",
  "[data-bookmarks-menu]",
  "[data-bookmark-editor]",
  "[data-icon-picker]",
].join(", ");

/** A hidden sidebar is shown over the page while the pointer is in it, or a menu of it is open. */
const isOverlay = () => isSidebarHidden();
const isAway = () => isSidebarHidden() && !sidebarPeek();

/** Switches between horizontal tabs and the vertical sidebar. */
const layoutMenuItem = (): MenuItem =>
  isHorizontal()
    ? { id: "tab-layout", label: "Use vertical tabs", icon: "panel-left", onSelect: () => setTabLayout("vertical") }
    : { id: "tab-layout", label: "Use horizontal tabs", icon: "panel-top", onSelect: () => setTabLayout("horizontal") };

/**
 * The tab area's own menu, on its empty space (the same in the sidebar and the tab bar): what's for all the
 * tabs, not one of them. A tab's menu only has what's for that tab.
 */
export const tabAreaMenuItems = (): (MenuItem | "separator")[] => [
  { id: "new-tab", label: "New tab", icon: "plus", hint: shortcutLabel("tab.new"), onSelect: () => void newWebTab() },
  "separator",
  layoutMenuItem(),
];

/** Right-clicks on these in the tab area are theirs (they have menus of their own, or none). */
const NOT_TAB_AREA =
  "[data-app-id], [data-split-group], button, input, textarea, a, [data-address-slot], [data-sidebar-footer], [data-sidebar-chrome], [data-nav-row]";

/** A right-click on the tab area's empty space (not on a tab, a button or the address): where its menu opens. */
export const tabAreaMenuAt = (e: MouseEvent): MenuPosition | undefined => {
  if ((e.target as Element).closest(NOT_TAB_AREA)) return;
  e.preventDefault();
  return { x: e.clientX, y: e.clientY };
};

/**
 * While something is dragged near an end of a list that scrolls (a tab being reordered, a link), the list
 * scrolls that way, so every place in it can be reached.
 */
export function scrollWhileDragging(list: HTMLElement, axis: "x" | "y", area: HTMLElement = list) {
  const onDragOver = (e: DragEvent) => {
    const r = list.getBoundingClientRect();
    const [at, start, end] = axis === "x" ? [e.clientX, r.left, r.right] : [e.clientY, r.top, r.bottom];
    const zone = Math.min(36, (end - start) / 4);
    const step = at < start + zone ? -(start + zone - at) : at > end - zone ? at - (end - zone) : 0;
    if (!step) return;
    const by = Math.sign(step) * Math.min(14, 3 + Math.abs(step) / 2);
    if (axis === "x") list.scrollLeft += by;
    else list.scrollTop += by;
  };
  area.addEventListener("dragover", onDragOver, true);
  onCleanup(() => area.removeEventListener("dragover", onDragOver, true));
}

/** Scrolls the list so the tab on screen is in it, with `margin` to spare (a new tab, or one picked elsewhere). */
export function keepSelectedInView(list: () => HTMLElement | undefined, axis: "x" | "y", margin: number) {
  createEffect(
    on([selectedId, () => entries().length, () => tiles().length], ([id]) =>
      requestAnimationFrame(() => {
        const el = list();
        const tab = id && el?.isConnected && el.querySelector(`[data-app-id="${CSS.escape(id)}"]`);
        if (!el || !tab) return;
        const box = el.getBoundingClientRect();
        const r = tab.getBoundingClientRect();
        const [lo, hi, boxLo, boxHi] =
          axis === "x" ? [r.left, r.right, box.left, box.right] : [r.top, r.bottom, box.top, box.bottom];
        const delta = lo < boxLo + margin ? lo - boxLo - margin : hi > boxHi - margin ? hi - boxHi + margin : 0;
        if (!delta) return;
        if (axis === "x") el.scrollLeft += delta;
        else el.scrollTop += delta;
      }),
    ),
  );
}

/** The New tab menu: a tab or a window. */
export function NewTabMenu(props: { position: MenuPosition; onClose: () => void; anchor?: Element }) {
  const items = (): (MenuItem | "separator")[] => [
    { label: "New tab", icon: "globe", onSelect: () => newWebTab() },
    "separator",
    { label: withKeys("New window", "window.new"), icon: "app-window", onSelect: () => void newWindow() },
    {
      label: withKeys("New private window", "window.private"),
      icon: "hat-glasses",
      onSelect: () => void newPrivateWindow(),
    },
  ];
  return <ContextMenu items={items()} position={props.position} anchor={props.anchor} onClose={props.onClose} />;
}

/** The tabs: the vertical sidebar, or (horizontal tabs) nothing here: they're in the tab bar (components/TabStrip.tsx). */
export function Sidebar() {
  // macOS's traffic lights go with a hidden sidebar.
  if (window.rune.window.platform === "darwin")
    createEffect(on(isAway, (away) => window.rune.window.setButtonsVisible(!away)));
  return (
    <Show when={!isHorizontal()}>
      <VerticalSidebar />
    </Show>
  );
}

function VerticalSidebar() {
  const [newMenu, setNewMenu] = createSignal<MenuPosition>();
  const [areaMenu, setAreaMenu] = createSignal<MenuPosition>();
  let nav!: HTMLElement;
  let list!: HTMLUListElement;
  let pinnedList: HTMLUListElement | undefined;
  // Only the tabs scroll (the address, pinned tabs, New tab and the buttons at the bottom stay).
  onMount(() => scrollWhileDragging(list, "y"));
  keepSelectedInView(() => list, "y", 4);
  // Many pinned tabs scroll in their own few rows.
  keepSelectedInView(() => pinnedList, "y", 2);
  // Hidden: it slides back out once the pointer has left it, unless a menu or the address is still open.
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(leaveTimer));
  let edge: HTMLDivElement | undefined;
  const busy = () =>
    nav.matches(":hover") ||
    !!edge?.matches(":hover") ||
    !!document.querySelector("[data-address-open]") ||
    // A menu of the sidebar's (they're portaled: one next to it, not one of the page's).
    [...document.querySelectorAll(POPOVERS)].some(
      (menu) => menu.getBoundingClientRect().left < nav.getBoundingClientRect().right + 16,
    ) ||
    (nav.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement);
  const leaveSoon = () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      if (!sidebarPeek()) return;
      if (busy() || atBorder) return leaveSoon();
      setSidebarPeek(false);
    }, 260);
  };
  const peek = () => {
    setSidebarPeek(true);
    // From here the pointer may go straight back to the page, without entering the sidebar.
    leaveSoon();
  };
  // Linux and Windows resize a window that isn't maximized from the 5px inside its edges, and the pointer
  // there never reaches the page: only 3px of the edge strip would be left, easily flicked past. Leaving
  // the page through the window's left edge (into that border) brings the sidebar in as well, and it stays
  // while the pointer is there.
  // (Only for a moment: the pointer may have gone on to another screen on the left.)
  let atBorder = false;
  let borderTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(borderTimer));
  createEffect(() => {
    if (!isOverlay()) return;
    const out = (e: MouseEvent) => {
      if (e.relatedTarget !== null || e.clientX < 0 || e.clientX >= EDGE_WIDTH) return;
      if (e.clientY < 0 || e.clientY >= window.innerHeight) return;
      atBorder = true;
      clearTimeout(borderTimer);
      borderTimer = setTimeout(() => (atBorder = false), 1500);
      peek();
    };
    const over = () => (atBorder = false);
    document.addEventListener("mouseout", out);
    document.addEventListener("mouseover", over, true);
    onCleanup(() => {
      atBorder = false;
      document.removeEventListener("mouseout", out);
      document.removeEventListener("mouseover", over, true);
    });
  });
  return (
    <>
      <Show when={isOverlay()}>
        {/* The window's left edge: the pointer there brings the sidebar in, like Zen's compact mode. */}
        <div
          {...stylex.attrs(styles.edge)}
          ref={edge}
          // Any movement in it, not only entering it: the pointer may already be there when the sidebar
          // goes (a menu closed, the pointer left the window and came back at the edge).
          onPointerEnter={peek}
          onPointerMove={() => !sidebarPeek() && peek()}
          data-sidebar-edge
        />
      </Show>
      <nav
        ref={nav}
        {...stylex.attrs(
          styles.root,
          isOverlay() && styles.rootOverlay,
          isAway() && styles.rootAway,
          privateWindow() && styles.rootPrivate,
        )}
        style={{ width: `${sidebarWidth()}px`, "--sidebar-width": `${sidebarWidth()}px` }}
        data-sidebar={isSidebarHidden() ? (sidebarPeek() ? "peek" : "hidden") : "shown"}
        data-private-window={isPrivate ? "" : undefined}
        // The tab on screen's chrome: its navigation, address, agent and ⋯ menu are all in here.
        data-tab-chrome={selectedId() ?? ""}
        aria-hidden={isAway() && !addressOpen() ? true : undefined}
        inert={isAway() && !addressOpen() ? true : undefined}
        onMouseEnter={() => clearTimeout(leaveTimer)}
        onMouseLeave={() => isOverlay() && leaveSoon()}
        onContextMenu={(e) => {
          const at = tabAreaMenuAt(e);
          if (at) setAreaMenu(at);
        }}
        // Files, links and text dropped on the tab bar open in new tabs (not on fields: they take the text).
        onDragOver={(e) => {
          if (isForeignTabDrag(e.dataTransfer)) {
            e.preventDefault();
            e.dataTransfer!.dropEffect = "move";
            return;
          }
          if (isField(e.target) || !hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer!.dropEffect = "copy";
          setDropTarget({ kind: "list" });
        }}
        onDrop={(e) => {
          // A tab dragged here from another window (dropped below the tabs): it comes here, last.
          const tab = tabFromElsewhere(e.dataTransfer);
          if (tab) {
            e.preventDefault();
            return void takeTab(tab);
          }
          if (isField(e.target) || !hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          setDropTarget(null);
          openDropped(e.dataTransfer!);
        }}
      >
        {/* The tab on screen: its navigation and address, its tools in the ⋯ menu (components/TopBar.tsx). */}
        <div {...stylex.attrs(styles.chrome)} data-sidebar-chrome>
          <NavRow />
          <AddressBar />
        </div>
        <Show when={tiles().length}>
          <ul ref={pinnedList} {...stylex.attrs(styles.tiles)} data-pinned-tiles>
            <For each={tiles()}>{(app) => <Item app={app} tile />}</For>
          </ul>
        </Show>
        <ul ref={list} {...stylex.attrs(styles.list, styles.listScroll)} data-tab-list>
          <For each={entries()}>
            {(key) => (
              <Show
                when={key.startsWith("split:")}
                fallback={<Show when={appById(key)}>{(app) => <Item app={app()} />}</Show>}
              >
                <SplitGroup splitId={key.slice(6)} />
              </Show>
            )}
          </For>
          <Show when={dropTarget()?.kind === "list"}>
            <li {...stylex.attrs(styles.dropSlot)} data-drop-slot>
              <Icon name="plus" size={15} />
              Open in a new tab
            </li>
          </Show>
        </ul>
        <Button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setNewMenu({ x: r.left, y: r.bottom + 4 });
          }}
          xstyle={styles.newButton}
          aria-haspopup="menu"
          data-new-tab
        >
          <Icon name="plus" size={15} />
          New tab
        </Button>
        <Show when={newMenu()}>{(position) => <NewTabMenu position={position()} onClose={() => setNewMenu()} />}</Show>
        <Show when={areaMenu()}>
          {(position) => <ContextMenu items={tabAreaMenuItems()} position={position()} onClose={() => setAreaMenu()} />}
        </Show>
        <TabHoverCard area={() => nav} placement="beside" />
        {/* At the very bottom, like Zen's: the ⋯ menu, the workspaces in the middle, the agent. */}
        <div {...stylex.attrs(styles.footer)} data-sidebar-footer>
          <MoreMenu />
          <Show when={!isPrivate} fallback={<span {...stylex.attrs(styles.footerSpacer)} />}>
            <WorkspaceBar />
          </Show>
          <Show when={!isPrivate} fallback={<SettingsLink />}>
            <span {...stylex.attrs(styles.footerEnd)} data-footer-end>
              <AgentButton />
            </span>
          </Show>
        </div>
      </nav>
      <Show when={!isSidebarHidden()}>
        <Resizer />
      </Show>
    </>
  );
}

/**
 * The sidebar's right edge: drag to resize, double-click for the default
 * width, arrow keys when focused. Dragging it far past the minimum hides it.
 */
function Resizer() {
  const [dragging, setDragging] = createSignal(false);
  let stop = () => {};
  onCleanup(() => stop());

  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth();
    let raw = startWidth;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      raw = startWidth + ev.clientX - startX;
      setSidebarWidth(raw, false);
    };
    stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setDragging(false);
      stop = () => {};
      if (raw < SIDEBAR_MIN - 60) {
        setSidebarWidth(startWidth);
        setSidebarHidden(true);
      } else setSidebarWidth(raw);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div {...stylex.attrs(styles.resizer)}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={sidebarWidth()}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={start}
        onDblClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16;
          if (e.key === "ArrowLeft") setSidebarWidth(sidebarWidth() - step);
          else if (e.key === "ArrowRight") setSidebarWidth(sidebarWidth() + step);
          else return;
          e.preventDefault();
        }}
        {...stylex.attrs(styles.handle, dragging() && styles.handleActive)}
        data-sidebar-resizer
      />
      {/* Over everything (web pages too), so they don't swallow the drag. */}
      <Show when={dragging()}>
        <div {...stylex.attrs(styles.dragShield)} />
      </Show>
    </div>
  );
}

/** Creates a workspace, switches to it and opens its editor, for its name and icon. */
async function newWorkspace() {
  const workspace = await createWorkspace("New workspace");
  editWorkspace({ id: workspace.id, focus: "name", isNew: true });
}

const WORKSPACE_DRAG_TYPE = "application/x-rune-workspace";

/**
 * The workspaces as icons at the bottom of the sidebar: click one to switch,
 * drag to reorder, drop a tab on one to move it there, right-click for its menu.
 */
export function WorkspaceBar(props: { inline?: boolean }) {
  const [dragged, setDragged] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  const reorderTo = (id: string, target: string) => {
    const ids = workspaces.map((w) => w.id).filter((x) => x !== id);
    const at = ids.indexOf(target);
    const from = workspaces.findIndex((w) => w.id === id);
    const to = workspaces.findIndex((w) => w.id === target);
    ids.splice(from < to ? at + 1 : at, 0, id);
    void reorderWorkspaces(ids);
  };
  return (
    <div
      {...stylex.attrs(styles.workspaceBar, props.inline && styles.workspaceBarInline)}
      role="tablist"
      aria-label="Workspaces"
      data-workspace-bar
      data-current-workspace={currentWorkspace()?.name}
    >
      <For each={workspaces}>
        {(w, i) => {
          const [menu, setMenu] = createSignal<MenuPosition>();
          const current = () => currentWorkspace()?.id === w.id;
          const edited = () => workspaceEditing()?.id === w.id;
          const isOver = () => over() === w.id;
          const items = (): (MenuItem | "separator")[] => [
            { label: "Rename", icon: "pencil", onSelect: () => editWorkspace({ id: w.id, focus: "name" }) },
            { label: "Change icon…", icon: "shapes", onSelect: () => editWorkspace({ id: w.id, focus: "icon" }) },
            {
              label: "Move left",
              icon: "arrow-left",
              disabled: i() === 0,
              onSelect: () => reorderTo(w.id, workspaces[i() - 1]!.id),
            },
            {
              label: "Move right",
              icon: "arrow-right",
              disabled: i() === workspaces.length - 1,
              onSelect: () => reorderTo(w.id, workspaces[i() + 1]!.id),
            },
            {
              label: "Workspace settings",
              icon: "settings-2",
              onSelect: () => void showWorkspace(w.id).then(openWorkspaceSettings),
            },
            "separator",
            {
              label: "Delete workspace",
              icon: "trash",
              danger: true,
              disabled: workspaces.length <= 1,
              onSelect: async () => {
                const tabs = apps.filter((a) => a.workspaceId === w.id).length;
                const ok = await confirmDialog(
                  `Delete the workspace ${w.name}${tabs ? ` with its ${tabs} tab${tabs === 1 ? "" : "s"}` : ""}? Its permissions and web logins go too.`,
                  { confirmLabel: "Delete", danger: true },
                );
                if (ok) await deleteWorkspace(w.id);
              },
            },
          ];
          return (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={current()}
                title={withKeys(w.name, `workspace.select-${i() + 1}`)}
                onClick={() => void showWorkspace(w.id)}
                onDblClick={() => editWorkspace({ id: w.id, focus: "name" })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY });
                }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer!.setData(WORKSPACE_DRAG_TYPE, w.id);
                  e.dataTransfer!.effectAllowed = "move";
                  setDragged(w.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  // A workspace being reordered, or a tab to move here.
                  if (!dragged() && !draggedTab()) return;
                  e.preventDefault();
                  e.dataTransfer!.dropEffect = "move";
                  setOver(w.id);
                }}
                onDragLeave={() => over() === w.id && setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const moving = dragged();
                  const tab = draggedTab();
                  setDragged(null);
                  if (moving && moving !== w.id) reorderTo(moving, w.id);
                  else if (tab && appById(tab)?.workspaceId !== w.id) {
                    setDraggedTab(null);
                    void moveApp(tab, w.id);
                  }
                }}
                {...stylex.attrs(
                  styles.workspaceIcon,
                  current() && styles.workspaceIconOn,
                  isOver() && styles.workspaceIconOver,
                  edited() && styles.workspaceIconEdited,
                )}
                data-workspace={w.id}
              >
                <WorkspaceBadge workspace={w} bare />
              </button>
              <Show when={menu()}>
                {(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}
              </Show>
            </>
          );
        }}
      </For>
      <button
        type="button"
        title="New workspace"
        onClick={() => void newWorkspace()}
        {...stylex.attrs(styles.workspaceIcon, styles.workspaceAdd)}
        data-new-workspace
      >
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}

/** Opens Settings at the current workspace's section. */
function openWorkspaceSettings() {
  return openSettings("workspace");
}

/** The workspace's icon, or its initial. */
export function WorkspaceBadge(props: { workspace: WorkspaceInfo; bare?: boolean }) {
  const bare = () => !!props.bare;
  return (
    <span {...stylex.attrs(styles.badge, bare() && styles.badgeBare)} aria-hidden="true">
      <Icon
        name={props.workspace.icon}
        size={13}
        fallback={<>{props.workspace.icon ?? props.workspace.name.trim().charAt(0).toUpperCase()}</>}
      />
    </span>
  );
}

/** Settings (and the pages in it: Downloads, History, Snapshots, Schedules, Mods, Activity), at the bottom right of the sidebar. */
export function SettingsLink() {
  const selected = () => isSettingsView(selectedId());
  return (
    <button
      type="button"
      title="Settings"
      aria-label="Settings"
      aria-current={selected() ? "page" : undefined}
      onClick={() => void openSettings()}
      {...stylex.attrs(styles.pageLink, selected() && styles.pageLinkOn)}
      data-page-link="Settings"
    >
      <Icon name="settings" size={17} />
    </button>
  );
}

/** A split view: its tabs in one block, with a handle to drag them all and a menu. */
export function SplitGroup(props: { splitId: string; horizontal?: boolean }) {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const split = () => workspaces.flatMap((w) => w.splits).find((x) => x.id === props.splitId);
  const isRow = () => split()?.direction === "row";
  // In the sidebar's list, which scrolls: at its full height, never squeezed (in the tab bar it shrinks, groupH).
  const vertical = () => !props.horizontal;
  const isDragged = () => draggedSplit() === props.splitId;
  const openMenu = (position: MenuPosition) => setMenu(position);

  const items = (): MenuItem[] => [
    {
      label: isRow() ? "Stack them" : "Side by side",
      icon: isRow() ? "rows-2" : "columns-2",
      onSelect: () => rotateSplit(props.splitId),
    },
    { label: "Equal sizes", icon: "equal", onSelect: () => evenSplit(props.splitId) },
    { label: "Unsplit", icon: "square-split-horizontal", onSelect: () => unsplit(props.splitId) },
  ];

  return (
    <Show when={split()}>
      {(s) => (
        <li
          {...stylex.attrs(
            styles.group,
            props.horizontal && styles.groupH,
            vertical() && styles.fullHeight,
            isDragged() && styles.dragging,
          )}
          data-split-group={props.splitId}
        >
          <div
            {...stylex.attrs(stylex.defaultMarker(), styles.groupHeader, props.horizontal && styles.groupHeaderH)}
            title="Drag to move the split view"
            draggable
            onDragStart={(e) => {
              e.dataTransfer!.setData(TAB_DRAG_TYPE, `split:${props.splitId}`);
              e.dataTransfer!.effectAllowed = "move";
              setDraggedSplit(props.splitId);
            }}
            onDragEnd={() => {
              setDraggedSplit(null);
              setDropAt(null);
            }}
            onClick={() => {
              // Shows the split: on the tab last focused in it, else its first.
              const tabs = s().tabs;
              if (!tabs.includes(selectedId() ?? "")) void selectApp(tabs[0]!);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <Icon name={isRow() ? "columns-2" : "rows-2"} size={13} />
            <Show when={!props.horizontal}>
              <span {...stylex.attrs(styles.groupLabel)}>Split view</span>
            </Show>
            <button
              type="button"
              title="Split view options"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                openMenu({ x: r.left, y: r.bottom + 4 });
              }}
              {...stylex.attrs(styles.more, styles.groupMore)}
              data-split-menu
            >
              <Icon name="ellipsis" size={14} />
            </button>
          </div>
          <ul {...stylex.attrs(styles.list, props.horizontal && styles.listH)}>
            <For each={s().tabs}>
              {(id) => <Show when={appById(id)}>{(app) => <Item app={app()} horizontal={props.horizontal} />}</Show>}
            </For>
          </ul>
          <Show when={menu()}>
            {(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}
          </Show>
        </li>
      )}
    </Show>
  );
}

/** A tab being dragged in from another window (this window's own drags are in draggedTab). */
export function tabFromElsewhere(dt: DataTransfer | null) {
  if (draggedTab() || draggedSplit() || !dt?.types.includes(TAB_DRAG_TYPE)) return null;
  const id = dt.getData(TAB_DRAG_TYPE);
  return id && !id.startsWith("split:") ? id : null;
}
/** While dragging over, the data itself can't be read: only that it's a tab. */
export const isForeignTabDrag = (dt: DataTransfer | null) =>
  !draggedTab() && !draggedSplit() && !!dt?.types.includes(TAB_DRAG_TYPE);

/** Where a dragged tab would land: before or after which tab. */
const [dropAt, setDropAt] = createSignal<{ id: string; side: "before" | "after" } | null>(null);

/**
 * A tab dropped next to a tab of a split view joins it there (or moves within
 * it); next to any other tab it leaves its split. A dragged split view moves
 * with all its tabs.
 */
function dropOn(at: { id: string; side: "before" | "after" }, tabId: string | null, groupId: string | null) {
  const target = splitOf(at.id);
  if (groupId) {
    const group = workspaces.flatMap((w) => w.splits).find((x) => x.id === groupId);
    if (group && target?.id !== groupId) void moveTabs(group.tabs, at.id, at.side);
    return;
  }
  if (!tabId) return;
  if (target) placeInSplit(target.id, tabId, target.tabs.indexOf(at.id) + (at.side === "after" ? 1 : 0));
  else removeFromSplit(tabId);
  void moveTab(tabId, at.id, at.side);
}

/** A tab: a row in the sidebar, a tab in the horizontal tab bar, or a pinned tile in either. */
export function Item(props: { app: AppSummary; tile?: boolean; horizontal?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [iconPicker, setIconPicker] = createSignal<MenuPosition>();
  // The menu is closed by the time its item runs: the icon picker opens where it was.
  let menuAt: MenuPosition = { x: 0, y: 0 };
  createEffect(() => {
    const at = menu();
    if (at) menuAt = at;
  });
  const dropSide = () => (draggedTab() !== props.app.id && dropAt()?.id === props.app.id ? dropAt()!.side : null);
  // The line where a dragged tab would land: above or below it in the sidebar, left or right of it in the tab bar.
  const dropBefore = () => !props.horizontal && dropSide() === "before";
  const dropAfter = () => !props.horizontal && dropSide() === "after";
  const dropLeft = () => !!props.horizontal && dropSide() === "before";
  const dropRight = () => !!props.horizontal && dropSide() === "after";
  const sideOf = (e: DragEvent): "before" | "after" => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = props.horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    return before ? "before" : "after";
  };
  const tileH = () => !!props.tile && !!props.horizontal;
  // A row in the sidebar's list, which scrolls: at its full height, never squeezed (in the tab bar it shrinks, itemH).
  const vertical = () => !props.horizontal;
  const audible = () => isAudible(props.app.id);
  const split = () => splitOf(props.app.id);
  // On screen next to the selected tab, in a split view.
  const beside = () => selectedId() !== props.app.id && visibleTabs().includes(props.app.id);
  // The tab on screen this one could be shown beside.
  const current = () => {
    const id = selectedId();
    return id && id !== props.app.id && appById(id)?.workspaceId === props.app.workspaceId ? appById(id) : undefined;
  };
  const isDragged = () => draggedTab() === props.app.id;
  // A file or link dragged in would open in this tab.
  const dropInto = () => {
    const target = dropTarget();
    return target?.kind === "tab" && target.id === props.app.id;
  };
  const neighbour = (offset: number) => {
    const tabs = workspaceTabs();
    return tabs[tabs.findIndex((t) => t.id === props.app.id) + offset];
  };
  const selected = () => selectedId() === props.app.id;
  /** Icon only: a pinned tile. */
  const hideName = () => !!props.tile;
  // In the tab bar, the close button of a tab that isn't on screen shows over the end of its name (on hover)
  // instead of taking room from it: a narrow tab still shows a readable part of its name.
  const closeOverName = () => !!props.horizontal && !props.tile && !selected();
  const running = () => !!states[props.app.id]?.running;
  const menuOpen = () => menu() !== undefined;
  const highlighted = () => selected() || menuOpen();
  const tileOn = () => !!props.tile && highlighted();
  // Its page isn't open (unloaded for being idle, or not opened yet): it loads when clicked.
  const asleep = () => !isLoaded(props.app.id) && !selected();

  const commit = (value: string) => {
    if (!editing()) return; // Enter already committed; this is the blur that follows
    setEditing(false);
    const name = value.trim();
    if (name && name !== props.app.name) renameApp(props.app.id, name);
  };

  // Renaming needs the sidebar on screen.
  const rename = () => {
    if (isSidebarHidden()) setSidebarPeek(true);
    setEditing(true);
  };

  // The other windows it can move to, fresh each time the menu opens.
  const [windowsToMoveTo, setWindowsToMoveTo] = createSignal<{ id: string; title: string }[]>([]);
  createEffect(on(menu, (open) => open && void otherWindows().then(setWindowsToMoveTo)));
  const menuItems = (): (MenuItem | "separator")[] => [
    { label: "Rename", icon: "pencil", onSelect: rename },
    { label: "Change icon…", icon: "shapes", onSelect: () => setIconPicker(menuAt) },
    { label: "Duplicate", icon: "copy", onSelect: () => duplicateApp(props.app.id) },
    ...(split()
      ? [{ label: "Remove from split view", icon: "square-x", onSelect: () => removeFromSplit(props.app.id) }]
      : current()
        ? [
            {
              label: `Show beside “${current()!.name}”`,
              icon: "columns-2",
              onSelect: () => splitWith(current()!.id, props.app.id, "right"),
            },
          ]
        : []),
    props.app.pinned
      ? { label: "Unpin", icon: "pin-off", onSelect: () => void setTabPinned(props.app.id, false) }
      : {
          label: "Pin (a tile above the tabs, kept loaded)",
          icon: "pin",
          onSelect: () => void setTabPinned(props.app.id, true),
        },
    { label: "Unload", icon: "moon", disabled: !canUnload(props.app.id), onSelect: () => void unloadTab(props.app.id) },
    {
      label: props.horizontal ? "Move left" : "Move up",
      icon: props.horizontal ? "arrow-left" : "arrow-up",
      disabled: !neighbour(-1),
      onSelect: () => void moveTab(props.app.id, neighbour(-1)!.id, "before"),
    },
    {
      label: props.horizontal ? "Move right" : "Move down",
      icon: props.horizontal ? "arrow-right" : "arrow-down",
      disabled: !neighbour(1),
      onSelect: () => void moveTab(props.app.id, neighbour(1)!.id, "after"),
    },
    ...(isPrivate
      ? []
      : workspaces
          .filter((w) => w.id !== props.app.workspaceId)
          .map((w) => ({
            label: `Move to ${w.name}`,
            icon: "folder-input",
            onSelect: () => void moveApp(props.app.id, w.id),
          }))),
    {
      label: "Move to new window",
      icon: "app-window",
      disabled: apps.length < 2,
      onSelect: () => void moveToNewWindow([props.app.id]),
    },
    ...windowsToMoveTo().map((w) => ({
      label: `Move to window “${w.title.length > 40 ? `${w.title.slice(0, 40)}…` : w.title}”`,
      icon: "square-arrow-out-up-right",
      onSelect: () => void moveToWindow([props.app.id], w.id),
    })),
    ...(isPrivate
      ? []
      : [
          {
            label: "New chat",
            icon: "message-square-plus",
            disabled: running() || !states[props.app.id]?.messages.length,
            onSelect: () =>
              void newChat(props.app.id).catch((err) =>
                toast({ message: err instanceof Error ? err.message : String(err), kind: "error" }),
              ),
          },
        ]),
    ...(audible() || isMuted(props.app.id)
      ? [
          {
            label: isMuted(props.app.id) ? "Unmute site" : "Mute site",
            icon: isMuted(props.app.id) ? "volume-2" : "volume-x",
            onSelect: () => toggleMuted(props.app.id),
          },
        ]
      : []),
    "separator",
    { label: "Close tab", icon: "x", onSelect: () => void close() },
  ];
  const close = () =>
    closeTab(props.app.id).catch((err) =>
      toast({ message: err instanceof Error ? err.message : String(err), kind: "error" }),
    );

  return (
    <li
      {...stylex.attrs(
        stylex.defaultMarker(),
        styles.item,
        props.horizontal && styles.itemH,
        vertical() && styles.fullHeight,
        props.tile && styles.tile,
        tileH() && styles.tileH,
        highlighted() && styles.selected,
        tileOn() && styles.tileOn,
        beside() && styles.beside,
        isDragged() && styles.dragging,
        dropBefore() && styles.dropBefore,
        dropAfter() && styles.dropAfter,
        dropLeft() && styles.dropLeft,
        dropRight() && styles.dropRight,
        dropInto() && styles.dropInto,
      )}
      // No tooltip: the pointer resting on it shows its card, with its name and address (components/TabHoverCard.tsx).
      aria-label={props.tile ? props.app.name : undefined}
      onClick={() => selectApp(props.app.id)}
      onAuxClick={(e) => {
        // Middle click closes it, like in a browser.
        if (e.button !== 1) return;
        e.preventDefault();
        void close();
      }}
      onDblClick={rename}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      aria-current={selected() ? "page" : undefined}
      data-app-id={props.app.id}
      data-loaded={isLoaded(props.app.id) ? "" : undefined}
      data-pinned={props.app.pinned ? "" : undefined}
      draggable={!editing()}
      onDragStart={(e) => {
        e.dataTransfer!.setData(TAB_DRAG_TYPE, props.app.id);
        e.dataTransfer!.effectAllowed = "move";
        setDraggedTab(props.app.id);
      }}
      onDragEnd={(e) => {
        setDraggedTab(null);
        setDropAt(null);
        // Let go outside the window (and not on another window, which takes it itself): it tears off into a new one.
        tearOff(props.app.id, e);
      }}
      onDragOver={(e) => {
        if (isForeignTabDrag(e.dataTransfer)) {
          // A tab from another window: it would land here.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer!.dropEffect = "move";
          setDropAt({ id: props.app.id, side: sideOf(e) });
          return;
        }
        if (!draggedTab() && !draggedSplit()) {
          // A file, link or text from outside: the tab opens it.
          if (!hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer!.dropEffect = "copy";
          setDropTarget({ kind: "tab", id: props.app.id });
          return;
        }
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        setDropAt({ id: props.app.id, side: sideOf(e) });
      }}
      onDragLeave={(e) => {
        if (dropAt()?.id === props.app.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={(e) => {
        const id = draggedTab();
        const group = draggedSplit();
        const foreign = tabFromElsewhere(e.dataTransfer);
        if (foreign) {
          e.preventDefault();
          e.stopPropagation();
          const at = dropAt();
          setDropAt(null);
          return void takeTab(foreign, at ?? undefined);
        }
        if (!id && !group) {
          if (!hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          const target = dropTarget();
          setDropTarget(null);
          openDropped(e.dataTransfer!, target?.kind === "tab" ? { tabId: target.id } : {});
          return;
        }
        const at = dropAt();
        setDraggedTab(null);
        setDraggedSplit(null);
        setDropAt(null);
        if (!at) return;
        e.preventDefault();
        dropOn(at, id, group);
      }}
    >
      <span {...stylex.attrs(styles.tabIcon, asleep() && styles.asleep)}>
        <TabIcon tab={props.app} size={props.tile ? 20 : undefined} />
      </span>
      <Show
        when={editing()}
        fallback={<span {...stylex.attrs(styles.name, hideName() && styles.hiddenText)}>{props.app.name}</span>}
      >
        <input
          ref={(el) => queueMicrotask(() => el.select())}
          value={props.app.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          {...stylex.attrs(styles.rename)}
        />
      </Show>

      {/* Playing sound (or muted): a click mutes it or turns its sound back on, like Chrome's. */}
      <Show when={audible() || isMuted(props.app.id)}>
        <button
          type="button"
          title={isMuted(props.app.id) ? "Unmute site" : "Mute site"}
          aria-label={isMuted(props.app.id) ? `Unmute ${props.app.name}` : `Mute ${props.app.name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleMuted(props.app.id);
          }}
          {...stylex.attrs(styles.audio, props.tile && styles.audioTile)}
          data-tab-audio={isMuted(props.app.id) ? "muted" : "playing"}
        >
          <Icon name={isMuted(props.app.id) ? "volume-x" : "volume-2"} size={13} />
        </button>
      </Show>
      <Show when={running()}>
        <span
          {...stylex.attrs(styles.dot, fullAccess() && styles.dotFull)}
          title={fullAccess() ? "Agent is working with full access (it doesn't ask)" : "Agent is working"}
          data-running-full={fullAccess() ? "" : undefined}
        />
      </Show>
      <Show when={!hideName()}>
        <button
          type="button"
          title={withKeys("Close tab", "tab.close")}
          aria-label={`Close ${props.app.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void close();
          }}
          {...stylex.attrs(styles.more, selected() && styles.moreOpen, closeOverName() && styles.moreOverName)}
          data-close-tab
        >
          <Icon name="x" size={14} />
        </button>
      </Show>
      <Show when={menu()}>
        {(position) => <ContextMenu items={menuItems()} position={position()} onClose={() => setMenu()} />}
      </Show>
      <Show when={iconPicker()}>
        {(position) => <IconPicker tab={props.app} position={position()} onClose={() => setIconPicker()} />}
      </Show>
    </li>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.3 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.3 },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    flexShrink: 0,
    padding: space.md,
    // No border: the page's inset (App.tsx) sets it apart, like Zen Browser.
    backgroundColor: colors.sidebar,
    // Only the tab list scrolls (listScroll; its scrollbar in global.css), never the whole sidebar.
    overflow: "hidden",
  },
  footerSpacer: { flex: 1 },
  // A private window's sidebar is tinted, so it's never mistaken for a normal one.
  // Hidden: it floats over the page from the left, as a card, while it's shown.
  rootOverlay: {
    position: "fixed",
    // Over the page, under every menu, popover and dialog (1000 and up): the ones it opens included.
    zIndex: 900,
    // Flush with the window's edge, like Zen's: it slides in from there, rounded only where it meets the page.
    top: 0,
    bottom: 0,
    left: 0,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    boxShadow: `0 0 0 1px color-mix(in oklab, ${colors.text} 13%, transparent), 0 24px 64px -12px rgb(0 0 0 / 0.32), 0 6px 18px -6px rgb(0 0 0 / 0.14)`,
    transitionProperty: "left, box-shadow",
    transitionDuration: "200ms",
    transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
  // Moved by `left`, not a transform: the address pops out of it with position: fixed (Ctrl+L while it's hidden).
  rootAway: { left: "calc(-1 * var(--sidebar-width) - 32px)", boxShadow: "none" },
  // The strip at the window's left edge that brings a hidden sidebar in (over web pages too).
  edge: { position: "fixed", zIndex: 899, top: 0, bottom: 0, left: 0, width: EDGE_WIDTH },
  footerEnd: { display: "flex", justifyContent: "flex-end", flexShrink: 0, minWidth: 32 },
  rootPrivate: { backgroundImage: "linear-gradient(rgb(76 29 149 / 0.12), rgb(76 29 149 / 0.12))" },
  collapse: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 34,
    height: 34,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  resizer: { position: "relative", width: 0, flexShrink: 0, zIndex: 5 },
  handle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -3,
    width: 6,
    cursor: "col-resize",
    backgroundColor: { default: "transparent", ":hover": colors.accent, ":focus-visible": colors.accent },
    opacity: { default: 1, ":hover": 0.5, ":focus-visible": 0.5 },
    outline: "none",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  handleActive: { backgroundColor: colors.accent, opacity: 0.5 },
  dragShield: { position: "fixed", inset: 0, zIndex: 1000, cursor: "col-resize" },
  hiddenText: { display: "none" },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 3,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 20,
    paddingInline: 6,
    color: colors.muted,
    fontSize: font.xs,
    cursor: "grab",
    userSelect: "none",
  },
  groupLabel: { flex: 1, fontWeight: 600, letterSpacing: "0.02em" },
  // Horizontal tabs: its tabs in a row, after a handle with its icon and menu.
  groupH: { flexDirection: "row", alignItems: "center", flex: "0 1 auto", minWidth: 0, padding: 2 },
  groupHeaderH: { alignSelf: "stretch", gap: 2, height: "auto", paddingInline: 4 },
  listH: { flexDirection: "row", minWidth: 0, flex: "0 1 auto" },
  groupMore: { width: 18, height: 18 },
  dragging: { opacity: 0.45 },
  // In the split view on screen, next to the selected tab.
  beside: { backgroundColor: { default: colors.surfaceHover, ":hover": colors.surfaceHover } },
  // A line where the dragged tab would land (the list has a 2px gap).
  dropBefore: { boxShadow: `0 -2px 0 0 ${colors.accent}` },
  dropAfter: { boxShadow: `0 2px 0 0 ${colors.accent}` },
  dropLeft: { boxShadow: `-2px 0 0 0 ${colors.accent}` },
  dropRight: { boxShadow: `2px 0 0 0 ${colors.accent}` },
  // A file or link dragged in opens in this tab.
  dropInto: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    boxShadow: `inset 0 0 0 1.5px ${colors.accent}`,
  },
  // Where a file or link dragged in opens in a new tab: a slot at the end of the list.
  dropSlot: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.sm,
    height: 34,
    paddingInline: 10,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: font.sm,
    fontWeight: 500,
    pointerEvents: "none",
  },
  dotFull: { backgroundColor: colors.danger },
  badge: {
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    flexShrink: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: font.xs,
    fontWeight: 700,
  },
  // In the footer: just the glyph, the same in every theme (its chip shows hover and the active mark).
  badgeBare: { backgroundColor: "transparent", fontSize: font.sm },
  newButton: {
    justifyContent: "flex-start",
    width: "100%",
    flexShrink: 0,
    height: 34,
    paddingInline: 10,
    borderColor: "transparent",
    borderRadius: 8,
    backgroundColor: { default: "transparent", ":hover": `color-mix(in oklab, ${colors.text} 6%, transparent)` },
    boxShadow: "none",
    color: colors.muted,
    fontWeight: 400,
  },
  chrome: { display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 },
  tiles: {
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))",
    gap: 6,
    flexShrink: 0,
    // Many of them: a few rows, then they scroll themselves, leaving the tabs their room. Padded (and pulled
    // back out by as much) for the ring of the one on screen.
    maxHeight: "min(30vh, 200px)",
    overflowY: "auto",
    padding: 2,
    marginTop: -2,
    marginInline: -2,
    marginBottom: 2,
  },
  // Pinned tabs: tiles in the address pill's tint, the one on screen lifted like a selected tab.
  tile: {
    position: "relative",
    justifyContent: "center",
    height: 42,
    paddingInline: 0,
    borderRadius: 10,
    backgroundColor: {
      // Lighter than the address, which stays the anchor of the top.
      default: `color-mix(in oklab, ${colors.text} 4.5%, transparent)`,
      ":hover": `color-mix(in oklab, ${colors.text} 9%, transparent)`,
    },
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  // The pinned tab on screen: lifted like a selected tab, its ring a notch stronger so it holds in dark.
  tileOn: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px color-mix(in oklab, ${colors.text} 16%, transparent), 0 1px 2px rgb(0 0 0 / 0.06)`,
  },
  chevron: { marginLeft: "auto", opacity: 0.6 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 },
  // The sidebar's tabs: as tall as they are, then scrolling in what's left between the pinned tabs and New tab.
  // Padded (and pulled back out by as much) so the selected tab's ring and the drop lines aren't clipped.
  listScroll: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: "auto",
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: 2,
    margin: -2,
  },
  // The sidebar's tabs, split views and drop slot keep their height: past the room there is, the list scrolls.
  // (Only ever applied without itemH/groupH, whose flex shorthands it would win over: longhands go first.)
  fullHeight: { flexShrink: 0 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 34,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    fontSize: font.sm,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  // A tab in the horizontal tab bar: as wide as there's room for, up to Chrome's width; past the
  // narrowest (still room for a few letters of its name next to its icon and close button), the bar scrolls
  // (components/TabStrip.tsx).
  // (A width, not a flex basis: the bar's own width comes from its tabs' widths.)
  itemH: {
    position: "relative",
    flex: "0 1 auto",
    width: 220,
    minWidth: 112,
    height: 30,
    gap: 6,
    paddingInline: 8,
    overflow: "hidden",
  },
  // A pinned tab there: an icon, the tabs' height.
  // (Its audio badge sits over its corner.)
  tileH: { flex: "none", minWidth: 0, width: 38, height: 30, borderRadius: 8, overflow: "visible" },
  audio: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  // On a pinned tile: a badge in its corner.
  audioTile: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: radius.full,
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px ${colors.border}`,
  },
  selected: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px ${colors.border}`,
    fontWeight: 500,
  },
  icon: { width: 18, textAlign: "center", flexShrink: 0, color: colors.muted },
  tabIcon: { display: "flex", flexShrink: 0, transitionProperty: "opacity", transitionDuration: "150ms" },
  // Not loaded: dimmed, like a sleeping tab.
  asleep: { opacity: 0.45, filter: "grayscale(0.6)" },
  pin: { flexShrink: 0, color: colors.muted, transform: "rotate(45deg)" },
  // Collapse | workspaces (centered) | Settings; a column when the sidebar is collapsed to icons.
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    marginTop: "auto",
    marginInline: -4,
    marginBottom: -4,
  },
  pageLink: {
    display: "grid",
    placeItems: "center",
    flexShrink: 1,
    minWidth: 28,
    width: 34,
    height: 34,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: -2,
  },
  pageLinkOn: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    color: colors.text,
    boxShadow: `0 0 0 1px ${colors.border}`,
  },
  name: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rename: {
    flex: 1,
    minWidth: 0,
    height: 24,
    paddingInline: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    outline: "none",
    fontSize: font.sm,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    flexShrink: 0,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  more: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, ":focus-visible": 1 },
  },
  moreOpen: { opacity: 1 },
  moreOverName: {
    position: "absolute",
    top: "50%",
    right: 4,
    marginTop: -11,
    backgroundColor: { default: colors.surfaceHover, ":hover": colors.surfaceHover },
  },
  workspaceBar: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
    flex: 1,
    minWidth: 0,
  },
  // In the toolbar under horizontal tabs: as wide as its icons, in one row.
  // In the bar with horizontal tabs: on a narrow window its icons give way after the address does (TopBar.tsx:
  // its big shrink factor) and before the agent and ⋯ buttons do, keeping one whole. Clipped with room for the ring
  // a tab dragged over an icon gets.
  workspaceBarInline: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 30,
    flexWrap: "nowrap",
    // Clipped at its end, not both sides.
    justifyContent: "flex-start",
    overflow: "clip",
    overflowClipMargin: 3,
  },
  workspaceIcon: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: 8,
    // A faint surface at rest, so each reads as a switch, not a letter.
    backgroundColor: {
      default: `color-mix(in oklab, ${colors.text} 4%, transparent)`,
      ":hover": `color-mix(in oklab, ${colors.text} 8%, transparent)`,
    },
    color: colors.muted,
    cursor: "pointer",
    opacity: { default: 0.55, ":hover": 1 },
    transitionProperty: "opacity, background-color",
    transitionDuration: "120ms",
  },
  // The workspace on screen: at full strength (no card: the footer stays quieter than the tabs).
  workspaceIconOn: {
    opacity: 1,
    "::after": {
      content: '""',
      position: "absolute",
      bottom: 0,
      left: "50%",
      width: 10,
      height: 2,
      marginLeft: -5,
      borderRadius: 1,
      backgroundColor: colors.accent,
    },
  },
  workspaceIconOver: { boxShadow: `0 0 0 2px ${colors.accent}`, opacity: 1 },
  // Its editor is open.
  workspaceIconEdited: { boxShadow: `0 0 0 2px ${colors.accent}`, opacity: 1 },
  workspaceAdd: {
    backgroundColor: { default: "transparent", ":hover": `color-mix(in oklab, ${colors.text} 8%, transparent)` },
    opacity: { default: 0.6, ":hover": 1 },
  },
});
