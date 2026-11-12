// Passkeys and security keys (lib/passkeys.ts, main/passkeys.ts): the prompt over a web tab while its
// page waits for a security key ("touch your key", with Cancel), the account picker when a key holds
// several passkeys for the site, and why a request couldn't be used. At the top of the tab, like Chrome's
// WebAuthn dialog (site permission prompts are at its top left).
import * as stylex from "@stylexjs/stylex";
import { For, Match, Show, Switch } from "solid-js";
import { failureText, waitingText, type PasskeyPrompt as Prompt } from "../../shared/passkeys";
import { passkeyPromptFor, replyToPasskeyPrompt } from "../lib/passkeys";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

export function PasskeyPrompt(props: { contentsId: number | null; onTakeOver: () => void }) {
  return (
    <div {...stylex.attrs(styles.area)}>
      <Show when={passkeyPromptFor(props.contentsId)} keyed>
        {(prompt) => <PromptCard prompt={prompt} onTakeOver={props.onTakeOver} />}
      </Show>
    </div>
  );
}

function PromptCard(props: { prompt: Prompt; onTakeOver: () => void }) {
  const platform = window.rune.window.platform;
  const cancel = () => replyToPasskeyPrompt(props.prompt, { action: "cancel" });
  const dismiss = () => replyToPasskeyPrompt(props.prompt, { action: "dismiss" });
  return (
    <div
      role={props.prompt.kind === "failed" ? "alert" : "dialog"}
      aria-label={`Passkey for ${props.prompt.site}`}
      {...stylex.attrs(styles.card)}
      data-passkey-prompt={props.prompt.kind}
    >
      <Switch>
        <Match when={props.prompt.kind === "waiting" && props.prompt} keyed>
          {(prompt) => {
            const text = waitingText(prompt, platform);
            return (
              <>
                <div {...stylex.attrs(styles.header)}>
                  <span {...stylex.attrs(styles.badge)}>
                    <span {...stylex.attrs(styles.pulse)} />
                    <Icon name="usb" size={18} />
                  </span>
                  <h2 {...stylex.attrs(styles.title)}>{text.title}</h2>
                </div>
                <p {...stylex.attrs(styles.body)}>{text.body}</p>
                <p {...stylex.attrs(styles.note)}>{text.note}</p>
                <div {...stylex.attrs(styles.actions)}>
                  <Button onClick={cancel} data-passkey-cancel>
                    Cancel
                  </Button>
                </div>
              </>
            );
          }}
        </Match>
        <Match when={props.prompt.kind === "account" && props.prompt} keyed>
          {(prompt) => (
            <>
              <div {...stylex.attrs(styles.header)}>
                <span {...stylex.attrs(styles.badge)}>
                  <Icon name="key-round" size={18} />
                </span>
                <h2 {...stylex.attrs(styles.title)}>Choose an account for {prompt.site}</h2>
              </div>
              <ul {...stylex.attrs(styles.accounts)}>
                <For each={prompt.accounts}>
                  {(account) => (
                    <li>
                      <button
                        type="button"
                        onClick={() =>
                          replyToPasskeyPrompt(prompt, { action: "account", credentialId: account.credentialId })
                        }
                        {...stylex.attrs(styles.account)}
                        data-passkey-account={account.name}
                      >
                        <span {...stylex.attrs(styles.avatar)}>{account.name.slice(0, 1).toUpperCase()}</span>
                        <span {...stylex.attrs(styles.accountText)}>
                          <span {...stylex.attrs(styles.accountName)}>{account.name}</span>
                          <Show when={account.detail}>
                            <span {...stylex.attrs(styles.accountDetail)}>{account.detail}</span>
                          </Show>
                        </span>
                        <Icon name="chevron-right" size={16} {...stylex.attrs(styles.chevron)} />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <div {...stylex.attrs(styles.actions)}>
                <Button onClick={cancel} data-passkey-cancel>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </Match>
        <Match when={props.prompt.kind === "failed" && props.prompt} keyed>
          {(prompt) => {
            const text = failureText(prompt.failure, prompt.site, platform);
            const agent = () => prompt.failure === "agent";
            return (
              <>
                <div {...stylex.attrs(styles.header)} data-passkey-failure={prompt.failure}>
                  <span {...stylex.attrs(styles.badge, styles.warningBadge)}>
                    <Icon name={agent() ? "bot-off" : "shield-alert"} size={18} />
                  </span>
                  <h2 {...stylex.attrs(styles.title)}>{text.title}</h2>
                  <button
                    type="button"
                    title="Close"
                    onClick={dismiss}
                    {...stylex.attrs(styles.iconButton)}
                    data-passkey-dismiss
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <p {...stylex.attrs(styles.body)}>{text.body}</p>
                <Show when={agent()}>
                  <div {...stylex.attrs(styles.actions)}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        dismiss();
                        props.onTakeOver();
                      }}
                      data-passkey-take-over
                    >
                      Take over
                    </Button>
                  </div>
                </Show>
              </>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}

const pulse = stylex.keyframes({
  "0%": { transform: "scale(0.85)", opacity: 0.7 },
  "100%": { transform: "scale(1.6)", opacity: 0 },
});

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  area: {
    position: "absolute",
    top: space.sm,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 6,
    width: 380,
    maxWidth: "calc(100% - 16px)",
    pointerEvents: "none",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.2)",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    pointerEvents: "auto",
  },
  header: { display: "flex", alignItems: "center", gap: space.md },
  badge: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  warningBadge: {
    backgroundColor: "color-mix(in oklab, transparent, currentColor 14%)",
    color: colors.warning,
  },
  pulse: {
    position: "absolute",
    inset: 0,
    borderRadius: radius.full,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: colors.accent,
    animationName: { default: pulse, [REDUCED_MOTION]: "none" },
    animationDuration: "1.6s",
    animationTimingFunction: "ease-out",
    animationIterationCount: "infinite",
    opacity: { default: null, [REDUCED_MOTION]: 0 },
  },
  title: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    fontSize: font.md,
    fontWeight: 600,
    lineHeight: 1.3,
    overflowWrap: "anywhere",
  },
  body: { margin: 0, lineHeight: 1.45, overflowWrap: "anywhere" },
  note: { margin: 0, color: colors.muted, fontSize: font.xs, lineHeight: 1.4 },
  actions: { display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.xs },
  accounts: { display: "flex", flexDirection: "column", gap: 4, margin: 0, padding: 0, listStyle: "none" },
  account: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    width: "100%",
    paddingBlock: space.sm,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: "inherit",
    fontSize: font.sm,
    textAlign: "start",
    cursor: "pointer",
  },
  avatar: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontWeight: 600,
  },
  accountText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  accountName: { fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  accountDetail: {
    color: colors.muted,
    fontSize: font.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: { flexShrink: 0, color: colors.muted },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 26,
    height: 26,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
});
