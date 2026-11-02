import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

// Rune's palette (docs/design-system.md). These defaults are the default theme's colors
// (palette() in shared/theme.ts, kept equal by tests/theme.test.ts); lib/theme.ts
// overrides them with the user's theme at runtime.
export const colors = stylex.defineVars({
  bg: { default: "#f8f5f0", [DARK]: "#171411" },
  surface: { default: "#fffdfa", [DARK]: "#211d19" },
  surfaceHover: {
    default: "color-mix(in oklab, #fffdfa, #2b211a 5%)",
    [DARK]: "color-mix(in oklab, #211d19, #f2ece3 8%)",
  },
  sidebar: { default: "color-mix(in oklab, #f8f5f0, #2b211a 4%)", [DARK]: "color-mix(in oklab, #171411, #000000 30%)" },
  border: { default: "color-mix(in oklab, #fffdfa, #2b211a 12%)", [DARK]: "color-mix(in oklab, #211d19, #f2ece3 14%)" },
  text: { default: "#2b211a", [DARK]: "#f2ece3" },
  muted: { default: "color-mix(in oklab, #2b211a, #f8f5f0 36%)", [DARK]: "color-mix(in oklab, #f2ece3, #171411 36%)" },
  accent: { default: "#c2461f", [DARK]: "#ec7748" },
  accentText: { default: "#ffffff", [DARK]: "#000000" },
  accentSoft: {
    default: "color-mix(in oklab, #fffdfa, #c2461f 12%)",
    [DARK]: "color-mix(in oklab, #211d19, #ec7748 22%)",
  },
  accentGradient: {
    default: "linear-gradient(180deg, #d9582f, #a62f19)",
    [DARK]: "linear-gradient(180deg, #f08a5d, #d9582f)",
  },
  danger: { default: "#b42346", [DARK]: "#f06b85" },
  success: { default: "#2e7d3a", [DARK]: "#5fc477" },
  warning: { default: "#9a5800", [DARK]: "#eaa63f" },
});

/** Categorical palette for charts, starting with Rune's accent. */
export const chartColors = stylex.defineVars({
  c1: { default: "#c2461f", [DARK]: "#ec7748" },
  c2: { default: "#0284c7", [DARK]: "#38bdf8" },
  c3: { default: "#6d4aff", [DARK]: "#a08cff" },
  c4: { default: "#0f9f6e", [DARK]: "#34d399" },
  c5: { default: "#db2777", [DARK]: "#f472b6" },
  c6: { default: "#ca8a04", [DARK]: "#facc15" },
});

export const space = stylex.defineVars({
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "40px",
});

export const radius = stylex.defineVars({
  sm: "6px",
  md: "10px",
  lg: "14px",
  full: "999px",
});

export const font = stylex.defineVars({
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", monospace',
  xs: "12px",
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "20px",
  xxl: "26px",
});
