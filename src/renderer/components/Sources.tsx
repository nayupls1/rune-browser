// The code attached to a tab for its agent (server: workspace/Sources.ts), in
// the agent sidebar: "Add a folder" in the composer's + menu attaches one,
// and each source is a small chip under the composer, with a repository's
// clone progress, pull and remove.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { ContextSource } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { colors, radius } from "../theme.stylex";
import { Icon } from "./Icon";
import { toast } from "./Toast";
const failed = (err: unknown) => toast({ message: err instanceof Error ? err.message : String(err), kind: "error" });

/** A tab's attached sources, kept up to date from the hub. */
function useSources(tabId: () => string) {
  const [sources, { mutate }] = createResource(tabId, (id) => api.sources(id).catch(() => [] as ContextSource[]));
  const [progress, setProgress] = createSignal<Record<string, string>>({});
  const stop = watchTopic(topics.app(tabId()), (msg) => {
    if (msg.type === "sources" && msg.appId === tabId()) mutate(msg.sources);
    if (msg.type === "source-progress" && msg.appId === tabId())
      setProgress((p) => ({ ...p, [msg.sourceId]: `${msg.phase}${msg.percent !== null ? ` ${msg.percent}%` : ""}` }));
  });
  onCleanup(stop);
  return { sources: () => sources() ?? [], progress };
}

/** Asks for a folder and attaches it to the tab. */
export async function addFolder(tabId: string) {
  const folder = await window.rune.pickFolder("A folder of code for the agent");
  if (folder) await api.addSource(tabId, { folder }).catch(failed);
}

/** Chips for the attached sources, under the composer. */
export function SourcesBar(props: { tabId: string }) {
  const { sources, progress } = useSources(() => props.tabId);
  return (
    <Show when={sources().length}>
      <div {...stylex.attrs(styles.bar)} data-sources>
        <For each={sources()}>
          {(source) => {
            const busy = () => source.state === "cloning" || source.state === "pulling";
            const broken = () => source.state === "error";
            const status = () =>
              busy()
                ? (progress()[source.id] ?? (source.state === "cloning" ? "Cloning…" : "Pulling…"))
                : broken()
                  ? source.error
                  : null;
            return (
              <span
                {...stylex.attrs(stylex.defaultMarker(), styles.chip, broken() && styles.chipBroken)}
                title={`${source.kind === "git" ? `${source.url}${source.branch ? ` (${source.branch})` : ""}\nCloned to ${source.path}` : source.path}${source.error ? `\n${source.error}` : ""}\nThe agent can read and search it, and changes it with your OK.`}
                data-source-chip={source.id}
                data-source-state={source.state}
              >
                <Icon
                  name={busy() ? "loader-circle" : source.kind === "git" ? "git-branch" : "folder-code"}
                  size={12}
                  {...stylex.attrs(busy() && styles.spin)}
                />
                <span {...stylex.attrs(styles.label)}>{source.name}</span>
                <Show when={status()}>{(text) => <span {...stylex.attrs(styles.status)}>{text()}</span>}</Show>
                <Show when={source.kind === "git" && !busy()}>
                  <button
                    type="button"
                    title={broken() ? "Try again" : "Pull the latest commits"}
                    onClick={() => void api.pullSource(props.tabId, source.id).catch(failed)}
                    {...stylex.attrs(styles.chipButton)}
                    data-source-pull
                  >
                    <Icon name="refresh-cw" size={11} />
                  </button>
                </Show>
                <button
                  type="button"
                  title={
                    source.kind === "git"
                      ? "Remove (deletes Rune Browser's clone)"
                      : "Remove (your folder stays as it is)"
                  }
                  onClick={() => void api.removeSource(props.tabId, source.id).catch(failed)}
                  {...stylex.attrs(styles.chipButton)}
                  data-source-remove
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

const styles = stylex.create({
  bar: { display: "contents" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    maxWidth: "100%",
    height: 24,
    paddingLeft: 7,
    paddingRight: 2,
    borderRadius: radius.full,
    color: colors.muted,
    fontSize: 12,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
  },
  chipBroken: { color: colors.danger },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140, fontWeight: 500 },
  status: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140, opacity: 0.8 },
  chipButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 18,
    height: 18,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.border },
    color: "inherit",
    cursor: "pointer",
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, ":focus-visible": 1 },
  },
  spin: {
    animationName: spin,
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
});
