// Settings → Keyboard shortcuts: every shortcut by category, searchable, and
// changeable. A new key is recorded by pressing it; a key another action had
// moves over to this one.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, Show } from "solid-js";
import {
  comboOf,
  defaultKeys,
  formatCombo,
  isUsableCombo,
  mouseComboOf,
  shortcutCategories,
  shortcutDef,
  shortcutDefs,
  type ShortcutDef,
} from "../../shared/shortcuts";
import { settings, updateSettings } from "../lib/settings";
import { bindings, platform, setRecordingShortcut } from "../lib/shortcuts";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button, Input } from "./ui";
import { toast } from "./Toast";

const isChanged = (id: string) => settings().shortcuts[id] !== undefined;

/** Gives an action these keys (as the user's change), taking them from any other action that had them. */
function setKeys(id: string, keys: string[]) {
  updateSettings((s) => {
    const shortcuts: Record<string, readonly string[]> = { ...s.shortcuts };
    const current = bindings();
    for (const def of shortcutDefs) {
      if (def.id === id) continue;
      const theirs = current[def.id] ?? [];
      if (theirs.some((k) => keys.includes(k))) shortcuts[def.id] = theirs.filter((k) => !keys.includes(k));
    }
    // Back to its defaults: no change to keep.
    const defaults = defaultKeys(shortcutDef(id)!, platform);
    if (defaults.length === keys.length && defaults.every((k, i) => k === keys[i])) delete shortcuts[id];
    else shortcuts[id] = keys;
    return { ...s, shortcuts };
  });
}

function reset(id: string) {
  updateSettings((s) => {
    const shortcuts: Record<string, readonly string[]> = { ...s.shortcuts };
    delete shortcuts[id];
    return { ...s, shortcuts };
  });
}

export function ShortcutSettings() {
  const [query, setQuery] = createSignal("");
  const matches = (def: ShortcutDef) => {
    const q = query().trim().toLowerCase();
    if (!q) return true;
    const keys = (bindings()[def.id] ?? []).map((k) => formatCombo(k, platform).toLowerCase());
    return (
      def.label.toLowerCase().includes(q) || def.category.toLowerCase().includes(q) || keys.some((k) => k.includes(q))
    );
  };
  const anyChanged = () => Object.keys(settings().shortcuts).length > 0;

  return (
    <div {...stylex.attrs(styles.page)} data-shortcut-settings>
      <div {...stylex.attrs(styles.toolbar)}>
        <Input
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search shortcuts by name or key"
          xstyle={styles.search}
          data-shortcut-search
        />
        <Show when={anyChanged()}>
          <Button onClick={() => updateSettings((s) => ({ ...s, shortcuts: {} }))} data-shortcuts-reset-all>
            Reset all
          </Button>
        </Show>
      </div>
      <p {...stylex.attrs(styles.note)}>
        Keys work in every tab. While a page has the focus it gets most of them first, like in Chrome: a site that uses
        a key itself (Ctrl+K in many apps) keeps it. Opening, closing and switching tabs always work.
      </p>
      <For each={shortcutCategories}>
        {(category) => {
          const defs = () => shortcutDefs.filter((d) => d.category === category && matches(d));
          return (
            <Show when={defs().length}>
              <section {...stylex.attrs(styles.group)}>
                <h3 {...stylex.attrs(styles.groupTitle)}>{category}</h3>
                <div {...stylex.attrs(styles.rows)}>
                  <For each={defs()}>{(def) => <ShortcutRow def={def} />}</For>
                </div>
              </section>
            </Show>
          );
        }}
      </For>
    </div>
  );
}

function ShortcutRow(props: { def: ShortcutDef }) {
  const [recording, setRecording] = createSignal(false);
  const keys = () => bindings()[props.def.id] ?? [];

  const stop = () => {
    setRecording(false);
    setRecordingShortcut(false);
  };
  onCleanup(() => recording() && setRecordingShortcut(false));

  const recordKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    record(
      comboOf({
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      }),
    );
  };
  // The mouse's back and forward buttons can be shortcuts too.
  const recordMouse = (e: MouseEvent) => {
    const combo = mouseComboOf(e.button, { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    if (!combo) return;
    e.preventDefault();
    e.stopPropagation();
    record(combo);
  };

  const record = (combo: string | null) => {
    if (!combo) return; // a modifier on its own: wait for the key
    if (combo === "Esc") return stop();
    if (!isUsableCombo(combo)) {
      toast({ message: `${formatCombo(combo, platform)} needs Ctrl, Alt or ${platform === "mac" ? "Cmd" : "Super"}` });
      return;
    }
    stop();
    if (keys().includes(combo)) return;
    const owner = shortcutDefs.find((d) => d.id !== props.def.id && (bindings()[d.id] ?? []).includes(combo));
    setKeys(props.def.id, [...keys(), combo]);
    if (owner)
      toast({ message: `${formatCombo(combo, platform)} moved from “${owner.label}” to “${props.def.label}”` });
  };

  return (
    <div {...stylex.attrs(styles.row)} data-shortcut={props.def.id}>
      <span {...stylex.attrs(styles.label)}>
        {props.def.label}
        <Show when={isChanged(props.def.id)}>
          <span {...stylex.attrs(styles.changed)}>changed</span>
        </Show>
      </span>
      <div {...stylex.attrs(styles.keys)}>
        <For each={keys()}>
          {(combo) => (
            <span {...stylex.attrs(styles.chip)} data-shortcut-key={combo}>
              <kbd {...stylex.attrs(styles.kbd)}>{formatCombo(combo, platform)}</kbd>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${formatCombo(combo, platform)}`}
                onClick={() =>
                  setKeys(
                    props.def.id,
                    keys().filter((k) => k !== combo),
                  )
                }
                {...stylex.attrs(styles.chipRemove)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          )}
        </For>
        <Show
          when={recording()}
          fallback={
            <button
              type="button"
              title="Add a key"
              aria-label={`Add a key for ${props.def.label}`}
              onClick={() => {
                setRecording(true);
                setRecordingShortcut(true);
              }}
              {...stylex.attrs(styles.add)}
              data-shortcut-add
            >
              <Icon name="plus" size={13} />
            </button>
          }
        >
          <button
            type="button"
            ref={(el) => queueMicrotask(() => el.focus())}
            onKeyDown={recordKey}
            onMouseUp={recordMouse}
            onBlur={stop}
            {...stylex.attrs(styles.recording)}
            data-shortcut-recording
          >
            Press keys or a mouse button… (Esc to cancel)
          </button>
        </Show>
        <Show when={isChanged(props.def.id)}>
          <button
            type="button"
            title="Back to the default keys"
            aria-label={`Reset ${props.def.label}`}
            onClick={() => reset(props.def.id)}
            {...stylex.attrs(styles.add)}
            data-shortcut-reset
          >
            <Icon name="rotate-ccw" size={13} />
          </button>
        </Show>
      </div>
    </div>
  );
}

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  toolbar: { display: "flex", alignItems: "center", gap: space.md },
  search: { flex: 1, minWidth: 0 },
  note: { margin: 0, color: colors.muted, fontSize: font.sm },
  group: { display: "flex", flexDirection: "column", gap: space.sm },
  groupTitle: { margin: 0, fontSize: font.md, fontWeight: 600 },
  rows: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    minHeight: 44,
    paddingBlock: 6,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  label: { display: "flex", alignItems: "center", gap: space.sm, fontSize: font.sm },
  changed: {
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: font.xs,
  },
  keys: { display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 6 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    height: 24,
    paddingLeft: 8,
    paddingRight: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  kbd: { fontFamily: font.mono, fontSize: font.xs, color: colors.text },
  chipRemove: {
    display: "grid",
    placeItems: "center",
    width: 18,
    height: 18,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
  add: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
  recording: {
    height: 24,
    paddingInline: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: font.xs,
    outline: "none",
    cursor: "default",
  },
});
