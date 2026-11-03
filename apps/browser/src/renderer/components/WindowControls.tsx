// The window's close button, first in the sidebar's top row, like macOS's red
// traffic light (gray while the window isn't focused, × on hover). The window
// is frameless; it's moved by dragging the row and maximized by double-clicking
// it. macOS keeps its own traffic lights.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, Show } from "solid-js";
import { hasOwnControls } from "../lib/windowChrome";

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
  // Hovered, it's red with its × even while the window isn't focused.
  const blurred = () => !focused() && !hover();
  const showGlyph = () => hover();
  return (
    <Show when={hasOwnControls}>
      <button
        type="button"
        title="Close"
        aria-label="Close"
        onClick={() => window.rune.window.close()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        {...stylex.attrs(styles.button)}
        data-window-controls
      >
        <span {...stylex.attrs(styles.light, blurred() && styles.lightBlurred)}>
          <svg
            viewBox="0 0 8 8"
            width="6"
            height="6"
            {...stylex.attrs(styles.glyph, showGlyph() && styles.glyphOn)}
            aria-hidden="true"
          >
            <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </span>
      </button>
    </Show>
  );
}

const styles = stylex.create({
  // A bigger target than the light itself.
  button: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 30,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "default",
  },
  light: {
    display: "grid",
    placeItems: "center",
    width: 12,
    height: 12,
    borderRadius: "50%",
    backgroundColor: "#ff5f57",
    boxShadow: "inset 0 0 0 0.5px rgb(0 0 0 / 0.18)",
    color: "#4d0000",
  },
  lightBlurred: { backgroundColor: "rgb(128 128 128 / 0.35)" },
  glyph: { opacity: 0 },
  glyphOn: { opacity: 0.75 },
});
