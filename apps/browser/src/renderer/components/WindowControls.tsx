// The window's three buttons, first in the sidebar's top row, drawn like macOS's
// traffic lights: close, minimize and zoom (maximize). Gray while the window
// isn't focused; hovering the group shows each one's glyph, as on macOS. The
// window is frameless; it's moved by dragging the row and maximized by
// double-clicking it too. macOS keeps its own traffic lights.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { hasOwnControls } from "../lib/windowChrome";

interface Light {
  id: "close" | "minimize" | "maximize";
  label: string;
  run: () => void;
  glyph: string;
}

const LIGHTS: Light[] = [
  { id: "close", label: "Close", run: () => window.rune.window.close(), glyph: "M2.5 2.5l5 5M7.5 2.5l-5 5" },
  { id: "minimize", label: "Minimize", run: () => window.rune.window.minimize(), glyph: "M2 5h6" },
  {
    id: "maximize",
    label: "Maximize",
    run: () => window.rune.window.toggleMaximize(),
    // macOS's zoom glyph: two triangles pointing apart.
    glyph: "M3 7V3.6L6.4 7zM7 3v3.4L3.6 3z",
  },
];

export function WindowControls() {
  const [focused, setFocused] = createSignal(document.hasFocus());
  const onFocus = () => setFocused(true);
  const onBlur = () => setFocused(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  onCleanup(() => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  });
  const [hover, setHover] = createSignal(false);
  // Hovered, they're in color with their glyphs even while the window isn't focused.
  const blurred = () => !focused() && !hover();
  const showGlyph = () => hover();
  return (
    <Show when={hasOwnControls}>
      <div
        role="group"
        aria-label="Window"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        {...stylex.attrs(styles.group)}
        data-window-controls
      >
        <For each={LIGHTS}>
          {(light) => (
            <button
              type="button"
              title={light.label}
              aria-label={light.label}
              onClick={light.run}
              // Double-clicking the buttons isn't double-clicking the row (which maximizes).
              onDblClick={(e) => e.stopPropagation()}
              {...stylex.attrs(styles.button)}
              data-window-control={light.id}
            >
              <span {...stylex.attrs(styles.light, styles[light.id], blurred() && styles.lightBlurred)}>
                <svg
                  viewBox="0 0 10 10"
                  width="8"
                  height="8"
                  {...stylex.attrs(styles.glyph, showGlyph() && styles.glyphOn)}
                  aria-hidden="true"
                >
                  <path
                    d={light.glyph}
                    stroke="currentColor"
                    fill={light.id === "maximize" ? "currentColor" : "none"}
                    stroke-width={light.id === "maximize" ? 0 : 1.2}
                    stroke-linecap="round"
                  />
                </svg>
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

const styles = stylex.create({
  group: { display: "flex", alignItems: "center", flexShrink: 0, height: 30, marginRight: 4 },
  // A bigger target than the light itself: 12px lights, 8px apart, like macOS.
  button: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 20,
    height: 30,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "default",
  },
  // Fixed colors: they're the system's, whatever the theme.
  light: {
    display: "grid",
    placeItems: "center",
    width: 12,
    height: 12,
    borderRadius: "50%",
    boxShadow: "inset 0 0 0 0.5px rgb(0 0 0 / 0.16)",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  close: { backgroundColor: "#ff5f57", color: "#4d0000" },
  minimize: { backgroundColor: "#febc2e", color: "#5a3a00" },
  maximize: { backgroundColor: "#28c840", color: "#0a4a12" },
  lightBlurred: { backgroundColor: "rgb(128 128 128 / 0.3)" },
  glyph: { opacity: 0, transitionProperty: "opacity", transitionDuration: "100ms" },
  glyphOn: { opacity: 0.7 },
});
