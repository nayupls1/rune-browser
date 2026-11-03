// Runtime theming. StyleX compiles `defineVars` to CSS custom properties, so the
// theme is applied by overriding those properties on the document root.
import { createSignal } from "solid-js";
import type { GlobalTheme, Theme } from "../../shared/settings";
import { palette, resolveMode, type Mode } from "../../shared/theme";
import { colors, font, radius } from "../theme.stylex";

/** `var(--x1abc)` → `--x1abc` */
const varName = (ref: string) => /var\((--[^),\s]+)/.exec(ref)?.[1] ?? ref;

/** CSS custom properties (StyleX var name → value) for a theme. */
export function themeVars(theme: Omit<Theme, "mode">, mode: Mode): Record<string, string> {
  const p = palette(theme, mode);
  const vars: Record<string, string> = {
    [colors.bg]: p.bg,
    [colors.surface]: p.surface,
    [colors.surfaceHover]: p.surfaceHover,
    [colors.sidebar]: p.sidebar,
    [colors.border]: p.border,
    [colors.text]: p.text,
    [colors.muted]: p.muted,
    [colors.accent]: p.accent,
    [colors.accentText]: p.accentText,
    [colors.accentSoft]: p.accentSoft,
    [colors.accentGradient]: p.accentGradient,
    [colors.danger]: p.danger,
    [colors.success]: p.success,
    [colors.warning]: p.warning,
    [radius.sm]: p.radiusSm,
    [radius.md]: p.radiusMd,
    [radius.lg]: p.radiusLg,
    [font.sans]: p.font,
  };
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [varName(k), v]));
}

export { resolveMode };

// --- System preference ---------------------------------------------------------------

const media = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(media.matches);
media.addEventListener("change", (e) => setSystemDark(e.matches));
export { systemDark };

// --- Global theme ----------------------------------------------------------------------

const CACHE_KEY = "rune.theme";
let applied: string[] = [];

/** Applies the global theme to the document root. */
export function applyGlobalTheme(theme: GlobalTheme) {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  const mode = resolveMode(theme, systemDark());
  const vars = themeVars(theme, mode);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = mode;
  applied = Object.keys(vars);
  localStorage.setItem(CACHE_KEY, JSON.stringify(theme));
}

/** Applies the last used theme before settings arrive from the server, so there is no flash. */
export function applyCachedTheme() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyGlobalTheme(JSON.parse(cached) as GlobalTheme);
  } catch {
    // ignore a corrupt cache
  }
}
