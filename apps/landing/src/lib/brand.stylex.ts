import * as stylex from "@stylexjs/stylex";

// Rune's light palette (apps/browser/docs/design-system.md). The website is light only.
export const brand = stylex.defineVars({
  bg: "#f8f5f0",
  surface: "#fffdfa",
  // The browser's own sidebar color, for panels that hold its UI.
  sunken: "color-mix(in oklab, #f8f5f0, #2b211a 4%)",
  border: "color-mix(in oklab, #fffdfa, #2b211a 12%)",
  line: "color-mix(in oklab, #fffdfa, #2b211a 7%)",
  text: "#2b211a",
  muted: "color-mix(in oklab, #2b211a, #f8f5f0 36%)",
  accent: "#c2461f",
  accentText: "#ffffff",
  accentSoft: "color-mix(in oklab, #fffdfa, #c2461f 12%)",
  runeTop: "#d9582f",
  runeBottom: "#a62f19",
  // A warm shadow for screenshots and floating UI, from the text color.
  shadow: "0 1px 2px rgba(43, 33, 26, 0.06), 0 24px 48px -24px rgba(43, 33, 26, 0.28)",
});
