// Variant 3, "Statements": the type is the page. Four claims set huge and condensed, each with a short
// gloss beside it; no pictures, one accent (the mark and the download button).
import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";

const NARROW = "@media (max-width: 860px)";

export const s = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: brand.bg,
    color: brand.text,
    fontFamily: '"Bricolage Grotesque Variable", ui-sans-serif, system-ui, sans-serif',
    fontSize: "1.0625rem",
    lineHeight: 1.5,
    paddingInline: { default: "clamp(1.5rem, 5vw, 4.5rem)", [NARROW]: "1.25rem" },
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBlock: "1.75rem",
  },
  brand: { display: "flex", alignItems: "center", gap: "0.6rem", fontWeight: 600 },
  headerLink: {
    color: brand.text,
    fontWeight: 500,
    textDecoration: "none",
    textUnderlineOffset: "0.25em",
    ":hover": { textDecoration: "underline", textDecorationColor: brand.accent },
  },
  list: {
    paddingBlockStart: { default: "10vh", [NARROW]: "3rem" },
    display: "grid",
    rowGap: { default: "3.25rem", [NARROW]: "2.5rem" },
  },
  item: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr) 21rem", [NARROW]: "1fr" },
    alignItems: "end",
    columnGap: "3rem",
    rowGap: "0.9rem",
  },
  claim: {
    fontSize: "clamp(3rem, 9.2vw, 8.75rem)",
    fontStretch: "75%",
    fontWeight: 650,
    lineHeight: 0.9,
    letterSpacing: "-0.015em",
    textWrap: "balance",
  },
  gloss: {
    color: brand.muted,
    textWrap: "pretty",
    paddingBlockEnd: { default: "0.6rem", [NARROW]: 0 },
    maxWidth: "26rem",
  },
  close: {
    marginBlockStart: { default: "9rem", [NARROW]: "5rem" },
    paddingBlock: "2.5rem 3rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1.5rem",
  },
  closeText: { color: brand.muted, maxWidth: "30rem" },
  button: {
    display: "inline-block",
    paddingBlock: "0.95rem",
    paddingInline: "1.6rem",
    borderRadius: "0.5rem",
    backgroundColor: { default: brand.accent, ":hover": brand.text },
    color: { default: brand.accentText, ":hover": brand.bg },
    fontSize: "1.125rem",
    fontWeight: 600,
    textDecoration: "none",
    transitionProperty: "background-color, color",
    transitionDuration: "0.15s",
    outlineOffset: "3px",
  },
  link: { color: brand.text, textUnderlineOffset: "0.2em", textDecorationColor: brand.border },
});
