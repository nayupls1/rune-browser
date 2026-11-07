// The screen of a new app tab (no project yet): describing the app happens in
// the agent sidebar; here are ideas, templates, and importing a project from
// Git or a folder. Each way ends in the same app lifecycle (server: Projects).
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { sendWithShares } from "../lib/sharing";
import { isAgentCollapsed, setAgentCollapsed } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

const examples = [
  "A habit tracker with daily check-ins and a streak count",
  "Track my expenses by category with a monthly total",
  "A shared grocery list that updates live on every device",
];

/** A new app tab: describe the app to the agent, pick an idea or a template, or bring an existing project. */
export function NewApp(props: { appId: string }) {
  const send = (prompt: string) => sendWithShares(props.appId, prompt);
  // Ready to type: the agent sidebar's composer.
  onMount(() =>
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>(`[data-agent-for="${props.appId}"] textarea`)?.focus(),
    ),
  );
  const [presets] = createResource(() => api.presets().catch(() => []));
  const [starting, setStarting] = createSignal<string>();

  const [gitUrl, setGitUrl] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const [showBranch, setShowBranch] = createSignal(false);
  const [importing, setImporting] = createSignal<"git" | "folder">();
  const [progress, setProgress] = createSignal<{ phase: string; percent: number | null }>();
  const [importError, setImportError] = createSignal<string>();
  const cloning = () => importing() === "git";
  const percent = () => progress()?.percent ?? null;
  const hasPercent = () => percent() !== null;
  const indeterminate = () => percent() === null;
  onCleanup(
    watchTopic(topics.app(props.appId), (msg) => {
      if (msg.type === "import-progress" && importing()) setProgress({ phase: msg.phase, percent: msg.percent });
    }),
  );
  /** Cloned or copied in, then it's an app like any other (Projects.importApp). */
  const importFrom = async (source: { git: string; branch?: string } | { folder: string }) => {
    setImportError();
    setImporting("git" in source ? "git" : "folder");
    setProgress({ phase: "git" in source ? "Starting git…" : "Copying…", percent: null });
    try {
      const { project } = await api.importApp(props.appId, source);
      // Rune Browser couldn't tell how to run it: the agent sets it up.
      if (!project) {
        setAgentCollapsed(props.appId, false);
        await send(
          "I imported this project. Look at it and set it up so Rune Browser can run it: write rune.json (install, dev, build and start commands), make the server listen on $PORT, then start it and check that it works.",
        );
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting();
      setProgress();
    }
  };
  const clone = () => {
    const url = gitUrl().trim();
    if (url) void importFrom({ git: url, ...(branch().trim() ? { branch: branch().trim() } : {}) });
  };
  const pickFolder = async () => {
    const folder = await window.rune.pickFolder("Import an app from a folder");
    if (folder) await importFrom({ folder });
  };

  const startFrom = async (preset: string) => {
    setStarting(preset);
    try {
      await api.createProject(props.appId, preset);
    } finally {
      setStarting();
    }
  };

  return (
    <div {...stylex.attrs(styles.newRoot)} data-app-tab={props.appId}>
      <div {...stylex.attrs(styles.newInner)}>
        <h1 {...stylex.attrs(styles.title)}>What do you want to build?</h1>
        <p {...stylex.attrs(styles.subtitle)}>
          Describe an app to the agent and it builds it: a real project with its own server and database, running right
          here.
        </p>
        <Show
          when={isAgentCollapsed(props.appId)}
          fallback={
            <p {...stylex.attrs(styles.describeHint)}>
              Describe it in the agent panel
              <Icon name="arrow-right" size={16} />
            </p>
          }
        >
          <Button variant="primary" onClick={() => setAgentCollapsed(props.appId, false)} data-agent-show>
            <Icon name="bot" size={16} />
            Describe it to the agent
          </Button>
        </Show>
        <span {...stylex.attrs(styles.presetsLabel)}>Or pick an idea</span>
        <div {...stylex.attrs(styles.chips)}>
          <For each={examples}>
            {(example) => (
              <button type="button" onClick={() => send(example)} {...stylex.attrs(styles.example)}>
                {example}
              </button>
            )}
          </For>
        </div>
        <Show when={presets()?.length}>
          <div {...stylex.attrs(styles.presets)}>
            <span {...stylex.attrs(styles.presetsLabel)}>Or start from a template</span>
            <div {...stylex.attrs(styles.chips)}>
              <For each={presets()}>
                {(preset) => (
                  <button
                    type="button"
                    title={preset.description}
                    disabled={!!starting()}
                    onClick={() => void startFrom(preset.id)}
                    {...stylex.attrs(styles.preset)}
                    data-template={preset.id}
                  >
                    <strong>{preset.name}</strong>
                    <span {...stylex.attrs(styles.presetStack)}>
                      {starting() === preset.id ? "Setting up…" : preset.stack}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div {...stylex.attrs(styles.presets)}>
          <span {...stylex.attrs(styles.presetsLabel)}>Or bring an app you have</span>
          <div {...stylex.attrs(styles.importRow)}>
            <input
              value={gitUrl()}
              placeholder="https://github.com/owner/repo, owner/repo or git@…"
              spellcheck={false}
              disabled={!!importing()}
              onInput={(e) => setGitUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && clone()}
              {...stylex.attrs(styles.importInput)}
              data-import-git
            />
            <Show when={showBranch()}>
              <input
                value={branch()}
                placeholder="Branch"
                spellcheck={false}
                disabled={!!importing()}
                onInput={(e) => setBranch(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && clone()}
                {...stylex.attrs(styles.importInput, styles.branchInput)}
                data-import-branch
              />
            </Show>
            <Button disabled={!!importing() || !gitUrl().trim()} onClick={clone} data-import-clone>
              <Icon name="git-branch" size={14} />
              Clone
            </Button>
            <Button disabled={!!importing()} onClick={() => void pickFolder()} data-import-folder>
              <Icon name="folder-open" size={14} />
              Import a folder…
            </Button>
          </div>
          <Show when={!showBranch() && !importing()}>
            <button type="button" onClick={() => setShowBranch(true)} {...stylex.attrs(styles.linkButton)}>
              Choose a branch
            </button>
          </Show>
          <Show when={importing() && progress()}>
            {(p) => (
              <div {...stylex.attrs(styles.progress)} data-import-progress>
                <div {...stylex.attrs(styles.progressHead)}>
                  <span {...stylex.attrs(styles.progressPhase)}>{p().phase}</span>
                  <Show when={hasPercent()}>
                    <span {...stylex.attrs(styles.presetStack)}>{percent()}%</span>
                  </Show>
                  <Show when={cloning()}>
                    <button
                      type="button"
                      onClick={() => void api.cancelImport(props.appId).catch(() => {})}
                      {...stylex.attrs(styles.linkButton)}
                      data-import-cancel
                    >
                      Cancel
                    </button>
                  </Show>
                </div>
                <div
                  {...stylex.attrs(styles.track)}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent() ?? undefined}
                >
                  <div
                    {...stylex.attrs(styles.bar, indeterminate() && styles.barBusy)}
                    style={{ width: hasPercent() ? `${percent()}%` : "30%" }}
                  />
                </div>
              </div>
            )}
          </Show>
          <Show when={!importing() && importError()}>
            {(text) => (
              <span {...stylex.attrs(styles.presetStack, styles.importError)} data-import-error>
                {text()}
              </span>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

const busy = stylex.keyframes({
  from: { transform: "translateX(-100%)" },
  to: { transform: "translateX(340%)" },
});

const styles = stylex.create({
  newRoot: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: space.xl,
    overflowY: "auto",
  },
  newInner: { width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", gap: space.lg },
  title: { margin: 0, fontSize: 28, fontWeight: 650, letterSpacing: "-0.02em" },
  subtitle: { margin: 0, marginTop: -8, color: colors.muted, fontSize: font.md, lineHeight: 1.5 },
  describeHint: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    color: colors.accent,
    fontSize: font.md,
    fontWeight: 600,
  },
  chips: { display: "flex", flexWrap: "wrap", gap: space.sm },
  example: {
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
  presets: { display: "flex", flexDirection: "column", gap: space.sm, marginTop: space.sm },
  presetsLabel: {
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  preset: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "progress" },
  },
  presetStack: { color: colors.muted, fontSize: font.xs },
  importRow: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  importInput: {
    flex: 1,
    minWidth: 220,
    height: 32,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: font.sm,
    outline: "none",
  },
  importError: { color: colors.danger, overflowWrap: "anywhere" },
  branchInput: { flex: "0 1 140px", minWidth: 100 },
  linkButton: {
    alignSelf: "flex-start",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.accent },
    fontSize: font.xs,
    cursor: "pointer",
  },
  progress: { display: "flex", flexDirection: "column", gap: 6 },
  progressHead: { display: "flex", alignItems: "baseline", gap: space.sm },
  progressPhase: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
  },
  track: {
    position: "relative",
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  bar: { height: "100%", borderRadius: radius.full, backgroundColor: colors.accent, transition: "width 200ms" },
  barBusy: {
    animationName: busy,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
});
