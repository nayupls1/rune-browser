import * as stylex from "@stylexjs/stylex";
import { brand } from "../lib/brand.stylex";

const draw = stylex.keyframes({
  from: { strokeDashoffset: 1 },
  to: { strokeDashoffset: 0 },
});

export const mark = stylex.create({
  svg: { display: "block", height: "auto", overflow: "visible" },
  top: { stopColor: brand.runeTop },
  bottom: { stopColor: brand.runeBottom },
  // The rune drawn in one stroke, the way it's written.
  draw: {
    strokeDasharray: 1,
    strokeDashoffset: { default: 1, "@media (prefers-reduced-motion: reduce)": 0 },
    animationName: { default: draw, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1.6s",
    animationDelay: "0.15s",
    animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
    animationFillMode: "forwards",
  },
});
