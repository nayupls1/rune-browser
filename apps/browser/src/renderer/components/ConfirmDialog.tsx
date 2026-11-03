// In-app confirmation dialog (themed, non-blocking) instead of window.confirm.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { colors, font, radius, space } from "../theme.stylex";
import { Button } from "./ui";

interface Request {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const [request, setRequest] = createSignal<Request>();

/** Asks the user to confirm; resolves to true if they did. */
export function confirmDialog(message: string, options: { confirmLabel?: string; danger?: boolean } = {}) {
  request()?.resolve(false);
  return new Promise<boolean>((resolve) =>
    setRequest({ message, confirmLabel: options.confirmLabel ?? "OK", danger: !!options.danger, resolve }),
  );
}

/** Mount once at the app root. */
export function ConfirmHost() {
  return <Show when={request()}>{(req) => <Dialog request={req()} />}</Show>;
}

function Dialog(props: { request: Request }) {
  let confirmButton!: HTMLButtonElement;
  const close = (ok: boolean) => {
    props.request.resolve(ok);
    setRequest(undefined);
  };
  onMount(() => {
    confirmButton.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });
  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)} onClick={(e) => e.target === e.currentTarget && close(false)}>
        <div role="alertdialog" aria-modal="true" {...stylex.attrs(styles.dialog)} data-confirm-dialog>
          <p {...stylex.attrs(styles.message)}>{props.request.message}</p>
          <div {...stylex.attrs(styles.actions)}>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button
              ref={confirmButton}
              variant={props.request.danger ? "danger" : "primary"}
              onClick={() => close(true)}
              data-confirm
            >
              {props.request.confirmLabel}
            </Button>
          </div>
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
    zIndex: 2000,
    display: "grid",
    placeItems: "center",
    padding: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.35)",
    animationName: fadeIn,
    animationDuration: "120ms",
  },
  dialog: {
    width: "min(420px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    boxShadow: "0 20px 50px rgb(0 0 0 / 0.25)",
  },
  message: { margin: 0, fontSize: font.md, lineHeight: 1.5, whiteSpace: "pre-wrap" },
  actions: { display: "flex", justifyContent: "flex-end", gap: space.sm },
});
