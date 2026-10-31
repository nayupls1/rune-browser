// The top of the sidebar, like Zen Browser's: the window's close button, the
// agent, extensions, back, forward and reload, then the address of the tab on screen (an app's localhost URL)
// with suggestions as you type, and the tab's own tools. Pages get the whole
// content area. Each tab provides what's shown here (lib/tabChrome.ts).
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { searchEngines } from "../../shared/settings";
import { normalizeUrl } from "../../shared/web";
import { isExtensionUrl } from "../../shared/extensions";
import { settings } from "../lib/settings";
import {
  appById,
  apps,
  isAgentCollapsed,
  isTab,
  newWebTab,
  selectApp,
  selectedId,
  states,
  toggleAgent,
  workspaces,
} from "../lib/store";
import { chromeOf, focusRequest } from "../lib/tabChrome";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { TabIcon } from "./TabIcon";
import { WindowControls } from "./WindowControls";
import { withKeys } from "../lib/shortcuts";

interface Suggestion {
  key: string;
  icon: () => JSX.Element;
  title: string;
  detail: string;
  run: () => void;
}

/**
 * The strip the window is dragged by, like Zen Browser's: the close button
 * (macOS: its own traffic lights), the agent, the tab's extensions, then back,
 * forward and reload.
 */
export function NavRow(props: { compact: boolean }) {
  const chrome = () => chromeOf(selectedId());
  const tabId = () => (isTab(selectedId()) ? selectedId()! : null);
  const agentHidden = () => !!tabId() && isAgentCollapsed(tabId()!);
  const agentShown = () => !!tabId() && !isAgentCollapsed(tabId()!);
  const working = () => !!tabId() && !!states[tabId()!]?.running;
  return (
    <div {...stylex.attrs(styles.nav, props.compact && styles.navCompact)} data-titlebar data-nav-row>
      <WindowControls />
      <Show when={!props.compact}>
        <Show when={tabId()}>
          <button
            type="button"
            title={withKeys(agentHidden() ? "Show the agent" : "Hide the agent", "agent.toggle")}
            onClick={() => toggleAgent(tabId()!)}
            {...stylex.attrs(styles.navButton, styles.agentButton, agentShown() && styles.agentOn)}
            data-agent-show={agentHidden() ? "" : undefined}
          >
            <Icon name="bot" size={16} />
            <Show when={working()}>
              <span {...stylex.attrs(styles.workingDot)} />
            </Show>
          </button>
        </Show>
        {/* Keyed: the tab on screen changes, and with it its extensions. */}
        <Show when={chrome()?.extensions} keyed>
          {(extensions) => extensions()}
        </Show>
        <span {...stylex.attrs(styles.spacer)} />
        <button
          type="button"
          title="Back (Alt+←)"
          disabled={!chrome()?.canBack()}
          onClick={() => chrome()?.back()}
          {...stylex.attrs(styles.navButton)}
          data-back
        >
          <Icon name="arrow-left" size={16} />
        </button>
        <button
          type="button"
          title="Forward (Alt+→)"
          disabled={!chrome()?.canForward()}
          onClick={() => chrome()?.forward()}
          {...stylex.attrs(styles.navButton)}
          data-forward
        >
          <Icon name="arrow-right" size={16} />
        </button>
        <Show
          when={chrome()?.loading() && chrome()?.stop}
          fallback={
            <button
              type="button"
              title={withKeys("Reload", "nav.reload")}
              disabled={!chrome()}
              onClick={() => chrome()?.reload()}
              {...stylex.attrs(styles.navButton)}
              data-reload
            >
              <Icon name="rotate-cw" size={15} />
            </button>
          }
        >
          <button type="button" title="Stop" onClick={() => chrome()?.stop?.()} {...stylex.attrs(styles.navButton)}>
            <Icon name="x" size={16} />
          </button>
        </Show>
      </Show>
    </div>
  );
}

/** The address of the tab on screen, with suggestions: open tabs (all workspaces), the URL, a search. */
export function AddressBar() {
  const chrome = () => chromeOf(selectedId());
  const [text, setText] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const [rect, setRect] = createSignal<DOMRect>();
  let input!: HTMLInputElement;

  // Shows the tab's address unless you're typing.
  createEffect(() => {
    const url = chrome()?.url() ?? "";
    if (!editing()) setText(url);
  });
  createEffect(on(focusRequest, () => focus(), { defer: true }));
  // Another tab on screen: what was being typed for the last one goes (a new blank tab takes the focus again below).
  createEffect(on(selectedId, () => editing() && finish(), { defer: true }));
  // A new web tab starts here.
  createEffect(
    on(
      () => [selectedId(), chrome()?.blank?.()] as const,
      ([, blank]) => blank && queueMicrotask(focus),
    ),
  );

  function focus() {
    input.focus();
    input.select();
  }

  const loadingShown = () => !editing() && !!chrome()?.loading();
  const query = () => (editing() ? text().trim() : "");
  const suggestions = (): Suggestion[] => {
    const q = query();
    if (!q) return [];
    const lower = q.toLowerCase();
    const out: Suggestion[] = [];
    const target = isExtensionUrl(q) ? q : normalizeUrl(q, settings().web.searchEngine);
    const searching =
      target.startsWith(searchEngines[settings().web.searchEngine].url.split("%s")[0]!) && !/^https?:\/\//i.test(q);
    if (!searching)
      out.push({
        key: "go",
        icon: () => <Icon name="globe" size={14} />,
        title: target,
        detail: "Open",
        run: () => open(target, q),
      });
    // Open tabs, in every workspace.
    const tabs = apps
      .filter(
        (t) =>
          t.id !== selectedId() &&
          (t.name.toLowerCase().includes(lower) || (t.url ?? "").toLowerCase().includes(lower)),
      )
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)))
      .slice(0, 6);
    for (const tab of tabs) {
      const space = workspaces.find((w) => w.id === tab.workspaceId);
      out.push({
        key: `tab:${tab.id}`,
        icon: () => <TabIcon tab={tab} size={14} />,
        title: tab.name,
        detail: `Switch to tab${workspaces.length > 1 && space ? ` · ${space.name}` : ""}${tab.url ? ` · ${tab.url.replace(/^https?:\/\//, "").slice(0, 60)}` : ""}`,
        run: () => void selectApp(tab.id),
      });
    }
    out.push({
      key: "search",
      icon: () => <Icon name="search" size={14} />,
      title: q,
      detail: `Search with ${searchEngines[settings().web.searchEngine].label}`,
      run: () => open(normalizeUrl(q, settings().web.searchEngine)),
    });
    // Typed words (not an address): the matching tabs first, then the search.
    if (searching && !tabs.length) out.unshift(out.pop()!);
    // A bare path ("/act") is more likely part of an open tab's address than a local file: tabs first.
    if (!searching && tabs.length && /^file:/i.test(target) && !/^file:/i.test(q))
      out.splice(tabs.length, 0, out.shift()!);
    return out;
  };

  /**
   * In this tab when it can (a web tab), else in a new web tab. A typed path goes to the
   * app on screen first (its preview); elsewhere it's a local file.
   */
  function open(target: string, typed?: string) {
    const c = chrome();
    if (typed?.startsWith("/") && c?.go?.(typed)) return;
    if (!(c?.go && c.go(target))) void newWebTab(target);
  }

  const finish = () => {
    setEditing(false);
    setText(chrome()?.url() ?? "");
    input.blur();
  };
  const run = (s: Suggestion | undefined) => {
    if (!s) return;
    s.run();
    finish();
  };
  /**
   * Enter with modifiers, like in Chromium: Ctrl+Enter makes "example" www.example.com,
   * Alt+Enter (Cmd+Enter on macOS) and Shift+Enter open in a new tab. True if it handled it.
   */
  const enterWith = (e: KeyboardEvent) => {
    const typed = text().trim();
    const newTab = window.rune.window.platform === "darwin" ? e.metaKey : e.altKey || e.shiftKey;
    const complete = e.ctrlKey && !e.metaKey && /^[\w-]+$/.test(typed);
    if (!typed || (!newTab && !complete)) return false;
    e.preventDefault();
    const chosen = list()[active()];
    // A suggested tab is switched to, wherever it is.
    if (!complete && chosen?.key.startsWith("tab:")) {
      run(chosen);
      return true;
    }
    const target = complete
      ? `https://www.${typed}.com/`
      : chosen?.key === "go"
        ? chosen.title
        : isExtensionUrl(typed)
          ? typed
          : normalizeUrl(typed, settings().web.searchEngine);
    if (newTab) void newWebTab(target);
    else open(target, typed);
    finish();
    return true;
  };
  const list = () => suggestions();
  const isActive = (i: number) => i === active();

  return (
    <form
      {...stylex.attrs(styles.address)}
      onSubmit={(e) => {
        e.preventDefault();
        const chosen = list()[active()];
        if (chosen) return run(chosen);
        const typed = text().trim();
        if (!typed) return;
        open(isExtensionUrl(typed) ? typed : normalizeUrl(typed, settings().web.searchEngine), typed);
        finish();
      }}
      data-address-bar
    >
      {/* While the page loads, a spinner in place of its icon (the address bar is the toolbar). */}
      <Show
        when={loadingShown()}
        fallback={
          <Icon
            name={editing() ? "search" : (chrome()?.icon() ?? "search")}
            size={13}
            {...stylex.attrs(styles.addressIcon)}
          />
        }
      >
        <Icon
          name="loader-circle"
          size={13}
          {...stylex.attrs(styles.addressIcon, styles.spinning)}
          data-address-loading
        />
      </Show>
      <input
        ref={input}
        value={text()}
        placeholder="Search or enter an address"
        spellcheck={false}
        onFocus={(e) => {
          setEditing(true);
          setRect(e.currentTarget.parentElement!.getBoundingClientRect());
          e.currentTarget.select();
        }}
        onBlur={() => setTimeout(() => editing() && finish(), 120)}
        onInput={(e) => {
          // Typing is editing, whether or not the focus event came first.
          if (!editing()) {
            setEditing(true);
            setRect(e.currentTarget.parentElement!.getBoundingClientRect());
          }
          setText(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          const n = list().length;
          if (e.key === "Escape") return finish();
          if (e.key === "Enter" && enterWith(e)) return;
          if (!n) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
          }
        }}
        {...stylex.attrs(styles.addressInput)}
        data-address
      />
      {/* Keyed: the tab on screen changes, and with it what's shown here. */}
      <Show when={!editing() && chrome()?.addressExtras} keyed>
        {(extras) => extras()}
      </Show>
      <Show when={list().length && rect()}>
        <Portal>
          <div
            role="listbox"
            {...stylex.attrs(styles.suggestions)}
            style={{
              left: `${rect()!.left}px`,
              top: `${rect()!.bottom + 4}px`,
              width: `${Math.max(rect()!.width, 380)}px`,
            }}
            data-suggestions
          >
            <For each={list()}>
              {(s, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive(i())}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i())}
                  onClick={() => run(s)}
                  {...stylex.attrs(styles.suggestion, isActive(i()) && styles.suggestionOn)}
                  data-suggestion={s.key}
                >
                  <span {...stylex.attrs(styles.suggestionIcon)}>{s.icon()}</span>
                  <span {...stylex.attrs(styles.suggestionTitle)}>{s.title}</span>
                  <span {...stylex.attrs(styles.suggestionDetail)}>{s.detail}</span>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </form>
  );
}

/** The tab's own tools (extensions, an app's logs, data, tools…), under the address. */
export function TabTools() {
  const chrome = () => chromeOf(selectedId());
  return (
    <Show when={chrome()?.tools} keyed>
      {(tools) => (
        <div {...stylex.attrs(styles.tools)} data-tab-tools>
          {tools()}
        </div>
      )}
    </Show>
  );
}

/** Whether the tab on screen is an app (for labels). */
export const selectedIsApp = () => appById(selectedId())?.kind === "app";

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

const pulse = stylex.keyframes({ "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } });

const styles = stylex.create({
  nav: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    height: 40,
    marginTop: `calc(-1 * ${space.md})`,
    marginInline: `calc(-1 * ${space.md})`,
    paddingInline: 10,
  },
  navCompact: { justifyContent: "center", marginInline: -8, paddingInline: 0 },
  navButton: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text, ":disabled": colors.border },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  agentButton: { color: { default: colors.muted, ":hover": colors.text } },
  agentOn: { color: { default: colors.accent, ":hover": colors.accent } },
  workingDot: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 6,
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  spacer: { flex: 1 },
  address: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    height: 34,
    paddingInline: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "transparent", ":focus-within": colors.accent },
    backgroundColor: colors.surface,
    boxShadow: `0 0 0 1px ${colors.border}`,
  },
  addressIcon: { flexShrink: 0, color: colors.muted },
  spinning: {
    color: colors.accent,
    animationName: spin,
    animationDuration: "0.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
    textOverflow: "ellipsis",
  },
  suggestions: {
    position: "fixed",
    zIndex: 1500,
    display: "flex",
    flexDirection: "column",
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgb(0 0 0 / 0.18)",
    fontFamily: font.sans,
  },
  suggestion: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 34,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
  },
  suggestionOn: { backgroundColor: colors.surfaceHover },
  suggestionIcon: { display: "grid", placeItems: "center", width: 18, flexShrink: 0, color: colors.muted },
  suggestionTitle: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
  },
  suggestionDetail: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.muted,
    fontSize: font.xs,
  },
  tools: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2, flexShrink: 0, minHeight: 30 },
});
