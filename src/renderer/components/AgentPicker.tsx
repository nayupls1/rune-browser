// Picks who answers: provider, model and effort (modeled on t3code's picker).
// The popover has a rail of providers on the left and the selected
// provider's models on the right, with search; effort is a small menu next to
// it, offering only what the model supports.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  effortLabels,
  providerIds,
  type AgentChoice,
  type ProviderId,
  type ProviderModel,
  type ProviderStatus,
} from "../../shared/api";
import { providerById, providers, refreshProviders } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { focusComposer, PopoverMenu } from "./PopoverMenu";
import { Icon } from "./Icon";
import { ProviderIcon } from "./ProviderIcon";

const usable = (p: ProviderStatus | undefined) => p?.state === "ready" || p?.state === "checking";

const stateText: Record<ProviderStatus["state"], string> = {
  ready: "Ready",
  checking: "Checking…",
  missing: "Not installed",
  "signed-out": "Not signed in",
  error: "Unavailable",
  disabled: "Turned off in Settings",
};

/** The model a choice resolves to (its own, or the provider's default). */
export function choiceModel(choice: AgentChoice): ProviderModel | undefined {
  const provider = providerById(choice.provider);
  const id = choice.model ?? provider?.defaultModel;
  return provider?.models.find((m) => m.id === id);
}

/** Effort as signal bars: one per level the model has (up to five), filled up to the chosen one (none for Auto). */
export function EffortBars(props: { level: string | null; levels: readonly string[] }) {
  const count = () => Math.min(5, Math.max(3, props.levels.length));
  const filled = () => {
    const i = props.level ? props.levels.indexOf(props.level) : -1;
    if (i < 0) return 0;
    return Math.max(1, Math.round(((i + 1) / props.levels.length) * count()));
  };
  return (
    <span {...stylex.attrs(styles.bars)} aria-hidden="true">
      <For each={Array.from({ length: count() }, (_, i) => i)}>
        {(i) => {
          const on = () => i < filled();
          return (
            <span
              {...stylex.attrs(styles.bar, on() && styles.barOn)}
              style={{ height: `${Math.round(3 + (i * 7) / (count() - 1))}px` }}
            />
          );
        }}
      </For>
    </span>
  );
}

export function AgentPicker(props: {
  choice: AgentChoice;
  onChange: (choice: AgentChoice) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [effortOpen, setEffortOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  let effortTrigger!: HTMLButtonElement;

  const model = () => choiceModel(props.choice);
  const modelLabel = () => model()?.name.replace(/^Claude /, "") ?? props.choice.model ?? "Default model";
  const efforts = () => model()?.efforts ?? [];
  const effortLabel = () => (props.choice.effort ? (effortLabels[props.choice.effort] ?? props.choice.effort) : "Auto");

  const pick = (provider: ProviderId, modelId: string) => {
    const next = providerById(provider)?.models.find((m) => m.id === modelId);
    // Keep the effort when the new model supports it.
    const effort = props.choice.effort && next?.efforts.includes(props.choice.effort) ? props.choice.effort : null;
    props.onChange({ provider, model: modelId, effort });
    setOpen(false);
    focusComposer(trigger);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={`Model: ${providerById(props.choice.provider)?.label ?? props.choice.provider} · ${model()?.name ?? modelLabel()}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen((o) => !o)}
        {...stylex.attrs(styles.trigger, open() && styles.triggerOpen)}
        data-agent-picker
      >
        <ProviderIcon provider={props.choice.provider} size={14} />
        <Show when={!props.compact}>
          <span {...stylex.attrs(styles.triggerLabel)}>{modelLabel()}</span>
        </Show>
        <Icon name="chevron-down" size={12} {...stylex.attrs(styles.chevron)} />
      </button>
      <Show when={efforts().length}>
        <button
          ref={effortTrigger}
          type="button"
          title={`Reasoning effort: ${effortLabel()}`}
          aria-haspopup="menu"
          aria-expanded={effortOpen()}
          onClick={() => setEffortOpen((o) => !o)}
          {...stylex.attrs(styles.trigger, effortOpen() && styles.triggerOpen)}
          data-effort-picker
        >
          <Show when={props.choice.effort}>
            <EffortBars level={props.choice.effort} levels={efforts()} />
          </Show>
          <span {...stylex.attrs(styles.triggerLabel)}>{effortLabel()}</span>
          <Icon name="chevron-down" size={12} {...stylex.attrs(styles.chevron)} />
        </button>
      </Show>
      <Show when={effortOpen()}>
        <PopoverMenu
          anchor={effortTrigger}
          title="Reasoning effort"
          name="effort-menu"
          width={210}
          onClose={() => setEffortOpen(false)}
          items={[
            {
              label: "Auto",
              description: "The model decides",
              icon: "sparkles",
              checked: !props.choice.effort,
              id: "auto",
              onSelect: () => props.onChange({ ...props.choice, effort: null }),
            },
            ...efforts().map((level) => ({
              label: effortLabels[level] ?? level,
              icon: <EffortBars level={level} levels={efforts()} />,
              checked: props.choice.effort === level,
              id: level,
              onSelect: () => props.onChange({ ...props.choice, effort: level }),
            })),
          ]}
        />
      </Show>
      <Show when={open()}>
        <Popover anchor={trigger} choice={props.choice} onPick={pick} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

function Popover(props: {
  anchor: HTMLElement;
  choice: AgentChoice;
  onPick: (provider: ProviderId, model: string) => void;
  onClose: () => void;
}) {
  const [browsing, setBrowsing] = createSignal<ProviderId>(props.choice.provider);
  const [query, setQuery] = createSignal("");
  /** Where a provider's list starts: on the chosen model (or its default). */
  const chosenIndex = (id: ProviderId) => {
    const p = providerById(id);
    const wanted = id === props.choice.provider ? (props.choice.model ?? p?.defaultModel) : p?.defaultModel;
    return Math.max(
      0,
      (p?.models ?? []).findIndex((m) => m.id === wanted),
    );
  };
  const [highlight, setHighlight] = createSignal(chosenIndex(props.choice.provider));
  const close = () => {
    props.onClose();
    props.anchor.focus({ preventScroll: true });
  };
  let root!: HTMLDivElement;
  let search: HTMLInputElement | undefined;

  const status = () => providerById(browsing());
  const models = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = status()?.models ?? [];
    return q ? list.filter((m) => `${m.name} ${m.id} ${m.group ?? ""}`.toLowerCase().includes(q)) : list;
  });
  const selectedId = () =>
    props.choice.provider === browsing() ? (props.choice.model ?? status()?.defaultModel) : undefined;

  // Over the composer card it's in (the agent sidebar), at the card's width; elsewhere under or over the trigger.
  const [place, setPlace] = createSignal<{ top?: number; bottom?: number; left: number; width: number }>({
    top: -9999,
    left: -9999,
    width: 380,
  });
  onMount(() => {
    const rect = props.anchor.getBoundingClientRect();
    const card = props.anchor.closest("[data-composer]")?.getBoundingClientRect();
    const width = card ? Math.min(420, card.width) : 380;
    const left = card ? card.right - width : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    // Above: held by its bottom edge, so it stays put when another provider's list is shorter.
    if (rect.top > 340 + 16) setPlace({ bottom: window.innerHeight - (card?.top ?? rect.top) + 6, left, width });
    else setPlace({ top: rect.bottom + 6, left, width });
    (search ?? root.querySelector<HTMLButtonElement>("button"))?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!root.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) props.onClose();
    };
    const onAway = () => props.onClose();
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onAway);
    window.addEventListener("resize", onAway);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("resize", onAway);
    });
  });
  // The highlighted model stays in view while the arrow keys move it.
  createEffect(() => {
    const i = highlight();
    root?.querySelectorAll<HTMLElement>("[data-model]")[i]?.scrollIntoView({ block: "nearest" });
  });

  const onKey = (e: KeyboardEvent) => {
    const list = models();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = list[highlight()];
      if (m && usable(status())) props.onPick(browsing(), m.id);
    } else if (e.key === "Tab" && !e.shiftKey && e.altKey === false && e.ctrlKey) {
      // Ctrl+Tab cycles providers.
      e.preventDefault();
      const i = providerIds.indexOf(browsing());
      setBrowsing(providerIds[(i + 1) % providerIds.length]!);
    }
  };

  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label="Choose a model"
        onKeyDown={onKey}
        {...stylex.attrs(styles.popover)}
        style={{
          top: place().top === undefined ? undefined : `${place().top}px`,
          bottom: place().bottom === undefined ? undefined : `${place().bottom}px`,
          left: `${Math.max(8, place().left)}px`,
          width: `${place().width}px`,
        }}
        data-agent-popover
      >
        <div {...stylex.attrs(styles.rail)}>
          <For each={providerIds}>
            {(id) => {
              const p = () => providerById(id);
              const active = () => browsing() === id;
              const off = () => !usable(p());
              return (
                <button
                  type="button"
                  title={`${p()?.label ?? id}${off() ? ` · ${stateText[p()?.state ?? "missing"]}` : ""}`}
                  onClick={() => {
                    setBrowsing(id);
                    setHighlight(chosenIndex(id));
                    setQuery("");
                    queueMicrotask(() => search?.focus());
                  }}
                  {...stylex.attrs(
                    styles.railButton,
                    active() && styles.railButtonActive,
                    off() && styles.railButtonOff,
                  )}
                  aria-pressed={active()}
                  data-provider={id}
                >
                  <ProviderIcon provider={id} size={18} />
                </button>
              );
            }}
          </For>
        </div>
        <div {...stylex.attrs(styles.panel)}>
          <Show
            when={usable(status())}
            fallback={
              <div {...stylex.attrs(styles.notice)} data-provider-notice>
                <span {...stylex.attrs(styles.noticeTitle)}>
                  <ProviderIcon provider={browsing()} size={16} />
                  {status()?.label ?? browsing()}
                  <span {...stylex.attrs(styles.noticeState)}>{stateText[status()?.state ?? "missing"]}</span>
                </span>
                <Show when={status()?.message}>
                  {(message) => (
                    <p {...stylex.attrs(styles.noticeText)}>
                      <For each={message().split(/`([^`]+)`/)}>
                        {(part, i) => (
                          <Show when={i() % 2} fallback={part}>
                            <code {...stylex.attrs(styles.noticeCode)}>{part}</code>
                          </Show>
                        )}
                      </For>
                    </p>
                  )}
                </Show>
                <button
                  type="button"
                  onClick={() => void refreshProviders(browsing())}
                  {...stylex.attrs(styles.noticeButton)}
                >
                  <Icon name="refresh-cw" size={12} />
                  Check again
                </button>
              </div>
            }
          >
            <div {...stylex.attrs(styles.searchRow)}>
              <Icon name="search" size={14} {...stylex.attrs(styles.searchIcon)} />
              <input
                ref={search}
                value={query()}
                placeholder={`Search ${status()?.label ?? ""} models`}
                onInput={(e) => {
                  setQuery(e.currentTarget.value);
                  setHighlight(0);
                }}
                {...stylex.attrs(styles.search)}
              />
            </div>
            <div {...stylex.attrs(styles.list)}>
              <For
                each={models()}
                fallback={
                  <p {...stylex.attrs(styles.empty)}>
                    {status()?.state === "checking" ? "Loading models…" : "No models"}
                  </p>
                }
              >
                {(m, i) => {
                  const isHighlighted = () => highlight() === i();
                  return (
                    <>
                      <Show when={m.group && m.group !== models()[i() - 1]?.group}>
                        <div {...stylex.attrs(styles.group)}>{m.group}</div>
                      </Show>
                      <button
                        type="button"
                        onClick={() => props.onPick(browsing(), m.id)}
                        onMouseMove={() => setHighlight(i())}
                        {...stylex.attrs(styles.model, isHighlighted() && styles.modelHighlight)}
                        data-model={m.id}
                      >
                        <span {...stylex.attrs(styles.modelText)}>
                          <span {...stylex.attrs(styles.modelName)}>
                            {m.name}
                            <Show when={m.id === status()?.defaultModel}>
                              <span {...stylex.attrs(styles.badge)}>default</span>
                            </Show>
                          </span>
                          <Show when={m.description}>
                            <span {...stylex.attrs(styles.modelDescription)}>{m.description}</span>
                          </Show>
                        </span>
                        <Show when={selectedId() === m.id}>
                          <Icon name="check" size={14} {...stylex.attrs(styles.check)} />
                        </Show>
                      </button>
                    </>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 1,
    minWidth: 0,
    height: 28,
    maxWidth: 170,
    paddingInline: 7,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "background-color 120ms, color 120ms",
  },
  triggerOpen: { backgroundColor: colors.surfaceHover, color: colors.text },
  triggerLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  chevron: { flexShrink: 0, opacity: 0.7 },
  bars: { display: "inline-flex", alignItems: "flex-end", gap: 1.5, height: 10, flexShrink: 0 },
  bar: { width: 2.5, borderRadius: 1, backgroundColor: "currentColor", opacity: 0.28 },
  barOn: { opacity: 1 },
  popover: {
    position: "fixed",
    // Over the floating sidebar (components/Sidebar.tsx), like every menu.
    zIndex: 1000,
    display: "flex",
    maxHeight: 340,
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgb(0 0 0 / 0.18)",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  rail: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    width: 46,
    flexShrink: 0,
    padding: 4,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    backgroundColor: colors.bg,
  },
  railButton: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: 37,
    height: 37,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    cursor: "pointer",
  },
  railButtonActive: { backgroundColor: colors.surfaceHover },
  railButtonOff: { opacity: 0.45 },
  panel: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 40,
    flexShrink: 0,
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  searchIcon: { color: colors.muted, flexShrink: 0 },
  search: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderStyle: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
  },
  list: { flex: 1, overflowY: "auto", padding: 4 },
  group: {
    paddingTop: space.sm,
    paddingBottom: 2,
    paddingInline: space.sm,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  model: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    paddingBlock: 6,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.text,
    textAlign: "left",
    cursor: "pointer",
  },
  modelHighlight: { backgroundColor: colors.surfaceHover },
  modelText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 },
  modelName: { display: "flex", alignItems: "center", gap: 6, fontSize: font.sm, fontWeight: 500 },
  modelDescription: {
    color: colors.muted,
    fontSize: 11.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  badge: {
    paddingInline: 5,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontSize: 10.5,
    fontWeight: 500,
  },
  check: { color: colors.accent, flexShrink: 0 },
  empty: { margin: 0, padding: space.lg, color: colors.muted, textAlign: "center" },
  notice: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.lg,
    color: colors.muted,
    lineHeight: 1.45,
  },
  noticeTitle: { display: "flex", alignItems: "center", gap: 8, color: colors.text, fontWeight: 600 },
  noticeState: {
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: "18px",
  },
  noticeText: { margin: 0, fontSize: font.sm },
  noticeCode: {
    paddingBlock: 1,
    paddingInline: 5,
    borderRadius: 4,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 12,
    userSelect: "all",
  },
  noticeButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    marginTop: 2,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: "inherit",
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
});
