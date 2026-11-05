// Small styled primitives for the host UI.
import * as stylex from "@stylexjs/stylex";
import { Show, splitProps, type JSX } from "solid-js";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

type StyleProp = { xstyle?: stylex.StyleXStyles };

const styles = stylex.create({
  button: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    height: 32,
    paddingInline: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    fontSize: font.sm,
    fontWeight: 500,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.5 },
    whiteSpace: "nowrap",
    transition: "background-color 120ms, opacity 120ms",
  },
  primary: {
    borderColor: colors.accent,
    backgroundColor: { default: colors.accent, ":hover": colors.accent },
    color: colors.accentText,
    filter: { default: null, ":hover": "brightness(1.08)" },
  },
  danger: {
    color: colors.danger,
  },
  ghost: {
    borderColor: "transparent",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  field: {
    width: "100%",
    height: 32,
    paddingInline: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.surface,
    fontSize: font.md,
    outline: "none",
    boxShadow: { default: null, ":focus": `0 0 0 3px ${colors.accentSoft}` },
  },
  checkbox: {
    flexShrink: 0,
    width: 16,
    height: 16,
    margin: 0,
    appearance: "none",
    borderRadius: 4,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: {
      default: `color-mix(in oklab, ${colors.border}, ${colors.text} 30%)`,
      ":checked": colors.accent,
    },
    backgroundColor: { default: colors.surface, ":checked": colors.accent },
    backgroundImage: {
      default: "none",
      ":checked":
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E\")",
    },
    backgroundSize: "12px",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    cursor: "pointer",
    transition: "background-color 100ms, border-color 100ms",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: 2,
  },
  select: {
    width: "auto",
    minWidth: 160,
    height: 32,
    paddingRight: 32,
    appearance: "none",
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23948a80' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    backgroundSize: "14px",
    borderColor: {
      default: colors.border,
      ":hover": `color-mix(in oklab, ${colors.border}, ${colors.text} 20%)`,
      ":focus": colors.accent,
    },
    fontFamily: font.sans,
    fontSize: font.sm,
    cursor: "pointer",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    paddingBlock: 40,
    paddingInline: space.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    textAlign: "center",
  },
  emptyIcon: {
    display: "grid",
    placeItems: "center",
    width: 44,
    height: 44,
    marginBottom: space.xs,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  emptyTitle: { fontSize: font.lg, fontWeight: 600 },
  emptyHint: { maxWidth: "52ch", color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  emptyActions: { display: "flex", gap: space.sm, marginTop: space.sm },
});

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> &
  StyleProp & { variant?: "default" | "primary" | "danger" | "ghost" };

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "xstyle", "type"]);
  return (
    <button
      type={local.type ?? "button"}
      {...rest}
      {...stylex.attrs(
        styles.button,
        local.variant === "primary" && styles.primary,
        local.variant === "danger" && styles.danger,
        local.variant === "ghost" && styles.ghost,
        local.xstyle,
      )}
    />
  );
}

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement> & StyleProp) {
  const [local, rest] = splitProps(props, ["xstyle"]);
  return <input {...rest} {...stylex.attrs(styles.field, local.xstyle)} />;
}

export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement> & StyleProp) {
  const [local, rest] = splitProps(props, ["xstyle"]);
  return <select {...rest} {...stylex.attrs(styles.field, styles.select, local.xstyle)} />;
}

export function Checkbox(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="checkbox" {...props} {...stylex.attrs(styles.checkbox)} />;
}

/** What a list shows while it has nothing: an icon, a line saying so, a hint and what to do. */
export function EmptyState(
  props: { icon: string; title: string; hint?: string; children?: JSX.Element } & JSX.HTMLAttributes<HTMLDivElement>,
) {
  const [local, rest] = splitProps(props, ["icon", "title", "hint", "children"]);
  return (
    <div {...rest} {...stylex.attrs(styles.empty)}>
      <span {...stylex.attrs(styles.emptyIcon)}>
        <Icon name={local.icon} size={22} />
      </span>
      <span {...stylex.attrs(styles.emptyTitle)}>{local.title}</span>
      <Show when={local.hint}>
        <span {...stylex.attrs(styles.emptyHint)}>{local.hint}</span>
      </Show>
      <Show when={local.children}>
        <div {...stylex.attrs(styles.emptyActions)}>{local.children}</div>
      </Show>
    </div>
  );
}
