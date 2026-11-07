// The homepage's shared parts (the "Letter" design): a narrow column of plain prose on the left, a picture
// of the browser on the right; on narrow screens the picture follows the text.
import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";

const WIDE = "@media (min-width: 1080px)";

export const s = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: brand.bg,
    color: brand.text,
    fontFamily: '"Schibsted Grotesk Variable", ui-sans-serif, system-ui, sans-serif',
    fontSize: "1.0625rem",
    lineHeight: 1.6,
    overflowX: "clip",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [WIDE]: "minmax(0, 33rem) minmax(0, 1fr)" },
    columnGap: "clamp(3rem, 6vw, 6.5rem)",
    rowGap: "3.5rem",
    alignItems: "start",
    paddingInlineStart: { default: "1.25rem", [WIDE]: "max(2rem, 8vw)" },
    paddingInlineEnd: { default: "1.25rem", [WIDE]: "max(2rem, 5vw)" },
    paddingBlockStart: { default: "4.5rem", [WIDE]: "15vh" },
  },
  // For a picture that runs off the right edge of the window.
  bleed: { paddingInlineEnd: { default: "1.25rem", [WIDE]: 0 } },
  column: { maxWidth: "35rem" },
  visual: { minWidth: 0 },
  // Stays in view beside the text while it scrolls.
  sticky: {
    position: { default: "static", [WIDE]: "sticky" },
    top: "10vh",
  },

  mark: { marginBlockEnd: "2.75rem" },
  name: { fontSize: "1.0625rem", fontWeight: 600, marginBlockEnd: "0.5rem" },
  title: {
    fontSize: { default: "2.125rem", "@media (min-width: 640px)": "2.75rem" },
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
    marginInlineStart: { default: "1.25rem", [WIDE]: "max(2rem, 8vw)" },
    marginInlineEnd: { default: "1.25rem", [WIDE]: "max(2rem, 5vw)" },
    paddingBlock: "1.25rem 2.5rem",
    borderBlockStartWidth: "1px",
    borderBlockStartStyle: "solid",
    borderBlockStartColor: brand.border,
    color: brand.muted,
    fontSize: "0.875rem",
  },

  // Screenshots of the browser: its own window shape, on the page's paper.
  shot: {
    display: "block",
    width: "100%",
    height: "auto",
    borderRadius: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: brand.border,
    boxShadow: brand.shadow,
    backgroundColor: brand.surface,
  },
  // The homepage's screenshot: wider than its column, so the window runs off the right edge (the page clips
  // it). On phones too: there it's shown larger, the page and its menu of changes first.
  frame: {
    width: { default: "170%", [WIDE]: "max(100%, 58rem)" },
    // Beside the text: the window's top lines up with "Rune Browser", below the mark (its height, 30px wide
    // at the icon's 388:628, and the space under it).
    marginBlockStart: { default: 0, [WIDE]: "calc(30px * 628 / 388 + 2.75rem)" },
  },
  cut: { borderStartEndRadius: 0, borderEndEndRadius: 0 },
});
