// Horizontal tabs: one bar along the top of the window, minimal like Helium's: the window's buttons,
// back, forward and reload, a compact address, then the tabs right next to it (pinned ones as icons,
// New tab after them), and at the end the workspaces, the agent and the ⋯ menu. The same tabs as the
// vertical sidebar's (components/Sidebar.tsx), in a row: the same menus, dragging (to reorder, into a
// split view, out to a new window) and drops. Tabs shrink as more are opened, down to a width where their
// names can still be read; past that they scroll, fading out at the ends with an arrow there to show the next
// ones. Pinned tabs get whole tiles in part of the bar; the rest are behind a button at their end.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { AppSummary } from "../../shared/api";
import { openDropped, dropTarget, hasDroppable, setDropTarget } from "../lib/drops";
import { withKeys } from "../lib/shortcuts";
import { appById, isPrivate, newWebTab, selectedId } from "../lib/store";
import { takeTab } from "../lib/windows";
import { colors, font, radius, space } from "../theme.stylex";
import { ContextMenu, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import {
  entries,
  isForeignTabDrag,
  Item,
  keepSelectedInView,
  NewTabMenu,
  scrollWhileDragging,
  SettingsLink,
  SplitGroup,
  tabAreaMenuAt,
  tabAreaMenuItems,
  tabFromElsewhere,
  tiles,
  WorkspaceBar,
} from "./Sidebar";
import { TabHoverCard } from "./TabHoverCard";
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
        <WorkspaceBar inline />
        <AgentButton />
      </Show>
      <MoreMenu />
    </div>
  );
}

/** A pinned tab's tile in the bar, and the gap after it. */
const TILE = 38;
const GAP = 4;
/** What New tab needs, with its gap and the strip's padding. */
const NEW_TAB_ROOM = 42;
/**
 * What the tabs keep at least: one tab at its narrowest (Sidebar.tsx: itemH), with the list's padding and the
 * arrows at its ends.
 */
const TABS_ROOM = 112 + 4 + 2 * 24;
/** How far into the list its ends fade while there are tabs past them; the tab on screen is kept clear of it. */
const FADE = 24;

/** The tabs, New tab after them, and the free room up to the bar's end. */
function TabStrip() {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [newMenu, setNewMenu] = createSignal<MenuPosition>();
  const [pinnedMenu, setPinnedMenu] = createSignal<MenuPosition>();
  const [stripWidth, setStripWidth] = createSignal(0);
  const [edges, setEdges] = createSignal({ before: 0, after: 0, start: false, end: false });
  let strip!: HTMLDivElement;
  let wrap!: HTMLDivElement;
  let scroller!: HTMLUListElement;
  let newButton!: HTMLButtonElement;
  let moreButton: HTMLButtonElement | undefined;

  // Pinned tabs get whole tiles in up to a third of the bar, never the room New tab and one tab need. The
  // rest are behind a button at their end, which shows how many there are.
  const pinnedFits = () => {
    const width = stripWidth();
    const room = Math.min(width / 3, width - NEW_TAB_ROOM - TABS_ROOM);
    return Math.max(1, Math.floor((room + GAP) / (TILE + GAP)));
  };
  const shownTiles = () => {
    const all = tiles();
    return all.length <= pinnedFits() ? all : all.slice(0, pinnedFits() - 1);
  };
  const moreTiles = () => tiles().slice(shownTiles().length);
  const minWidth = () => NEW_TAB_ROOM + (tiles().length ? TILE + GAP + 4 : 0) + (entries().length ? TABS_ROOM : 0);
  const hasMoreTiles = () => moreTiles().length > 0;
  const moreTilesOn = () => !!pinnedMenu() || moreTiles().some((t) => t.id === selectedId());

  // Which of the tabs are out of view, on either side: the list fades there, and an arrow scrolls to them.
  const measure = () => {
    const box = scroller.getBoundingClientRect();
    let before = 0;
    let after = 0;
    for (const tab of scroller.querySelectorAll<HTMLElement>(":scope > li")) {
      const r = tab.getBoundingClientRect();
      if (r.left + r.width / 2 < box.left) before++;
      else if (r.right - r.width / 2 > box.right) after++;
    }
    const start = scroller.scrollLeft > 1;
    const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    const now = edges();
    if (now.before !== before || now.after !== after || now.start !== start || now.end !== end)
      setEdges({ before, after, start, end });
  };
  const fadeStart = () => edges().start && !edges().end;
  const fadeEnd = () => edges().end && !edges().start;
  const fadeBoth = () => edges().start && edges().end;
  const scrollPage = (direction: -1 | 1) =>
    scroller.scrollBy({ left: direction * Math.max(120, scroller.clientWidth - 2 * FADE), behavior: "smooth" });

  onMount(() => {
    const observer = new ResizeObserver(() => {
      setStripWidth(strip.clientWidth);
      measure();
    });
    observer.observe(strip);
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
    scrollWhileDragging(scroller, "x", wrap);
  });
  createEffect(on([entries, tiles], () => requestAnimationFrame(measure)));
  keepSelectedInView(() => scroller, "x", FADE);

  const arrowTitle = (count: number, side: string) =>
    count ? `${count} more tab${count === 1 ? "" : "s"} ${side}` : `More tabs ${side}`;

  return (
    <div
      ref={strip}
      {...stylex.attrs(styles.strip)}
      // On a narrow window (the address gives way first): room for New tab, a tab and the pinned tabs' button.
      style={{ "min-width": `${minWidth()}px` }}
      data-tab-strip
      onContextMenu={(e) => {
        const at = tabAreaMenuAt(e);
        if (at) setMenu(at);
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
          <For each={shownTiles()}>{(app) => <Item app={app} tile horizontal />}</For>
          <Show when={hasMoreTiles()}>
            <li {...stylex.attrs(styles.moreTilesSlot)}>
              <button
                type="button"
                ref={moreButton}
                title={`${moreTiles().length} more pinned tab${moreTiles().length === 1 ? "" : "s"}`}
                aria-haspopup="menu"
                aria-expanded={!!pinnedMenu()}
                onClick={() => {
                  if (pinnedMenu()) return setPinnedMenu();
                  const r = moreButton!.getBoundingClientRect();
                  setPinnedMenu({ x: r.left, y: r.bottom + 6 });
                }}
                {...stylex.attrs(styles.moreTiles, moreTilesOn() && styles.moreTilesOn)}
                data-more-pinned={moreTiles().length}
              >
                +{moreTiles().length}
              </button>
            </li>
          </Show>
        </ul>
      </Show>
      <div ref={wrap} {...stylex.attrs(styles.tabsWrap)}>
        {/* At the list's ends while there are tabs past them: a click shows the next ones. */}
        <Show when={edges().start}>
          <button
            type="button"
            title={arrowTitle(edges().before, "to the left")}
            aria-label={arrowTitle(edges().before, "to the left")}
            onClick={() => scrollPage(-1)}
            {...stylex.attrs(styles.arrow)}
            data-tabs-scroll="start"
          >
            <Icon name="chevron-left" size={14} />
          </button>
        </Show>
        <ul
          ref={scroller}
          {...stylex.attrs(
            styles.tabs,
            fadeStart() && styles.fadeStart,
            fadeEnd() && styles.fadeEnd,
            fadeBoth() && styles.fadeBoth,
          )}
          onScroll={measure}
          // The wheel scrolls the tabs sideways.
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.scrollLeft += e.deltaY;
          }}
          data-tab-list
          data-tabs-hidden-before={edges().before}
          data-tabs-hidden-after={edges().after}
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
        <Show when={edges().end}>
          <button
            type="button"
            title={arrowTitle(edges().after, "to the right")}
            aria-label={arrowTitle(edges().after, "to the right")}
            onClick={() => scrollPage(1)}
            {...stylex.attrs(styles.arrow)}
            data-tabs-scroll="end"
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </Show>
      </div>
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
      <span {...stylex.attrs(styles.spacer)} data-tab-strip-spacer />
      <Show when={menu()}>
        {(position) => <ContextMenu items={tabAreaMenuItems()} position={position()} onClose={() => setMenu()} />}
      </Show>
      <Show when={newMenu()}>{(position) => <NewTabMenu position={position()} onClose={() => setNewMenu()} />}</Show>
      <Show when={pinnedMenu() && hasMoreTiles() && pinnedMenu()}>
        {(position) => (
          <PinnedOverflow
            tabs={moreTiles()}
            position={position()}
            button={() => moreButton}
            onClose={() => setPinnedMenu()}
          />
        )}
      </Show>
      <TabHoverCard area={() => strip} placement="below" />
    </div>
  );
}

/**
 * The pinned tabs that don't fit in the bar, in a list under their button: each with its icon and name,
 * clicked to show it, with its menu on a right-click like any tab.
 */
function PinnedOverflow(props: {
  tabs: AppSummary[];
  position: MenuPosition;
  button: () => HTMLElement | undefined;
  onClose: () => void;
}) {
  let el!: HTMLDivElement;
  const left = () => Math.max(4, Math.min(props.position.x, window.innerWidth - OVERFLOW_WIDTH - 4));
  onMount(() => {
    // Clicks in a tab's own menu (and the dialogs it opens) aren't clicks outside.
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (el.contains(target) ||
        !!props.button()?.contains(target) ||
        (target instanceof Element && !!target.closest("[data-context-menu], [data-icon-picker], [role=dialog]")));
    const onPointer = (e: PointerEvent) => !inside(e.target) && props.onClose();
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !document.querySelector("[data-context-menu]") && props.onClose();
    const close = () => props.onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    });
  });
  return (
    <Portal>
      <div
        ref={el}
        role="menu"
        {...stylex.attrs(styles.overflow)}
        style={{ left: `${left()}px`, top: `${props.position.y}px` }}
        // A tab picked here is on screen: the list has done its job.
        onClick={(e) => {
          const target = e.target as Element;
          if (target.closest("[data-app-id]") && !target.closest("button, input")) props.onClose();
        }}
        data-pinned-overflow
      >
        <ul {...stylex.attrs(styles.overflowList)}>
          <For each={props.tabs}>{(app) => <Item app={app} horizontal />}</For>
        </ul>
      </div>
    </Portal>
  );
}

/** A tab's row in it (Sidebar.tsx: itemH), and the list's padding and border. */
const OVERFLOW_WIDTH = 230;

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
    // (Its narrowest is set where it's drawn: room for New tab, and nothing past its end.)
    overflowX: "clip",
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
  // Only whole tiles: as many as TabStrip has room for, the rest behind their button.
  tiles: {
    listStyle: "none",
    display: "flex",
    alignItems: "center",
    gap: GAP,
    flexShrink: 0,
    margin: 0,
    padding: 0,
    paddingRight: 4,
  },
  moreTilesSlot: { display: "flex", flexShrink: 0 },
  // The pinned tabs that don't fit: a tile with their number.
  moreTiles: {
    display: "grid",
    placeItems: "center",
    width: TILE,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: 8,
    backgroundColor: {
      default: `color-mix(in oklab, ${colors.text} 4.5%, transparent)`,
      ":hover": `color-mix(in oklab, ${colors.text} 9%, transparent)`,
    },
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: font.sans,
    fontSize: font.xs,
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
  // Its list is open, or the tab on screen is in it.
  moreTilesOn: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    boxShadow: `0 0 0 1px color-mix(in oklab, ${colors.text} 16%, transparent), 0 1px 2px rgb(0 0 0 / 0.06)`,
    color: colors.text,
  },
  // The tabs and the arrows over their ends.
  tabsWrap: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    flex: "0 1 auto",
    minWidth: 0,
    height: "100%",
  },
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
  // Tabs past an end fade out there, next to its arrow.
  fadeStart: { maskImage: `linear-gradient(to right, transparent 0, #000 ${FADE}px)` },
  fadeEnd: { maskImage: `linear-gradient(to left, transparent 0, #000 ${FADE}px)` },
  fadeBoth: {
    maskImage: `linear-gradient(to right, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)`,
  },
  // Beside the list (not over it: it never covers a tab).
  arrow: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 24,
    marginInline: 1,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: {
      default: colors.surface,
      ":hover": `color-mix(in oklab, ${colors.text} 10%, ${colors.surface})`,
    },
    boxShadow: `0 0 0 1px color-mix(in oklab, ${colors.text} 12%, transparent), 0 1px 3px rgb(0 0 0 / 0.1)`,
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  overflow: {
    position: "fixed",
    zIndex: 1000,
    width: OVERFLOW_WIDTH,
    maxHeight: "min(60vh, 420px)",
    overflowY: "auto",
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.08)",
    color: colors.text,
    fontFamily: font.sans,
  },
  overflowList: {
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 2,
    margin: 0,
    padding: 0,
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
});
