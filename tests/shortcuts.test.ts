import { describe, expect, test } from "bun:test";
import {
  comboOf,
  defaultKeys,
  formatCombo,
  isUsableCombo,
  keymapOf,
  legacyKeyCode,
  matchShortcut,
  mouseComboOf,
  normalizeCombo,
  resolveBindings,
  shortcutDef,
  shortcutDefs,
  type KeyInput,
} from "../src/shared/shortcuts";

const key = (k: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  code,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
});

describe("writing shortcuts", () => {
  test("Mod is Cmd on macOS and Ctrl elsewhere; modifiers in a fixed order", () => {
    expect(normalizeCombo("Mod+Shift+T", "linux")).toBe("Ctrl+Shift+T");
    expect(normalizeCombo("mod+shift+t", "mac")).toBe("Shift+Meta+T");
    expect(normalizeCombo("Shift+Ctrl+Alt+k", "windows")).toBe("Ctrl+Alt+Shift+K");
    expect(normalizeCombo("Cmd+Option+I", "mac")).toBe("Alt+Meta+I");
    expect(normalizeCombo("Alt+ArrowLeft", "linux")).toBe("Alt+Left");
    expect(normalizeCombo("Ctrl++", "linux")).toBe("Ctrl+Plus");
    expect(normalizeCombo("escape", "linux")).toBe("Esc");
  });

  test("rejects what isn't a key", () => {
    expect(normalizeCombo("Ctrl+", "linux")).toBeNull();
    expect(normalizeCombo("Hyper+T", "linux")).toBeNull();
    expect(normalizeCombo("Ctrl+Nope", "linux")).toBeNull();
  });

  test("Shift isn't part of a symbol (it's what types it)", () => {
    expect(normalizeCombo("Ctrl+Shift+Plus", "linux")).toBe("Ctrl+Plus");
    expect(normalizeCombo("Meta+Shift+}", "mac")).toBe("Meta+}");
    expect(normalizeCombo("Ctrl+Shift+Tab", "linux")).toBe("Ctrl+Shift+Tab");
  });

  test("shown the platform's way", () => {
    expect(formatCombo("Ctrl+Shift+T", "linux")).toBe("Ctrl+Shift+T");
    expect(formatCombo("Shift+Meta+T", "mac")).toBe("⇧⌘T");
    expect(formatCombo("Alt+Left", "windows")).toBe("Alt+←");
    expect(formatCombo("Meta+K", "linux")).toBe("Super+K");
  });

  test("a shortcut needs a modifier unless it's an F-key, Esc or a browser key", () => {
    expect(isUsableCombo("K")).toBe(false);
    expect(isUsableCombo("Shift+K")).toBe(false);
    expect(isUsableCombo("Ctrl+K")).toBe(true);
    expect(isUsableCombo("F6")).toBe(true);
    expect(isUsableCombo("Esc")).toBe(true);
    expect(isUsableCombo("BrowserBack")).toBe(true);
  });
});

describe("pressed keys", () => {
  test("letters by what the layout types, or by position", () => {
    expect(comboOf(key("t", "KeyT", { ctrl: true }))).toBe("Ctrl+T");
    // Dvorak: the key in QWERTY's K position types T.
    expect(comboOf(key("t", "KeyK", { ctrl: true }))).toBe("Ctrl+T");
    // Cyrillic: no Latin letter, so its position.
    expect(comboOf(key("е", "KeyT", { ctrl: true }))).toBe("Ctrl+T");
    // macOS Option turns letters into other characters.
    expect(comboOf(key("ˆ", "KeyI", { alt: true, meta: true }))).toBe("Alt+Meta+I");
    expect(comboOf(key("Dead", "KeyI", { alt: true, meta: true }))).toBe("Alt+Meta+I");
  });

  test("digits by position, whatever Shift or the layout types", () => {
    expect(comboOf(key("&", "Digit1", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+1");
    expect(comboOf(key("1", "Digit1", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+1");
  });

  test("zoom keys from the main row, the number pad and other layouts", () => {
    expect(comboOf(key("+", "Equal", { ctrl: true, shift: true }))).toBe("Ctrl+Plus");
    expect(comboOf(key("+", "NumpadAdd", { ctrl: true }))).toBe("Ctrl+Plus");
    expect(comboOf(key("=", "Equal", { ctrl: true }))).toBe("Ctrl+=");
    expect(comboOf(key("-", "Minus", { ctrl: true }))).toBe("Ctrl+-");
  });

  test("a modifier alone is nothing", () => {
    expect(comboOf(key("Control", "ControlLeft", { ctrl: true }))).toBeNull();
    expect(comboOf(key("Shift", "ShiftLeft", { shift: true }))).toBeNull();
  });

  test("legacy keyCodes for pages' shortcut libraries", () => {
    expect(legacyKeyCode("k", "KeyK")).toBe(75);
    expect(legacyKeyCode("1", "Digit1")).toBe(49);
    expect(legacyKeyCode("F5", "F5")).toBe(116);
    expect(legacyKeyCode("ArrowLeft", "ArrowLeft")).toBe(37);
    expect(legacyKeyCode("+", "NumpadAdd")).toBe(107);
  });
});

describe("the keymap", () => {
  const linux = keymapOf(resolveBindings("linux"));
  const mac = keymapOf(resolveBindings("mac"));
  const windows = keymapOf(resolveBindings("windows"));

  test("Chromium's shortcuts on each platform", () => {
    const on = (map: typeof linux, input: KeyInput) => matchShortcut(map, input)?.id;
    expect(on(linux, key("t", "KeyT", { ctrl: true }))).toBe("tab.new");
    expect(on(mac, key("t", "KeyT", { meta: true }))).toBe("tab.new");
    expect(on(mac, key("t", "KeyT", { ctrl: true }))).toBeUndefined();
    expect(on(linux, key("w", "KeyW", { ctrl: true }))).toBe("tab.close");
    expect(on(windows, key("F4", "F4", { ctrl: true }))).toBe("tab.close");
    expect(on(linux, key("Tab", "Tab", { ctrl: true, shift: true }))).toBe("tab.previous");
    expect(on(mac, key("Tab", "Tab", { ctrl: true }))).toBe("tab.next");
    expect(on(mac, key("}", "BracketRight", { meta: true, shift: true }))).toBe("tab.next");
    expect(on(linux, key("3", "Digit3", { ctrl: true }))).toBe("tab.select-3");
    expect(on(linux, key("3", "Digit3", { alt: true }))).toBe("tab.select-3");
    expect(on(windows, key("3", "Digit3", { alt: true }))).toBeUndefined();
    expect(on(linux, key("9", "Digit9", { ctrl: true }))).toBe("tab.last");
    expect(on(linux, key("ArrowLeft", "ArrowLeft", { alt: true }))).toBe("nav.back");
    expect(on(mac, key("[", "BracketLeft", { meta: true }))).toBe("nav.back");
    expect(on(linux, key("F5", "F5"))).toBe("nav.reload");
    expect(on(linux, key("F5", "F5", { shift: true }))).toBe("nav.hard-reload");
    expect(on(linux, key("Escape", "Escape"))).toBe("nav.stop");
    expect(on(linux, key("d", "KeyD", { alt: true }))).toBe("nav.address");
    expect(on(linux, key("F6", "F6"))).toBe("nav.address");
    expect(on(linux, key("f", "KeyF", { ctrl: true }))).toBe("find.open");
    expect(on(linux, key("F3", "F3", { shift: true }))).toBe("find.previous");
    expect(on(linux, key("+", "Equal", { ctrl: true, shift: true }))).toBe("zoom.in");
    expect(on(linux, key("0", "Digit0", { ctrl: true }))).toBe("zoom.reset");
    expect(on(linux, key("F12", "F12"))).toBe("page.devtools");
    expect(on(mac, key("ˆ", "KeyI", { alt: true, meta: true }))).toBe("page.devtools");
    expect(on(linux, key("q", "KeyQ", { ctrl: true, shift: true }))).toBe("app.quit");
    expect(on(mac, key("y", "KeyY", { meta: true }))).toBe("open.history");
    expect(on(linux, key("j", "KeyJ", { ctrl: true }))).toBe("open.downloads");
    expect(on(windows, key("j", "KeyJ", { ctrl: true }))).toBe("open.downloads");
    expect(on(mac, key("J", "KeyJ", { meta: true, shift: true }))).toBe("open.downloads");
    expect(on(linux, key("J", "KeyJ", { ctrl: true, shift: true }))).toBe("page.console");
    // The agent moved off Chromium's downloads key.
    expect(on(linux, key("i", "KeyI", { ctrl: true }))).toBe("agent.toggle");
    expect(on(mac, key("i", "KeyI", { meta: true }))).toBe("agent.toggle");
    // Bookmarks have Chromium's keys; pinning has none of its own.
    expect(on(linux, key("d", "KeyD", { ctrl: true }))).toBe("bookmark.page");
    expect(on(mac, key("d", "KeyD", { meta: true }))).toBe("bookmark.page");
    expect(on(windows, key("D", "KeyD", { ctrl: true, shift: true }))).toBe("bookmark.all");
    expect(on(linux, key("O", "KeyO", { ctrl: true, shift: true }))).toBe("open.bookmarks");
    expect(on(mac, key("∫", "KeyB", { alt: true, meta: true }))).toBe("open.bookmarks");
    expect(resolveBindings("linux")["tab.pin"]).toEqual([]);
    expect(on(linux, key("Delete", "Delete", { ctrl: true, shift: true }))).toBe("open.clear-data");
    expect(on(mac, key("Backspace", "Backspace", { meta: true, shift: true }))).toBe("open.clear-data");
    expect(on(windows, key("o", "KeyO", { ctrl: true }))).toBe("file.open");
    expect(on(mac, key("o", "KeyO", { meta: true }))).toBe("file.open");
    expect(on(linux, key("2", "Digit2", { ctrl: true, alt: true }))).toBe("workspace.select-2");
  });

  test("no key does two things by default", () => {
    for (const platform of ["linux", "mac", "windows"] as const) {
      const seen = new Map<string, string>();
      for (const def of shortcutDefs)
        for (const k of defaultKeys(def, platform)) {
          expect(`${platform} ${k}: ${seen.get(k) ?? def.id}`).toBe(`${platform} ${k}: ${def.id}`);
          seen.set(k, def.id);
        }
    }
  });

  test("every default is a key that can be written", () => {
    for (const def of shortcutDefs)
      for (const k of [...def.keys, ...(def.mac ?? []), ...(def.linux ?? []), ...(def.notMac ?? [])])
        expect([def.id, normalizeCombo(k, "linux") !== null && normalizeCombo(k, "mac") !== null]).toEqual([
          def.id,
          true,
        ]);
  });

  test("the user's keys replace the defaults and are taken from other actions", () => {
    const bindings = resolveBindings("linux", { "app.command-bar": ["Ctrl+Shift+P"], "page.print": ["mod+k"] });
    expect(bindings["app.command-bar"]).toEqual(["Ctrl+Shift+P"]);
    expect(bindings["page.print"]).toEqual(["Ctrl+K"]);
    const map = keymapOf(bindings);
    expect(matchShortcut(map, key("k", "KeyK", { ctrl: true }))?.id).toBe("page.print");
    expect(matchShortcut(map, key("p", "KeyP", { ctrl: true }))).toBeUndefined();
  });

  test("an empty list turns a shortcut off", () => {
    const map = keymapOf(resolveBindings("linux", { "tab.close": [] }));
    expect(matchShortcut(map, key("w", "KeyW", { ctrl: true }))).toBeUndefined();
    expect(matchShortcut(map, key("F4", "F4", { ctrl: true }))).toBeUndefined();
  });

  test("opening, closing and switching tabs are the browser's, like Chromium's reserved keys", () => {
    for (const id of ["tab.new", "tab.close", "tab.reopen", "tab.next", "tab.previous", "window.close"])
      expect(shortcutDef(id)?.page).toBe("reserved");
    // Pages may use these themselves (an app's own Ctrl+K, Ctrl+F, Ctrl+S).
    for (const id of ["app.command-bar", "find.open", "page.save", "nav.address", "zoom.in"])
      expect(shortcutDef(id)?.page).toBe("page");
    expect(shortcutDef("nav.stop")?.page).toBe("passive");
  });

  test("the mouse's back and forward buttons go back and forward, and can be bound like keys", () => {
    const none = { ctrl: false, alt: false, shift: false, meta: false };
    expect(mouseComboOf(3, none)).toBe("MouseBack");
    expect(mouseComboOf(4, { ...none, shift: true })).toBe("Shift+MouseForward");
    expect(mouseComboOf(1, none)).toBeNull();
    const map = keymapOf(resolveBindings("linux"));
    expect(map.get("MouseBack")?.id).toBe("nav.back");
    expect(map.get("MouseForward")?.id).toBe("nav.forward");
    expect(keymapOf(resolveBindings("mac")).get("MouseBack")?.id).toBe("nav.back");
    expect(normalizeCombo("ctrl+mouseback", "linux")).toBe("Ctrl+MouseBack");
    expect(isUsableCombo("MouseForward")).toBe(true);
    expect(formatCombo("MouseBack", "linux")).toBe("Mouse Back");
  });

  test("tabs by number: Ctrl+1…8 and Ctrl+9 for the last everywhere, Alt+1…9 too on Linux", () => {
    const linux = keymapOf(resolveBindings("linux"));
    const windows = keymapOf(resolveBindings("windows"));
    const mac = keymapOf(resolveBindings("mac"));
    for (let n = 1; n <= 8; n++) {
      expect(linux.get(`Ctrl+${n}`)?.id).toBe(`tab.select-${n}`);
      expect(linux.get(`Alt+${n}`)?.id).toBe(`tab.select-${n}`);
      expect(windows.get(`Ctrl+${n}`)?.id).toBe(`tab.select-${n}`);
      expect(windows.get(`Alt+${n}`)).toBeUndefined();
      expect(mac.get(`Meta+${n}`)?.id).toBe(`tab.select-${n}`);
    }
    expect(linux.get("Ctrl+9")?.id).toBe("tab.last");
    // The numpad's digits are digits too.
    expect(matchShortcut(linux, key("3", "Numpad3", { ctrl: true }))?.id).toBe("tab.select-3");
    expect(linux.get("Alt+F4")?.id).toBe("window.close");
    expect(mac.get("Alt+F4")).toBeUndefined();
  });
});
