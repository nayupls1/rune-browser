import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { AppSummary, WorkspaceInfo } from "../../shared/api";
import {
  appById,
  newChat,
  createWorkspace,
  currentWorkspace,
  deleteApp,
  duplicateApp,
  isLoaded,
  moveApp,
  moveTab,
  moveTabs,
  newApp,
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
  reopenApp,
} from "../lib/store";
import {
  draggedSplit,
  draggedTab,
  isSidebarCollapsed,
  setDraggedSplit,
  setDraggedTab,
  setSidebarCollapsed,
  TAB_DRAG_TYPE,
  setSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  sidebarWidth,
  toggleSidebar,
} from "../lib/layout";
import { canUnload, unloadTab } from "../lib/unload";
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
import { AddressBar, NavRow, TabTools } from "./TopBar";
import { api } from "../lib/api";
import { confirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { IconPicker, TabIcon } from "./TabIcon";
import { toast } from "./Toast";
import { Button } from "./ui";
import { withKeys } from "../lib/shortcuts";

/**
 * What the list shows, in the tabs' order: tab ids, and "split:<id>" for a
 * split view, which takes the place of its first tab and lists its tabs in it.
 */
const entries = () => {
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

/** Pinned tabs show as tiles above the list (not in a split view, not in the collapsed sidebar). */
const isTile = (tab: AppSummary) => tab.pinned && !splitOf(tab.id) && !isSidebarCollapsed();
const tiles = () => workspaceTabs().filter(isTile);

/** Text fields take dropped text themselves. */
const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("input, textarea, [contenteditable]");

/** Width of the collapsed sidebar: icons only. */
const RAIL_WIDTH = 52;

export function Sidebar() {
  const [newMenu, setNewMenu] = createSignal<MenuPosition>();
  const [library, setLibrary] = createSignal<AppSummary[]>([]);
  const newItems = (): (MenuItem | "separator")[] => [
    { label: "New web tab", icon: "globe", onSelect: () => newWebTab() },
    { label: "New app", icon: "sparkles", onSelect: () => newApp() },
    ...(library().length
      ? [
          "separator" as const,
          ...library()
            .slice(0, 12)
            .map((app): MenuItem => ({
              label: `Open ${app.name}`,
              icon: "archive-restore",
              onSelect: () => void reopenApp(app.id),
            })),
        ]
      : []),
  ];
  // Closed apps (the library), fresh each time the menu opens.
  createEffect(on(newMenu, (open) => open && void api.library().then(setLibrary, () => setLibrary([]))));
  const compact = isSidebarCollapsed;
  return (
    <>
      <nav
        {...stylex.attrs(styles.root, compact() && styles.rootCompact)}
        style={{ width: `${compact() ? RAIL_WIDTH : sidebarWidth()}px` }}
        data-sidebar={compact() ? "collapsed" : "expanded"}
        // Files, links and text dropped on the tab bar open in new tabs (not on fields: they take the text).
        onDragOver={(e) => {
          if (isField(e.target) || !hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer!.dropEffect = "copy";
          setDropTarget({ kind: "list" });
        }}
        onDrop={(e) => {
          if (isField(e.target) || !hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          setDropTarget(null);
          openDropped(e.dataTransfer!);
        }}
      >
        {/* The tab on screen: its navigation, address and tools (components/TopBar.tsx). */}
        <div {...stylex.attrs(styles.chrome)} data-tab-chrome={selectedId() ?? ""}>
          <NavRow compact={compact()} />
          <Show when={!compact()}>
            <AddressBar />
            <TabTools />
          </Show>
        </div>
        <Show when={tiles().length}>
          <ul {...stylex.attrs(styles.tiles)} data-pinned-tiles>
            <For each={tiles()}>{(app) => <Item app={app} tile />}</For>
          </ul>
        </Show>
        <ul {...stylex.attrs(styles.list)}>
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
            <li {...stylex.attrs(styles.dropSlot, compact() && styles.dropSlotCompact)} data-drop-slot>
              <Icon name="plus" size={15} />
              <Show when={!compact()}>Open in a new tab</Show>
            </li>
          </Show>
        </ul>
        <Button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setNewMenu({ x: r.left, y: r.bottom + 4 });
          }}
          xstyle={compact() ? styles.newButtonCompact : styles.newButton}
          title={compact() ? "New tab" : undefined}
          aria-haspopup="menu"
          data-new-tab
        >
          <Icon name="plus" size={15} />
          <Show when={!compact()}>New tab</Show>
        </Button>
        <Show when={newMenu()}>
          {(position) => <ContextMenu items={newItems()} position={position()} onClose={() => setNewMenu()} />}
        </Show>
        <WorkspaceName />
        {/* At the very bottom: collapse, the workspaces in the middle, Settings (a column when collapsed). */}
        <div {...stylex.attrs(styles.footer, compact() && styles.footerCompact)} data-sidebar-footer>
          <Show when={!compact()}>
            <CollapseButton />
          </Show>
          <WorkspaceBar />
          <SettingsLink />
          <Show when={compact()}>
            <CollapseButton />
          </Show>
        </div>
      </nav>
      <Show when={!compact()}>
        <Resizer />
      </Show>
    </>
  );
}

/**
 * The sidebar's right edge: drag to resize, double-click for the default
 * width, arrow keys when focused. Dragging it far past the minimum collapses it.
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
        setSidebarCollapsed(true);
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
      {/* Over everything (web pages and previews too), so they don't swallow the drag. */}
      <Show when={dragging()}>
        <div {...stylex.attrs(styles.dragShield)} />
      </Show>
    </div>
  );
}

/** Where a workspace's name is typed: right after "+" made it, or "Rename" in its menu. */
function WorkspaceName() {
  const [naming, setNaming] = createSignal(false);
  createEffect(on(namingRequest, (n) => n && setNaming(true), { defer: true }));
  const commit = (value: string) => {
    if (!naming()) return;
    setNaming(false);
    const name = value.trim();
    const workspace = currentWorkspace();
    if (workspace && name && name !== workspace.name) void updateWorkspace(workspace.id, { name });
  };
  return (
    <Show when={naming()}>
      <div {...stylex.attrs(styles.naming)}>
        <Show when={currentWorkspace()}>{(w) => <WorkspaceBadge workspace={w()} />}</Show>
        <input
          ref={(el) => queueMicrotask(() => el.select())}
          value={currentWorkspace()?.name ?? ""}
          aria-label="Workspace name"
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setNaming(false);
          }}
          {...stylex.attrs(styles.rename, styles.workspaceRename)}
          data-workspace-name
        />
      </div>
    </Show>
  );
}

const [namingRequest, setNamingRequest] = createSignal(0);
/** Creates a workspace, switches to it and lets the user name it. */
async function newWorkspace() {
  await createWorkspace("New workspace");
  setSidebarCollapsed(false);
  setNamingRequest((n) => n + 1);
}

const WORKSPACE_DRAG_TYPE = "application/x-rune-workspace";

/**
 * The workspaces as icons at the bottom of the sidebar: click one to switch,
 * drag to reorder, drop a tab on one to move it there, right-click for its menu.
 */
function WorkspaceBar() {
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
      {...stylex.attrs(styles.workspaceBar, isSidebarCollapsed() && styles.workspaceBarCompact)}
      role="tablist"
      aria-label="Workspaces"
      data-workspace-bar
      data-current-workspace={currentWorkspace()?.name}
    >
      <For each={workspaces}>
        {(w, i) => {
          const [menu, setMenu] = createSignal<MenuPosition>();
          const [iconPicker, setIconPicker] = createSignal<MenuPosition>();
          const current = () => currentWorkspace()?.id === w.id;
          const isOver = () => over() === w.id;
          const items = (): (MenuItem | "separator")[] => [
            {
              label: "Rename",
              icon: "pencil",
              onSelect: () => void showWorkspace(w.id).then(() => setNamingRequest((n) => n + 1)),
            },
            { label: "Change icon…", icon: "shapes", onSelect: () => setIconPicker(menu() ?? { x: 0, y: 0 }) },
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
                  `Delete the workspace ${w.name}${tabs ? ` with its ${tabs} tab${tabs === 1 ? "" : "s"} and their data` : ""}? Its secrets, permissions and web logins go too.`,
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
                )}
                data-workspace={w.id}
              >
                <WorkspaceBadge workspace={w} />
              </button>
              <Show when={menu()}>
                {(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}
              </Show>
              <Show when={iconPicker()}>
                {(position) => <IconPicker workspace={w} position={position()} onClose={() => setIconPicker()} />}
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

function CollapseButton() {
  return (
    <button
      type="button"
      title={withKeys(isSidebarCollapsed() ? "Expand the sidebar" : "Collapse the sidebar", "sidebar.toggle")}
      aria-label={isSidebarCollapsed() ? "Expand the sidebar" : "Collapse the sidebar"}
      aria-expanded={!isSidebarCollapsed()}
      onClick={toggleSidebar}
      {...stylex.attrs(styles.collapse)}
      data-sidebar-toggle
    >
      <Icon name={isSidebarCollapsed() ? "panel-left-open" : "panel-left-close"} size={16} />
    </button>
  );
}

/** Opens Settings at the current workspace's section. */
function openWorkspaceSettings() {
  return openSettings("workspace");
}

/** The workspace's icon, or its initial. */
export function WorkspaceBadge(props: { workspace: WorkspaceInfo }) {
  return (
    <span {...stylex.attrs(styles.badge)} aria-hidden="true">
      <Icon
        name={props.workspace.icon}
        size={13}
        fallback={<>{props.workspace.icon ?? props.workspace.name.trim().charAt(0).toUpperCase()}</>}
      />
    </span>
  );
}

/** Settings (and the pages in it: History, Schedules, Mods, Activity), at the bottom right of the sidebar. */
function SettingsLink() {
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
function SplitGroup(props: { splitId: string }) {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const split = () => workspaces.flatMap((w) => w.splits).find((x) => x.id === props.splitId);
  const isRow = () => split()?.direction === "row";
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
        <li {...stylex.attrs(styles.group, isDragged() && styles.dragging)} data-split-group={props.splitId}>
          <div
            {...stylex.attrs(
              stylex.defaultMarker(),
              styles.groupHeader,
              isSidebarCollapsed() && styles.groupHeaderCompact,
            )}
            title={isSidebarCollapsed() ? "Split view" : "Drag to move the split view"}
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
            <Show when={!isSidebarCollapsed()}>
              <span {...stylex.attrs(styles.groupLabel)}>Split view</span>
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
            </Show>
          </div>
          <ul {...stylex.attrs(styles.list)}>
            <For each={s().tabs}>{(id) => <Show when={appById(id)}>{(app) => <Item app={app()} />}</Show>}</For>
          </ul>
          <Show when={menu()}>
            {(position) => <ContextMenu items={items()} position={position()} onClose={() => setMenu()} />}
          </Show>
        </li>
      )}
    </Show>
  );
}

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

function Item(props: { app: AppSummary; tile?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [iconPicker, setIconPicker] = createSignal<MenuPosition>();
  const dropBefore = () =>
    draggedTab() !== props.app.id && dropAt()?.id === props.app.id && dropAt()?.side === "before";
  const dropAfter = () => draggedTab() !== props.app.id && dropAt()?.id === props.app.id && dropAt()?.side === "after";
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
  /** Icon only: the collapsed sidebar, or a pinned tile. */
  const hideName = () => isSidebarCollapsed() || !!props.tile;
  const running = () => !!states[props.app.id]?.running;
  const menuOpen = () => menu() !== undefined;
  const highlighted = () => selected() || menuOpen();
  // Its page isn't open (unloaded for being idle, or not opened yet): it loads when clicked.
  const asleep = () => !isLoaded(props.app.id) && !selected();

  const commit = (value: string) => {
    if (!editing()) return; // Enter already committed; this is the blur that follows
    setEditing(false);
    const name = value.trim();
    if (name && name !== props.app.name) renameApp(props.app.id, name);
  };

  // Renaming needs room: a collapsed sidebar opens first.
  const rename = () => {
    setSidebarCollapsed(false);
    setEditing(true);
  };

  const menuItems = (): (MenuItem | "separator")[] => [
    { label: "Rename", icon: "pencil", onSelect: rename },
    { label: "Change icon…", icon: "shapes", onSelect: () => setIconPicker(menu() ?? { x: 0, y: 0 }) },
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
      label: "Move up",
      icon: "arrow-up",
      disabled: !neighbour(-1),
      onSelect: () => void moveTab(props.app.id, neighbour(-1)!.id, "before"),
    },
    {
      label: "Move down",
      icon: "arrow-down",
      disabled: !neighbour(1),
      onSelect: () => void moveTab(props.app.id, neighbour(1)!.id, "after"),
    },
    ...workspaces
      .filter((w) => w.id !== props.app.workspaceId)
      .map((w) => ({
        label: `Move to ${w.name}`,
        icon: "folder-input",
        onSelect: () => void moveApp(props.app.id, w.id),
      })),
    {
      label: "New chat",
      icon: "message-square-plus",
      disabled: running() || !states[props.app.id]?.messages.length,
      onSelect: () =>
        void newChat(props.app.id).catch((err) =>
          toast({ message: err instanceof Error ? err.message : String(err), kind: "error" }),
        ),
    },
    "separator",
    {
      label: props.app.kind === "app" ? "Close (the app is kept)" : "Close tab",
      icon: "x",
      onSelect: () => void close(),
    },
    ...(props.app.kind === "app"
      ? [
          {
            label: "Delete",
            icon: "trash",
            danger: true,
            onSelect: async () => {
              const ok = await confirmDialog(`Delete “${props.app.name}” and all its data?`, {
                confirmLabel: "Delete",
                danger: true,
              });
              if (ok) deleteApp(props.app.id);
            },
          },
        ]
      : []),
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
        props.tile && styles.tile,
        highlighted() && styles.selected,
        beside() && styles.beside,
        isSidebarCollapsed() && styles.itemCompact,
        isDragged() && styles.dragging,
        dropBefore() && styles.dropBefore,
        dropAfter() && styles.dropAfter,
        dropInto() && styles.dropInto,
      )}
      title={
        isSidebarCollapsed() || props.tile
          ? props.app.name
          : asleep()
            ? "Not loaded: opens where you left it"
            : undefined
      }
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
      onDragEnd={() => {
        setDraggedTab(null);
        setDropAt(null);
      }}
      onDragOver={(e) => {
        if (!draggedTab() && !draggedSplit()) {
          // A file, link or text from outside: a web tab opens it, an app tab leaves it to a new tab.
          if (!hasDroppable(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer!.dropEffect = "copy";
          setDropTarget(props.app.kind === "web" ? { kind: "tab", id: props.app.id } : { kind: "list" });
          return;
        }
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        setDropAt({ id: props.app.id, side: e.clientY < r.top + r.height / 2 ? "before" : "after" });
      }}
      onDragLeave={(e) => {
        if (dropAt()?.id === props.app.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={(e) => {
        const id = draggedTab();
        const group = draggedSplit();
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
        <TabIcon tab={props.app} />
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

      <Show when={running()}>
        <span
          {...stylex.attrs(styles.dot, isSidebarCollapsed() && styles.dotCompact, fullAccess() && styles.dotFull)}
          title={fullAccess() ? "Agent is working with full access (it doesn't ask)" : "Agent is working"}
          data-running-full={fullAccess() ? "" : undefined}
        />
      </Show>
      <Show when={!hideName()}>
        <button
          type="button"
          title={
            props.app.kind === "app"
              ? "Close (the app is kept: New tab → Open it again)"
              : withKeys("Close tab", "tab.close")
          }
          aria-label={`Close ${props.app.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void close();
          }}
          {...stylex.attrs(styles.more, selected() && styles.moreOpen)}
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
    overflowX: "hidden",
    overflowY: "auto",
  },
  rootCompact: { paddingInline: 8 },
  naming: { display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 },
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
  newButtonCompact: { justifyContent: "center", width: "100%", paddingInline: 0 },
  itemCompact: { justifyContent: "center", paddingInline: 0, position: "relative" },
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
  groupHeaderCompact: { justifyContent: "center", paddingInline: 0 },
  groupLabel: { flex: 1, fontWeight: 600, letterSpacing: "0.02em" },
  groupMore: { width: 18, height: 18 },
  dragging: { opacity: 0.45 },
  // In the split view on screen, next to the selected tab.
  beside: { backgroundColor: { default: colors.surfaceHover, ":hover": colors.surfaceHover } },
  // A line where the dragged tab would land (the list has a 2px gap).
  dropBefore: { boxShadow: `0 -2px 0 0 ${colors.accent}` },
  dropAfter: { boxShadow: `0 2px 0 0 ${colors.accent}` },
  // A file or link dragged in opens in this tab.
  dropInto: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    boxShadow: `inset 0 0 0 1.5px ${colors.accent}`,
  },
  // Where a file or link dragged in opens in a new tab: a slot at the end of the list.
  dropSlot: {
    display: "flex",
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
  dropSlotCompact: { justifyContent: "center", paddingInline: 0 },
  dotCompact: { position: "absolute", top: 5, right: 5 },
  dotFull: { backgroundColor: colors.danger },
  workspaceRename: { height: 30, fontSize: font.md },
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
  newButton: {
    justifyContent: "flex-start",
    width: "100%",
    flexShrink: 0,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    boxShadow: "none",
    color: colors.muted,
  },
  chrome: { display: "flex", flexDirection: "column", gap: space.sm, flexShrink: 0 },
  tiles: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))",
    gap: 6,
    flexShrink: 0,
  },
  tile: {
    justifyContent: "center",
    height: 40,
    paddingInline: 0,
    borderRadius: radius.md,
    backgroundColor: { default: colors.surfaceHover, ":hover": colors.surface },
  },
  chevron: { marginLeft: "auto", opacity: 0.6 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 },
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
    alignItems: "flex-end",
    gap: 4,
    flexShrink: 0,
    marginTop: "auto",
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  footerCompact: { flexDirection: "column", alignItems: "center" },
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
  workspaceBar: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
    flex: 1,
    minWidth: 0,
  },
  workspaceBarCompact: { flexDirection: "column", flexWrap: "nowrap", flex: "none" },
  workspaceIcon: {
    display: "grid",
    placeItems: "center",
    width: 34,
    height: 34,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
    opacity: { default: 0.55, ":hover": 1 },
    transitionProperty: "opacity, background-color",
    transitionDuration: "120ms",
  },
  workspaceIconOn: {
    opacity: 1,
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px ${colors.border}`,
  },
  workspaceIconOver: { boxShadow: `0 0 0 2px ${colors.accent}`, opacity: 1 },
  workspaceAdd: { opacity: { default: 0.6, ":hover": 1 } },
});
