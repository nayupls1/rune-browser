// Keyboard shortcuts: every action with its default keys (Chromium's, on each
// platform), how keys are written ("Ctrl+Shift+T", "Mod" = Cmd on macOS and
// Ctrl elsewhere), and matching a pressed key against the keymap. The main
// process routes keys pressed in pages with it, the renderer those pressed in
// Rune Browser itself; the renderer decides whether an action applies
// (lib/shortcuts.ts).

export type KeyPlatform = "mac" | "linux" | "windows";

export const keyPlatform = (platform: string): KeyPlatform =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";

/**
 * Who gets a key first when a page has the focus, like in Chromium:
 * - reserved: the browser, always (opening, closing and switching tabs and windows);
 * - page: the page; the browser acts when it didn't use the key (preventDefault);
 * - passive: both: the page gets the key, and the browser acts too (Esc stops loading).
 */
export type PageBehavior = "reserved" | "page" | "passive";

export const shortcutCategories = ["Tabs", "Navigation", "Page", "Window", "Browser", "Rune Browser"] as const;
export type ShortcutCategory = (typeof shortcutCategories)[number];

export interface ShortcutDef {
  id: string;
  label: string;
  category: ShortcutCategory;
  /** Default keys; "Mod" is Cmd on macOS and Ctrl elsewhere. */
  keys: string[];
  /** macOS's own defaults, instead of `keys`. */
  mac?: string[];
  /** More keys on Linux (Chromium there also takes Alt+1…9 for tabs). */
  linux?: string[];
  /** Not on macOS (F-keys a Mac keyboard doesn't have without Fn, Ctrl+F4…). */
  notMac?: string[];
  page: PageBehavior;
}

const tabNumbers = [1, 2, 3, 4, 5, 6, 7, 8];
const workspaceNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const shortcutDefs: ShortcutDef[] = [
  // --- Tabs
  { id: "tab.new", label: "New tab", category: "Tabs", keys: ["Mod+T"], page: "reserved" },
  { id: "tab.close", label: "Close tab", category: "Tabs", keys: ["Mod+W"], notMac: ["Ctrl+F4"], page: "reserved" },
  { id: "tab.reopen", label: "Reopen closed tab", category: "Tabs", keys: ["Mod+Shift+T"], page: "reserved" },
  {
    id: "tab.next",
    label: "Next tab",
    category: "Tabs",
    keys: ["Ctrl+Tab", "Ctrl+PageDown"],
    mac: ["Ctrl+Tab", "Alt+Meta+Right", "Meta+}", "Ctrl+PageDown"],
    page: "reserved",
  },
  {
    id: "tab.previous",
    label: "Previous tab",
    category: "Tabs",
    keys: ["Ctrl+Shift+Tab", "Ctrl+PageUp"],
    mac: ["Ctrl+Shift+Tab", "Alt+Meta+Left", "Meta+{", "Ctrl+PageUp"],
    page: "reserved",
  },
  ...tabNumbers.map((n): ShortcutDef => ({
    id: `tab.select-${n}`,
    label: `Tab ${n}`,
    category: "Tabs",
    keys: [`Mod+${n}`],
    linux: [`Alt+${n}`],
    page: "page",
  })),
  { id: "tab.last", label: "Last tab", category: "Tabs", keys: ["Mod+9"], linux: ["Alt+9"], page: "page" },
  {
    id: "tab.move-left",
    label: "Move tab up",
    category: "Tabs",
    keys: ["Ctrl+Shift+PageUp"],
    mac: ["Ctrl+Shift+PageUp", "Meta+Shift+PageUp"],
    page: "page",
  },
  {
    id: "tab.move-right",
    label: "Move tab down",
    category: "Tabs",
    keys: ["Ctrl+Shift+PageDown"],
    mac: ["Ctrl+Shift+PageDown", "Meta+Shift+PageDown"],
    page: "page",
  },
  { id: "tab.duplicate", label: "Duplicate tab", category: "Tabs", keys: [], page: "page" },
  // No keys of its own (Ctrl+D bookmarks, like in Chromium); its menu and the command bar pin, or give it keys in Settings.
  { id: "tab.pin", label: "Pin or unpin tab", category: "Tabs", keys: [], page: "page" },
  { id: "tab.search", label: "Search tabs", category: "Tabs", keys: ["Mod+Shift+A"], page: "page" },

  // --- Navigation
  {
    id: "nav.back",
    label: "Back",
    category: "Navigation",
    keys: ["Alt+Left", "BrowserBack", "MouseBack"],
    mac: ["Meta+[", "Meta+Left", "BrowserBack", "MouseBack"],
    page: "page",
  },
  {
    id: "nav.forward",
    label: "Forward",
    category: "Navigation",
    keys: ["Alt+Right", "BrowserForward", "MouseForward"],
    mac: ["Meta+]", "Meta+Right", "BrowserForward", "MouseForward"],
    page: "page",
  },
  {
    id: "nav.reload",
    label: "Reload",
    category: "Navigation",
    keys: ["Mod+R", "F5", "BrowserRefresh"],
    mac: ["Meta+R", "BrowserRefresh"],
    page: "page",
  },
  {
    id: "nav.hard-reload",
    label: "Reload without the cache",
    category: "Navigation",
    keys: ["Mod+Shift+R", "Shift+F5", "Ctrl+F5"],
    mac: ["Meta+Shift+R"],
    page: "page",
  },
  { id: "nav.stop", label: "Stop loading", category: "Navigation", keys: ["Esc", "BrowserStop"], page: "passive" },
  {
    id: "nav.address",
    label: "Focus the address bar",
    category: "Navigation",
    keys: ["Mod+L", "Alt+D", "F6"],
    mac: ["Meta+L"],
    page: "page",
  },
  {
    id: "nav.search",
    label: "Search from the address bar",
    category: "Navigation",
    keys: ["Mod+E"],
    mac: ["Meta+E", "Alt+Meta+F"],
    page: "page",
  },

  // --- Page
  { id: "find.open", label: "Find in page", category: "Page", keys: ["Mod+F"], page: "page" },
  { id: "find.next", label: "Find next", category: "Page", keys: ["Mod+G", "F3"], mac: ["Meta+G"], page: "page" },
  {
    id: "find.previous",
    label: "Find previous",
    category: "Page",
    keys: ["Mod+Shift+G", "Shift+F3"],
    mac: ["Meta+Shift+G"],
    page: "page",
  },
  { id: "zoom.in", label: "Zoom in", category: "Page", keys: ["Mod+Plus", "Mod+="], page: "page" },
  { id: "zoom.out", label: "Zoom out", category: "Page", keys: ["Mod+-", "Mod+_"], page: "page" },
  { id: "zoom.reset", label: "Actual size", category: "Page", keys: ["Mod+0"], page: "page" },
  { id: "page.print", label: "Print", category: "Page", keys: ["Mod+P"], page: "page" },
  { id: "page.save", label: "Save page as", category: "Page", keys: ["Mod+S"], page: "page" },
  {
    // In DevTools' Sources panel: Electron can't show view-source: pages.
    id: "page.source",
    label: "View page source",
    category: "Page",
    keys: ["Ctrl+U"],
    mac: ["Alt+Meta+U"],
    page: "page",
  },
  {
    id: "page.devtools",
    label: "Developer tools",
    category: "Page",
    keys: ["F12", "Ctrl+Shift+I"],
    mac: ["Alt+Meta+I"],
    page: "page",
  },
  {
    id: "page.console",
    label: "JavaScript console",
    category: "Page",
    keys: ["Ctrl+Shift+J"],
    mac: ["Alt+Meta+J"],
    page: "page",
  },
  {
    id: "page.inspect",
    label: "Inspect an element",
    category: "Page",
    keys: ["Ctrl+Shift+C"],
    mac: ["Alt+Meta+C"],
    page: "page",
  },

  // --- Window
  { id: "window.new", label: "New window", category: "Window", keys: ["Mod+N"], page: "reserved" },
  { id: "file.open", label: "Open file", category: "Window", keys: ["Mod+O"], page: "page" },
  { id: "window.private", label: "New private window", category: "Window", keys: ["Mod+Shift+N"], page: "reserved" },
  {
    id: "window.fullscreen",
    label: "Full screen",
    category: "Window",
    keys: ["F11"],
    mac: ["Ctrl+Meta+F"],
    page: "page",
  },
  {
    id: "window.close",
    label: "Close window",
    category: "Window",
    keys: ["Mod+Shift+W"],
    notMac: ["Alt+F4"],
    page: "reserved",
  },
  // macOS quits with Cmd+Q from the app menu (main/menu.ts).
  { id: "app.quit", label: "Quit", category: "Window", keys: ["Ctrl+Shift+Q"], mac: [], page: "reserved" },

  // --- Browser
  { id: "bookmark.page", label: "Bookmark this tab", category: "Browser", keys: ["Mod+D"], page: "page" },
  { id: "bookmark.all", label: "Bookmark all tabs", category: "Browser", keys: ["Mod+Shift+D"], page: "page" },
  {
    id: "open.bookmarks",
    label: "Bookmarks",
    category: "Browser",
    keys: ["Mod+Shift+O"],
    mac: ["Alt+Meta+B"],
    page: "page",
  },
  // Chromium's Ctrl+Shift+B is the sidebar's.
  { id: "bookmarks.bar", label: "Show or hide the bookmarks bar", category: "Browser", keys: [], page: "page" },
  { id: "open.history", label: "History", category: "Browser", keys: ["Mod+H"], mac: ["Meta+Y"], page: "page" },
  {
    id: "open.downloads",
    label: "Downloads",
    category: "Browser",
    keys: ["Mod+J"],
    mac: ["Meta+Shift+J", "Alt+Meta+L"],
    page: "page",
  },
  {
    id: "open.clear-data",
    label: "Clear browsing data",
    category: "Browser",
    keys: ["Ctrl+Shift+Delete"],
    mac: ["Meta+Shift+Backspace"],
    page: "page",
  },
  { id: "open.settings", label: "Settings", category: "Browser", keys: ["Mod+,"], page: "page" },
  { id: "open.extensions", label: "Extensions", category: "Browser", keys: [], page: "page" },
  { id: "open.shortcuts", label: "Keyboard shortcuts", category: "Browser", keys: ["Mod+/"], page: "page" },
  // Chrome on macOS has no keys for it (Window → Task Manager).
  { id: "open.task-manager", label: "Task manager", category: "Browser", keys: ["Shift+Esc"], mac: [], page: "page" },

  // --- Rune Browser's own
  { id: "app.command-bar", label: "Command bar", category: "Rune Browser", keys: ["Mod+K"], page: "page" },
  // Chromium has nothing on Ctrl+I (its Ctrl+J is downloads).
  { id: "agent.toggle", label: "Show or hide the agent", category: "Rune Browser", keys: ["Mod+I"], page: "page" },
  {
    id: "sidebar.toggle",
    label: "Show or hide the sidebar",
    category: "Rune Browser",
    keys: ["Mod+Shift+B"],
    page: "page",
  },
  ...workspaceNumbers.map((n): ShortcutDef => ({
    id: `workspace.select-${n}`,
    label: `Workspace ${n}`,
    category: "Rune Browser",
    keys: [`Mod+Alt+${n}`],
    page: "reserved",
  })),
];

export type ShortcutId = string;

export const shortcutDef = (id: ShortcutId) => shortcutDefs.find((d) => d.id === id);

// --- Writing keys ------------------------------------------------------------------

/** Key names as written in a shortcut, by KeyboardEvent.key. */
const NAMED_KEYS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Esc",
  " ": "Space",
  "+": "Plus",
};

/** Written names (any case) to the canonical ones. */
const KEY_ALIASES: Record<string, string> = {
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  esc: "Esc",
  escape: "Esc",
  space: "Space",
  plus: "Plus",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  browserback: "BrowserBack",
  browserforward: "BrowserForward",
  browserrefresh: "BrowserRefresh",
  browserstop: "BrowserStop",
  browserhome: "BrowserHome",
  browsersearch: "BrowserSearch",
  mouseback: "MouseBack",
  mouseforward: "MouseForward",
};

const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "CapsLock",
]);

/** A key as pressed (a DOM KeyboardEvent or Electron's Input, both mapped to this). */
export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * The key's name in a shortcut. Letters go by what the layout types (Dvorak's
 * Ctrl+T is where its T is), or by position where it types no Latin letter;
 * digits by position (Shift+1 still is 1).
 */
export function keyName(key: string, code: string): string | null {
  if (MODIFIER_KEYS.has(key) || key === "Dead" || key === "Unidentified" || key === "Process") {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    return null;
  }
  if (/^Key[A-Z]$/.test(code)) return /^[a-z]$/i.test(key) ? key.toUpperCase() : code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (NAMED_KEYS[key]) return NAMED_KEYS[key]!;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  if (key.length === 1) return /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
  return KEY_ALIASES[key.toLowerCase()] ?? key;
}

/** One printable character that isn't a letter or digit: typing it may take Shift, so Shift isn't part of the shortcut. */
const isSymbol = (name: string) => name.length === 1 && !/^[A-Z0-9]$/.test(name);

const combo = (mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }, name: string) =>
  [
    mods.ctrl && "Ctrl",
    mods.alt && "Alt",
    mods.shift && !isSymbol(name) && name !== "Plus" && "Shift",
    mods.meta && "Meta",
    name,
  ]
    .filter(Boolean)
    .join("+");

/** The pressed key, written the way shortcuts are ("Ctrl+Shift+T"), or null for a modifier alone. */
export function comboOf(input: KeyInput): string | null {
  const name = keyName(input.key, input.code);
  return name ? combo(input, name) : null;
}

/** A shortcut as written ("mod+shift+t", "Cmd+Option+I"), in the canonical form for this platform; null if it isn't one. */
export function normalizeCombo(text: string, platform: KeyPlatform): string | null {
  const parts = text.split("+").map((p) => p.trim());
  // "Ctrl++": the key is "+".
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "Plus");
  if (!parts.length || parts.some((p) => !p)) return null;
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts.slice(0, -1)) {
    const p = part.toLowerCase();
    if (p === "mod") mods[platform === "mac" ? "meta" : "ctrl"] = true;
    else if (p === "ctrl" || p === "control") mods.ctrl = true;
    else if (p === "alt" || p === "option" || p === "opt") mods.alt = true;
    else if (p === "shift") mods.shift = true;
    else if (p === "meta" || p === "cmd" || p === "command" || p === "super" || p === "win") mods.meta = true;
    else return null;
  }
  const last = parts[parts.length - 1]!;
  let name: string;
  if (last.length === 1) name = /^[a-z]$/i.test(last) ? last.toUpperCase() : last;
  else if (/^f([1-9]|1\d|2[0-4])$/i.test(last)) name = last.toUpperCase();
  else if (KEY_ALIASES[last.toLowerCase()]) name = KEY_ALIASES[last.toLowerCase()]!;
  else return null;
  return combo(mods, name);
}

/** The mouse's back and forward buttons (MouseEvent.button 3 and 4) as keys of a shortcut. */
export const mouseButtonName = (button: number) => (button === 3 ? "MouseBack" : button === 4 ? "MouseForward" : null);

/** A mouse button pressed with modifiers, written like a key ("Shift+MouseBack"). */
export const mouseComboOf = (
  button: number,
  mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
): string | null => {
  const name = mouseButtonName(button);
  return name ? combo(mods, name) : null;
};

/** Keys that work as shortcuts on their own; everything else needs Ctrl, Alt or Cmd. */
const standalone = (name: string) =>
  /^F\d+$/.test(name) || name === "Esc" || name.startsWith("Browser") || name.startsWith("Mouse");

/** Whether a combo can be a shortcut (what the recorder in Settings accepts). */
export function isUsableCombo(text: string) {
  const parts = text.split("+");
  const name = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  return standalone(name) || mods.some((m) => m === "Ctrl" || m === "Alt" || m === "Meta");
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const KEY_LABELS: Record<string, string> = {
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Plus: "+",
  BrowserBack: "Browser Back",
  BrowserForward: "Browser Forward",
  BrowserRefresh: "Browser Refresh",
  BrowserStop: "Browser Stop",
  BrowserHome: "Browser Home",
  BrowserSearch: "Browser Search",
  MouseBack: "Mouse Back",
  MouseForward: "Mouse Forward",
};

/** As shown to people: "Ctrl+Shift+T" (Linux, Windows), "⇧⌘T" (macOS). */
export function formatCombo(text: string, platform: KeyPlatform) {
  return comboKeys(text, platform).join(platform === "mac" ? "" : "+");
}

/** A combination's keys, each as it's labeled (a keycap each in Settings): ["Ctrl", "+"]. */
export function comboKeys(text: string, platform: KeyPlatform) {
  const parts = text.split("+");
  const name = parts[parts.length - 1]!;
  const key = KEY_LABELS[name] ?? name;
  const mods = parts.slice(0, -1);
  if (platform === "mac") return [...mods.map((m) => MAC_SYMBOLS[m] ?? m), key];
  const meta = platform === "windows" ? "Win" : "Super";
  return [...mods.map((m) => (m === "Meta" ? meta : m)), key];
}

// --- The keymap --------------------------------------------------------------------

/** Changed shortcuts (Settings), by action: the keys it has instead of its defaults. */
export type ShortcutOverrides = Readonly<Record<string, readonly string[]>>;

/** An action's default keys on a platform, canonical. */
export function defaultKeys(def: ShortcutDef, platform: KeyPlatform): string[] {
  const keys =
    platform === "mac"
      ? (def.mac ?? def.keys)
      : [...def.keys, ...(def.notMac ?? []), ...(platform === "linux" ? (def.linux ?? []) : [])];
  return keys.flatMap((k) => normalizeCombo(k, platform) ?? []);
}

/** Every action's keys: the defaults, with the user's changes. */
export function resolveBindings(
  platform: KeyPlatform,
  overrides: ShortcutOverrides = {},
): Record<ShortcutId, string[]> {
  const out: Record<ShortcutId, string[]> = {};
  for (const def of shortcutDefs) {
    const custom = overrides[def.id];
    out[def.id] = custom ? custom.flatMap((k) => normalizeCombo(k, platform) ?? []) : defaultKeys(def, platform);
  }
  // A key the user gave to one action is taken from the others' defaults.
  const claimed = new Map<string, string>();
  for (const id of Object.keys(overrides)) if (out[id]) for (const k of out[id]) claimed.set(k, id);
  for (const def of shortcutDefs)
    if (!overrides[def.id]) out[def.id] = out[def.id]!.filter((k) => !claimed.has(k) || claimed.get(k) === def.id);
  return out;
}

/** What each key does. */
export function keymapOf(bindings: Record<ShortcutId, readonly string[]>) {
  const map = new Map<string, ShortcutDef>();
  for (const def of shortcutDefs) for (const k of bindings[def.id] ?? []) if (!map.has(k)) map.set(k, def);
  return map;
}

/** The action a pressed key runs, if any. */
export function matchShortcut(keymap: Map<string, ShortcutDef>, input: KeyInput) {
  const pressed = comboOf(input);
  return pressed ? keymap.get(pressed) : undefined;
}

/** The legacy KeyboardEvent.keyCode of a key (pages' shortcut libraries still read it). */
export function legacyKeyCode(key: string, code: string): number {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit\d$/.test(code)) return 48 + Number(code[5]);
  if (/^Numpad\d$/.test(code)) return 96 + Number(code[6]);
  const f = /^F(\d+)$/.exec(key);
  if (f) return 111 + Number(f[1]);
  const codes: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    " ": 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Insert: 45,
    Delete: 46,
    "=": 187,
    "+": 187,
    ",": 188,
    "-": 189,
    _: 189,
    ".": 190,
    "/": 191,
    "`": 192,
    "[": 219,
    "{": 219,
    "\\": 220,
    "]": 221,
    "}": 221,
    "'": 222,
    BrowserBack: 166,
    BrowserForward: 167,
    BrowserRefresh: 168,
    BrowserStop: 169,
  };
  if (code === "NumpadAdd") return 107;
  if (code === "NumpadSubtract") return 109;
  return codes[key] ?? 0;
}
