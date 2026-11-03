// A web tab's page that didn't load, like Chromium's error pages (shared/loadErrors.ts):
// "This site can't be reached" with Reload, or for a certificate that isn't valid
// "Your connection is not private" with Back to safety, and under Advanced what's
// wrong and a way through to the site, at the user's own risk.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, Show } from "solid-js";
import type { LoadError } from "../../shared/loadErrors";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

export function LoadErrorPage(props: {
  error: LoadError;
  url: string;
  contentsId: number | null;
  onReload: () => void;
  onBack: () => void;
  onProceed: () => void;
}) {
  const [advanced, setAdvanced] = createSignal(false);
  const certificate = () => props.error.kind === "certificate";
  const [problem] = createResource(
    () => (certificate() && props.contentsId !== null ? ([props.contentsId, props.url] as const) : null),
    ([id, url]) => window.rune.web.certificateProblem(id, url).catch(() => null),
  );
  const host = () => {
    try {
      return new URL(props.url).host;
    } catch {
      return props.url;
    }
  };
  return (
    <div {...stylex.attrs(styles.page, certificate() && styles.pageDanger)} data-load-error={props.error.kind}>
      <div {...stylex.attrs(styles.body)}>
        <Icon
          name={certificate() ? "shield-alert" : "cloud-off"}
          size={56}
          {...stylex.attrs(styles.icon, certificate() && styles.iconDanger)}
        />
        <h1 {...stylex.attrs(styles.title)}>{props.error.title}</h1>
        <p {...stylex.attrs(styles.text)}>{props.error.message}</p>
        <Show when={props.error.tips?.length}>
          <div {...stylex.attrs(styles.text)}>
            Try:
            <ul {...stylex.attrs(styles.tips)}>
              <For each={props.error.tips}>{(tip) => <li>{tip}</li>}</For>
            </ul>
          </div>
        </Show>
        <p {...stylex.attrs(styles.code)} data-load-error-code>
          {props.error.code}
        </p>
        <div {...stylex.attrs(styles.buttons)}>
          <Show
            when={certificate()}
            fallback={
              <Button variant="primary" onClick={props.onReload} data-load-error-reload>
                Reload
              </Button>
            }
          >
            <Button onClick={() => setAdvanced(!advanced())} data-load-error-advanced>
              {advanced() ? "Hide advanced" : "Advanced"}
            </Button>
            <Button variant="primary" onClick={props.onBack} data-load-error-back>
              Back to safety
            </Button>
          </Show>
        </div>
        <Show when={certificate() && advanced()}>
          <div {...stylex.attrs(styles.advanced)}>
            <p {...stylex.attrs(styles.text)}>{props.error.advanced}</p>
            <Show when={problem()}>
              {(p) => (
                <dl {...stylex.attrs(styles.details)} data-certificate-details>
                  <dt>Issued to</dt>
                  <dd {...stylex.attrs(styles.dd)}>{p().subject}</dd>
                  <dt>Issued by</dt>
                  <dd {...stylex.attrs(styles.dd)}>{p().issuer}</dd>
                  <dt>Valid</dt>
                  <dd {...stylex.attrs(styles.dd)}>
                    {date(p().validFrom)} to {date(p().validUntil)}
                  </dd>
                  <dt>Fingerprint</dt>
                  <dd {...stylex.attrs(styles.dd, styles.mono)}>{p().fingerprint}</dd>
                </dl>
              )}
            </Show>
            <button type="button" {...stylex.attrs(styles.proceed)} onClick={props.onProceed} data-load-error-proceed>
              Proceed to {host()} (unsafe)
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

const styles = stylex.create({
  page: {
    position: "absolute",
    inset: 0,
    zIndex: 2,
    overflowY: "auto",
    display: "flex",
    justifyContent: "center",
    backgroundColor: colors.bg,
    color: colors.text,
  },
  pageDanger: { backgroundColor: { default: "#fdf3f2", "@media (prefers-color-scheme: dark)": "#1f1413" } },
  body: {
    width: "100%",
    maxWidth: 600,
    paddingTop: "12vh",
    paddingInline: space.xl,
    paddingBottom: space.xxl,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.md,
  },
  icon: { color: colors.muted, marginBottom: space.md },
  iconDanger: { color: colors.danger },
  title: { margin: 0, fontSize: font.xxl, fontWeight: 600 },
  text: { margin: 0, color: colors.muted, fontSize: font.md, lineHeight: 1.6 },
  tips: { marginBlock: space.xs, paddingLeft: space.xl },
  code: { margin: 0, color: colors.muted, fontSize: font.xs, fontFamily: font.mono, textTransform: "uppercase" },
  buttons: { display: "flex", gap: space.sm, marginTop: space.lg, alignSelf: "stretch", justifyContent: "flex-end" },
  advanced: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    marginTop: space.lg,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    alignSelf: "stretch",
  },
  details: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: space.lg,
    rowGap: space.xs,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    fontSize: font.sm,
    overflowWrap: "anywhere",
  },
  dd: { margin: 0 },
  mono: { fontFamily: font.mono, fontSize: font.xs },
  proceed: {
    alignSelf: "flex-start",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.muted,
    fontSize: font.sm,
    textDecoration: "underline",
    cursor: "pointer",
  },
});
