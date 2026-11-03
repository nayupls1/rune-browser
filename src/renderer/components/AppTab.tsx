// An app tab: a prompt for new apps, otherwise the running app in a preview
// next to the agent. While the agent panel is open the app is being edited and
// the preview shows its dev server (changes appear live); closing the panel
// means done: the app is built and the preview shows the finished version.
import * as stylex from "@stylexjs/stylex";
import type { DidFailLoadEvent, WebviewTag } from "electron";
import { createEffect, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import { appPartition, type ElementInfo, type LogLine, type PageContext, type RuntimeStatus } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { captureScript, restoreScript, takeSavedPage, type SavedPage } from "../lib/pagestate";
import { cancelPickScript, pickScript, unmarkScript } from "../lib/picker";
import { addPick, clearPicks, isPicking, picksOf, removePick, setPickingIn } from "../lib/picks";
import { watchTopic } from "../lib/realtime";
import { sendWithShares } from "../lib/sharing";
import { appMode, isAgentCollapsed, setAgentCollapsed, setRuntime, states } from "../lib/store";
import { registerPage, type PageInfo } from "../lib/webtabs";
import { foundInPage, syncZoom } from "../lib/pageTools";
import { FindBar } from "./FindBar";
import { registerChrome } from "../lib/tabChrome";
import { colors, font, radius, space } from "../theme.stylex";
import { ShowAgentButton } from "./Chat";
import { NewApp } from "./NewApp";
import { Icon } from "./Icon";
import { DataPanel } from "./DataPanel";
import { HistoryPanel } from "./History";
import { ToolsPanel } from "./ToolsPanel";
import { SecretsPanel } from "./Secrets";

export function AppTab(props: { appId: string; active: boolean }) {
  const state = () => states[props.appId];
  const isNew = () => !state()?.project && !state()?.messages.length && !state()?.running;

  return (
    <Show when={state()?.loaded}>
      <Show when={!isNew()} fallback={<NewApp appId={props.appId} />}>
        <Workbench appId={props.appId} active={props.active} />
      </Show>
    </Show>
  );
}

const stateLabels: Record<RuntimeStatus["state"], string> = {
  stopped: "Stopped",
  installing: "Installing dependencies…",
  building: "Building…",
  starting: "Starting…",
  running: "Running",
  crashed: "Crashed",
};

function Workbench(props: { appId: string; active: boolean }) {
  const state = () => states[props.appId]!;
  const runtime = () => state().runtime;
  const running = () => runtime()?.state === "running" && !!runtime()?.url;
  const busy = () => ["installing", "building", "starting"].includes(runtime()?.state ?? "");
  const collapsed = () => isAgentCollapsed(props.appId);
  const isLive = () => appMode(props.appId) === "live";
  const isRunning = () => runtime()?.state === "running";
  const isCrashed = () => runtime()?.state === "crashed";
  const [logsOpen, setLogsOpen] = createSignal(false);
  const [secretsOpen, setSecretsOpen] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [dataOpen, setDataOpen] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  const picking = () => isPicking(props.appId);
  const [loadError, setLoadError] = createSignal<string>();

  let webview: WebviewTag | undefined;
  let ready = false;
  // An app tab that was unloaded comes back on the page it was on, as it was (lib/unload.ts).
  let restoring = takeSavedPage(props.appId);
  const sameOrigin = (a: string, b: string) => {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return false;
    }
  };
  /** Where a new preview starts: the app's home, or the page it was on before it was unloaded. */
  const previewSrc = () => {
    const url = runtime()!.url!;
    return restoring && sameOrigin(restoring.url, url) ? restoring.url : url;
  };

  // --- Runtime control ---------------------------------------------------------------

  const control = async (action: "start" | "stop" | "restart") =>
    setRuntime(props.appId, await api.controlRuntime(props.appId, action));

  // --- The preview page --------------------------------------------------------------

  let loadWaiters: (() => void)[] = [];
  let firstLoaded!: () => void;
  const firstLoad = new Promise<void>((resolve) => (firstLoaded = resolve));
  const loaded = () => {
    firstLoaded();
    for (const fn of loadWaiters.splice(0)) fn();
  };
  const waitForLoad = (timeoutMs = 30_000) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      loadWaiters.push(() => (clearTimeout(timer), resolve()));
    });

  const requireReady = () => {
    if (!webview || !ready)
      throw new Error(
        running() ? "The preview is still loading" : `The app isn't running (${runtime()?.state ?? "no project"})`,
      );
    return webview;
  };
  const info = (): PageInfo =>
    webview && ready ? { url: webview.getURL(), title: webview.getTitle() } : { url: runtime()?.url ?? "", title: "" };

  function attach(view: WebviewTag) {
    webview = view;
    ready = false;
    const track = () => {
      if (!ready) return;
      setPreviewUrl(view.getURL());
      setNav((n) => ({ ...n, back: view.canGoBack(), forward: view.canGoForward() }));
    };
    view.addEventListener("did-start-loading", () => setNav((n) => ({ ...n, loading: true })));
    view.addEventListener("did-stop-loading", () => (setNav((n) => ({ ...n, loading: false })), track()));
    view.addEventListener("did-navigate", track);
    view.addEventListener("did-navigate-in-page", track);
    // A new preview (mode switch, restart) keeps what was picked; navigating within it doesn't.
    let first = true;
    view.addEventListener("did-start-loading", () => setLoadError());
    view.addEventListener("did-stop-loading", () => {
      const saved = restoring;
      restoring = undefined;
      if (saved && sameOrigin(view.getURL(), saved.url))
        void view.executeJavaScript(restoreScript(saved)).catch(() => {});
      loaded();
    });
    view.addEventListener("did-fail-load", (e: DidFailLoadEvent) => {
      if (e.isMainFrame && e.errorCode !== -3)
        setLoadError(`${e.errorDescription || "Failed to load"} (${e.validatedURL})`);
      loaded();
    });
    view.addEventListener("did-navigate", () => (first ? (first = false) : clearPicks(props.appId)));
    view.addEventListener("dom-ready", () => (ready = true));
    view.addEventListener("did-navigate", () => syncZoom(props.appId));
    view.addEventListener("found-in-page", (e) => foundInPage(props.appId, e.result));
  }

  const unregister = registerPage(props.appId, {
    info,
    eval: (code) => requireReady().executeJavaScript(code),
    capture: () => window.rune.web.capture(requireReady().getWebContentsId()),
    navigate: async (url) => {
      const view = requireReady();
      const target = new URL(url, runtime()!.url!).toString();
      const done = waitForLoad();
      await view.loadURL(target).catch(() => {});
      await done;
      return info();
    },
    reload: async () => {
      const view = requireReady();
      const done = waitForLoad();
      view.reload();
      await done;
      return info();
    },
    back: () => webview && ready && webview.goBack(),
    forward: () => webview && ready && webview.goForward(),
    focusAddress: () => {},
    view: () => (webview && ready ? webview : undefined),
    applyOverride: async () => ({ applied: false }),
    overrideChanged: () => {},
    send,
    // Its traffic and console, for the agent's DevTools (main/devtools.ts).
    webContentsId: () => requireReady().getWebContentsId(),
    pick,
    unpick,
    // Bounded: an app that isn't running has no page to load.
    whenLoaded: () => Promise.race([firstLoad, new Promise<void>((r) => setTimeout(r, 15_000))]),
    saveState: async () => {
      if (!webview || !ready) return null;
      return (await webview.executeJavaScript(captureScript).catch(() => null)) as SavedPage | null;
    },
    busy: () => {
      try {
        return !!webview && ready && webview.isCurrentlyAudible();
      } catch {
        return false;
      }
    },
  });
  onCleanup(unregister);

  // A new server (restart, mode switch) means a new page.
  const previewKey = () => (running() ? `${runtime()!.url}|${runtime()!.startedAt}|${runtime()!.mode}` : null);

  // --- Element picker ----------------------------------------------------------------

  async function pick() {
    if (!webview || !ready) return;
    if (picking()) return void webview.executeJavaScript(cancelPickScript).catch(() => {});
    setPickingIn(props.appId, true);
    webview.focus();
    try {
      const element = (await webview.executeJavaScript(pickScript, true)) as ElementInfo | null;
      if (element) {
        addPick(props.appId, element);
        setAgentCollapsed(props.appId, false);
        queueMicrotask(() => document.querySelector<HTMLTextAreaElement>("[data-agent-panel] textarea")?.focus());
      }
    } catch {
      // the page reloaded mid-pick
    } finally {
      setPickingIn(props.appId, false);
    }
  }

  function unpick(selector: string) {
    removePick(props.appId, selector);
    if (webview && ready) void webview.executeJavaScript(unmarkScript(selector)).catch(() => {});
  }

  function send(prompt: string) {
    const selection = [...picksOf(props.appId)];
    const page: PageContext | undefined =
      webview && ready && selection.length
        ? { url: webview.getURL(), title: webview.getTitle(), selection }
        : undefined;
    clearPicks(props.appId);
    if (webview && ready) void webview.executeJavaScript(unmarkScript()).catch(() => {});
    void sendWithShares(props.appId, prompt, page);
  }

  // The sidebar's top bar for this tab (components/TopBar.tsx): the preview's localhost address, and the app's tools.
  const [previewUrl, setPreviewUrl] = createSignal("");
  const [nav, setNav] = createSignal({ back: false, forward: false, loading: false });
  onCleanup(
    registerChrome(props.appId, {
      url: () => (running() ? previewUrl() || runtime()!.url! : ""),
      icon: () => "app-window",
      canBack: () => nav().back,
      canForward: () => nav().forward,
      loading: () => nav().loading,
      back: () => webview && ready && webview.goBack(),
      forward: () => webview && ready && webview.goForward(),
      reload: () => (webview && ready ? webview.reload() : void control("restart")),
      stop: () => webview?.stop(),
      // Paths and addresses of the app open in its preview; anything else in a new web tab.
      go: (input) => {
        if (!webview || !ready || !running()) return false;
        const base = runtime()!.url!;
        const target = input.startsWith("/") ? new URL(input, base).toString() : input;
        if (!sameOrigin(target, base)) return false;
        void webview.loadURL(target).catch(() => {});
        return true;
      },
      tools: () => (
        <>
          <Show when={state().project}>
            <span
              {...stylex.attrs(styles.status)}
              title={
                runtime()?.error ??
                (isLive()
                  ? "The finished app (open the agent to edit it)"
                  : "Being edited: the dev server, changes appear live")
              }
              data-runtime-state={runtime()?.state}
              data-mode={appMode(props.appId)}
            >
              <span
                {...stylex.attrs(
                  styles.dot,
                  isRunning() && styles.dotRunning,
                  busy() && styles.dotBusy,
                  isCrashed() && styles.dotCrashed,
                )}
              />
              {isLive() ? "" : "Editing · "}
              {stateLabels[runtime()?.state ?? "stopped"]}
            </span>
          </Show>
          <button
            type="button"
            title="Restart the app"
            disabled={!state().project || busy()}
            onClick={() => void control("restart")}
            {...stylex.attrs(styles.iconButton)}
            data-restart
          >
            <Icon name="rotate-cw" size={15} />
          </button>
          <button
            type="button"
            title="Logs"
            disabled={!state().project}
            onClick={() => setLogsOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, logsOpen() && styles.iconButtonOn)}
            data-logs
          >
            <Icon name="terminal" size={15} />
          </button>
          <button
            type="button"
            title="Secrets (API keys, passwords) for this app"
            onClick={() => setSecretsOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, secretsOpen() && styles.iconButtonOn)}
            data-secrets
          >
            <Icon name="key-round" size={15} />
          </button>
          <button
            type="button"
            title="Snapshots: undo changes, restore earlier versions"
            disabled={!state().project}
            onClick={() => setHistoryOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, historyOpen() && styles.iconButtonOn)}
            data-history-button
          >
            <Icon name="file-clock" size={15} />
          </button>
          <button
            type="button"
            title="Data: what the app has stored"
            disabled={!state().project}
            onClick={() => setDataOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, dataOpen() && styles.iconButtonOn)}
            data-data-button
          >
            <Icon name="database" size={15} />
          </button>
          <button
            type="button"
            title="Tools: what the app can do, for you, agents and other apps"
            disabled={!state().project}
            onClick={() => setToolsOpen((o) => !o)}
            {...stylex.attrs(styles.iconButton, toolsOpen() && styles.iconButtonOn)}
            data-tools-button
          >
            <Icon name="wrench" size={15} />
          </button>
          <button
            type="button"
            title="Open in your browser"
            disabled={!running()}
            onClick={() => window.rune.web.openExternal(runtime()!.url!)}
            {...stylex.attrs(styles.iconButton)}
          >
            <Icon name="external-link" size={15} />
          </button>
        </>
      ),
    }),
  );

  return (
    <div
      {...stylex.attrs(styles.split)}
      data-app-tab={props.appId}
      data-runtime-state={runtime()?.state}
      data-mode={appMode(props.appId)}
    >
      <div {...stylex.attrs(styles.main)}>
        <div {...stylex.attrs(styles.viewport)}>
          <Show
            when={previewKey()}
            keyed
            fallback={
              <Placeholder
                appId={props.appId}
                onStart={() => void control("start")}
                onLogs={() => setLogsOpen(true)}
                onHistory={() => setHistoryOpen(true)}
              />
            }
          >
            {(_) => {
              // Set once: the page navigates on its own from there.
              const src = untrack(previewSrc);
              return (
                <webview
                  ref={attach}
                  src={src}
                  partition={appPartition(props.appId)}
                  {...stylex.attrs(styles.webview)}
                />
              );
            }}
          </Show>
          <Show when={picking()}>
            <div {...stylex.attrs(styles.banner)}>Click an element to pick it · Esc to cancel</div>
          </Show>
          <FindBar tabId={props.appId} />
          <Show when={loadError() && running()}>
            <div {...stylex.attrs(styles.banner, styles.bannerError)}>
              {loadError()}
              <button type="button" onClick={() => webview?.reload()} {...stylex.attrs(styles.bannerButton)}>
                Retry
              </button>
            </div>
          </Show>
          <Show when={collapsed()}>
            <ShowAgentButton appId={props.appId} />
          </Show>
        </div>
        <Show when={logsOpen()}>
          <Logs appId={props.appId} onClose={() => setLogsOpen(false)} />
        </Show>
        <Show when={secretsOpen()}>
          <SecretsPanel appId={props.appId} onClose={() => setSecretsOpen(false)} />
        </Show>
        <Show when={historyOpen()}>
          <HistoryPanel appId={props.appId} onClose={() => setHistoryOpen(false)} />
        </Show>
        <Show when={dataOpen()}>
          <DataPanel appId={props.appId} onClose={() => setDataOpen(false)} />
        </Show>
        <Show when={toolsOpen()}>
          <ToolsPanel appId={props.appId} onClose={() => setToolsOpen(false)} />
        </Show>
      </div>
    </div>
  );
}

/** What the preview shows while there's nothing to show. */
function Placeholder(props: { appId: string; onStart: () => void; onLogs: () => void; onHistory: () => void }) {
  const state = () => states[props.appId]!;
  const runtime = () => state().runtime;
  // A crash right after the agent changed something: offer to take that change back.
  const [undoError, setUndoError] = createSignal<string>();
  const [lastChange] = createResource(
    () => (runtime()?.state === "crashed" ? props.appId : undefined),
    async (id) =>
      (await api.history({ target: `app:${id}`, limit: 20 })).find((e) => e.actor === "agent" && !e.first) ?? null,
  );
  const undoLast = async () => {
    setUndoError();
    try {
      await api.undoSnapshot(lastChange()!.id);
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div {...stylex.attrs(styles.placeholder)}>
      <Switch>
        <Match when={!state().project}>
          <Icon name="hammer" size={28} {...stylex.attrs(styles.placeholderIcon)} />
          <p>
            {state().running ? "The agent is setting up your app…" : "No app yet. Describe what you want in the chat."}
          </p>
        </Match>
        <Match when={runtime()?.state === "crashed"}>
          <Icon name="triangle-alert" size={28} {...stylex.attrs(styles.placeholderError)} />
          <p>{runtime()?.error ?? "The app stopped unexpectedly."}</p>
          <div {...stylex.attrs(styles.placeholderActions)}>
            <button type="button" onClick={props.onStart} {...stylex.attrs(styles.pillButton)}>
              Try again
            </button>
            <button type="button" onClick={props.onLogs} {...stylex.attrs(styles.pillButton)}>
              Show logs
            </button>
            <Show when={lastChange()}>
              <button
                type="button"
                onClick={() => void undoLast()}
                title={lastChange()!.summary}
                {...stylex.attrs(styles.pillButton)}
                data-undo-last
              >
                Undo the agent's last change
              </button>
            </Show>
            <button type="button" onClick={props.onHistory} {...stylex.attrs(styles.pillButton)}>
              History
            </button>
          </div>
          <Show when={undoError()}>
            <p {...stylex.attrs(styles.placeholderErrorText)}>{undoError()}</p>
          </Show>
        </Match>
        <Match when={!runtime() || runtime()!.state === "stopped"}>
          <Icon name="play" size={28} {...stylex.attrs(styles.placeholderIcon)} />
          <p>The app isn't running.</p>
          <button type="button" onClick={props.onStart} {...stylex.attrs(styles.pillButton)} data-start>
            Start
          </button>
        </Match>
        <Match when={true}>
          <span {...stylex.attrs(styles.spinner)} />
          <p>{stateLabels[runtime()!.state]}</p>
        </Match>
      </Switch>
    </div>
  );
}

/** The app's output (install, build, server), live. */
function Logs(props: { appId: string; onClose: () => void }) {
  const [lines, setLines] = createSignal<LogLine[]>([]);
  let scroller!: HTMLDivElement;
  let stick = true;

  api.runtime(props.appId).then(
    (r) => setLines(r.logs),
    () => {},
  );
  const stop = watchTopic(topics.logs(props.appId), (msg) => {
    if (msg.type === "log") setLines((l) => [...l, ...msg.lines].slice(-2000));
  });
  onCleanup(stop);

  createEffect(
    on(lines, () => {
      if (stick) queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );

  return (
    <div {...stylex.attrs(styles.logs)} data-logs-panel>
      <div {...stylex.attrs(styles.logsHeader)}>
        <Icon name="terminal" size={14} />
        <span {...stylex.attrs(styles.logsTitle)}>Logs</span>
        <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div
        ref={scroller}
        onScroll={() => (stick = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8)}
        {...stylex.attrs(styles.logsBody)}
      >
        <For each={lines()} fallback={<span {...stylex.attrs(styles.logSystem)}>No output yet.</span>}>
          {(line) => {
            const isErr = () => line.stream === "err";
            const isSystem = () => line.stream === "system";
            return (
              <div {...stylex.attrs(styles.logLine, isErr() && styles.logErr, isSystem() && styles.logSystem)}>
                {line.text}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.35 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.35 },
});

const spin = stylex.keyframes({
  "0%": { transform: "rotate(0deg)" },
  "100%": { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  placeholderErrorText: { margin: 0, maxWidth: 480, color: colors.danger, fontSize: font.sm, textAlign: "center" },
  split: { display: "flex", height: "100%", minHeight: 0 },
  main: { position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    height: 44,
    flexShrink: 0,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  // In the sidebar's top bar: a line of its own above the app's tools.
  status: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexBasis: "100%",
    minWidth: 0,
    paddingInline: space.xs,
    paddingBottom: 2,
    color: colors.muted,
    fontSize: font.xs,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  dot: { width: 7, height: 7, borderRadius: radius.full, backgroundColor: colors.muted },
  dotRunning: { backgroundColor: colors.success },
  dotBusy: {
    backgroundColor: colors.warning,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  dotCrashed: { backgroundColor: colors.danger },
  url: {
    flex: 1,
    minWidth: 0,
    paddingInline: space.sm,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.muted,
    fontFamily: font.mono,
    fontSize: 11.5,
    textAlign: "right",
  },
  // In the sidebar's top bar: seven of them fit its default width.
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 27,
    height: 27,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text, ":disabled": colors.muted },
    opacity: { default: 1, ":disabled": 0.4 },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  iconButtonOn: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    color: { default: colors.accent, ":hover": colors.accent },
  },
  viewport: { position: "relative", flex: 1, minHeight: 0, backgroundColor: colors.bg },
  webview: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  placeholder: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    height: "100%",
    padding: space.xl,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  placeholderIcon: { color: colors.accent },
  placeholderError: { color: colors.danger },
  placeholderActions: { display: "flex", gap: space.sm },
  pillButton: {
    paddingBlock: 6,
    paddingInline: space.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
  },
  spinner: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: colors.border,
    borderTopColor: colors.accent,
    animationName: spin,
    animationDuration: "0.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  banner: {
    position: "absolute",
    top: space.md,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    maxWidth: "90%",
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontSize: font.sm,
    fontWeight: 500,
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.18)",
    pointerEvents: "none",
  },
  bannerError: { backgroundColor: colors.danger, pointerEvents: "auto" },
  bannerButton: {
    paddingBlock: 2,
    paddingInline: space.sm,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: "rgb(255 255 255 / 0.2)",
    color: "inherit",
    fontSize: font.xs,
    fontWeight: 600,
    cursor: "pointer",
  },
  logs: {
    display: "flex",
    flexDirection: "column",
    height: 220,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  logsHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 34,
    flexShrink: 0,
    paddingInline: space.md,
    color: colors.muted,
  },
  logsTitle: { flex: 1, fontSize: font.xs, fontWeight: 600 },
  logsBody: {
    flex: 1,
    overflowY: "auto",
    paddingInline: space.md,
    paddingBottom: space.sm,
    fontFamily: font.mono,
    fontSize: 11.5,
    lineHeight: 1.5,
  },
  logLine: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  logErr: { color: colors.danger },
  logSystem: { color: colors.muted },
});
