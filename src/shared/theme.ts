// Theme palette, shared by the renderer (Rune Browser's own look) and the server (the
// design tokens every new app starts with).
import type { GlobalTheme, Theme } from "./settings";

export type Mode = "light" | "dark";

/**
 * Rune's palette, taken from the app icon (build/icon.svg): its burnt orange rune and
 * warm cream background. docs/design-system.md documents it; the default theme is these
 * colors, and a theme's own colors replace them.
 */
export const brand = {
  /** The icon's rune, top to bottom. */
  rune: ["#d9582f", "#a62f19"],
  /** The icon's background, top to bottom. */
  cream: ["#f8f5f0", "#e5ded3"],
} as const;

interface Base {
  bg: string;
  surface: string;
  text: string;
  accent: string;
  /** Top and bottom of the accent gradient. */
  gradient: readonly [string, string];
  danger: string;
  success: string;
  warning: string;
}

export const base: Record<Mode, Base> = {
  light: {
    bg: brand.cream[0],
    surface: "#fffdfa",
    text: "#2b211a",
    // Between the rune's two stops, dark enough for white text on it.
    accent: "#c2461f",
    gradient: brand.rune,
    danger: "#b42346",
    success: "#2e7d3a",
    warning: "#9a5800",
  },
  dark: {
    bg: "#171411",
    surface: "#211d19",
    text: "#f2ece3",
    accent: "#ec7748",
    gradient: ["#f08a5d", "#d9582f"],
    danger: "#f06b85",
    success: "#5fc477",
    warning: "#eaa63f",
  },
};

const radii = {
  none: ["0px", "0px", "0px"],
  sm: ["4px", "6px", "8px"],
  md: ["6px", "10px", "14px"],
  lg: ["10px", "16px", "22px"],
} as const;

export const fonts = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, "Iowan Old Style", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", system-ui, sans-serif',
} as const;

const mix = (a: string, b: string, pct: number) => `color-mix(in oklab, ${a}, ${b} ${pct}%)`;

/** WCAG relative luminance of a hex color. */
function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two hex colors (1 to 21). */
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** White text on the given color when it's readable (4.5:1), otherwise whichever of white and black reads better. */
export function readableOn(hex: string) {
  const white = contrast(hex, "#ffffff");
  return white >= 4.5 || white >= contrast(hex, "#000000") ? "#ffffff" : "#000000";
}

export interface Palette {
  bg: string;
  surface: string;
  surfaceHover: string;
  sidebar: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  accentGradient: string;
  danger: string;
  success: string;
  warning: string;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  font: string;
}

export function palette(theme: Omit<Theme, "mode">, mode: Mode): Palette {
  const b = base[mode];
  const bg = theme.background ?? b.bg;
  const surface = theme.surface ?? b.surface;
  const text = theme.text ?? b.text;
  const accent = theme.accent ?? b.accent;
  const dark = mode === "dark";
  // A custom accent gets a gradient of its own, lighter on top and darker below, like the icon's.
  const [top, bottom] = theme.accent ? [mix(accent, "#ffffff", 14), mix(accent, "#000000", 18)] : b.gradient;
  const [radiusSm, radiusMd, radiusLg] = radii[theme.radius ?? "md"];
  return {
    bg,
    surface,
    surfaceHover: mix(surface, text, dark ? 8 : 5),
    sidebar: dark ? mix(bg, "#000000", 30) : mix(bg, text, 4),
    border: mix(surface, text, dark ? 14 : 12),
    text,
    muted: mix(text, bg, 36),
    accent,
    accentText: readableOn(accent),
    accentSoft: mix(surface, accent, dark ? 22 : 12),
    accentGradient: `linear-gradient(180deg, ${top}, ${bottom})`,
    danger: b.danger,
    success: b.success,
    warning: b.warning,
    radiusSm,
    radiusMd,
    radiusLg,
    font: fonts[theme.font ?? "sans"],
  };
}

export const resolveMode = (theme: GlobalTheme, systemDark: boolean): Mode =>
  theme.mode === "system" ? (systemDark ? "dark" : "light") : theme.mode;

/** Presets shown in Settings. */
export const themePresets: { name: string; theme: Omit<GlobalTheme, "mode"> & { mode?: GlobalTheme["mode"] } }[] = [
  { name: "Default", theme: {} },
  { name: "Ocean", theme: { accent: "#0284c7" } },
  { name: "Forest", theme: { accent: "#15803d", radius: "sm" } },
  { name: "Rose", theme: { accent: "#e11d48", radius: "lg" } },
  { name: "Amber", theme: { accent: "#d97706" } },
  { name: "Graphite", theme: { accent: "#52525b", radius: "sm" } },
  {
    name: "Midnight",
    theme: { mode: "dark", accent: "#7c9cff", background: "#0b1020", surface: "#121a2e", text: "#e3e8f7" },
  },
  {
    name: "Paper",
    theme: {
      mode: "light",
      accent: "#9a3412",
      background: "#f6f1e7",
      surface: "#fffdf8",
      text: "#2b2118",
      font: "serif",
    },
  },
  {
    name: "Terminal",
    theme: {
      mode: "dark",
      accent: "#22c55e",
      background: "#0a0a0a",
      surface: "#111111",
      text: "#d4d4d4",
      font: "mono",
      radius: "none",
    },
  },
];

function tokenBlock(p: Palette, indent: string) {
  const lines = [
    ["--color-bg", p.bg],
    ["--color-surface", p.surface],
    ["--color-surface-hover", p.surfaceHover],
    ["--color-border", p.border],
    ["--color-text", p.text],
    ["--color-muted", p.muted],
    ["--color-accent", p.accent],
    ["--color-accent-text", p.accentText],
    ["--color-accent-soft", p.accentSoft],
    ["--color-accent-gradient", p.accentGradient],
    ["--color-danger", p.danger],
    ["--color-success", p.success],
    ["--color-warning", p.warning],
    ["--radius-sm", p.radiusSm],
    ["--radius-md", p.radiusMd],
    ["--radius-lg", p.radiusLg],
    ["--font-sans", p.font],
    ["--font-mono", fonts.mono],
  ];
  return lines.map(([k, v]) => `${indent}${k}: ${v};`).join("\n");
}

/**
 * The design tokens a new app starts with (tokens.css): CSS custom properties
 * from the user's theme. With the "system" mode the app follows the OS between
 * light and dark, like Rune Browser does.
 */
export function tokensCss(theme: GlobalTheme): string {
  const head = `/* Design tokens. Rune Browser generated them from your theme; change them freely. */\n`;
  const shared = `\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 16px;\n  --space-5: 24px;\n  --space-6: 40px;\n  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.06);\n  --shadow-md: 0 4px 16px rgb(0 0 0 / 0.1);\n`;
  if (theme.mode !== "system") {
    return `${head}:root {\n  color-scheme: ${theme.mode};\n${tokenBlock(palette(theme, theme.mode), "  ")}${shared}}\n`;
  }
  return (
    `${head}:root {\n  color-scheme: light dark;\n${tokenBlock(palette(theme, "light"), "  ")}${shared}}\n\n` +
    `@media (prefers-color-scheme: dark) {\n  :root {\n${tokenBlock(palette(theme, "dark"), "    ")}\n  }\n}\n`
  );
}
