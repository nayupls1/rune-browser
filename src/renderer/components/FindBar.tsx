// Find in page (Ctrl+F), over the top right of a tab's page, and the zoom
// badge in the address field when a page isn't at its actual size.
import * as stylex from "@stylexjs/stylex";
import { createEffect, on, Show } from "solid-js";
import { defaultZoom } from "../lib/browser";
import { closeFind, findOf, findStep, search, zoom, zoomKnown, zoomOf } from "../lib/pageTools";
import { shortcutLabel } from "../lib/shortcuts";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

export function FindBar(props: { tabId: string }) {
  const state = () => findOf(props.tabId);
  let input: HTMLInputElement | undefined;

  createEffect(
    on(
      () => (state()?.open ? state()!.focus : 0),
      (focus) => {
        if (!focus) return;
        queueMicrotask(() => {
          input?.focus();
          input?.select();
        });
      },
    ),
  );

  const counter = () => {
    const s = state();
    if (!s?.query) return "";
    return s.total ? `${s.active}/${s.total}` : "0/0";
  };
  const notFound = () => !!state()?.query && state()!.total === 0;
  const hint = (label: string, id: string) => (shortcutLabel(id) ? `${label} (${shortcutLabel(id)})` : label);

  return (
    <Show when={state()?.open}>
      <div {...stylex.attrs(styles.bar)} data-find-bar role="search">
        <input
          ref={input}
          value={state()?.query ?? ""}
          placeholder="Find in page"
          spellcheck={false}
          aria-label="Find in page"
          {...stylex.attrs(styles.input, notFound() && styles.notFound)}
          onInput={(e) => search(props.tabId, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              findStep(props.tabId, !e.shiftKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              closeFind(props.tabId);
            }
          }}
          data-find-input
        />
        <span {...stylex.attrs(styles.counter)} data-find-count>
          {counter()}
        </span>
        <span {...stylex.attrs(styles.divider)} />
        <button
          type="button"
          title={hint("Previous", "find.previous")}
          aria-label="Previous match"
          disabled={!state()?.total}
          onClick={() => findStep(props.tabId, false)}
          {...stylex.attrs(styles.button)}
        >
          <Icon name="chevron-up" size={15} />
        </button>
        <button
          type="button"
          title={hint("Next", "find.next")}
          aria-label="Next match"
          disabled={!state()?.total}
          onClick={() => findStep(props.tabId, true)}
          {...stylex.attrs(styles.button)}
        >
          <Icon name="chevron-down" size={15} />
        </button>
        <button
          type="button"
          title="Close (Esc)"
          aria-label="Close"
          onClick={() => closeFind(props.tabId)}
          {...stylex.attrs(styles.button)}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
    </Show>
  );
}

/** "110%" in the address field while a web page is zoomed (to other than the default zoom); a click goes back. */
export function ZoomBadge(props: { tabId: string }) {
  const percent = () => Math.round(zoomOf(props.tabId) * 100);
  return (
    <Show when={zoomKnown(props.tabId) && percent() !== Math.round(defaultZoom() * 100)}>
      <button
        type="button"
        title={`Zoom: ${percent()}%. Click for the default size${shortcutLabel("zoom.reset") ? ` (${shortcutLabel("zoom.reset")})` : ""}`}
        onClick={() => zoom(props.tabId, 0)}
        {...stylex.attrs(styles.zoom)}
        data-zoom={percent()}
      >
        <Icon name={percent() > 100 ? "zoom-in" : "zoom-out"} size={12} />
        {percent()}%
      </button>
    </Show>
  );
}

const styles = stylex.create({
  bar: {
    position: "absolute",
    top: space.sm,
    right: space.md,
    zIndex: 4,
    display: "flex",
    alignItems: "center",
    gap: 2,
    height: 36,
    paddingLeft: space.md,
    paddingRight: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: "0 6px 20px rgb(0 0 0 / 0.16)",
  },
  input: {
    width: 200,
    height: "100%",
    padding: 0,
    borderStyle: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
  },
  notFound: { color: colors.danger },
  counter: {
    minWidth: 36,
    paddingInline: space.xs,
    color: colors.muted,
    fontSize: font.xs,
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
  },
  divider: {
    width: 1,
    height: 18,
    marginInline: space.xs,
    backgroundColor: colors.border,
  },
  button: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text },
    opacity: { default: 1, ":disabled": 0.4 },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  zoom: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
    height: 20,
    paddingInline: 6,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: { default: colors.surfaceHover, ":hover": colors.accentSoft },
    color: colors.muted,
    fontSize: font.xs,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
});
