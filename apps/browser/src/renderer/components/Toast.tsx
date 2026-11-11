// Small notices in the corner ("Saved a snapshot", a failed action).
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Portal } from "solid-js/web";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

type Kind = "info" | "success" | "error";

interface ToastAction {
  label: string;
  run: () => void;
}

interface Toast {
  id: number;
  title?: string;
  message: string;
  kind: Kind;
  action?: ToastAction;
}

const [toasts, setToasts] = createStore<Toast[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

const dismiss = (id: number) => {
  clearTimeout(timers.get(id));
  timers.delete(id);
  setToasts((list) => list.filter((t) => t.id !== id));
};

const expire = (id: number, kind: Kind) => {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => dismiss(id), kind === "error" ? 10_000 : 5_000),
  );
};

/** Shows a notice, with a button if given. `sticky` ones stay until updated (e.g. "Running…" → the result). */
export function toast(options: {
  title?: string;
  message: string;
  kind?: Kind;
  sticky?: boolean;
  action?: ToastAction;
}) {
  const id = nextId++;
  const kind = options.kind ?? "info";
  setToasts((list) => [
    ...list.slice(-3),
    { id, title: options.title, message: options.message, kind, action: options.action },
  ]);
  if (!options.sticky) expire(id, kind);
  return {
    update(next: { message?: string; kind?: Kind }) {
      setToasts(
        (t) => t.id === id,
        produce((t) => Object.assign(t, next)),
      );
      expire(id, next.kind ?? kind);
    },
    dismiss: () => dismiss(id),
  };
}

const icons: Record<Kind, string> = { info: "info", success: "circle-check", error: "circle-alert" };

/** Mount once at the app root. */
export function ToastHost() {
  return (
    <Portal>
      <div {...stylex.attrs(styles.stack)} aria-live="polite">
        <For each={toasts}>
          {(t) => {
            const succeeded = () => t.kind === "success";
            const failed = () => t.kind === "error";
            return (
              <div role="status" {...stylex.attrs(styles.toast)} data-toast={t.kind}>
                <Icon
                  name={icons[t.kind]}
                  size={16}
                  {...stylex.attrs(styles.icon, succeeded() && styles.success, failed() && styles.error)}
                />
                <div {...stylex.attrs(styles.body)}>
                  <Show when={t.title}>
                    <strong {...stylex.attrs(styles.title)}>{t.title}</strong>
                  </Show>
                  <span {...stylex.attrs(styles.message)}>{t.message}</span>
                  <Show when={t.action}>
                    {(action) => (
                      <button
                        type="button"
                        onClick={() => {
                          action().run();
                          dismiss(t.id);
                        }}
                        {...stylex.attrs(styles.action)}
                        data-toast-action
                      >
                        {action().label}
                      </button>
                    )}
                  </Show>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismiss(t.id)}
                  {...stylex.attrs(styles.close)}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </Portal>
  );
}

const slideIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(6px)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  stack: {
    position: "fixed",
    right: space.lg,
    bottom: space.lg,
    zIndex: 2500,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space.sm,
    pointerEvents: "none",
  },
  toast: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    width: "min(360px, calc(100vw - 32px))",
    paddingBlock: space.md,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
    pointerEvents: "auto",
    animationName: slideIn,
    animationDuration: "140ms",
  },
  icon: { flexShrink: 0, marginTop: 1, color: colors.muted },
  success: { color: colors.success },
  error: { color: colors.danger },
  body: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  title: { fontWeight: 600 },
  message: { lineHeight: 1.45, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
  action: {
    alignSelf: "flex-start",
    marginTop: 4,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.accent, ":hover": colors.text },
    fontFamily: font.sans,
    fontSize: font.sm,
    fontWeight: 600,
    cursor: "pointer",
  },
  close: {
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    padding: 2,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    ":hover": { color: colors.text, backgroundColor: colors.surfaceHover },
  },
});
