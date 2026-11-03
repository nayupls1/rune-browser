// A site's (or a proxy's) sign-in prompt (HTTP authentication), like
// Chrome's: shown when no extension, such as a password manager, filled it in
// (main/web.ts). One at a time; the others wait.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { AuthPrompt } from "../../shared/api";
import { colors, font, radius, space } from "../theme.stylex";
import { Button, Input } from "./ui";

const [queue, setQueue] = createSignal<AuthPrompt[]>([]);
window.rune.web.onAuthPrompt((request) => setQueue((q) => [...q, request]));

/** Mount once at the app root. */
export function AuthHost() {
  return (
    <Show when={queue()[0]} keyed>
      {(request) => <Dialog request={request} />}
    </Show>
  );
}

function Dialog(props: { request: AuthPrompt }) {
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  let first!: HTMLInputElement;
  const close = (value: { username: string; password: string } | null) => {
    window.rune.web.authReply(props.request.requestId, value);
    setQueue((q) => q.filter((r) => r.requestId !== props.request.requestId));
  };
  const insecure = () => !props.request.isProxy && !/^https:/i.test(props.request.url);
  onMount(() => {
    first.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close(null);
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });
  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)}>
        <form
          role="dialog"
          aria-modal="true"
          aria-label="Sign in"
          onSubmit={(e) => {
            e.preventDefault();
            close({ username: username(), password: password() });
          }}
          {...stylex.attrs(styles.dialog)}
          data-auth-dialog
        >
          <h2 {...stylex.attrs(styles.title)}>Sign in</h2>
          <p {...stylex.attrs(styles.text)}>
            {props.request.isProxy
              ? `The proxy ${props.request.host} needs a username and password.`
              : `${props.request.host} needs a username and password.`}
            <Show when={props.request.realm}>
              <span {...stylex.attrs(styles.muted)}> It says: “{props.request.realm}”</span>
            </Show>
          </p>
          <Show when={insecure()}>
            <p {...stylex.attrs(styles.text, styles.warning)}>
              Your connection to this site isn't private: they're sent unencrypted.
            </p>
          </Show>
          <label {...stylex.attrs(styles.label)}>
            Username
            <Input
              ref={first}
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              autocomplete="username"
              spellcheck={false}
              data-auth-username
            />
          </label>
          <label {...stylex.attrs(styles.label)}>
            Password
            <Input
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              autocomplete="current-password"
              data-auth-password
            />
          </label>
          <div {...stylex.attrs(styles.actions)}>
            <Button onClick={() => close(null)}>Cancel</Button>
            <Button type="submit" variant="primary" data-auth-submit>
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "grid",
    placeItems: "center",
    padding: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.35)",
  },
  dialog: {
    width: "min(400px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
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
  title: { margin: 0, fontSize: font.lg, fontWeight: 600 },
  text: { margin: 0, fontSize: font.sm, lineHeight: 1.5, overflowWrap: "anywhere" },
  muted: { color: colors.muted },
  warning: { color: colors.warning },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: font.sm },
  actions: { display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.xs },
});
