// The buttons inside the address bar (site info, zoom, bookmark star, the agent's response changes, page
// changes, extensions, downloads): one size, icon size, corner and hover, so the bar reads as one row. The
// address row is 32px high with horizontal tabs and 36px in the vertical sidebar; 24px fits both with room
// above and below.
import * as stylex from "@stylexjs/stylex";
import { colors, font, radius } from "../theme.stylex";

export const ADDRESS_BUTTON_SIZE = 24;
export const ADDRESS_ICON_SIZE = 14;

const ink = (percent: number) => `color-mix(in oklab, ${colors.text} ${percent}%, transparent)`;

export const addressButton = stylex.create({
  button: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: ADDRESS_BUTTON_SIZE,
    height: ADDRESS_BUTTON_SIZE,
    padding: 0,
    borderWidth: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": ink(9), ":disabled": "transparent" },
    color: { default: ink(58), ":hover": colors.text },
    opacity: { default: 1, ":disabled": 0.4 },
    cursor: { default: "pointer", ":disabled": "default" },
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: -2,
    transitionProperty: "background-color, color",
    transitionDuration: "120ms",
  },
  // Its popover is open.
  on: {
    backgroundColor: { default: ink(11), ":hover": ink(11) },
    color: { default: colors.text, ":hover": colors.text },
  },
  // On, in the accent: something this page has turned on (the page's changes, a site using the camera…).
  accent: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    color: { default: colors.accent, ":hover": colors.accent },
  },
  // With a number or a word next to its icon (zoom, the agent's response changes): as high, as wide as it needs.
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    width: "auto",
    minWidth: ADDRESS_BUTTON_SIZE,
    paddingInline: 6,
    fontFamily: font.sans,
    fontSize: 11,
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
});
