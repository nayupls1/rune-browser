// What each homepage design puts beside the text (src/pages/1.astro … 5.astro).
import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";
// The same breakpoint as letter.ts (StyleX only reads constants defined in the file).
const WIDE = "@media (min-width: 1080px)";

export const one = stylex.create({
  // Wider than its column, so the window runs off the right edge (the page clips it).
  // On phones too: there it's shown larger, the page and its menu of changes first.
  frame: {
    width: { default: "170%", [WIDE]: "max(100%, 58rem)" },
    // Beside the text: the window's top lines up with "Rune Browser", below the mark (its height, 30px wide
    // at the icon's 388:628, and the space under it in letter.ts).
    marginBlockStart: { default: 0, [WIDE]: "calc(30px * 628 / 388 + 2.75rem)" },
  },
  shot: { borderStartEndRadius: 0, borderEndEndRadius: 0 },
});

export const two = stylex.create({
  stack: { display: "grid", paddingBlockStart: { default: 0, [WIDE]: "1rem" } },
  before: { width: "82%" },
  after: {
    width: "82%",
    justifySelf: "end",
    marginBlockStart: "-28%",
    position: "relative",
  },
});

export const three = stylex.create({
  list: { display: "grid", rowGap: "3rem" },
});

export const five = stylex.create({
  panel: {
    position: "relative",
    borderRadius: "20px",
    backgroundColor: brand.sunken,
    paddingBlock: { default: "2rem", [WIDE]: "3rem" },
    paddingInline: { default: "1.25rem", [WIDE]: "3rem" },
    display: "grid",
    rowGap: "1.5rem",
  },
  // The browser's own UI, cut out at 2x: drawn as it floats in the browser.
  piece: {
    display: "block",
    height: "auto",
    maxWidth: "100%",
    boxShadow: brand.shadow,
  },
  composer: { width: "356px", borderRadius: "16px", justifySelf: "start" },
  menu: { width: "360px", borderRadius: "12px", justifySelf: "end" },
});

// The drawn window (4.astro): the browser in outline, with a change asked for in its sidebar.
export const four = stylex.create({
  window: {
    borderRadius: "14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: brand.border,
    backgroundColor: brand.sunken,
    boxShadow: brand.shadow,
    overflow: "hidden",
    fontSize: "0.8125rem",
    lineHeight: 1.45,
  },
  bar: { display: "flex", alignItems: "center", gap: "0.75rem", paddingInline: "0.85rem", height: "2.6rem" },
  dots: { display: "flex", gap: "0.38rem" },
  dot: { width: "0.6rem", height: "0.6rem", borderRadius: "50%", backgroundColor: brand.border },
  address: {
    flexGrow: 1,
    maxWidth: "16rem",
    paddingBlock: "0.22rem",
    paddingInline: "0.7rem",
    borderRadius: "7px",
    backgroundColor: brand.line,
    color: brand.muted,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  host: { color: brand.text },
  body: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", "@media (min-width: 560px)": "minmax(0, 1fr) 13.5rem" },
    gap: "0.5rem",
    paddingInline: "0.5rem",
    paddingBlockEnd: "0.5rem",
  },
  page: {
    borderRadius: "9px",
    backgroundColor: "#ffffff",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: brand.line,
    paddingBlock: "1.4rem",
    paddingInline: "1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
    minHeight: "24rem",
  },
  // What a change hid: kept as an outline, so the drawing says what happened.
  hidden: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    paddingBlock: "0.55rem",
    paddingInline: "0.75rem",
    borderRadius: "7px",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: brand.border,
    color: brand.muted,
    fontSize: "0.75rem",
  },
  title: {
    fontFamily: "Georgia, serif",
    fontSize: "1.35rem",
    fontWeight: 700,
    lineHeight: 1.15,
    marginBlock: "0.4rem 0.2rem",
  },
  card: {
    borderRadius: "6px",
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: brand.text,
    paddingBlock: "0.9rem",
    paddingInline: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.45rem",
  },
  cardHead: { fontFamily: "Georgia, serif", fontWeight: 700, fontSize: "1rem" },
  rows: { display: "flex", flexDirection: "column", gap: "0.45rem", paddingBlockStart: "0.2rem" },
  row: { height: "0.45rem", borderRadius: "3px", backgroundColor: brand.line },
  w85: { width: "85%" },
  w70: { width: "70%" },
  w60: { width: "60%" },
  w45: { width: "45%" },
  side: { display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: "0.7rem", padding: "0.4rem" },
  ask: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    paddingBlock: "0.5rem",
    paddingInline: "0.7rem",
    borderRadius: "10px",
    backgroundColor: brand.surface,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: brand.line,
  },
  reply: { color: brand.muted },
  saved: { display: "flex", alignItems: "center", gap: "0.4rem" },
  savedDot: { width: "0.4rem", height: "0.4rem", borderRadius: "50%", backgroundColor: brand.accent },
  composer: {
    marginBlockStart: "0.3rem",
    borderRadius: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: brand.border,
    backgroundColor: brand.surface,
    padding: "0.6rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.55rem",
  },
  placeholder: { color: brand.muted },
  composerRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  chip: {
    paddingBlock: "0.12rem",
    paddingInline: "0.5rem",
    borderRadius: "999px",
    backgroundColor: brand.accentSoft,
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  send: { width: "1.45rem", height: "1.45rem", borderRadius: "50%", backgroundColor: brand.accent },
});
