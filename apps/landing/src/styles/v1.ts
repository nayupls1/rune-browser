// Variant 1, "Letter": one narrow column set like a short letter, left of center. The rune draws itself
// once; everything else is type.
import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";

const MOBILE = "@media (max-width: 640px)";

export const s = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: brand.bg,
    color: brand.text,
    fontFamily: '"Schibsted Grotesk Variable", ui-sans-serif, system-ui, sans-serif',
    fontSize: "1.0625rem",
    lineHeight: 1.6,
  },
  column: {
    maxWidth: "35rem",
    marginInlineStart: { default: "max(1.5rem, 14vw)", [MOBILE]: "1.25rem" },
    marginInlineEnd: { default: "1.5rem", [MOBILE]: "1.25rem" },
    paddingBlockStart: { default: "16vh", [MOBILE]: "4.5rem" },
    paddingBlockEnd: "4rem",
  },
  mark: { marginBlockEnd: "2.75rem" },
  name: {
    fontSize: "1.0625rem",
    fontWeight: 600,
    marginBlockEnd: "0.5rem",
  },
  title: {
    fontSize: { default: "2.75rem", [MOBILE]: "2.125rem" },
    lineHeight: 1.08,
    fontWeight: 500,
    letterSpacing: "-0.025em",
    textWrap: "balance",
    marginBlockEnd: "2.5rem",
  },
  points: { display: "grid", gap: "1.25rem", marginBlockEnd: "2.75rem" },
  point: { color: brand.muted, textWrap: "pretty" },
  lead: { color: brand.text, fontWeight: 600 },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "1.25rem",
    rowGap: "0.75rem",
  },
  button: {
    display: "inline-block",
    paddingBlock: "0.7rem",
    paddingInline: "1.15rem",
    borderRadius: "0.6rem",
    backgroundColor: { default: brand.text, ":hover": brand.accent },
    color: { default: brand.bg, ":hover": brand.accentText },
    fontWeight: 600,
    textDecoration: "none",
    transitionProperty: "background-color, color",
    transitionDuration: "0.15s",
    outlineOffset: "3px",
  },
  also: { color: brand.muted, fontSize: "0.9375rem" },
  link: {
    color: brand.text,
    textDecorationColor: brand.border,
    textUnderlineOffset: "0.2em",
    textDecorationThickness: "1px",
    ":hover": { textDecorationColor: brand.accent },
  },
  footer: {
    marginBlockStart: "5rem",
    paddingBlockStart: "1.25rem",
    borderBlockStartWidth: "1px",
    borderBlockStartStyle: "solid",
    borderBlockStartColor: brand.border,
    color: brand.muted,
    fontSize: "0.875rem",
  },
});
