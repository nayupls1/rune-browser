// Asks the user when an app or agent wants to do something new (use AI, a
// global secret, customize a site). One request at a time, oldest first;
// unanswered requests are denied by the server after a while.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { PermissionRequest } from "../../shared/api";
import { answerPermission, permissionRequests } from "../lib/security";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

const icons: Record<PermissionRequest["action"], string> = {
  "app.ai": "sparkles",
  "app.secret": "key-round",
  "agent.site": "paintbrush",
  "agent.network": "network",
  "agent.override": "flask-conical",
  "app.data": "database",
  "app.endpoints": "waypoints",
  "app.tool": "wrench",
  "agent.schedule": "calendar-clock",
  "agent.tab": "app-window",
  "agent.browse": "mouse-pointer-click",
  "agent.confirm": "shield-alert",
  "agent.source": "file-code",
};

/** A diff line's kind, for its color. */
const lineKind = (line: string) =>
  line.startsWith("+") && !line.startsWith("+++")
    ? "add"
    : line.startsWith("-") && !line.startsWith("---")
      ? "remove"
      : line.startsWith("@@")
        ? "hunk"
        : "same";

/** Mount once at the app root. */
export function PermissionHost() {
  return (
    <Show when={permissionRequests()[0]} keyed>
      {(request) => <Prompt request={request} more={permissionRequests().length - 1} />}
    </Show>
  );
}

function Prompt(props: { request: PermissionRequest; more: number }) {
  const [remember, setRemember] = createSignal(false);
  const [wholeWorkspace, setWholeWorkspace] = createSignal(false);
  let allowButton!: HTMLButtonElement;
  onMount(() => allowButton.focus());
  const answer = (allow: boolean) =>
    void answerPermission(
      props.request.id,
      allow,
      remember() && wholeWorkspace() && props.request.workspace ? "workspace" : remember(),
    );
  const showWorkspaceOption = () => remember() && !!props.request.workspace;

  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)}>
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="permission-title"
          {...stylex.attrs(styles.dialog)}
          data-permission-request={props.request.action}
        >
          <div {...stylex.attrs(styles.head)}>
            <span {...stylex.attrs(styles.icon)}>
              <Icon name={icons[props.request.action]} size={18} />
            </span>
            <div {...stylex.attrs(styles.text)}>
              <span {...stylex.attrs(styles.who)}>{props.request.subjectName}</span>
              <h2 id="permission-title" {...stylex.attrs(styles.title)}>
                {props.request.title}
              </h2>
            </div>
          </div>
          <p {...stylex.attrs(styles.detail)}>{props.request.detail}</p>
          <Show when={props.request.diff}>
            {(diff) => (
              <pre {...stylex.attrs(styles.diff)} data-permission-diff>
                <For each={diff().split("\n")}>
                  {(line) => {
                    const kind = lineKind(line);
                    const added = () => kind === "add";
                    const removed = () => kind === "remove";
                    const hunk = () => kind === "hunk";
                    return (
                      <div
                        {...stylex.attrs(
                          styles.line,
                          added() && styles.added,
                          removed() && styles.removed,
                          hunk() && styles.hunk,
                        )}
                      >
                        {line || " "}
                      </div>
                    );
                  }}
                </For>
              </pre>
            )}
          </Show>
          <Show when={!props.request.once}>
            <label {...stylex.attrs(styles.remember)}>
              <input
                type="checkbox"
                checked={remember()}
                onChange={(e) => setRemember(e.currentTarget.checked)}
                data-remember
              />
              Remember my choice (you can change it in Settings → Agent permissions)
            </label>
          </Show>
          <Show when={showWorkspaceOption()}>
            <label {...stylex.attrs(styles.remember, styles.indented)}>
              <input
                type="checkbox"
                checked={wholeWorkspace()}
                onChange={(e) => setWholeWorkspace(e.currentTarget.checked)}
                data-remember-workspace
              />
              For every app in the workspace {props.request.workspace!.name}
            </label>
          </Show>
          <div {...stylex.attrs(styles.actions)}>
            <Show when={props.more > 0}>
              <span {...stylex.attrs(styles.more)}>{props.more} more waiting</span>
            </Show>
            <Button onClick={() => answer(false)} data-deny>
              Don't allow
            </Button>
            <Button ref={allowButton} variant="primary" onClick={() => answer(true)} data-allow>
              Allow
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
    zIndex: 2100,
    display: "grid",
    placeItems: "center",
    padding: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.35)",
    animationName: fadeIn,
    animationDuration: "120ms",
  },
  dialog: {
    width: "min(560px, 100%)",
    maxHeight: "calc(100vh - 48px)",
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
  head: { display: "flex", alignItems: "center", gap: space.md },
  icon: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  text: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  who: { color: colors.muted, fontSize: font.xs, fontWeight: 600 },
  title: { margin: 0, fontSize: font.lg, fontWeight: 600, lineHeight: 1.3, overflowWrap: "anywhere" },
  detail: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  remember: { display: "flex", alignItems: "center", gap: space.sm, fontSize: font.sm, cursor: "pointer" },
  indented: { marginTop: -4, paddingLeft: 22 },
  actions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: space.sm },
  more: { marginRight: "auto", color: colors.muted, fontSize: font.xs },
  diff: {
    margin: 0,
    maxHeight: 320,
    overflow: "auto",
    paddingBlock: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    fontFamily: font.mono,
    fontSize: font.xs,
    lineHeight: 1.5,
    whiteSpace: "pre",
  },
  line: { paddingInline: space.sm, minWidth: "max-content" },
  added: { backgroundColor: `color-mix(in oklab, transparent, ${colors.success} 16%)` },
  removed: { backgroundColor: `color-mix(in oklab, transparent, ${colors.danger} 16%)` },
  hunk: { color: colors.muted },
});
