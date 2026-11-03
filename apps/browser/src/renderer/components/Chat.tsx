import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FULL_ACCESS_WARNING, fullAccess, setFullAccess } from "../lib/access";
import { isPicking, picksOf } from "../lib/picks";
import { sendWithShares } from "../lib/sharing";
import { api } from "../lib/api";
import { appById, newChat, openChat, setAgentCollapsed, states, stopAgent } from "../lib/store";
import { confirmDialog } from "./ConfirmDialog";
import { pageOf, pagesVersion } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { Composer } from "./Composer";
import { Chip, Timeline } from "./ChatTimeline";
import { SourcesBar, SourcesButton } from "./Sources";
import { type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { withKeys } from "../lib/shortcuts";

/**
 * The agent of a tab: its conversation and composer, in the agent sidebar
 * (AgentSidebar). Works the same for every kind of tab: the elements picked
 * in the tab's page (lib/picks.ts) come with the message, and the tab's page
 * handle sends it with the page.
 */
export function Chat(props: { appId: string }) {
  const state = () => states[props.appId]!;
  const tab = () => appById(props.appId);
  const web = () => tab()?.kind === "web";
  const [history, setHistory] = createSignal<MenuPosition>();
  const [addingRepository, setAddingRepository] = createSignal(false);
  // The tab's page (a web page or an app's preview), once it's registered.
  const page = () => (pagesVersion(), pageOf(props.appId));
  let scroller!: HTMLDivElement;
  // Follow the conversation while you're at its end; scrolled up, it stays put.
  const [pinned, setPinned] = createSignal(true);
  const toEnd = (smooth = false) =>
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  const onScroll = () => setPinned(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48);
  createEffect(
    on(
      () => props.appId,
      () => (setPinned(true), queueMicrotask(() => toEnd())),
    ),
  );
  // Your own message always brings you back to the end.
  createEffect(
    on(
      () => state().messages.filter((m) => m.role === "user").length,
      () => setPinned(true),
      { defer: true },
    ),
  );
  onMount(() => {
    // Content grows while streaming, when rows open, when images load: keep the end in view.
    const follow = new ResizeObserver(() => pinned() && toEnd());
    follow.observe(scroller.firstElementChild!);
    onCleanup(() => follow.disconnect());
  });
  const empty = () => !state().messages.length && !state().running;

  return (
    <aside {...stylex.attrs(styles.root)} data-agent-panel>
      <header {...stylex.attrs(styles.header)} data-titlebar>
        <Show when={fullAccess()}>
          <button
            type="button"
            title={`Full access: agents don't ask before acting. ${FULL_ACCESS_WARNING} Click to make them ask again.`}
            aria-label="Full access is on: click to make agents ask again"
            onClick={() => void setFullAccess(false)}
            {...stylex.attrs(styles.fullAccess)}
            data-full-access
          >
            <Icon name="shield-off" size={14} />
          </button>
        </Show>
        <span {...stylex.attrs(styles.headerTab)} title="The tab the agent works on" data-agent-tab-name>
          {tab()?.name ?? ""}
        </span>
        <button
          type="button"
          title="New chat (this one is kept in the chat history)"
          disabled={state().running || !state().messages.length}
          onClick={() =>
            void newChat(props.appId).catch((err) =>
              toast({ message: err instanceof Error ? err.message : String(err), kind: "error" }),
            )
          }
          {...stylex.attrs(styles.headerButton)}
          data-new-chat
        >
          <Icon name="message-square-plus" size={16} />
        </button>
        <button
          type="button"
          title="Earlier chats"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHistory(history() ? undefined : { x: r.right - 320, y: r.bottom + 4 });
          }}
          {...stylex.attrs(styles.headerButton)}
          data-chat-history-button
        >
          <Icon name="clock" size={16} />
        </button>
        <Show when={history()}>
          {(at) => <ChatHistory appId={props.appId} position={at()} onClose={() => setHistory()} />}
        </Show>
        <button
          type="button"
          title={withKeys(
            editsApp(props.appId) ? "Done: hide the agent and run the finished app" : "Hide agent",
            "agent.toggle",
          )}
          onClick={() => setAgentCollapsed(props.appId, true)}
          {...stylex.attrs(styles.headerButton)}
          data-agent-hide
        >
          <Icon name="x" size={16} />
        </button>
      </header>
      <div {...stylex.attrs(styles.body)}>
        <div ref={scroller} onScroll={onScroll} {...stylex.attrs(styles.scroller)} data-chat-scroller>
          <div {...stylex.attrs(styles.messages)} data-chat-messages>
            <Show when={empty()}>
              <div {...stylex.attrs(styles.empty)} data-chat-empty>
                <span {...stylex.attrs(styles.emptyIcon)}>
                  <Icon name={web() ? "sparkles" : state().project ? "pencil" : "wand-sparkles"} size={20} />
                </span>
                <p {...stylex.attrs(styles.emptyTitle)}>
                  {web()
                    ? "Ask about this page"
                    : state().project
                      ? "What should change?"
                      : "Describe the app you want"}
                </p>
                <p {...stylex.attrs(styles.hint)}>
                  {web()
                    ? "Ask about this page, or pick elements with the crosshair and say how they should look or work. Changes are saved as customizations for the site."
                    : state().project
                      ? "The agent edits the app's code and runs it; you'll see every file it touches and command it runs here."
                      : "The agent sets up a project and builds it; you'll see every file it touches and command it runs here."}
                </p>
              </div>
            </Show>
            <Timeline appId={props.appId} />
          </div>
        </div>
        <Show when={!pinned()}>
          <button
            type="button"
            title="Scroll to the end"
            aria-label="Scroll to the end"
            onClick={() => (setPinned(true), toEnd(true))}
            {...stylex.attrs(styles.toEnd)}
            data-chat-to-end
          >
            <Icon name="arrow-down" size={15} />
          </button>
        </Show>
      </div>
      <div {...stylex.attrs(styles.composer)}>
        <Composer
          appId={props.appId}
          running={state().running}
          placeholder={
            web() ? "Ask about or change this page…" : state().project ? undefined : "Describe the app you want…"
          }
          top={
            <>
              <SourcesBar tabId={props.appId} adding={addingRepository()} onDone={() => setAddingRepository(false)} />
              <Show when={picksOf(props.appId).length}>
                <div {...stylex.attrs(styles.chips)}>
                  <For each={picksOf(props.appId)}>
                    {(el) => (
                      <Chip
                        label={
                          el.text ? `${el.tag} “${el.text.slice(0, 24)}${el.text.length > 24 ? "…" : ""}”` : el.selector
                        }
                        title={el.selector}
                        onRemove={() => page()?.unpick(el.selector)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </>
          }
          tools={
            <>
              <SourcesButton tabId={props.appId} onAddRepository={() => setAddingRepository(true)} />
              <Show when={page()}>
                <button
                  type="button"
                  title={
                    isPicking(props.appId)
                      ? "Cancel picking (Esc)"
                      : web()
                        ? "Pick elements on the page for the agent"
                        : "Pick elements in the app for the agent"
                  }
                  onClick={() => void page()?.pick()}
                  {...stylex.attrs(styles.pick, isPicking(props.appId) && styles.pickOn)}
                  data-pick-element
                >
                  <Icon name="crosshair" size={15} />
                </button>
              </Show>
            </>
          }
          onSend={(prompt) => {
            const handle = page();
            if (handle) handle.send(prompt);
            else void sendWithShares(props.appId, prompt);
          }}
          onStop={() => stopAgent(props.appId)}
        />
      </div>
    </aside>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.4 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.4 },
});

const styles = stylex.create({
  // The agent sidebar sizes it.
  root: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    minWidth: 0,
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 44,
    flexShrink: 0,
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  headerTab: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
    fontWeight: 600,
  },
  chips: { display: "flex", flexWrap: "wrap", gap: 4, paddingInline: 4, paddingTop: 2 },
  // A small red shield while agents don't ask (click to make them ask again).
  fullAccess: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: {
      default: `color-mix(in oklab, transparent, ${colors.danger} 14%)`,
      ":hover": `color-mix(in oklab, transparent, ${colors.danger} 24%)`,
    },
    color: colors.danger,
    cursor: "pointer",
  },
  history: {
    position: "fixed",
    zIndex: 1000,
    width: 320,
    maxHeight: 420,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14)",
    fontFamily: font.sans,
    color: colors.text,
  },
  historyTitle: { paddingBlock: 6, paddingInline: space.sm, color: colors.muted, fontSize: font.xs, fontWeight: 600 },
  historyEmpty: { margin: 0, padding: space.sm, color: colors.muted, fontSize: font.sm, lineHeight: 1.45 },
  historyRow: { display: "flex", alignItems: "center", gap: 2 },
  historyOpen: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    flex: 1,
    minWidth: 0,
    paddingBlock: 6,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "default" },
  },
  historyName: {
    width: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
    fontWeight: 500,
  },
  historyMeta: { color: colors.muted, fontSize: font.xs },
  pick: {
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
  pickOn: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    color: { default: colors.accent, ":hover": colors.accent },
  },
  headerButton: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  showButton: {
    position: "absolute",
    top: space.md,
    right: space.md,
    zIndex: 10,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.08)",
    color: colors.text,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  showDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  body: { position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  scroller: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    scrollbarGutter: "stable",
  },
  messages: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    minWidth: 0,
    paddingBlock: space.lg,
    paddingInline: space.lg,
  },
  composer: { padding: space.md, paddingTop: 0 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    marginTop: "18vh",
    paddingInline: space.lg,
    textAlign: "center",
  },
  emptyIcon: {
    display: "grid",
    placeItems: "center",
    width: 40,
    height: 40,
    marginBottom: space.xs,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  emptyTitle: { margin: 0, fontSize: font.lg, fontWeight: 600, letterSpacing: "-0.01em" },
  hint: { margin: 0, maxWidth: 320, fontSize: font.sm, lineHeight: 1.5, color: colors.muted },
  toEnd: {
    position: "absolute",
    bottom: space.sm,
    left: "50%",
    transform: "translateX(-50%)",
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.12)",
    color: colors.text,
    cursor: "pointer",
  },
});

/** The tab's earlier chats: open one again (the current one is kept) or delete it. */
function ChatHistory(props: { appId: string; position: MenuPosition; onClose: () => void }) {
  const [chats, { refetch }] = createResource(() => api.chats(props.appId));
  const running = () => !!states[props.appId]?.running;
  let root!: HTMLDivElement;
  onMount(() => {
    const away = (e: PointerEvent) => !root.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    });
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), kind: "error" });
    }
  };
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label="Earlier chats"
        {...stylex.attrs(styles.history)}
        style={{ left: `${Math.max(8, props.position.x)}px`, top: `${props.position.y}px` }}
        data-chat-history
      >
        <div {...stylex.attrs(styles.historyTitle)}>Earlier chats</div>
        <For
          each={chats() ?? []}
          fallback={
            <p {...stylex.attrs(styles.historyEmpty)}>
              {chats.loading ? "Loading…" : "No earlier chats. “New chat” keeps the current one here."}
            </p>
          }
        >
          {(chat) => (
            <div {...stylex.attrs(styles.historyRow)} data-chat={chat.id}>
              <button
                type="button"
                disabled={running()}
                title={running() ? "Stop the agent first" : "Continue this chat (the current one is kept)"}
                onClick={() => void act(async () => (await openChat(props.appId, chat.id), props.onClose()))}
                {...stylex.attrs(styles.historyOpen)}
                data-open-chat
              >
                <span {...stylex.attrs(styles.historyName)}>{chat.title}</span>
                <span {...stylex.attrs(styles.historyMeta)}>
                  {when(chat.updatedAt)} · {chat.messages} message{chat.messages === 1 ? "" : "s"}
                </span>
              </button>
              <button
                type="button"
                title="Delete this chat"
                onClick={() =>
                  void act(async () => {
                    if (
                      await confirmDialog(`Delete the chat “${chat.title}”?`, { confirmLabel: "Delete", danger: true })
                    ) {
                      await api.deleteChat(props.appId, chat.id);
                      await refetch();
                    }
                  })
                }
                {...stylex.attrs(styles.headerButton)}
                data-delete-chat
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}

/** Whether the agent panel stands for editing an app (its mode follows the panel). */
const editsApp = (id: string) => appById(id)?.kind === "app" && !!states[id]?.project;

/** Floating button that brings a hidden agent panel back (for an app: back to editing). */
export function ShowAgentButton(props: { appId: string }) {
  const running = () => !!states[props.appId]?.running;
  return (
    <button
      type="button"
      title={withKeys(
        editsApp(props.appId) ? "Edit: show the agent and run the dev server" : "Show agent",
        "agent.toggle",
      )}
      onClick={() => setAgentCollapsed(props.appId, false)}
      {...stylex.attrs(styles.showButton)}
      data-agent-show
    >
      <Icon name={editsApp(props.appId) ? "pencil" : "bot"} size={16} />
      {editsApp(props.appId) ? "Edit" : "Agent"}
      <Show when={running()}>
        <span {...stylex.attrs(styles.showDot)} />
      </Show>
    </button>
  );
}
