// The window has no title bar (main/index.ts). Its close button is first in
// the sidebar's top row (components/WindowControls.tsx; macOS: the system's
// traffic lights, top left), and the renderer's top bars (anything marked data-titlebar) are
// where the window is dragged. Here: keeping a bar's content out from under
// the buttons, and double-click to maximize where the system doesn't.

const bridge = window.rune.window;
const isMac = bridge.platform === "darwin";
/** Room for the traffic lights on macOS. */
const MAC_BUTTONS = 78;

export const hasOwnControls = !isMac;

/** The space the window's buttons take at the left and right of the top edge. */
function buttons() {
  // Elsewhere the buttons are in the sidebar's top row (components/TopBar.tsx), not over anything.
  return isMac ? { left: MAC_BUTTONS, right: 0, height: 44 } : { left: 0, right: 0, height: 44 };
}

/** Pads the top bars that run under the window's buttons. */
function layout() {
  const { left, right, height } = buttons();
  for (const bar of document.querySelectorAll<HTMLElement>("[data-titlebar]")) {
    const r = bar.getBoundingClientRect();
    const top = r.top < Math.max(height, 1) && r.height > 0;
    const underRight = top && right > 0 && r.right >= window.innerWidth - 1;
    const underLeft = top && left > 0 && r.left <= 1;
    const pad = (side: "Left" | "Right", on: boolean, size: number) => {
      const key = `padding${side}` as const;
      const base = bar.dataset[`base${side}`] ?? (bar.dataset[`base${side}`] = getComputedStyle(bar)[key]);
      const want = on ? `calc(${base} + ${size}px)` : "";
      if (bar.style[key] !== want) bar.style[key] = want;
    };
    pad("Right", underRight, right);
    pad("Left", underLeft, left);
  }
}

let queued = false;
const schedule = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    layout();
  });
};

/** Starts it (once, from App). */
export function startWindowChrome() {
  const resize = new ResizeObserver(schedule);
  const watched = new WeakSet<Element>();
  const watchBars = () => {
    for (const bar of document.querySelectorAll("[data-titlebar]")) {
      if (watched.has(bar)) continue;
      watched.add(bar);
      resize.observe(bar);
    }
    schedule();
  };
  // Bars come and go with tabs, panels and pages.
  new MutationObserver(watchBars).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  watchBars();

  // A frameless window maximizes on double-click only if the app does it (macOS does it itself).
  if (!isMac) {
    document.addEventListener("dblclick", (e) => {
      const target = e.target as HTMLElement | null;
      if (
        !target?.closest("[data-titlebar]") ||
        target.closest("button, input, select, textarea, a, [role=button], [role=switch], [role=tab], webview")
      )
        return;
      bridge.toggleMaximize();
    });
  }
}
