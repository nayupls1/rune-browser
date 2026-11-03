// The code attached to a tab for its agent (server: workspace/Sources.ts), in
// the agent sidebar: a button next to the composer adds a folder or a Git
// repository, and each source is a chip above the text, with its clone's
// progress, pull and remove.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { ContextSource } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { colors, font, radius, space } from "../theme.stylex";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
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

/** Chips for the attached sources, and the form to add a repository. Above the composer. */
export function SourcesBar(props: { tabId: string; adding: boolean; onDone: () => void }) {
  const { sources, progress } = useSources(() => props.tabId);
  const [url, setUrl] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const add = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!url().trim()) return;
    try {
      await api.addSource(props.tabId, { git: url().trim(), ...(branch().trim() ? { branch: branch().trim() } : {}) });
      setUrl("");
      setBranch("");
      props.onDone();
    } catch (err) {
      failed(err);
    }
  };
  return (
    <Show when={sources().length || props.adding}>
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
                {...stylex.attrs(styles.chip, broken() && styles.chipBroken)}
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
        <Show when={props.adding}>
          <form onSubmit={add} {...stylex.attrs(styles.form)} data-source-form>
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              value={url()}
              placeholder="https://github.com/owner/repo, owner/repo or git@…"
              spellcheck={false}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && props.onDone()}
              {...stylex.attrs(styles.input)}
              data-source-url
            />
            <input
              value={branch()}
              placeholder="Branch"
              spellcheck={false}
              onInput={(e) => setBranch(e.currentTarget.value)}
              {...stylex.attrs(styles.input, styles.branch)}
            />
            <button type="submit" disabled={!url().trim()} {...stylex.attrs(styles.link)}>
              Add
            </button>
            <button type="button" onClick={() => props.onDone()} {...stylex.attrs(styles.link, styles.muted)}>
              Cancel
            </button>
          </form>
        </Show>
      </div>
    </Show>
  );
}

/** The button next to the composer that attaches code. */
export function SourcesButton(props: { tabId: string; onAddRepository: () => void }) {
  const [menu, setMenu] = createSignal<MenuPosition>();
  const items: MenuItem[] = [
    {
      label: "Add a folder…",
      icon: "folder-code",
      onSelect: async () => {
        const folder = await window.rune.pickFolder("A folder of code for the agent");
        if (folder) await api.addSource(props.tabId, { folder }).catch(failed);
      },
    },
    { label: "Add a Git repository…", icon: "git-branch", onSelect: () => props.onAddRepository() },
  ];
  return (
    <>
      <button
        type="button"
        title="Give the agent code: a folder or a Git repository"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.top - 80 });
        }}
        {...stylex.attrs(styles.button)}
        data-add-source
      >
        <Icon name="folder-code" size={15} />
      </button>
      <Show when={menu()}>
        {(position) => <ContextMenu items={items} position={position()} onClose={() => setMenu()} />}
      </Show>
    </>
  );
}

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

const styles = stylex.create({
  bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, paddingInline: 4, paddingTop: 2 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    height: 22,
    paddingLeft: 7,
    paddingRight: 2,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    fontSize: font.xs,
  },
  chipBroken: { color: colors.danger },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160, fontWeight: 500 },
  status: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180, color: colors.muted },
  chipButton: {
    display: "grid",
    placeItems: "center",
    width: 18,
    height: 18,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.border },
    color: colors.muted,
    cursor: "pointer",
  },
  spin: {
    animationName: spin,
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  form: { display: "flex", alignItems: "center", gap: space.xs, width: "100%" },
  input: {
    flex: 1,
    minWidth: 0,
    height: 26,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    color: colors.text,
    outline: "none",
    fontSize: font.xs,
  },
  branch: { flex: "0 1 90px" },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontSize: font.xs,
    cursor: "pointer",
    opacity: { default: 1, ":disabled": 0.5 },
  },
  muted: { color: colors.muted },
  button: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
});
