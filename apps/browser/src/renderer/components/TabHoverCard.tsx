// The card shown for the tab the pointer rests on, like Chrome's: its name in full, its address and whether
// it's loaded. The same card in both layouts: under the tab with horizontal tabs (components/TabStrip.tsx),
// beside the sidebar with vertical ones (components/Sidebar.tsx), so it never covers the tab list.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { displayUrl } from "../../shared/visits";
import { appById, isLoaded, selectedId } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

const CARD_WIDTH = 260;
/** About its height with a long name (only to keep it on screen beside a tab near the window's bottom). */
const CARD_ROOM = 120;
/** How long the pointer rests on a tab before its card shows. */
const DELAY = 500;

/**
 * Watches the tabs in `area` (the tab bar, or the sidebar) and shows the card of the one the pointer rests
 * on. Once one is showing, moving along the tabs shows theirs right away.
 */
export function TabHoverCard(props: { area: () => HTMLElement; placement: "below" | "beside" }) {
  const [shown, setShown] = createSignal<{ id: string; left: number; top: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    setShown();
  };
  const place = (tab: HTMLElement) => {
    const r = tab.getBoundingClientRect();
    if (props.placement === "below")
      return { left: Math.max(4, Math.min(r.left, window.innerWidth - CARD_WIDTH - 4)), top: r.bottom + 6 };
    const area = props.area().getBoundingClientRect();
    return {
      left: Math.min(area.right + 8, window.innerWidth - CARD_WIDTH - 4),
      top: Math.max(4, Math.min(r.top - 4, window.innerHeight - CARD_ROOM)),
    };
  };
  const onOver = (e: PointerEvent) => {
    const target = e.target as Element;
    const tab = target.closest<HTMLElement>("[data-app-id]");
    // Not while it's being renamed, nor over its buttons (closing, muting), which have tooltips of their own.
    if (!tab || tab.querySelector("input") || (target !== tab && target.closest("[title]"))) return hide();
    const id = tab.dataset.appId!;
    if (shown()?.id === id) return;
    const show = () => tab.isConnected && setShown({ id, ...place(tab) });
    clearTimeout(timer);
    if (shown()) show();
    else timer = setTimeout(show, DELAY);
  };
  // Not while something else happens there: a click, a drag, a menu, scrolling.
  onMount(() => {
    const el = props.area();
    el.addEventListener("pointerover", onOver);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("pointerdown", hide, true);
    el.addEventListener("dragstart", hide, true);
    el.addEventListener("contextmenu", hide, true);
    el.addEventListener("scroll", hide, true);
    el.addEventListener("wheel", hide, { capture: true, passive: true });
    onCleanup(() => {
      el.removeEventListener("pointerover", onOver);
      el.removeEventListener("pointerleave", hide);
      el.removeEventListener("pointerdown", hide, true);
      el.removeEventListener("dragstart", hide, true);
      el.removeEventListener("contextmenu", hide, true);
      el.removeEventListener("scroll", hide, true);
      el.removeEventListener("wheel", hide, { capture: true });
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
          return t.url ? displayUrl(t.url) : "New tab";
        };
        return (
          <Portal>
            <div
              {...stylex.attrs(styles.card)}
              style={{ left: `${at.left}px`, top: `${at.top}px` }}
              role="tooltip"
              data-tab-card={at.id}
              data-tab-card-placement={props.placement}
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

const styles = stylex.create({
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
  cardTitle: {
    maxHeight: "4.2em",
    overflow: "hidden",
    fontSize: font.sm,
    fontWeight: 600,
    lineHeight: 1.4,
    overflowWrap: "anywhere",
  },
  cardDetail: {
    fontSize: font.xs,
    color: colors.muted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardNote: { display: "flex", alignItems: "center", gap: 4, marginTop: 2, fontSize: font.xs, color: colors.muted },
});
