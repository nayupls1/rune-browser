// Shown in a web tab instead of an http:// page that has no secure version
// (shared/insecure.ts), like other browsers' warning: go back, or continue to
// the site this time or always.
import * as stylex from "@stylexjs/stylex";
import { createSignal } from "solid-js";
import { insecureHostOf } from "../../shared/insecure";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button, Checkbox } from "./ui";

export function InsecureWarning(props: {
  url: string;
  /** Its HTTPS version was tried and didn't load (otherwise, it has a port of its own and wasn't tried). */
  failed: boolean;
  onBack: () => void;
  onContinue: (always: boolean) => void;
}) {
  const [always, setAlways] = createSignal(false);
  const host = () => insecureHostOf(props.url);
  return (
    <div {...stylex.attrs(styles.page)} data-insecure-warning={props.url}>
      <div {...stylex.attrs(styles.card)}>
        <Icon name="triangle-alert" size={36} {...stylex.attrs(styles.icon)} />
        <h1 {...stylex.attrs(styles.title)}>This site isn't secure</h1>
        <p {...stylex.attrs(styles.text)}>
          <strong>{host()}</strong>{" "}
          {props.failed
            ? "doesn't support a secure connection (HTTPS)."
            : "uses an unencrypted connection (HTTP) on its own port, so there's no secure version to try."}{" "}
          Others on your network can see and change what you see and send there, like passwords, messages or card
          numbers.
        </p>
        <p {...stylex.attrs(styles.url)}>{props.url}</p>
        <label {...stylex.attrs(styles.always)}>
          <Checkbox checked={always()} onChange={(e) => setAlways(e.currentTarget.checked)} data-insecure-always />
          Don't warn me about {host()} again
        </label>
        <div {...stylex.attrs(styles.actions)}>
          <Button variant="ghost" onClick={() => props.onContinue(always())} data-insecure-continue>
            Continue to site
          </Button>
          <Button variant="primary" onClick={props.onBack} data-insecure-back>
            Go back
          </Button>
        </div>
      </div>
    </div>
  );
}

const styles = stylex.create({
  page: {
    position: "absolute",
    inset: 0,
    zIndex: 4,
    display: "grid",
    placeItems: "center",
    overflow: "auto",
    padding: space.lg,
    backgroundColor: colors.bg,
    color: colors.text,
  },
  card: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.md, maxWidth: 520 },
  icon: { color: colors.warning },
  title: { margin: 0, fontSize: 22, fontWeight: 600 },
  text: { margin: 0, fontSize: font.md, lineHeight: 1.5, color: colors.muted },
  url: {
    margin: 0,
    maxWidth: "100%",
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceHover,
    fontFamily: "ui-monospace, monospace",
    fontSize: font.sm,
    overflowWrap: "anywhere",
  },
  always: { display: "flex", alignItems: "center", gap: space.sm, fontSize: font.sm, cursor: "pointer" },
  actions: { display: "flex", justifyContent: "flex-end", gap: space.sm, alignSelf: "stretch", marginTop: space.sm },
});
