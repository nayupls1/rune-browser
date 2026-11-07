import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

// Rune's palette (apps/browser/docs/design-system.md), following the OS between light and dark.
export const brand = stylex.defineVars({
  bg: { default: "#f8f5f0", [DARK]: "#171411" },
  surface: { default: "#fffdfa", [DARK]: "#211d19" },
  sunken: { default: "color-mix(in oklab, #f8f5f0, #2b211a 4%)", [DARK]: "color-mix(in oklab, #171411, #000000 30%)" },
  border: { default: "color-mix(in oklab, #fffdfa, #2b211a 12%)", [DARK]: "color-mix(in oklab, #211d19, #f2ece3 14%)" },
  text: { default: "#2b211a", [DARK]: "#f2ece3" },
  muted: { default: "color-mix(in oklab, #2b211a, #f8f5f0 36%)", [DARK]: "color-mix(in oklab, #f2ece3, #171411 36%)" },
  accent: { default: "#c2461f", [DARK]: "#ec7748" },
  accentText: { default: "#ffffff", [DARK]: "#000000" },
  accentSoft: {
    default: "color-mix(in oklab, #fffdfa, #c2461f 12%)",
    [DARK]: "color-mix(in oklab, #211d19, #ec7748 22%)",
  },
  runeTop: { default: "#d9582f", [DARK]: "#f08a5d" },
  runeBottom: { default: "#a62f19", [DARK]: "#d9582f" },
});
