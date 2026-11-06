// A menu that opens from a button in the agent sidebar (the composer's +, the
// effort and access pickers): above the button when it's low in the window,
// below it otherwise, with an optional title and items that can say more
// about themselves than a label.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

export interface PopoverItem {
  label: string;
  /** A second line, quieter. */
  description?: string;
  /** A Lucide name, or something drawn (effort bars). */
  icon?: string | JSX.Element;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Names it for tests (`data-menu-item`). */
  id?: string;
  onSelect: () => void;
}

export function PopoverMenu(props: {
  anchor: HTMLElement;
  items: (PopoverItem | "separator")[];
  title?: string;
  width?: number;
  /** Puts `data-<name>` on it, for tests. */
  name?: string;
  onClose: () => void;
}) {
  let menu!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ left: number; top: number }>({ left: -9999, top: -9999 });

  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const focusBy = (delta: number) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + delta + list.length) % list.length]?.focus();
  };

  onMount(() => {
    const a = props.anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const above = a.top > window.innerHeight / 2;
    setPos({
      left: Math.max(6, Math.min(a.left, window.innerWidth - m.width - 6)),
      top: Math.max(6, Math.min(above ? a.top - m.height - 6 : a.bottom + 6, window.innerHeight - m.height - 6)),
    });
    (buttons().find((b) => b.getAttribute("aria-checked") === "true") ?? buttons()[0])?.focus({ preventScroll: true });
    const onPointer = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
        props.anchor.focus({ preventScroll: true });
      } else if (e.key === "ArrowDown") (e.preventDefault(), focusBy(1));
      else if (e.key === "ArrowUp") (e.preventDefault(), focusBy(-1));
    };
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
        ref={menu}
        role="menu"
        {...stylex.attrs(styles.menu)}
        style={{ left: `${pos().left}px`, top: `${pos().top}px`, width: props.width ? `${props.width}px` : undefined }}
        {...(props.name ? { [`data-${props.name}`]: "" } : {})}
        data-popover-menu
      >
        <Show when={props.title}>
          <div {...stylex.attrs(styles.title)}>{props.title}</div>
        </Show>
        <For each={props.items}>
          {(item) =>
            item === "separator" ? (
              <div {...stylex.attrs(styles.separator)} role="separator" />
            ) : (
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                disabled={item.disabled}
                onClick={() => {
                  props.onClose();
                  item.onSelect();
                }}
                {...stylex.attrs(styles.item, item.danger && styles.danger)}
                data-menu-item={item.id}
              >
                <Show when={item.icon}>
                  <span {...stylex.attrs(styles.icon)}>
                    {typeof item.icon === "string" ? <Icon name={item.icon} size={15} /> : item.icon}
                  </span>
                </Show>
                <span {...stylex.attrs(styles.text)}>
                  <span {...stylex.attrs(styles.label)}>{item.label}</span>
                  <Show when={item.description}>
                    <span {...stylex.attrs(styles.description)}>{item.description}</span>
                  </Show>
                </span>
                <Show when={item.checked}>
                  <Icon name="check" size={14} {...stylex.attrs(styles.check)} />
                </Show>
              </button>
            )
          }
        </For>
      </div>
    </Portal>
  );
}

const pop = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(2px) scale(0.98)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  menu: {
    position: "fixed",
    // Over the floating sidebar (components/Sidebar.tsx), like every menu.
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    minWidth: 200,
    maxWidth: "calc(100vw - 12px)",
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.06), 0 12px 32px -6px rgb(0 0 0 / 0.2)",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    animationName: pop,
    animationDuration: "120ms",
    animationTimingFunction: "ease-out",
  },
  title: {
    paddingTop: 6,
    paddingBottom: 4,
    paddingInline: space.sm,
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: 500,
  },
  separator: { height: 1, marginBlock: 4, marginInline: 4, backgroundColor: colors.border },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    minHeight: 32,
    paddingBlock: 6,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":focus-visible": colors.surfaceHover },
    color: colors.text,
    fontFamily: "inherit",
    fontSize: font.sm,
    textAlign: "left",
    outline: "none",
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.45 },
  },
  danger: { color: colors.danger },
  icon: { display: "grid", placeItems: "center", flexShrink: 0, width: 18, color: "inherit", opacity: 0.8 },
  text: { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 },
  label: { fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  description: { color: colors.muted, fontSize: 12, lineHeight: 1.35 },
  check: { flexShrink: 0, color: colors.accent },
});
