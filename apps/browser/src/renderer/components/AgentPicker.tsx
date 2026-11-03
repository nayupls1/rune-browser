// Picks who answers: provider, model and effort (modeled on t3code's picker).
// The popover has a rail of providers on the left and the selected
// provider's models on the right, with search; effort is a small menu next to
// it, offering only what the model supports.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
import { ContextMenu, type MenuPosition } from "./ContextMenu";
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

export function AgentPicker(props: {
  choice: AgentChoice;
  onChange: (choice: AgentChoice) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [effortMenu, setEffortMenu] = createSignal<MenuPosition>();
  let trigger!: HTMLButtonElement;

  const model = () => choiceModel(props.choice);
  const modelLabel = () => model()?.name ?? props.choice.model ?? "Default model";
  const efforts = () => model()?.efforts ?? [];

  const pick = (provider: ProviderId, modelId: string) => {
    const next = providerById(provider)?.models.find((m) => m.id === modelId);
    // Keep the effort when the new model supports it.
    const effort = props.choice.effort && next?.efforts.includes(props.choice.effort) ? props.choice.effort : null;
    props.onChange({ provider, model: modelId, effort });
    setOpen(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={`${providerById(props.choice.provider)?.label ?? props.choice.provider} · ${modelLabel()}`}
        onClick={() => setOpen((o) => !o)}
        {...stylex.attrs(styles.trigger, open() && styles.triggerOpen)}
        data-agent-picker
      >
        <ProviderIcon provider={props.choice.provider} size={14} />
        <Show when={!props.compact}>
          <span {...stylex.attrs(styles.triggerLabel)}>{modelLabel()}</span>
        </Show>
        <Icon name="chevron-down" size={12} />
      </button>
      <Show when={efforts().length}>
        <button
          type="button"
          title="Reasoning effort"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setEffortMenu({ x: r.left, y: r.top - 8 - 36 * (efforts().length + 1) });
          }}
          {...stylex.attrs(styles.trigger)}
          data-effort-picker
        >
          <span {...stylex.attrs(styles.triggerLabel)}>
            {props.choice.effort ? (effortLabels[props.choice.effort] ?? props.choice.effort) : "Auto"}
          </span>
          <Icon name="chevron-down" size={12} />
        </button>
      </Show>
      <Show when={effortMenu()}>
        {(position) => (
          <ContextMenu
            position={position()}
            onClose={() => setEffortMenu()}
            items={[
              {
                label: "Auto",
                icon: props.choice.effort ? undefined : "check",
                onSelect: () => props.onChange({ ...props.choice, effort: null }),
              },
              ...efforts().map((level) => ({
                label: effortLabels[level] ?? level,
                icon: props.choice.effort === level ? "check" : undefined,
                onSelect: () => props.onChange({ ...props.choice, effort: level }),
              })),
            ]}
          />
        )}
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
  const [highlight, setHighlight] = createSignal(0);
  let root!: HTMLDivElement;
  let search!: HTMLInputElement;

  const status = () => providerById(browsing());
  const models = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = status()?.models ?? [];
    return q ? list.filter((m) => `${m.name} ${m.id} ${m.group ?? ""}`.toLowerCase().includes(q)) : list;
  });
  const selectedId = () =>
    props.choice.provider === browsing() ? (props.choice.model ?? status()?.defaultModel) : undefined;

  // Above the composer when there's room, else below the trigger.
  const rect = props.anchor.getBoundingClientRect();
  const height = 340;
  const top = rect.top > height + 16 ? rect.top - height - 8 : rect.bottom + 8;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 400));

  onMount(() => {
    search.focus();
    const onPointer = (e: PointerEvent) => {
      if (!root.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointer, true));
  });

  const onKey = (e: KeyboardEvent) => {
    const list = models();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
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
        style={{ top: `${top}px`, left: `${left}px`, height: `${height}px` }}
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
                    setHighlight(0);
                    search.focus();
                  }}
                  {...stylex.attrs(
                    styles.railButton,
                    active() && styles.railButtonActive,
                    off() && styles.railButtonOff,
                  )}
                  data-provider={id}
                >
                  <ProviderIcon provider={id} size={18} />
                  <Show when={active()}>
                    <span {...stylex.attrs(styles.railIndicator)} />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        <div {...stylex.attrs(styles.panel)}>
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
          <Show
            when={usable(status())}
            fallback={
              <div {...stylex.attrs(styles.notice)}>
                <strong>
                  {status()?.label ?? browsing()}: {stateText[status()?.state ?? "missing"]}
                </strong>
                <span>{status()?.message ?? ""}</span>
                <button
                  type="button"
                  onClick={() => void refreshProviders(browsing())}
                  {...stylex.attrs(styles.noticeButton)}
                >
                  Check again
                </button>
              </div>
            }
          >
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
    height: 28,
    maxWidth: 190,
    paddingInline: 7,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    fontSize: font.xs,
    cursor: "pointer",
  },
  triggerOpen: { backgroundColor: colors.surfaceHover, color: colors.text },
  triggerLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  popover: {
    position: "fixed",
    zIndex: 100,
    display: "flex",
    width: 380,
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
  railIndicator: {
    position: "absolute",
    right: -4,
    top: "50%",
    width: 3,
    height: 20,
    marginTop: -10,
    borderTopLeftRadius: 3,
    borderBottomLeftRadius: 3,
    backgroundColor: colors.accent,
  },
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
  noticeButton: {
    paddingBlock: 4,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.xs,
    cursor: "pointer",
  },
});
