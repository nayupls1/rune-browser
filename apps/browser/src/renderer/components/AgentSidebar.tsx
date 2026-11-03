// The agent sidebar: one panel, right of the tabs, that looks and works the
// same for every kind of tab (web pages, apps, extension pages). It shows the
// agent of the tab that has the focus (in a split view, the focused pane's):
// editing an app, customizing a site and using it all happen here. Open or
// closed per tab (store: isAgentCollapsed), one width for all tabs, resized by
// dragging its left edge like the tab sidebar.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, Show } from "solid-js";
import { AGENT_DEFAULT, AGENT_MIN, agentWidth, setAgentWidth } from "../lib/layout";
import { appById, isAgentCollapsed, isTab, selectedId, setAgentCollapsed, states } from "../lib/store";
import { colors } from "../theme.stylex";
import { Chat } from "./Chat";

/** The tab whose agent is shown, if its sidebar is open. */
export const agentTab = () => {
  const id = selectedId();
  return isTab(id) && appById(id) && states[id]?.loaded && !isAgentCollapsed(id) ? id : null;
};

export function AgentSidebar() {
  return (
    <Show when={agentTab()} keyed>
      {(tabId) => (
        <div
          {...stylex.attrs(styles.root)}
          style={{ width: `${agentWidth()}px` }}
          data-agent-sidebar
          data-agent-for={tabId}
        >
          <Resizer tabId={tabId} />
          <Chat appId={tabId} />
        </div>
      )}
    </Show>
  );
}

/** Its left edge: drag to resize (far enough to the right closes it), double-click for the default width, arrow keys when focused. */
function Resizer(props: { tabId: string }) {
  const [dragging, setDragging] = createSignal(false);
  let stop = () => {};
  onCleanup(() => stop());

  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = agentWidth();
    let raw = startWidth;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      raw = startWidth - (ev.clientX - startX);
      setAgentWidth(raw, false);
    };
    stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setDragging(false);
      stop = () => {};
      if (raw < AGENT_MIN - 80) {
        setAgentWidth(startWidth);
        setAgentCollapsed(props.tabId, true);
      } else setAgentWidth(raw);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the agent sidebar"
        aria-valuenow={agentWidth()}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={start}
        onDblClick={() => setAgentWidth(AGENT_DEFAULT)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16;
          if (e.key === "ArrowLeft") setAgentWidth(agentWidth() + step);
          else if (e.key === "ArrowRight") setAgentWidth(agentWidth() - step);
          else return;
          e.preventDefault();
        }}
        {...stylex.attrs(styles.handle, dragging() && styles.handleActive)}
        data-agent-resizer
      />
      {/* Over everything (web pages and previews too), so they don't swallow the drag. */}
      <Show when={dragging()}>
        <div {...stylex.attrs(styles.shield)} />
      </Show>
    </>
  );
}

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    // Never more than most of the window.
    maxWidth: "70vw",
    minHeight: 0,
    // Part of the frame around the page, like the tab sidebar.
    backgroundColor: colors.sidebar,
  },
  handle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    // In the gap between the page and the sidebar.
    left: -7,
    zIndex: 5,
    width: 8,
    cursor: "col-resize",
    backgroundColor: { default: "transparent", ":hover": colors.accent, ":focus-visible": colors.accent },
    opacity: { default: 1, ":hover": 0.5, ":focus-visible": 0.5 },
    outline: "none",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  handleActive: { backgroundColor: colors.accent, opacity: 0.5 },
  shield: { position: "fixed", inset: 0, zIndex: 1000, cursor: "col-resize" },
});
