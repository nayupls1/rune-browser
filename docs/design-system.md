# Design system

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Design system](design-system.md) · [Development](development.md) · [Releasing](releasing.md)

Rune Browser's look comes from its icon (`build/icon.svg`): a burnt orange rune on warm cream. The same palette is the browser's own UI, its internal pages (Settings, History, Mods…) and the apps it builds, so the icon, the app and what it makes look like one product.

## Palette

The colors live in `src/shared/theme.ts` (`brand`, `base` and `palette()`); everything else uses them:

- **The browser's UI** uses the StyleX variables in `src/renderer/theme.stylex.ts` (`colors.accent`, `colors.bg`…). Their defaults are the default theme, so the app looks right before settings load and in safe mode; `lib/theme.ts` sets them from the user's theme at runtime.
- **Apps** start with `src/tokens.css`, the same colors as CSS custom properties (`--color-accent`, `--color-bg`…; `tokensCss()`), following the OS between light and dark.
- **Web pages** only see the light accent, on what Rune Browser draws in them (the element picker, page-change buttons).

`tests/theme.test.ts` checks that the default theme is the icon's colors, that the StyleX defaults match it, and that text stays readable.

### Brand

| Color                   | Light                             | Dark                  |
| ----------------------- | --------------------------------- | --------------------- |
| Rune (accent gradient)  | `#d9582f` → `#a62f19`, the icon's | `#f08a5d` → `#d9582f` |
| Cream (icon background) | `#f8f5f0` → `#e5ded3`, the icon's |                       |

### Tokens

| Token (StyleX / CSS)                         | Light                | Dark                 | Used for                                               |
| -------------------------------------------- | -------------------- | -------------------- | ------------------------------------------------------ |
| `bg` / `--color-bg`                          | `#f8f5f0`            | `#171411`            | The window, page backgrounds                           |
| `surface` / `--color-surface`                | `#fffdfa`            | `#211d19`            | Cards, inputs, panels, menus                           |
| `surfaceHover` / `--color-surface-hover`     | surface + 5% text    | surface + 8% text    | Hovered rows and buttons                               |
| `sidebar`                                    | bg + 4% text         | bg + 30% black       | The tab sidebar                                        |
| `border` / `--color-border`                  | surface + 12% text   | surface + 14% text   | Borders, dividers                                      |
| `text` / `--color-text`                      | `#2b211a`            | `#f2ece3`            | Text                                                   |
| `muted` / `--color-muted`                    | text + 36% bg        | text + 36% bg        | Secondary text                                         |
| `accent` / `--color-accent`                  | `#c2461f`            | `#ec7748`            | Primary buttons, links, focus, selection               |
| `accentText` / `--color-accent-text`         | `#ffffff`            | `#000000`            | Text on the accent                                     |
| `accentSoft` / `--color-accent-soft`         | surface + 12% accent | surface + 22% accent | Selected rows, focus rings, highlights                 |
| `accentGradient` / `--color-accent-gradient` | the rune, light      | the rune, dark       | Decoration only: the icon's gradient, never under text |
| `success` / `--color-success`                | `#2e7d3a`            | `#5fc477`            | Running, saved, added lines                            |
| `warning` / `--color-warning`                | `#9a5800`            | `#eaa63f`            | Starting, needs attention                              |
| `danger` / `--color-danger`                  | `#b42346`            | `#f06b85`            | Errors, crashes, destructive actions, removed lines    |

The window's background is the cream's top stop; the full cream gradient is only in the icon. The accent gradient is for decoration (marks, illustrations, apps' brand moments): its lighter top stop doesn't hold white text at 4.5:1, so text goes on the flat accent. A custom accent gets a gradient of its own, from 14% lighter to 18% darker.

Mixed colors are `color-mix(in oklab, …)`, so they follow a custom theme too. The light accent sits between the rune's two stops, dark enough for white text; the dark accent is lighter, for dark backgrounds, and takes black text. Danger leans to crimson so errors aren't mistaken for the accent.

`chartColors` (`c1`–`c6`) is a categorical palette for charts, starting with the accent.

### Readability

In both modes, text is at least 7:1 on every background, and secondary text, the accent and the status colors at least 4.5:1 (WCAG AA). Text on the accent is white wherever white is readable and black otherwise, also for a custom accent.

## Customizing

Settings → Theme changes the accent, background, surfaces, text, corners and font, or applies a preset. Any color left unset is the palette's, and the color fields show it. The **Default** preset clears them all, back to Rune's palette. Mods can bring a theme of their own; removing the mod brings the previous one back.
