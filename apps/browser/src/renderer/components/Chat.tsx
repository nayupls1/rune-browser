import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { ChatSummary } from "../../shared/api";
import { Portal } from "solid-js/web";
import { FULL_ACCESS_WARNING, fullAccess, setFullAccess } from "../lib/access";
import { isPicking, picksOf } from "../lib/picks";
import { sendWithShares } from "../lib/sharing";
import { api } from "../lib/api";
import { appById, newChat, newWebTab, openChat, setAgentCollapsed, states, stopAgent } from "../lib/store";
import { confirmDialog } from "./ConfirmDialog";
import { pageOf, pagesVersion } from "../lib/webtabs";
import { closeHeadlessTab, headlessTabsOf } from "../lib/headless";
import { hostOf } from "../../shared/web";
import { colors, font, radius, space } from "../theme.stylex";
import { Composer, fillComposer } from "./Composer";
import { Chip, Timeline } from "./ChatTimeline";
import { addFolder, SourcesBar } from "./Sources";
import { PopoverMenu } from "./PopoverMenu";
import { TabIcon } from "./TabIcon";
import { Icon } from "./Icon";
import { JobsBar } from "./JobsBar";
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
  const [historyOpen, setHistoryOpen] = createSignal(false);
  let historyButton!: HTMLButtonElement;
  // The tab's page (a web page or an app's preview), once it's registered.
  const page = () => (pagesVersion(), pageOf(props.appId));
  let scroller!: HTMLDivElement;
  // Follow the conversation while you're at its end; scrolled up, it stays put.
  const [pinned, setPinned] = createSignal(true);
  const [scrolled, setScrolled] = createSignal(false);
  const toEnd = (smooth = false) =>
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  // At the end, or with nothing to scroll.
  const onScroll = () => {
    setPinned(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48);
    setScrolled(scroller.scrollTop > 2);
  };
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
    const follow = new ResizeObserver(() => {
      if (pinned()) toEnd();
      // Nothing left to scroll (a shorter chat): back at the end.
      else onScroll();
    });
    follow.observe(scroller.firstElementChild!);
    // The panel itself changing size (the window, the sidebar's width) too.
    follow.observe(scroller);
    onCleanup(() => follow.disconnect());
  });
  const empty = () => !state().messages.length && !state().running;
  const kind = () => (web() ? "web" : state().project ? "app" : "new");

  return (
    <aside {...stylex.attrs(styles.root)} data-agent-panel>
      <header {...stylex.attrs(styles.header, scrolled() && styles.headerScrolled)} data-titlebar>
        <span {...stylex.attrs(styles.headerTab)} title="The tab the agent works on">
          <Show when={tab()}>{(t) => <TabIcon tab={t()} size={14} />}</Show>
          <span {...stylex.attrs(styles.headerName)} data-agent-tab-name>
            {tab()?.name ?? ""}
          </span>
        </span>
        <Show when={state().messages.length}>
          <button
            type="button"
            title="New chat (this one is kept in the chat history)"
            aria-label="New chat"
            disabled={state().running}
            onClick={() =>
              void newChat(props.appId).catch((err) =>
                toast({ message: err instanceof Error ? err.message : String(err), kind: "error" }),
              )
            }
            {...stylex.attrs(styles.headerButton)}
            data-new-chat
          >
            <Icon name="square-pen" size={15} />
          </button>
        </Show>
        <button
          ref={historyButton}
          type="button"
          title="Earlier chats"
          aria-label="Earlier chats"
          aria-haspopup="dialog"
          aria-expanded={historyOpen()}
          onClick={() => setHistoryOpen(!historyOpen())}
          {...stylex.attrs(styles.headerButton, historyOpen() && styles.headerButtonOn)}
          data-chat-history-button
        >
          <Icon name="rotate-ccw-clock" size={15} />
        </button>
        <Show when={historyOpen()}>
          <ChatHistory appId={props.appId} anchor={historyButton} onClose={() => setHistoryOpen(false)} />
        </Show>
        <button
          type="button"
          title={withKeys(
            editsApp(props.appId) ? "Done: hide the agent and run the finished app" : "Hide agent",
            "agent.toggle",
          )}
          aria-label="Hide agent"
          onClick={() => setAgentCollapsed(props.appId, true)}
          {...stylex.attrs(styles.headerButton)}
          data-agent-hide
        >
          <Icon name="x" size={16} />
        </button>
      </header>
      <div {...stylex.attrs(styles.body)}>
        <div
          ref={scroller}
          onScroll={onScroll}
          {...stylex.attrs(styles.scroller, scrolled() && styles.scrollerScrolled)}
          data-chat-scroller
        >
          <div {...stylex.attrs(styles.messages, empty() && styles.messagesEmpty)} data-chat-messages>
            <Show when={empty()}>
              <EmptyState appId={props.appId} kind={kind()} />
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
        <JobsBar appId={props.appId} />
        <Composer
          appId={props.appId}
          running={state().running}
          placeholder={
            web()
              ? "Ask about or change this page…"
              : state().project
                ? "Ask for a change…"
                : "Describe the app you want…"
          }
          top={
            <Show when={picksOf(props.appId).length || headlessTabsOf(props.appId).length}>
              <div {...stylex.attrs(styles.chips)}>
                {/* Headless tabs the agent has open: not shown, unless the user opens one as a real tab. */}
                <For each={headlessTabsOf(props.appId)}>
                  {(h) => (
                    <Chip
                      icon="eye-off"
                      headless={h.id}
                      label={hostOf(h.url) || h.url}
                      title={`The agent is reading ${h.title ? `“${h.title}” (${h.url})` : h.url} in a headless tab${h.logins ? ", with your login" : ""}. Click to open it in a tab.`}
                      onOpen={() => void newWebTab(h.url, { workspaceId: tab()?.workspaceId })}
                      onRemove={() => closeHeadlessTab(h.id)}
                      removeTitle="Close the headless tab"
                    />
                  )}
                </For>
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
          }
          menuItems={[
            {
              label: "Add a folder of code",
              description: "The agent can read it, and changes it with your OK",
              icon: "folder-plus",
              id: "add-folder",
              onSelect: () => void addFolder(props.appId),
            },
          ]}
          tools={
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
                aria-label="Pick elements"
                aria-pressed={isPicking(props.appId)}
                onClick={() => void page()?.pick()}
                {...stylex.attrs(styles.pick, isPicking(props.appId) && styles.pickOn)}
                data-pick-element
              >
                <Icon name="crosshair" size={15} />
              </button>
            </Show>
          }
          below={
            <div {...stylex.attrs(styles.below)} data-composer-below>
              <AccessPicker />
              <SourcesBar tabId={props.appId} />
            </div>
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

const suggestions: Record<"web" | "app" | "new", { icon: string; text: string }[]> = {
  web: [
    { icon: "scroll-text", text: "Summarize this page" },
    { icon: "eye-off", text: "Hide what I don't need on this page" },
    { icon: "table", text: "Put the data on this page in a table" },
  ],
  app: [
    { icon: "palette", text: "Polish the design" },
    { icon: "moon", text: "Add a dark mode" },
    { icon: "bug", text: "Find and fix bugs" },
  ],
  new: [
    { icon: "list-checks", text: "A habit tracker with daily streaks" },
    { icon: "book-open", text: "A reading list with notes and ratings" },
    { icon: "wallet", text: "A budget for this month, by category" },
  ],
};

/** A fresh chat: what the agent can do here, and a few things to start with. */
function EmptyState(props: { appId: string; kind: "web" | "app" | "new" }) {
  return (
    <div {...stylex.attrs(styles.empty)} data-chat-empty>
      <span {...stylex.attrs(styles.emptyMark)} aria-hidden="true">
        <Icon name={props.kind === "web" ? "sparkles" : props.kind === "app" ? "pencil" : "wand-sparkles"} size={18} />
      </span>
      <p {...stylex.attrs(styles.emptyTitle)}>
        {props.kind === "web"
          ? "Ask about this page"
          : props.kind === "app"
            ? "What should change?"
            : "Describe your app"}
      </p>
      <p {...stylex.attrs(styles.hint)}>
        {props.kind === "web"
          ? "Ask anything, or pick elements and say how they should look or work. Changes are saved for the site."
          : props.kind === "app"
            ? "The agent edits the app's code and runs it. You'll see every file it touches here."
            : "The agent sets up a project and builds it. You'll see every file it touches here."}
      </p>
      <div {...stylex.attrs(styles.suggestions)}>
        <For each={suggestions[props.kind]}>
          {(s) => (
            <button
              type="button"
              onClick={() => fillComposer(props.appId, s.text)}
              {...stylex.attrs(styles.suggestion)}
              data-suggestion
            >
              <Icon name={s.icon} size={14} {...stylex.attrs(styles.suggestionIcon)} />
              <span>{s.text}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** Whether agents ask first or have full access (for every tab), under the composer. */
function AccessPicker() {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  return (
    <>
      <button
        ref={button}
        type="button"
        title={
          fullAccess()
            ? `Full access: agents don't ask before acting. ${FULL_ACCESS_WARNING}`
            : "Agents ask you before they act on sites, use your logins, other tabs or apps"
        }
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(styles.access, open() && styles.accessOpen, fullAccess() && styles.accessFull)}
        data-access-picker
        data-full-access={fullAccess() ? "" : undefined}
      >
        <Icon name={fullAccess() ? "shield-off" : "shield-check"} size={13} />
        <span>{fullAccess() ? "Full access" : "Ask first"}</span>
        <Icon name="chevron-down" size={11} {...stylex.attrs(styles.accessChevron)} />
      </button>
      <Show when={open()}>
        <PopoverMenu
          anchor={button}
          title="Agent permissions · every tab"
          name="access-menu"
          width={300}
          onClose={() => setOpen(false)}
          items={[
            {
              label: "Ask first",
              description: "Agents ask before acting for you",
              icon: "shield-check",
              checked: !fullAccess(),
              id: "ask",
              onSelect: () => void setFullAccess(false),
            },
            {
              label: "Full access",
              description: "Agents act without asking",
              icon: "shield-off",
              danger: true,
              checked: fullAccess(),
              id: "full",
              onSelect: () => void setFullAccess(true),
            },
          ]}
        />
      </Show>
    </>
  );
}

/** "Today", "Yesterday", "Previous 7 days"…: the group an earlier chat is listed under. */
function dayGroup(iso: string, now = new Date()) {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

/** When, short, for its day group: "3:40 PM" today and yesterday, "Tue" this week, else "Oct 25". */
function when(iso: string, group: string) {
  const date = new Date(iso);
  if (group === "Today" || group === "Yesterday")
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (group === "Previous 7 days") return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The tab's earlier chats, grouped by day: open one again (the current one is kept) or delete it. */
function ChatHistory(props: { appId: string; anchor: HTMLElement; onClose: () => void }) {
  const [chats, { refetch }] = createResource(() => api.chats(props.appId));
  const [query, setQuery] = createSignal("");
  const running = () => !!states[props.appId]?.running;
  let root!: HTMLDivElement;
  let list!: HTMLDivElement;
  const width = 320;
  const r = props.anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
  const top = r.bottom + 6;
  onMount(() => {
    const away = (e: PointerEvent) =>
      !root.contains(e.target as Node) && !props.anchor.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
        props.anchor.focus({ preventScroll: true });
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // The arrow keys go through the chats (from the search field too).
        e.preventDefault();
        const rows = [...root.querySelectorAll<HTMLButtonElement>("[data-open-chat]:not(:disabled)")];
        const i = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % rows.length : i <= 0 ? rows.length - 1 : i - 1;
        rows[next]?.focus();
      }
    };
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
  const shown = () => {
    const q = query().trim().toLowerCase();
    return (chats() ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  };
  const groups = () => {
    const out: { label: string; chats: ChatSummary[] }[] = [];
    for (const chat of shown()) {
      const label = dayGroup(chat.updatedAt);
      const last = out.at(-1);
      if (last?.label === label) last.chats.push(chat);
      else out.push({ label, chats: [chat] });
    }
    return out;
  };
  const searchable = () => (chats()?.length ?? 0) > 5;
  // Without a search field the list takes the focus (the arrow keys go from there), nothing highlighted.
  onMount(() => queueMicrotask(() => !searchable() && list.focus({ preventScroll: true })));
  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label="Earlier chats"
        {...stylex.attrs(styles.history)}
        style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}
        data-chat-history
      >
        <Show when={searchable()} fallback={<div {...stylex.attrs(styles.historyTitle)}>Earlier chats</div>}>
          <label {...stylex.attrs(styles.historySearch)}>
            <Icon name="search" size={14} />
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              value={query()}
              placeholder="Search earlier chats"
              onInput={(e) => setQuery(e.currentTarget.value)}
              {...stylex.attrs(styles.historySearchInput)}
              data-chat-search
            />
          </label>
        </Show>
        <div ref={list} tabIndex={-1} {...stylex.attrs(styles.historyList)}>
          <For
            each={groups()}
            fallback={
              <div {...stylex.attrs(styles.historyEmpty)}>
                <Show when={!chats.loading} fallback="Loading…">
                  <Show
                    when={query()}
                    fallback={
                      <>
                        <Icon name="messages-square" size={18} />
                        <span>No earlier chats yet. A new chat keeps the current one here.</span>
                      </>
                    }
                  >
                    <span>No chats match “{query()}”.</span>
                  </Show>
                </Show>
              </div>
            }
          >
            {(group) => (
              <>
                <div {...stylex.attrs(styles.historyGroup)}>{group.label}</div>
                <For each={group.chats}>
                  {(chat) => (
                    <div {...stylex.attrs(stylex.defaultMarker(), styles.historyRow)} data-chat={chat.id}>
                      <button
                        type="button"
                        disabled={running()}
                        title={
                          running()
                            ? "Stop the agent first"
                            : `${chat.title}\n${new Date(chat.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${chat.messages} message${chat.messages === 1 ? "" : "s"}`
                        }
                        onClick={() => void act(async () => (await openChat(props.appId, chat.id), props.onClose()))}
                        {...stylex.attrs(styles.historyOpen)}
                        data-open-chat
                      >
                        <span {...stylex.attrs(styles.historyName)}>{chat.title}</span>
                        <span {...stylex.attrs(styles.historyMeta)}>{when(chat.updatedAt, group.label)}</span>
                      </button>
                      <button
                        type="button"
                        title="Delete this chat"
                        aria-label={`Delete “${chat.title}”`}
                        onClick={() =>
                          void act(async () => {
                            if (
                              await confirmDialog(`Delete the chat “${chat.title}”?`, {
                                confirmLabel: "Delete",
                                danger: true,
                              })
                            ) {
                              await api.deleteChat(props.appId, chat.id);
                              await refetch();
                            }
                          })
                        }
                        {...stylex.attrs(styles.historyDelete)}
                        data-delete-chat
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}

const pulse = stylex.keyframes({
  "0%": { opacity: 0.4 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.4 },
});

const pop = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-2px) scale(0.98)" },
  to: { opacity: 1, transform: "none" },
});

const rise = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(4px)" },
  to: { opacity: 1, transform: "none" },
});

const iconButton = {
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
  cursor: { default: "pointer", ":disabled": "default" },
  opacity: { default: 1, ":disabled": 0.4 },
  transition: "background-color 120ms, color 120ms",
} as const;

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
    position: "relative",
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    gap: 2,
    height: 44,
    flexShrink: 0,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    transition: "border-color 150ms",
  },
  // A hairline once the conversation scrolls under it.
  headerScrolled: { borderBottomColor: colors.border },
  headerTab: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    marginRight: space.xs,
    color: colors.text,
  },
  headerName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
    fontWeight: 600,
    letterSpacing: "-0.005em",
  },
  headerButton: iconButton,
  headerButtonOn: { backgroundColor: colors.surfaceHover, color: colors.text },
  chips: { display: "contents" },
  history: {
    position: "fixed",
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    maxHeight: "min(460px, calc(100vh - 80px))",
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.06), 0 12px 32px -6px rgb(0 0 0 / 0.2)",
    fontFamily: font.sans,
    color: colors.text,
    animationName: pop,
    animationDuration: "120ms",
    animationTimingFunction: "ease-out",
  },
  historyTitle: {
    paddingTop: 10,
    paddingBottom: 2,
    paddingInline: space.md,
    color: colors.text,
    fontSize: font.sm,
    fontWeight: 600,
  },
  historySearch: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: 40,
    flexShrink: 0,
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    color: colors.muted,
  },
  historySearchInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderStyle: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: "inherit",
    fontSize: font.sm,
  },
  historyList: { flex: 1, minHeight: 0, overflowY: "auto", padding: 4, paddingTop: 0, outline: "none" },
  historyGroup: {
    paddingTop: 10,
    paddingBottom: 4,
    paddingInline: space.sm,
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: 500,
  },
  historyEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.lg,
    paddingInline: space.lg,
    color: colors.muted,
    fontSize: font.sm,
    lineHeight: 1.45,
    textAlign: "center",
  },
  historyRow: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    borderRadius: radius.sm,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.surfaceHover,
      ":focus-within": colors.surfaceHover,
    },
  },
  historyOpen: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flex: 1,
    minWidth: 0,
    height: 32,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: "inherit",
    textAlign: "left",
    outline: "none",
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.55 },
  },
  historyName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
  },
  historyMeta: {
    flexShrink: 0,
    color: colors.muted,
    fontSize: 11.5,
    fontVariantNumeric: "tabular-nums",
    opacity: { default: 1, [stylex.when.ancestor(":hover")]: 0, [stylex.when.ancestor(":focus-within")]: 0 },
  },
  historyDelete: {
    ...iconButton,
    position: "absolute",
    right: 2,
    width: 26,
    height: 26,
    color: { default: colors.muted, ":hover": colors.danger },
    backgroundColor: { default: "transparent", ":hover": colors.border },
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
      ":focus-visible": 1,
    },
  },
  pick: { ...iconButton, borderRadius: radius.full },
  pickOn: {
    backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft },
    color: { default: colors.accent, ":hover": colors.accent },
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
    // Fades out over its last 16px, into the composer.
    maskImage: "linear-gradient(to bottom, black calc(100% - 16px), transparent)",
  },
  // Scrolled: under the header too.
  scrollerScrolled: {
    maskImage: "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 16px), transparent)",
  },
  messages: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    minWidth: 0,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    paddingLeft: space.lg,
    // The scrollbar's gutter is on this side.
    paddingRight: 10,
  },
  // Only the empty chat fills the panel (to center its welcome); otherwise it's as tall as its content, so the
  // ResizeObserver sees it shrink too.
  messagesEmpty: { justifyContent: "center", minHeight: "100%" },
  composer: { paddingInline: space.md, paddingBottom: space.sm },
  below: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    minHeight: 28,
    paddingInline: 7,
  },
  access: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    height: 24,
    paddingInline: 7,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: "inherit",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    transition: "background-color 120ms, color 120ms",
  },
  accessOpen: { backgroundColor: colors.surfaceHover, color: colors.text },
  accessFull: {
    backgroundColor: {
      default: `color-mix(in oklab, transparent, ${colors.danger} 11%)`,
      ":hover": `color-mix(in oklab, transparent, ${colors.danger} 18%)`,
    },
    color: { default: colors.danger, ":hover": colors.danger },
  },
  accessChevron: { opacity: 0.7 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    paddingBottom: "8vh",
    textAlign: "center",
    animationName: rise,
    animationDuration: "240ms",
    animationTimingFunction: "ease-out",
  },
  emptyMark: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 36,
    marginBottom: 6,
    borderRadius: 11,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  emptyTitle: { margin: 0, fontSize: font.lg, fontWeight: 600, letterSpacing: "-0.015em" },
  hint: { margin: 0, maxWidth: 290, fontSize: font.sm, lineHeight: 1.5, color: colors.muted, textWrap: "pretty" },
  suggestions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 4,
    width: "100%",
    maxWidth: 300,
    marginTop: space.lg,
  },
  suggestion: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 34,
    paddingBlock: 6,
    paddingInline: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: "inherit",
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
    transition: "background-color 120ms",
  },
  suggestionIcon: { flexShrink: 0, color: colors.muted },
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
