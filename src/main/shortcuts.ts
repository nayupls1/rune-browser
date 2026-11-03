// Keyboard shortcuts pressed while a page (web tab, app preview) has the
// focus. Keys the browser reserves go straight to the Rune Browser window; the
// rest go to the page first, like in Chromium: it's given the key, and only
// when it doesn't use it (preventDefault) does the window run the shortcut.
// Keys pressed in the window itself are the renderer's (lib/shortcuts.ts),
// which also tells this one the keymap (the user can change it in Settings).
import { ipcMain, Menu, type Input, type WebContents } from "electron";
import {
  keymapOf,
  keyPlatform,
  legacyKeyCode,
  matchShortcut,
  mouseComboOf,
  resolveBindings,
  type ShortcutDef,
} from "../shared/shortcuts";
import type { ShortcutEvent } from "../shared/api";
import type { AppWindows } from "./windows";

const platform = keyPlatform(process.platform);

/** How long a busy page may take to say whether it used a key before the shortcut runs anyway. */
const PAGE_TIMEOUT_MS = 500;

/**
 * Hands the key to the page as a keydown on what has the focus (inside
 * same-origin frames and shadow roots too); true if the page used it. The
 * page's own key handlers see it like a real key press, including the
 * keyCode older shortcut libraries read.
 */
function dispatchScript(input: Input) {
  const init = {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
    metaKey: input.meta,
    repeat: input.isAutoRepeat,
    location: input.location ?? 0,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const keyCode = legacyKeyCode(input.key, input.code);
  return `(() => {
    let target = document.activeElement;
    try {
      for (;;) {
        while (target && target.shadowRoot && target.shadowRoot.activeElement) target = target.shadowRoot.activeElement;
        const inner = target && target.contentDocument && target.contentDocument.activeElement;
        if (!inner) break;
        target = inner;
      }
    } catch {}
    target = target || document.body || document.documentElement;
    if (!target) return false;
    const event = new KeyboardEvent("keydown", ${JSON.stringify(init)});
    for (const name of ["keyCode", "which"]) Object.defineProperty(event, name, { get: () => ${keyCode} });
    return !target.dispatchEvent(event);
  })()`;
}

async function pageUsesKey(contents: WebContents, input: Input) {
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), PAGE_TIMEOUT_MS));
  try {
    return (await Promise.race([contents.executeJavaScript(dispatchScript(input)), timeout])) === true;
  } catch {
    return false;
  }
}

export function setupShortcuts(windows: AppWindows) {
  let bindings: Record<string, readonly string[]> = resolveBindings(platform);
  let keymap = keymapOf(bindings);
  /** A shortcut pressed in a page runs in the window that page is in. */
  const send = (contents: WebContents, event: ShortcutEvent) =>
    windows.of(contents)?.webContents.send("rune:shortcut", event);

  /** A menu item runs its shortcut in the window in front. */
  const runInWindow = (id: string) =>
    windows.current()?.webContents.send("rune:shortcut", { id } satisfies ShortcutEvent);

  ipcMain.on("rune:shortcuts", (event, next: unknown) => {
    if (!windows.isUi(event.sender) || !next || typeof next !== "object") return;
    const valid: Record<string, string[]> = {};
    for (const [id, keys] of Object.entries(next))
      if (Array.isArray(keys)) valid[id] = keys.filter((k): k is string => typeof k === "string").slice(0, 10);
    bindings = valid;
    keymap = keymapOf(valid);
    setupMenu(runInWindow, valid);
  });

  setupMenu(runInWindow, bindings);

  return {
    /** A shortcut's first keys as an Electron accelerator (shown in menus), if it has any. */
    accelerator: (id: string) => bindings[id]?.find((k) => !/(Browser|Mouse)\w+$/.test(k)),

    /** The shortcut a key in a page is for (keyDown only). */
    match: (input: Input): ShortcutDef | undefined =>
      input.type === "keyDown" ? matchShortcut(keymap, toKey(input)) : undefined,

    /**
     * The mouse's back and forward buttons in a page: pages don't go back or
     * forward on their own in a webview, so they're shortcuts like Alt+Left.
     */
    handlePageMouse(contents: WebContents, event: Electron.InputEvent) {
      if (event.type !== "mouseUp") return;
      const button = (event as Electron.MouseInputEvent).button as string | undefined;
      const mods = new Set(event.modifiers ?? []);
      const pressed = mouseComboOf(button === "back" ? 3 : button === "forward" ? 4 : -1, {
        ctrl: mods.has("control") || mods.has("ctrl"),
        alt: mods.has("alt"),
        shift: mods.has("shift"),
        meta: mods.has("meta") || mods.has("command") || mods.has("cmd"),
      });
      const def = pressed ? keymap.get(pressed) : undefined;
      if (def) send(contents, { id: def.id, contentsId: contents.id });
    },

    /**
     * A key pressed in a page: runs its shortcut in the window when it's one
     * (reserved ones right away, the others once the page passed on it). True
     * if the page doesn't get the key as it was pressed.
     */
    handlePageInput(contents: WebContents, input: Input, def: ShortcutDef) {
      const event = { id: def.id, contentsId: contents.id };
      if (def.page === "passive") {
        send(contents, event);
        return false;
      }
      if (def.page === "reserved") {
        send(contents, event);
        return true;
      }
      void pageUsesKey(contents, input).then((used) => {
        if (!used && !contents.isDestroyed()) send(contents, event);
      });
      return true;
    },
  };
}

const toKey = (input: Input) => ({
  key: input.key,
  code: input.code,
  ctrl: input.control,
  alt: input.alt,
  shift: input.shift,
  meta: input.meta,
});

/**
 * The application menu. Electron's default one closes the window on Ctrl+W,
 * reloads Rune Browser itself on Ctrl+R and zooms it on Ctrl+Plus; those keys
 * are the tabs'. Linux and Windows show no menu, so they get none (editing
 * keys work without one; new windows are in the sidebar's New tab menu); macOS
 * keeps its app, File (new tabs and windows), Edit and Window menus, and has
 * History like Chrome's (with the keys the user chose for it).
 */
function setupMenu(run: (shortcut: string) => void, bindings: Record<string, readonly string[]>) {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  // Shown with their keys, which the window handles itself (lib/shortcuts.ts).
  const item = (label: string, id: string, accelerator: string | undefined) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => run(id),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          item("New Tab", "tab.new", "Cmd+T"),
          item("New Window", "window.new", "Cmd+N"),
          item("New Private Window", "window.private", "Cmd+Shift+N"),
          { type: "separator" },
          item("Reopen Closed Tab or Window", "tab.reopen", "Cmd+Shift+T"),
        ],
      },
      { role: "editMenu" },
      {
        label: "History",
        submenu: [
          item(
            "Show All History",
            "open.history",
            bindings["open.history"]?.find((k) => !/(Browser|Mouse)\w+$/.test(k)),
          ),
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
      },
    ]),
  );
}
