// Variant 5, "Field notes": about what Rune learns. A serif page with one exhibit, a sample of what it
// has mapped about one site, set like a reference card; the rest is a short list.
import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";

const MOBILE = "@media (max-width: 640px)";

export const s = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: brand.surface,
    color: brand.text,
    fontFamily: '"Literata Variable", ui-serif, Georgia, serif',
    fontSize: "1.0625rem",
    lineHeight: 1.65,
    paddingInline: { default: "2rem", [MOBILE]: "1.25rem" },
  },
  wrap: { maxWidth: "42rem", marginInline: "auto" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBlock: "1.75rem",
    fontFamily: '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif',
    fontSize: "0.9375rem",
  },
  brand: { display: "flex", alignItems: "center", gap: "0.55rem", fontWeight: 600 },
  headerLink: { color: brand.text, textUnderlineOffset: "0.25em", textDecorationColor: brand.border },
  title: {
    marginBlockStart: { default: "6rem", [MOBILE]: "3rem" },
    fontSize: { default: "3.125rem", [MOBILE]: "2.25rem" },
    fontWeight: 380,
    lineHeight: 1.08,
    letterSpacing: "-0.02em",
    textWrap: "balance",
  },
  intro: { marginBlockStart: "1.5rem", color: brand.muted, textWrap: "pretty" },

  // The exhibit.
  card: {
    marginBlockStart: "3rem",
    borderRadius: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: brand.border,
    backgroundColor: brand.bg,
    overflow: "hidden",
  },
  cardHead: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "0.25rem 1rem",
    paddingBlock: "0.9rem",
    paddingInline: "1.1rem",
    borderBlockEndWidth: "1px",
    borderBlockEndStyle: "solid",
    borderBlockEndColor: brand.border,
  },
  host: { fontWeight: 600 },
  count: { color: brand.muted, fontSize: "0.9375rem" },
  rows: { paddingBlock: "0.4rem" },
  row: {
    display: "grid",
    gridTemplateColumns: { default: "3.25rem minmax(0, 1fr) auto", [MOBILE]: "3rem minmax(0, 1fr)" },
    alignItems: "baseline",
    columnGap: "0.75rem",
    rowGap: "0.1rem",
    paddingBlock: "0.45rem",
    paddingInline: "1.1rem",
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
    fontSize: "0.8125rem",
    lineHeight: 1.5,
  },
  method: { color: brand.accent, fontWeight: 600 },
  path: { overflowWrap: "anywhere" },
  fields: {
    color: brand.muted,
    textAlign: { default: "end", [MOBILE]: "start" },
    gridColumn: { default: "auto", [MOBILE]: "2" },
  },
  caption: { marginBlockStart: "0.9rem", color: brand.muted, fontSize: "0.9375rem", textWrap: "pretty" },

  // The rest of what it does.
  list: {
    marginBlockStart: "4rem",
    display: "grid",
    gap: "1.5rem",
  },
  item: {
    display: "grid",
    gridTemplateColumns: { default: "11rem minmax(0, 1fr)", [MOBILE]: "1fr" },
    columnGap: "1.5rem",
    rowGap: "0.2rem",
  },
  term: { fontWeight: 600 },
  def: { color: brand.muted, textWrap: "pretty" },

  actions: {
    marginBlockStart: "4rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "1.25rem",
    rowGap: "0.75rem",
    fontFamily: '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif',
  },
  button: {
    display: "inline-block",
    paddingBlock: "0.7rem",
    paddingInline: "1.2rem",
    borderRadius: "999px",
    backgroundColor: { default: brand.accent, ":hover": brand.text },
    color: { default: brand.accentText, ":hover": brand.surface },
    fontWeight: 600,
    textDecoration: "none",
    transitionProperty: "background-color, color",
    transitionDuration: "0.15s",
    outlineOffset: "3px",
  },
  also: { color: brand.muted, fontSize: "0.9375rem" },
  link: { color: brand.text, textUnderlineOffset: "0.2em", textDecorationColor: brand.border },
  footer: {
    marginBlockStart: "5rem",
    paddingBlock: "1.5rem 2rem",
    borderBlockStartWidth: "1px",
    borderBlockStartStyle: "solid",
    borderBlockStartColor: brand.border,
    color: brand.muted,
    fontSize: "0.875rem",
  },
});
