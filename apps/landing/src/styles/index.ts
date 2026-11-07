// The index while the website has several designs: one link per variant.
import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";

export const s = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: brand.bg,
    color: brand.text,
    fontFamily: '"Schibsted Grotesk Variable", ui-sans-serif, system-ui, sans-serif',
    lineHeight: 1.5,
    paddingInline: "1.25rem",
  },
  main: { maxWidth: "36rem", marginInline: "auto", paddingBlock: "5rem" },
  title: { marginBlockStart: "1.5rem", fontSize: "1.75rem", fontWeight: 600, letterSpacing: "-0.02em" },
  intro: { marginBlockStart: "0.5rem", color: brand.muted },
  list: { marginBlockStart: "2.5rem", display: "grid", gap: "0.5rem" },
  link: {
    display: "block",
    paddingBlock: "0.9rem",
    paddingInline: "1rem",
    borderRadius: "10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: brand.border, ":hover": brand.accent },
    backgroundColor: brand.surface,
    textDecoration: "none",
    outlineOffset: "2px",
  },
  name: { fontWeight: 600 },
  about: { color: brand.muted, fontSize: "0.9375rem" },
});
