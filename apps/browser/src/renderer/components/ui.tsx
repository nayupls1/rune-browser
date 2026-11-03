// Small styled primitives for the host UI.
import * as stylex from "@stylexjs/stylex";
import { splitProps, type JSX } from "solid-js";
import { colors, font, radius, space } from "../theme.stylex";

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
    height: 34,
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
    width: 16,
    height: 16,
    margin: 0,
    accentColor: colors.accent,
    cursor: "pointer",
  },
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
  return <select {...rest} {...stylex.attrs(styles.field, local.xstyle)} />;
}

export function Checkbox(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="checkbox" {...props} {...stylex.attrs(styles.checkbox)} />;
}
