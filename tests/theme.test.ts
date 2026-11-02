// Rune's palette (docs/design-system.md): the default theme matches the icon, stays
// readable in light and dark, and Rune Browser's built-in defaults are the same colors.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtInMods } from "../src/server/mods/gallery";
import {
  base,
  brand,
  contrast,
  palette,
  readableOn,
  themePresets,
  tokensCss,
  type Mode,
  type Palette,
} from "../src/shared/theme";

// --- color-mix(in oklab, …) → hex, to measure the derived colors ---------------------------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: [number, number, number]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** A palette value as hex: either hex already or `color-mix(in oklab, #a, #b p%)`. */
function resolve(value: string): string {
  const mix = /^color-mix\(in oklab, (#[0-9a-f]{6}), (#[0-9a-f]{6}) (\d+)%\)$/i.exec(value);
  if (!mix) {
    expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    return value;
  }
  const [a, b, t] = [oklab(mix[1]!), oklab(mix[2]!), Number(mix[3]) / 100];
  return fromOklab([0, 1, 2].map((i) => a[i]! * (1 - t) + b[i]! * t) as [number, number, number]);
}

const ratio = (p: Palette, fg: keyof Palette, bg: keyof Palette) => contrast(resolve(p[fg]), resolve(p[bg]));

// --- Tests ------------------------------------------------------------------------------------

const modes: Mode[] = ["light", "dark"];

describe("Rune's palette", () => {
  test("the default theme is the icon's colors", () => {
    const icon = readFileSync(join(import.meta.dir, "../build/icon.svg"), "utf8");
    for (const color of [...brand.rune, ...brand.cream]) expect(icon).toContain(`stop-color="${color}"`);
    const light = palette({}, "light");
    expect(light.bg).toBe(brand.cream[0]);
    expect(light.accentGradient).toBe(`linear-gradient(180deg, ${brand.rune[0]}, ${brand.rune[1]})`);
    // The accent is the rune's orange: between its two stops in every channel.
    const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const [top, bottom, accent] = [brand.rune[0], brand.rune[1], light.accent].map(channels) as number[][];
    for (const [i, c] of accent!.entries()) {
      expect(c).toBeLessThanOrEqual(top![i]!);
      expect(c).toBeGreaterThanOrEqual(bottom![i]!);
    }
  });

  test("has a light and a dark version of every color", () => {
    for (const key of Object.keys(base.light) as (keyof typeof base.light)[]) {
      expect(base.dark[key]).toBeDefined();
      expect(base.dark[key]).not.toEqual(base.light[key]);
    }
  });

  for (const mode of modes) {
    test(`text and controls are readable (${mode})`, () => {
      const p = palette({}, mode);
      for (const bg of ["bg", "surface", "sidebar", "surfaceHover"] as const) {
        expect(ratio(p, "text", bg)).toBeGreaterThanOrEqual(7);
        expect(ratio(p, "muted", bg)).toBeGreaterThanOrEqual(4.5);
      }
      for (const fg of ["accent", "danger", "success", "warning"] as const) {
        expect(ratio(p, fg, "bg")).toBeGreaterThanOrEqual(4.5);
        expect(ratio(p, fg, "surface")).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(p, "accentText", "accent")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p, "text", "accentSoft")).toBeGreaterThanOrEqual(7);
      expect(ratio(p, "accent", "accentSoft")).toBeGreaterThanOrEqual(3);
      // Error banners put the accent's text color on the danger color.
      expect(ratio(p, "accentText", "danger")).toBeGreaterThanOrEqual(4.5);
      // Borders are visible, and the accent isn't mistaken for an error.
      expect(ratio(p, "border", "surface")).toBeGreaterThan(1.2);
      expect(p.accent).not.toBe(p.danger);
    });
  }

  test("an accent's text color is readable on it, for the presets and any color", () => {
    const accents = [
      ...themePresets.flatMap((t) => (t.theme.accent ? [t.theme.accent] : [])),
      ...builtInMods.flatMap((m) => (m.theme?.accent ? [m.theme.accent] : [])),
    ];
    for (const accent of accents) expect(contrast(readableOn(accent), accent)).toBeGreaterThanOrEqual(4.5);
    // White wherever it's readable: the light accent keeps its white text.
    expect(readableOn(base.light.accent)).toBe("#ffffff");
    for (let i = 0; i < 4096; i += 7) {
      const hex = `#${[i >> 8, (i >> 4) & 15, i & 15].map((c) => c.toString(16).repeat(2)).join("")}`;
      expect(contrast(readableOn(hex), hex)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("a custom theme replaces the palette, and an empty one goes back to it", () => {
    const custom = palette({ accent: "#0284c7", background: "#ffffff" }, "light");
    expect(custom.accent).toBe("#0284c7");
    expect(custom.bg).toBe("#ffffff");
    expect(custom.accentGradient).toContain("#0284c7");
    expect(custom.accentText).toBe(readableOn("#0284c7"));
    expect(palette({}, "light")).toEqual(palette({ radius: "md", font: "sans" }, "light"));
    expect(themePresets[0]).toEqual({ name: "Default", theme: {} });
  });

  test("Rune Browser's built-in colors are the default theme", () => {
    // theme.stylex.ts holds the colors used before the theme is applied and in safe mode.
    const source = readFileSync(join(import.meta.dir, "../src/renderer/theme.stylex.ts"), "utf8");
    const block = source.slice(
      source.indexOf("export const colors"),
      source.indexOf("});", source.indexOf("export const colors")),
    );
    const vars = new Map(
      [...block.matchAll(/(\w+): \{\s*default: "([^"]+)",\s*\[DARK\]: "([^"]+)",?\s*\}/g)].map((m) => [
        m[1]!,
        [m[2]!, m[3]!],
      ]),
    );
    const [light, dark] = [palette({}, "light"), palette({}, "dark")];
    const keys = Object.keys(light).filter((k) => !/^(radius|font)/.test(k)) as (keyof Palette)[];
    expect([...vars.keys()].sort()).toEqual([...keys].sort());
    for (const key of keys) expect(vars.get(key)).toEqual([light[key], dark[key]]);
  });

  test("new apps start with the palette as design tokens", () => {
    const css = tokensCss({ mode: "system" });
    for (const mode of modes) {
      const p = palette({}, mode);
      expect(css).toContain(`--color-accent: ${p.accent};`);
      expect(css).toContain(`--color-bg: ${p.bg};`);
      expect(css).toContain(`--color-accent-gradient: ${p.accentGradient};`);
      expect(css).toContain(`--color-success: ${p.success};`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });
});
