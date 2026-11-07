// The command bar (Ctrl+K, also from inside web pages and app previews).
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { closeCommandBar, commandBarOpen, commands, results, type Command } from "../lib/commands";
import { colors, font, radius, space } from "../theme.stylex";
import { shortcutLabel } from "../lib/shortcuts";
import { Icon } from "./Icon";
import { toast } from "./Toast";

/** Mount once at the app root. */
export function CommandBar() {
  return (
    <Show when={commandBarOpen()}>
      <Bar />
    </Show>
  );
}

function Bar() {
  let input!: HTMLInputElement;
  let list!: HTMLUListElement;
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  // A command that asks for text first.
  const [asking, setAsking] = createSignal<Command>();
  const shown = createMemo(() => (asking() ? [] : results(query(), commands(query()))));

  createEffect(on(query, () => setIndex(0)));
  createEffect(() => {
    list?.querySelector(`[data-index="${index()}"]`)?.scrollIntoView({ block: "nearest" });
  });

  const previous = document.activeElement as HTMLElement | null;
  onMount(() => input.focus());
  onCleanup(() => {
    if (previous?.isConnected && previous !== document.body) previous.focus();
  });

  const run = (command: Command, value?: string) => {
    if (command.input && value === undefined) {
      setAsking(command);
      setQuery("");
      input.focus();
      return;
    }
    closeCommandBar();
    void Promise.resolve()
      .then(() => command.run(value))
      .catch((err) =>
        toast({ title: command.title, message: err instanceof Error ? err.message : String(err), kind: "error" }),
      );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const count = shown().length;
    if (e.key === "Escape") {
      e.preventDefault();
      if (asking()) {
        setAsking(undefined);
        setQuery("");
      } else closeCommandBar();
    } else if (e.key === "Backspace" && asking() && !query()) {
      e.preventDefault();
      setAsking(undefined);
    } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      if (count) setIndex((index() + 1) % count);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      if (count) setIndex((index() - 1 + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = asking();
      if (command) run(command, query());
      else if (shown()[index()]) run(shown()[index()]!);
    }
  };

  const isAsking = () => !!asking();

  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)} onMouseDown={(e) => e.target === e.currentTarget && closeCommandBar()}>
        <div role="dialog" aria-modal="true" aria-label="Command bar" {...stylex.attrs(styles.panel)} data-command-bar>
          <div {...stylex.attrs(styles.inputRow)}>
            <Icon name="search" size={18} {...stylex.attrs(styles.searchIcon)} />
            <Show when={asking()}>
              {(command) => (
                <span {...stylex.attrs(styles.chip)} data-command-asking>
                  {command().title}
                </span>
              )}
            </Show>
            <input
              ref={input}
              {...stylex.attrs(styles.input)}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder={asking()?.input ?? "Search tabs and actions, type a URL, or ask for something…"}
              spellcheck={false}
              autocomplete="off"
              role="combobox"
              aria-expanded={!isAsking()}
              aria-controls="command-bar-results"
              aria-activedescendant={shown()[index()] ? `command-${index()}` : undefined}
            />
          </div>
          <Show
            when={!isAsking()}
            fallback={
              <p {...stylex.attrs(styles.hint)}>
                Enter to run <strong>{asking()?.title}</strong>
                {asking()?.subtitle ? ` in ${asking()?.subtitle}` : ""} · Esc to go back
              </p>
            }
          >
            <ul ref={list} id="command-bar-results" role="listbox" {...stylex.attrs(styles.list)}>
              <For each={shown()} fallback={<li {...stylex.attrs(styles.empty)}>Nothing matches</li>}>
                {(command, i) => {
                  const active = () => i() === index();
                  return (
                    <li
                      id={`command-${i()}`}
                      role="option"
                      aria-selected={active()}
                      data-index={i()}
                      data-command={command.id}
                      {...stylex.attrs(styles.item, active() && styles.active)}
                      onMouseMove={() => setIndex(i())}
                      onClick={() => run(command)}
                    >
                      <Show
                        when={command.favicon}
                        fallback={
                          <Icon
                            name={command.icon}
                            size={16}
                            {...stylex.attrs(styles.icon)}
                            fallback={<span {...stylex.attrs(styles.icon)}>{command.icon}</span>}
                          />
                        }
                      >
                        {(src) => <img src={src()} alt="" width={16} height={16} {...stylex.attrs(styles.icon)} />}
                      </Show>
                      <span {...stylex.attrs(styles.text)}>
                        <span {...stylex.attrs(styles.title)}>{command.title}</span>
                        <Show when={command.subtitle}>
                          <span {...stylex.attrs(styles.subtitle)}>{command.subtitle}</span>
                        </Show>
                      </span>
                      <Show when={command.input}>
                        <Icon name="text-cursor-input" size={14} {...stylex.attrs(styles.icon)} />
                      </Show>
                      <Show when={command.keys && shortcutLabel(command.keys)}>
                        {(label) => <kbd {...stylex.attrs(styles.keys)}>{label()}</kbd>}
                      </Show>
                      <span {...stylex.attrs(styles.group)}>{command.group}</span>
                    </li>
                  );
                }}
              </For>
            </ul>
            <p {...stylex.attrs(styles.hint)}>↑↓ to choose · Enter to run · Esc to close</p>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1900,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    paddingTop: "12vh",
    paddingInline: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.25)",
    animationName: fadeIn,
    animationDuration: "100ms",
  },
  panel: {
    width: "min(640px, 100%)",
    maxHeight: "70vh",
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.md,
    boxShadow: "0 24px 60px rgb(0 0 0 / 0.28)",
    overflow: "hidden",
  },
  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingInline: space.lg,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  searchIcon: { flexShrink: 0, color: colors.muted },
  chip: {
    flexShrink: 0,
    paddingBlock: 2,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: font.sm,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingBlock: 14,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.lg,
  },
  list: { margin: 0, padding: space.xs, listStyle: "none", overflowY: "auto", flex: 1, minHeight: 0 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: 8,
    paddingInline: space.md,
    borderRadius: radius.md,
    cursor: "pointer",
    userSelect: "none",
  },
  active: { backgroundColor: colors.surfaceHover },
  icon: { flexShrink: 0, color: colors.muted, objectFit: "contain" },
  text: { display: "flex", alignItems: "baseline", gap: space.sm, flex: 1, minWidth: 0, overflow: "hidden" },
  title: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 },
  subtitle: {
    color: colors.muted,
    fontSize: font.sm,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 2,
    minWidth: 0,
  },
  group: { flexShrink: 0, color: colors.muted, fontSize: font.xs },
  keys: {
    flexShrink: 0,
    paddingInline: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    color: colors.muted,
    fontFamily: font.mono,
    fontSize: font.xs,
  },
  empty: { paddingBlock: space.lg, textAlign: "center", color: colors.muted },
  hint: {
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    color: colors.muted,
    fontSize: font.xs,
  },
});
