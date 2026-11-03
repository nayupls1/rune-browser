// A small popup menu, opened at a point (right-click) or under an element.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Shows a check mark (the current choice). */
  checked?: boolean;
  onSelect: () => void;
}

export interface MenuPosition {
  x: number;
  y: number;
}

export function ContextMenu(props: { items: (MenuItem | "separator")[]; position: MenuPosition; onClose: () => void }) {
  let menu!: HTMLDivElement;
  const [pos, setPos] = createSignal(props.position);

  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const focusBy = (delta: number) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + delta + list.length) % list.length]?.focus();
  };

  onMount(() => {
    // Keep the menu inside the window.
    const rect = menu.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(props.position.y, window.innerHeight - rect.height - 4)),
    });
    buttons()[0]?.focus();

    const onPointer = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
      else if (e.key === "ArrowDown") (e.preventDefault(), focusBy(1));
      else if (e.key === "ArrowUp") (e.preventDefault(), focusBy(-1));
    };
    const close = () => props.onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    });
  });

  return (
    <Portal>
      <div
        ref={menu}
        role="menu"
        data-context-menu
        onContextMenu={(e) => e.preventDefault()}
        {...stylex.attrs(styles.menu, styles.at(`${pos().x}px`, `${pos().y}px`))}
      >
        <For each={props.items}>
          {(item) => (
            <Show when={item !== "separator" && item} fallback={<div {...stylex.attrs(styles.separator)} />}>
              {(entry) => (
                <button
                  type="button"
                  role="menuitem"
                  disabled={entry().disabled}
                  onClick={() => {
                    props.onClose();
                    entry().onSelect();
                  }}
                  {...stylex.attrs(styles.item, entry().danger && styles.danger)}
                >
                  <Icon name={entry().icon} size={15} {...stylex.attrs(styles.icon)} />
                  <span {...stylex.attrs(styles.label)}>{entry().label}</span>
                  <Show when={entry().checked}>
                    <Icon name="check" size={14} {...stylex.attrs(styles.check)} />
                  </Show>
                </button>
              )}
            </Show>
          )}
        </For>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  menu: {
    position: "fixed",
    zIndex: 1000,
    minWidth: 180,
    maxWidth: 320,
    padding: space.xs,
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.08)",
    fontFamily: font.sans,
    color: colors.text,
  },
  at: (left: string, top: string) => ({ left, top }),
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 30,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":focus-visible": colors.surfaceHover },
    color: "inherit",
    fontSize: font.sm,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.45 },
    outline: "none",
  },
  danger: { color: colors.danger },
  icon: { flexShrink: 0, opacity: 0.8 },
  label: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  check: { flexShrink: 0, color: colors.accent },
  separator: { height: 1, marginBlock: space.xs, backgroundColor: colors.border },
});
