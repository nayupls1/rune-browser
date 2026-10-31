// A web tab: a browser page (<webview>) with an address bar, an element
// picker and the website agent next to it. Web tabs stay mounted while you
// switch tabs so pages keep their state. Pages load once the workspace's
// extensions run (content scripts at document start), and extension pages
// (options, ones an extension opened) are web tabs too.
import * as stylex from "@stylexjs/stylex";
import type { DidFailLoadEvent, PageFaviconUpdatedEvent, PageTitleUpdatedEvent, WebviewTag } from "electron";
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { DEFAULT_WORKSPACE, webPartition, type ElementInfo, type PageContext } from "../../shared/api";
import { isExtensionUrl } from "../../shared/extensions";
import {
  fileNameOf,
  hostOf,
  normalizeUrl,
  overrideScript,
  pageChangeHandlerScript,
  pageChangesCss,
  pageChangesScript,
  scopeMatches,
} from "../../shared/web";
import { fillScript, focusScript, keyCodeOf, scrollScript } from "../lib/browse";
import { captureScript, restoreScript, takeSavedPage, type SavedPage } from "../lib/pagestate";
import { cancelPickScript, pickScript, unmarkScript } from "../lib/picker";
import { addPick, clearPicks, isPicking, picksOf, removePick, setPickingIn } from "../lib/picks";
import { settings } from "../lib/settings";
import { sendWithShares } from "../lib/sharing";
import { appById, isAgentCollapsed, setAgentCollapsed, states, stopAgent, updatePage } from "../lib/store";
import { showExtensionSettings } from "../lib/extensions";
import {
  cachedOverride,
  pageChanges,
  pagesChanged,
  registerPage,
  siteOverride,
  type ApplyResult,
  type BrowseAction,
  type PageInfo,
} from "../lib/webtabs";
import { focusAddress, networkTab, registerChrome, setNetworkTab } from "../lib/tabChrome";
import { colors, font, radius, space } from "../theme.stylex";
import type { MenuPosition } from "./ContextMenu";
import { openExtensionImport } from "./ExtensionImport";
import { ExtensionsBar } from "./ExtensionsBar";
import { Icon } from "./Icon";
import { NetworkPanel } from "./NetworkPanel";
import { toast } from "./Toast";
import { changesFor, PageChangesPopover } from "./PageChanges";
import { OverridesPopover, overridesFor } from "./ResponseOverrides";
import { FindBar, ZoomBadge } from "./FindBar";
import { foundInPage, syncZoom } from "../lib/pageTools";

export function WebTab(props: { appId: string; active: boolean }) {
  // A tab that was unloaded comes back where it was (lib/unload.ts).
  const restoring = untrack(() => takeSavedPage(props.appId));
  const initialUrl = untrack(() => restoring?.url ?? appById(props.appId)?.url ?? "");
  // The workspace's session (cookies, logins). A tab moved to another workspace is closed and reopened with the new one.
  const workspaceId = untrack(() => appById(props.appId)?.workspaceId ?? DEFAULT_WORKSPACE);
  const partition = webPartition(workspaceId);
  const [src, setSrc] = createSignal(initialUrl);
  const [address, setAddress] = createSignal(initialUrl);
  const [currentUrl, setCurrentUrl] = createSignal(initialUrl);
  const [loading, setLoading] = createSignal(false);
  const [history, setHistory] = createSignal({ back: false, forward: false });
  // Opened from the command bar ("Network requests"): it's mostly for the agent.
  const networkOpen = () => networkTab() === props.appId;
  const setNetworkOpen = (open: boolean) => setNetworkTab(open ? props.appId : null);
  const [loadError, setLoadError] = createSignal<string>();
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [overridesMenu, setOverridesMenu] = createSignal<MenuPosition>();
  const [contentsId, setContentsId] = createSignal<number | null>(null);
  // The webview waits for the workspace's extensions (never long).
  const [prepared, setPrepared] = createSignal(false);
  void window.rune.extensions.prepare(workspaceId).finally(() => setPrepared(true));
  const host = () => hostOf(currentUrl());
  const collapsed = () => isAgentCollapsed(props.appId);
  const state = () => states[props.appId];

  let webview: WebviewTag | undefined;
  let ready = false;
  let editing = false;
  /** Where to go once the webview is ready (asked for before it was). */
  let pendingUrl: string | null = null;

  // --- Loading ---------------------------------------------------------------------

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
    if (!webview || !ready) throw new Error("No page is open in this tab yet");
    return webview;
  };
  const info = (): PageInfo =>
    webview && ready ? { url: webview.getURL(), title: webview.getTitle() } : { url: currentUrl(), title: "" };
  /** The page's address; "" before the webview's ready or after the tab closed, where getURL would throw. */
  const pageUrl = () => (webview && ready ? webview.getURL() : "");
  // Closing the tab detaches the webview; work still in flight (applying changes) stops touching it.
  onCleanup(() => (ready = false));
  /** Page work that fails because the tab closed meanwhile isn't an error. */
  const unlessClosed = (e: unknown) => {
    if (ready) throw e;
  };

  function go(input: string) {
    // Chrome's extensions page is Rune Browser's.
    if (/^chrome:\/\/extensions\/?$/i.test(input.trim())) {
      showExtensionSettings();
      return false;
    }
    const target = isExtensionUrl(input.trim()) ? input.trim() : normalizeUrl(input, settings().web.searchEngine);
    if (!target) return false;
    setAddress(target);
    if (!src())
      setSrc(target); // creates the webview
    // Its first page is still on its way: loadURL would throw until it's ready.
    else if (!webview || !ready) pendingUrl = target;
    else webview.loadURL(target).catch(() => {}); // failures show up as did-fail-load
    return true;
  }

  const updateHistory = () => {
    if (webview && ready) setHistory({ back: webview.canGoBack(), forward: webview.canGoForward() });
  };

  function navigated(url: string, inPage: boolean) {
    setCurrentUrl(url);
    if (!editing) setAddress(url);
    updatePage(props.appId, { url });
    updateHistory();
    if (!inPage)
      clearPicks(props.appId); // the picked elements are gone with the old page
    // Single-page apps: another page, maybe other page changes.
    else void applyChanges();
  }

  // --- Site customizations -----------------------------------------------------------

  // What's applied to the current document: inserted CSS and whether JS ran.
  let cssKey: string | null = null;
  let ranJs = "";
  let lastError: string | undefined;
  let loadApplied: Promise<void> = Promise.resolve();

  const customizing = () => settings().web.overrides && !window.rune.safeMode;

  async function activeOverride() {
    const url = pageUrl();
    const h = /^https?:/i.test(url) ? hostOf(url) : "";
    if (!h || !customizing()) return null;
    const override = await siteOverride(h).catch(() => null);
    return override?.enabled ? override : null;
  }

  async function applyOnLoad() {
    cssKey = null;
    ranJs = "";
    lastError = undefined;
    resetChanges();
    const override = await activeOverride();
    if (override && webview) {
      if (override.css.trim()) cssKey = await webview.insertCSS(override.css).catch(() => null);
      if (override.js.trim()) {
        ranJs = override.js;
        const result = await webview.executeJavaScript(overrideScript(override.js)).catch((e: unknown) => String(e));
        lastError = typeof result === "string" ? result : undefined;
      }
    }
    await syncChanges(true);
  }

  // Page changes applied to the current document: their CSS, the scripts that
  // ran (they can't be taken back), the button handlers, and what failed.
  let changesCss = "";
  let changesCssKey: string | null = null;
  let ranScripts = new Map<string, string>();
  let handlers = new Map<string, string>();
  const [changeErrors, setChangeErrors] = createSignal<Record<string, string>>({});
  const resetChanges = () => {
    changesCss = "";
    changesCssKey = null;
    ranScripts = new Map();
    handlers = new Map();
    setChangeErrors({});
  };
  const activeChanges = () => {
    const url = pageUrl();
    return customizing() ? pageChanges().filter((c) => c.enabled && scopeMatches(c.scope, url)) : [];
  };

  /** Brings the document in line with the active page changes; false if it had to reload instead. */
  async function syncChanges(fresh: boolean): Promise<boolean> {
    if (!webview) return true;
    const view = webview;
    const list = activeChanges();
    const scripts = list.filter((c) => c.action === "script");
    const stale = [...ranScripts].some(([id, code]) => scripts.find((c) => c.id === id)?.value !== code);
    if (stale && !fresh) {
      view.reload();
      await waitForLoad();
      await loadApplied;
      return false;
    }
    const errors: Record<string, string> = {};
    const run = (code: string) => view.executeJavaScript(code).catch((e: unknown) => ({ __error: String(e) }));
    const css = pageChangesCss(list);
    if (css !== changesCss) {
      if (changesCssKey) await view.removeInsertedCSS(changesCssKey).catch(() => {});
      changesCssKey = css ? await view.insertCSS(css).catch(() => null) : null;
      changesCss = css;
    }
    for (const c of list) {
      if (c.action !== "button" || handlers.get(c.id) === c.onClick) continue;
      const result = await run(pageChangeHandlerScript(c));
      if (result && typeof result === "object" && "__error" in result) errors[c.id] = String(result.__error);
      else handlers.set(c.id, c.onClick ?? "");
    }
    const result = (await run(pageChangesScript(list))) as Record<string, string> | { __error: string } | null;
    if (result && "__error" in result) for (const c of list) errors[c.id] ??= String(result.__error);
    else Object.assign(errors, result ?? {});
    for (const c of scripts) {
      if (ranScripts.has(c.id)) continue;
      ranScripts.set(c.id, c.value ?? "");
      const out = await run(overrideScript(c.value ?? ""));
      if (typeof out === "string") errors[c.id] = out;
      else if (out && typeof out === "object" && "__error" in out) errors[c.id] = String(out.__error);
    }
    setChangeErrors(errors);
    return true;
  }

  // Serialized so concurrent updates (agent + realtime message) don't race.
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T,>(run: () => Promise<T>): Promise<T> => {
    const guarded = () => run().catch(unlessClosed) as Promise<T>;
    const next = chain.then(guarded, guarded);
    chain = next.catch(() => {});
    return next;
  };

  function applyOverride(): Promise<ApplyResult> {
    return serialized(async () => {
      if (!webview || !ready) return { applied: false };
      await loadApplied;
      const override = await activeOverride();
      const js = override?.js.trim() ? override.js : "";
      if (js !== ranJs) {
        // Scripts can't be taken back: reload so the new one runs on a fresh page.
        webview.reload();
        await waitForLoad();
        await loadApplied;
      } else {
        if (cssKey) await webview.removeInsertedCSS(cssKey).catch(() => {});
        cssKey = override?.css.trim() ? await webview.insertCSS(override.css).catch(() => null) : null;
        await syncChanges(false);
      }
      return { applied: !!override, error: lastError, changesEnabled: customizing(), changeErrors: changeErrors() };
    });
  }

  /** Applies the page changes as they are now (they changed, or the page did). */
  function applyChanges() {
    return serialized(async () => {
      if (!webview || !ready) return;
      await loadApplied;
      await syncChanges(false);
    });
  }

  createEffect(
    on(
      () => settings().web.overrides,
      () => void applyOverride(),
      { defer: true },
    ),
  );
  createEffect(on(pageChanges, () => void applyChanges(), { defer: true }));

  // --- Element picker ----------------------------------------------------------------

  const picking = () => isPicking(props.appId);

  async function pick() {
    if (!webview || !ready) return;
    if (picking()) {
      void webview.executeJavaScript(cancelPickScript).catch(() => {});
      return;
    }
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
      // the page navigated away mid-pick
    } finally {
      setPickingIn(props.appId, false);
    }
  }

  function unpick(selector: string) {
    removePick(props.appId, selector);
    if (webview && ready) void webview.executeJavaScript(unmarkScript(selector)).catch(() => {});
  }

  function send(prompt: string) {
    const page: PageContext | undefined =
      webview && ready
        ? { url: webview.getURL(), title: webview.getTitle(), selection: [...picksOf(props.appId)] }
        : undefined;
    clearPicks(props.appId);
    if (webview && ready) void webview.executeJavaScript(unmarkScript()).catch(() => {});
    void sendWithShares(props.appId, prompt, page);
  }

  // --- The website agent using the page (agent/browseTools.ts) ------------------------

  // Shown while the agent acts in this turn: where it clicks or types, and a way to take over.
  const [acting, setActing] = createSignal(false);
  const [marker, setMarker] = createSignal<{ x: number; y: number; key: number } | null>(null);
  createEffect(
    on(
      () => state()?.running,
      (running) => {
        if (!running) {
          setActing(false);
          setMarker(null);
        }
      },
    ),
  );
  const mark = (x: number, y: number) => {
    setActing(true);
    const key = Date.now();
    setMarker({ x, y, key });
    setTimeout(() => setMarker((m) => (m?.key === key ? null : m)), 1200);
  };
  const takeOver = () => {
    void stopAgent(props.appId);
    setActing(false);
    toast({ message: "You have the page. The agent stopped.", kind: "info" });
  };

  async function act(action: BrowseAction) {
    const view = requireReady();
    const click = (x: number, y: number) => {
      view.sendInputEvent({ type: "mouseMove", x, y });
      view.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      view.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    };
    switch (action.kind) {
      case "click":
        mark(action.x, action.y);
        click(action.x, action.y);
        return true;
      case "type":
        mark(action.x, action.y);
        await view.executeJavaScript(focusScript(action.x, action.y, action.clear));
        await view.insertText(action.value);
        return true;
      case "fill": {
        mark(action.x, action.y);
        const error = (await view.executeJavaScript(fillScript(action.selector, action.value))) as string | null;
        if (error) throw new Error(error);
        return true;
      }
      case "key": {
        setActing(true);
        const keyCode = keyCodeOf(action.key);
        view.sendInputEvent({ type: "keyDown", keyCode });
        // Enter and printable keys also type a character (that's what submits a form).
        const char = keyCode === "Enter" ? "\r" : keyCode === "Space" ? " " : keyCode.length === 1 ? keyCode : null;
        if (char) view.sendInputEvent({ type: "char", keyCode: char });
        view.sendInputEvent({ type: "keyUp", keyCode });
        return true;
      }
      case "scroll":
        setActing(true);
        return view.executeJavaScript(scrollScript(action.direction, action.pixels, action.selector));
    }
  }

  /** After an action: a navigation it started has loaded (or nothing happened for a moment). */
  async function settle() {
    await new Promise((r) => setTimeout(r, 400));
    if (loading()) await waitForLoad(15_000);
    await loadApplied;
    return info();
  }

  // --- The page handle (agent RPC, shortcuts) --------------------------------------

  const unregister = registerPage(props.appId, {
    info,
    eval: (code) => requireReady().executeJavaScript(code),
    capture: () => window.rune.web.capture(requireReady().getWebContentsId()),
    navigate: async (url) => {
      const done = waitForLoad();
      if (!go(url)) throw new Error(`Invalid URL: ${url}`);
      await done;
      await loadApplied;
      return info();
    },
    reload: async () => {
      const view = requireReady();
      const done = waitForLoad();
      view.reload();
      await done;
      await loadApplied;
      return info();
    },
    back: () => webview && ready && webview.goBack(),
    forward: () => webview && ready && webview.goForward(),
    focusAddress: () => focusAddress(),
    view: () => (webview && ready ? webview : undefined),
    applyOverride,
    overrideChanged: (changed) => {
      if (changed === host()) void applyOverride();
    },
    send,
    pick,
    unpick,
    webContentsId: () => requireReady().getWebContentsId(),
    // Nothing to wait for without an address.
    whenLoaded: () =>
      src()
        ? Promise.race([firstLoad.then(() => loadApplied), new Promise<void>((r) => setTimeout(r, 15_000))])
        : Promise.resolve(),
    saveState: async () => {
      if (!webview || !ready) return null;
      return (
        ((await webview.executeJavaScript(captureScript).catch(() => null)) as SavedPage | null) ?? {
          url: currentUrl(),
          scrollX: 0,
          scrollY: 0,
          scrollers: [],
          fields: [],
        }
      );
    },
    busy: () => {
      try {
        return !!webview && ready && webview.isCurrentlyAudible();
      } catch {
        return false;
      }
    },
    act,
    settle,
  });
  onCleanup(unregister);

  // Puts back the scroll position and form input it had when it was unloaded, on the same page.
  if (restoring) {
    const samePage = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];
    void firstLoad.then(async () => {
      await loadApplied;
      if (webview && ready && samePage(webview.getURL(), restoring.url))
        await webview.executeJavaScript(restoreScript(restoring)).catch(() => {});
    });
  }

  function attach(view: WebviewTag) {
    webview = view;
    view.addEventListener("did-start-loading", () => {
      setLoading(true);
      setLoadError();
    });
    view.addEventListener("did-stop-loading", () => {
      setLoading(false);
      // Whatever got it there (history, a redirect, a page's own navigation), the page is where it says.
      if (ready && view.getURL() && view.getURL() !== currentUrl()) {
        setCurrentUrl(view.getURL());
        if (!editing) setAddress(view.getURL());
      }
      updateHistory();
      loaded();
    });
    view.addEventListener("did-fail-load", (e: DidFailLoadEvent) => {
      // -3 is an aborted load (e.g. a new navigation replaced it).
      if (e.isMainFrame && e.errorCode !== -3)
        setLoadError(`${e.errorDescription || "Failed to load"} (${e.validatedURL})`);
      loaded();
    });
    view.addEventListener("did-navigate", (e) => {
      navigated(e.url, false);
      syncZoom(props.appId);
      // A local file is named after itself, like in Chrome (text, images and PDFs have no title of their own).
      if (/^file:/i.test(e.url)) updatePage(props.appId, { title: fileNameOf(e.url) });
    });
    view.addEventListener("found-in-page", (e) => foundInPage(props.appId, e.result));
    view.addEventListener("did-navigate-in-page", (e) => e.isMainFrame && navigated(e.url, true));
    view.addEventListener("page-title-updated", (e: PageTitleUpdatedEvent) =>
      updatePage(props.appId, { title: e.title }),
    );
    view.addEventListener("page-favicon-updated", (e: PageFaviconUpdatedEvent) =>
      updatePage(props.appId, { favicon: e.favicons.find((f) => /^https?:/.test(f)) ?? null }),
    );
    view.addEventListener("dom-ready", () => {
      const first = !ready;
      ready = true;
      if (pendingUrl) {
        const url = pendingUrl;
        pendingUrl = null;
        view.loadURL(url).catch(() => {});
      }
      if (first) {
        setContentsId(view.getWebContentsId());
        pagesChanged();
      }
      loadApplied = applyOnLoad().catch(unlessClosed);
      updateHistory();
    });
  }

  // --- Customization menu --------------------------------------------------------------

  // The address bar's paintbrush: the site's customization and the page changes for this page.
  const override = () => cachedOverride(host());
  const customized = () => !!override() && (override()!.css.trim() !== "" || override()!.js.trim() !== "");
  const changesHere = () => changesFor(currentUrl());
  const changed = () => customized() || changesHere().length > 0;
  const overrideActive = () =>
    customizing() && ((customized() && override()!.enabled) || changesHere().some((c) => c.enabled));

  // The address bar's flask: response overrides that apply to this tab, so a changed page is never mistaken for the real one.
  const overridesHere = () => overridesFor(props.appId, workspaceId, currentUrl());

  // What the sidebar's top bar shows for this tab (components/TopBar.tsx): the address with the page's changes, and the extensions.
  onCleanup(
    registerChrome(props.appId, {
      url: () => address(),
      blank: () => !src(),
      icon: () =>
        isExtensionUrl(currentUrl())
          ? "puzzle"
          : currentUrl().startsWith("https:")
            ? "lock"
            : currentUrl().startsWith("file:")
              ? "file"
              : "globe",
      canBack: () => history().back,
      canForward: () => history().forward,
      loading,
      back: () => webview?.goBack(),
      forward: () => webview?.goForward(),
      reload: () => webview?.reload(),
      stop: () => webview?.stop(),
      go,
      addressExtras: () => (
        <>
          <ZoomBadge tabId={props.appId} />
          <Show when={overridesHere().length}>
            <button
              type="button"
              title={`${overridesHere().length} of this page's responses are changed by the agent: see and remove them`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setOverridesMenu(overridesMenu() ? undefined : { x: r.left, y: r.bottom + 6 });
              }}
              {...stylex.attrs(styles.overrides)}
              data-overrides={overridesHere().length}
            >
              <Icon name="flask-conical" size={13} />
              {overridesHere().length}
            </button>
          </Show>
          <Show when={changed()}>
            <button
              type="button"
              title={
                overrideActive()
                  ? "This page is changed: see and turn off the changes"
                  : "The changes to this page are off"
              }
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu(menu() ? undefined : { x: r.left, y: r.bottom + 6 });
              }}
              {...stylex.attrs(styles.customized, overrideActive() && styles.customizedOn)}
              data-customized={overrideActive() ? "on" : "off"}
            >
              <Icon name="paintbrush" size={13} />
            </button>
          </Show>
        </>
      ),
      extensions: () => (
        <ExtensionsBar
          workspaceId={workspaceId}
          tabId={contentsId}
          active={props.active}
          onImport={openExtensionImport}
        />
      ),
    }),
  );

  return (
    <div {...stylex.attrs(styles.split)} data-web-tab={props.appId}>
      <div {...stylex.attrs(styles.main)}>
        <div {...stylex.attrs(styles.viewport)}>
          <Show
            when={src() && prepared()}
            fallback={
              <Show when={!src()}>
                <StartPage onGo={go} />
              </Show>
            }
          >
            <webview
              ref={attach}
              src={src()}
              partition={partition}
              // plugins: Chromium's PDF viewer, for PDFs on the web and local ones.
              {...{ allowpopups: "", plugins: "" }}
              {...stylex.attrs(styles.webview)}
            />
          </Show>
          <Show when={picking()}>
            <div {...stylex.attrs(styles.banner)}>Click an element to pick it · Esc to cancel</div>
          </Show>
          <FindBar tabId={props.appId} />
          <Show when={marker()} keyed>
            {(m) => (
              <span {...stylex.attrs(styles.marker)} style={{ left: `${m.x}px`, top: `${m.y}px` }} data-agent-marker />
            )}
          </Show>
          <Show when={acting() && state()?.running}>
            <div {...stylex.attrs(styles.agentBanner)} data-agent-acting>
              <span {...stylex.attrs(styles.runningDot)} />
              The agent is using this page
              <button type="button" onClick={takeOver} {...stylex.attrs(styles.bannerButton)} data-take-over>
                Take over
              </button>
            </div>
          </Show>
          <Show when={loadError()}>
            <div {...stylex.attrs(styles.banner, styles.bannerError)}>
              {loadError()}
              <button type="button" onClick={() => webview?.reload()} {...stylex.attrs(styles.bannerButton)}>
                Retry
              </button>
            </div>
          </Show>
        </div>
        <Show when={networkOpen()}>
          <NetworkPanel
            webContentsId={() => {
              try {
                return webview?.getWebContentsId() ?? null;
              } catch {
                return null;
              }
            }}
            workspaceId={() => appById(props.appId)?.workspaceId ?? DEFAULT_WORKSPACE}
            onClose={() => setNetworkOpen(false)}
          />
        </Show>
      </div>
      <Show when={overridesMenu()}>
        {(position) => (
          <OverridesPopover
            tabId={props.appId}
            workspaceId={workspaceId}
            url={currentUrl()}
            position={position()}
            onClose={() => setOverridesMenu()}
          />
        )}
      </Show>
      <Show when={menu()}>
        {(position) => (
          <PageChangesPopover
            url={currentUrl()}
            errors={changeErrors()}
            position={position()}
            onClose={() => setMenu()}
          />
        )}
      </Show>
    </div>
  );
}

function StartPage(props: { onGo: (input: string) => boolean }) {
  return (
    <div {...stylex.attrs(styles.start)}>
      <Icon name="globe" size={36} {...stylex.attrs(styles.startIcon)} />
      <p {...stylex.attrs(styles.startText)}>Search or enter an address above.</p>
      <div {...stylex.attrs(styles.startLinks)}>
        <For each={["news.ycombinator.com", "wikipedia.org", "github.com"]}>
          {(site) => (
            <button type="button" onClick={() => props.onGo(site)} {...stylex.attrs(styles.startLink)}>
              {site}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

const ping = stylex.keyframes({
  "0%": { transform: "scale(0.6)", opacity: 1 },
  "100%": { transform: "scale(1.6)", opacity: 0 },
});

const pulse = stylex.keyframes({
  "0%": { opacity: 0.4 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.4 },
});

const styles = stylex.create({
  split: { display: "flex", height: "100%", minHeight: 0 },
  main: { position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    height: 44,
    flexShrink: 0,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 30,
    height: 30,
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
  addressBar: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    marginInline: space.xs,
    paddingInline: space.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus-within": colors.accent },
    backgroundColor: colors.surface,
  },
  addressIcon: { flexShrink: 0, color: colors.muted },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderStyle: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
  },
  customized: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    marginRight: -4,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
  overrides: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
    height: 22,
    minWidth: 22,
    marginRight: -4,
    paddingInline: 5,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: {
      default: `color-mix(in srgb, ${colors.warning} 16%, transparent)`,
      ":hover": colors.surfaceHover,
    },
    color: colors.warning,
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
  customizedOn: { color: colors.accent, backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft } },
  agentButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    height: 30,
    marginLeft: space.xs,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  runningDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  viewport: { position: "relative", flex: 1, minHeight: 0, backgroundColor: "#ffffff" },
  webview: { position: "absolute", inset: 0, width: "100%", height: "100%" },
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
  agentBanner: {
    position: "absolute",
    bottom: space.md,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    paddingLeft: space.md,
    paddingRight: 6,
    borderRadius: radius.full,
    backgroundColor: colors.text,
    color: colors.bg,
    fontSize: font.sm,
    fontWeight: 500,
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.22)",
  },
  marker: {
    position: "absolute",
    zIndex: 3,
    width: 28,
    height: 28,
    marginLeft: -14,
    marginTop: -14,
    borderRadius: radius.full,
    borderWidth: 3,
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    pointerEvents: "none",
    animationName: ping,
    animationDuration: "1.2s",
    animationFillMode: "forwards",
  },
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
  start: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    height: "100%",
    backgroundColor: colors.bg,
    color: colors.muted,
  },
  startIcon: { color: colors.accent },
  startText: { margin: 0, fontSize: font.md },
  startLinks: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: space.sm },
  startLink: {
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
  },
});
