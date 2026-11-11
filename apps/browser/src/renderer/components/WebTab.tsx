// A web tab: a browser page (<webview>) with an address bar, an element
// picker and the website agent next to it. Web tabs stay mounted while you
// switch tabs so pages keep their state. Pages load once the workspace's
// extensions run (content scripts at document start), and extension pages
// (options, ones an extension opened) are web tabs too. A tab comes back with its
// back/forward history (lib/tabHistory.ts), and a page that crashed shows Chromium's
// sad tab ("Aw, Snap!") until it's reloaded.
import * as stylex from "@stylexjs/stylex";
import type {
  DidFailLoadEvent,
  PageFaviconUpdatedEvent,
  PageTitleUpdatedEvent,
  RenderProcessGoneEvent,
  WebviewTag,
} from "electron";
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { webPartition, type ElementInfo, type PageContext } from "../../shared/api";
import { isExtensionUrl } from "../../shared/extensions";
import { insecureAction, insecureHostOf, isInsecureUrl } from "../../shared/insecure";
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
import { searchEngine, settings } from "../lib/settings";
import { allowInsecure, insecurePolicy } from "../lib/insecure";
import { sendWithShares } from "../lib/sharing";
import {
  appById,
  isAgentCollapsed,
  isPrivate,
  sessionWorkspace,
  setAgentCollapsed,
  states,
  stopAgent,
  updatePage,
} from "../lib/store";
import { openInternalPage } from "../lib/internalPages";
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
import { focusAddress, networkTab, registerChrome, setNetworkTab, spinnerFor } from "../lib/tabChrome";
import { colors, font, radius, space } from "../theme.stylex";
import type { MenuPosition } from "./ContextMenu";
import { openExtensionImport } from "./ExtensionImport";
import { ExtensionsBar } from "./ExtensionsBar";
import { Icon } from "./Icon";
import { InsecureWarning } from "./InsecureWarning";
import { NetworkPanel } from "./NetworkPanel";
import { toast } from "./Toast";
import { changesFor, PageChangesPopover } from "./PageChanges";
import { OverridesPopover, overridesFor } from "./ResponseOverrides";
import { SiteInfoPopover } from "./SiteInfo";
import { PermissionPrompt, SiteStatusIcon, siteStatusTitle, siteUsage } from "./SitePermissions";
import { loadUsage } from "../lib/sitePermissions";
import { FindBar, ZoomBadge } from "./FindBar";
import { LoadErrorPage } from "./LoadError";
import { describeCrash, describeLoadError, type LoadError } from "../../shared/loadErrors";
import { hasHistory, trimHistory } from "../../shared/tabHistory";
import { flushHistory, historyOf, rememberHistory } from "../lib/tabHistory";
import { BookmarkStar } from "./Bookmarks";
import { ADDRESS_ICON_SIZE, addressButton } from "./addressButton";
import { applySiteZoom, foundInPage } from "../lib/pageTools";
import { siteForUrl } from "../lib/browser";

/** How long an http:// page's HTTPS version may take to answer before the tab warns instead. */
const UPGRADE_TIMEOUT_MS = 6_000;
/** A page that crashes again this soon after it was reloaded from the sad tab isn't reloaded by itself. */
const CRASH_AGAIN_MS = 30_000;

const sameUrl = (a: string, b: string) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};

export function WebTab(props: { appId: string; active: boolean }) {
  // A tab that was unloaded comes back where it was (lib/unload.ts).
  const restoring = untrack(() => takeSavedPage(props.appId));
  const initialUrl = untrack(() => restoring?.url ?? appById(props.appId)?.url ?? "");
  // The workspace's session (cookies, logins), or the private windows' one that keeps nothing. A tab moved to
  // another workspace is closed and reopened with the new one.
  const workspaceId = untrack(() => sessionWorkspace(appById(props.appId)));
  const partition = webPartition(workspaceId);
  // Set by open() below: an insecure first page may be tried over HTTPS, or not loaded at all.
  const [src, setSrc] = createSignal("");
  const [address, setAddress] = createSignal(initialUrl);
  const [currentUrl, setCurrentUrl] = createSignal(initialUrl);
  const [loading, setLoading] = createSignal(false);
  const spinner = spinnerFor(loading);
  const [history, setHistory] = createSignal({ back: false, forward: false });
  // Opened from the command bar ("Network requests"): it's mostly for the agent.
  const networkOpen = () => networkTab() === props.appId;
  const setNetworkOpen = (open: boolean) => setNetworkTab(open ? props.appId : null);
  /** The page didn't load: Chromium's error page for it (components/LoadError.tsx). */
  const [loadError, setLoadError] = createSignal<LoadError & { url: string }>();
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [overridesMenu, setOverridesMenu] = createSignal<MenuPosition>();
  const [siteMenu, setSiteMenu] = createSignal<MenuPosition>();
  // Their buttons in the address bar look pressed while their popovers are open.
  const siteMenuOpen = () => siteMenu() !== undefined;
  const overridesMenuOpen = () => overridesMenu() !== undefined;
  const changesMenuOpen = () => menu() !== undefined;
  const [contentsId, setContentsId] = createSignal<number | null>(null);
  // The webview waits for the workspace's extensions (never long).
  const [prepared, setPrepared] = createSignal(false);
  void window.rune.extensions.prepare(workspaceId).finally(() => setPrepared(true));
  const host = () => hostOf(currentUrl());
  // The site settings button shows what the page uses right now, or was refused (components/SitePermissions.tsx).
  const siteLive = () => (siteUsage(contentsId(), currentUrl())?.inUse.length ?? 0) > 0;
  const siteRefused = () => !siteLive() && (siteUsage(contentsId(), currentUrl())?.blocked.length ?? 0) > 0;
  createEffect(on(contentsId, (id) => id !== null && loadUsage(id)));
  /** The address field's icon: what kind of page this is, and whether it's secure. */
  const addressIcon = () =>
    notSecure()
      ? "triangle-alert"
      : isExtensionUrl(currentUrl())
        ? "puzzle"
        : currentUrl().startsWith("https:")
          ? "lock"
          : currentUrl().startsWith("file:")
            ? "file"
            : "globe";
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
    const gone = crashNote();
    if (gone) throw new Error(gone);
    if (!webview || !ready) throw new Error("No page is open in this tab yet");
    return webview;
  };
  const info = (): PageInfo => {
    const page =
      webview && ready ? { url: webview.getURL(), title: webview.getTitle() } : { url: currentUrl(), title: "" };
    const blocked = blockedNote();
    return blocked ? { ...page, blocked } : page;
  };
  /** The page's address; "" before the webview's ready or after the tab closed, where getURL would throw. */
  const pageUrl = () => (webview && ready ? webview.getURL() : "");
  // Closing the tab detaches the webview; work still in flight (applying changes) stops touching it.
  onCleanup(() => (ready = false));
  /** Page work that fails because the tab closed meanwhile isn't an error. */
  const unlessClosed = (e: unknown) => {
    if (ready) throw e;
  };

  function go(input: string) {
    // rune:// and chrome:// pages are Rune Browser's own, shown in Settings.
    if (openInternalPage(input)) return true;
    const target = isExtensionUrl(input.trim()) ? input.trim() : normalizeUrl(input, searchEngine().url);
    if (!target) return false;
    setAddress(target);
    open(target);
    return true;
  }

  function load(target: string) {
    if (!src())
      setSrc(target); // creates the webview
    // Its first page is still on its way: loadURL would throw until it's ready.
    else if (!webview || !ready) pendingUrl = target;
    else webview.loadURL(target).catch(() => {}); // failures show up as did-fail-load
  }

  // --- Insecure pages (shared/insecure.ts) -----------------------------------------------

  /** The http:// page the tab warns about instead of showing it, and the HTTPS version that was tried. */
  // `onPage`: the HTTPS version is the page the tab already shows (it sent the tab to its own http:// version).
  const [insecure, setInsecure] = createSignal<{ url: string; attempt: string | null; onPage?: boolean } | null>(null);
  /** Trying an http:// page's HTTPS version: if it fails, the tab warns instead. */
  let upgrading: { from: string; to: string; host: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The webview has shown a page (one that loaded, not an error): there's something to go back to. */
  let committed = false;
  const stopUpgrading = () => {
    if (upgrading) clearTimeout(upgrading.timer);
    upgrading = null;
  };
  onCleanup(stopUpgrading);

  /** Opens a page, over HTTPS when an http:// one can be, or warns first. */
  function open(target: string) {
    stopUpgrading();
    setInsecure(null);
    // What was asked for earlier, while the webview was getting ready, is replaced.
    pendingUrl = null;
    const action = insecureAction(target, insecurePolicy());
    if (action.kind === "allow") return load(target);
    if (action.kind === "warn") {
      // A page still loading would replace the warning when it commits.
      if (webview && ready) webview.stop();
      return warn(target, null);
    }
    const from = target;
    upgrading = {
      from,
      to: action.url,
      host: insecureHostOf(action.url),
      // A site that doesn't answer over HTTPS (a firewall dropping the connection) would keep the tab waiting.
      timer: setTimeout(() => {
        if (upgrading?.from !== from) return;
        webview?.stop();
        warn(from, action.url);
      }, UPGRADE_TIMEOUT_MS),
    };
    load(action.url);
  }

  function warn(url: string, attempt: string | null, onPage = false) {
    stopUpgrading();
    setLoadError();
    setInsecure({ url, attempt, onPage });
    if (!editing) setAddress(url);
    // The agent waiting for the page gets its answer (lib/webtabs.ts: navigate, settle).
    loaded();
  }

  /** "Continue to site": the page over HTTP, this time (until Rune Browser restarts) or always. */
  function proceed(always: boolean) {
    const warning = insecure();
    if (!warning) return;
    allowInsecure(insecureHostOf(warning.url), always);
    setInsecure(null);
    load(warning.url);
  }

  /** "Go back": the page the tab was on (stepping back over the failed HTTPS attempt, if it's in its history). */
  function leave() {
    const warning = insecure();
    setInsecure(null);
    if (!warning) return;
    const onAttempt = !warning.onPage && !!warning.attempt && sameUrl(pageUrl(), warning.attempt);
    if (onAttempt && webview!.canGoBack()) return webview!.goBack();
    if (committed && !onAttempt) {
      if (!editing) setAddress(currentUrl());
      return;
    }
    // Nothing to go back to: a new tab.
    ready = false;
    committed = false;
    webview = undefined;
    pendingUrl = null;
    setContentsId(null);
    setSrc("");
    setCurrentUrl("");
    setAddress("");
    updatePage(props.appId, { url: "" });
    pagesChanged();
  }

  // The page navigated (or was redirected) to an insecure page, and the main process held it back.
  onCleanup(
    window.rune.web.onInsecure(({ contentsId: id, url }) => {
      let mine = false;
      try {
        // Known as soon as the webview is attached, before its first page.
        mine = !!webview && webview.getWebContentsId() === id;
      } catch {
        // not attached
      }
      if (!mine) return;
      // The HTTPS version sends it back to HTTP: it has no secure version.
      if (upgrading && insecureHostOf(url) === upgrading.host) return warn(upgrading.from, upgrading.to);
      // A secure page sending the tab to its own http:// version: trying HTTPS again would only go round.
      const action = insecureAction(url, insecurePolicy());
      if (action.kind === "upgrade" && sameUrl(action.url, pageUrl())) return warn(url, action.url, true);
      if (!editing) setAddress(url);
      open(url);
    }),
  );

  /** What the agent is told when the page it asked for is behind the warning, or crashed. */
  const blockedNote = () => {
    const warning = insecure();
    return warning
      ? `${warning.url} isn't secure (plain HTTP${warning.attempt ? ", no HTTPS version" : ""}): Rune Browser shows the user a warning instead, and only they can choose to open it.`
      : crashNote();
  };

  const updateHistory = () => {
    if (webview && ready) setHistory({ back: webview.canGoBack(), forward: webview.canGoForward() });
  };

  // --- Back/forward history kept with the tab (lib/tabHistory.ts) ---------------------------

  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reads the page's history a moment after it changed (the main process has it) and keeps it. */
  const keepHistory = () => {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      const id = contentsId();
      if (id === null || !ready || crash()) return;
      void window.rune.web
        .navigationHistory(id)
        .then((h) => h && rememberHistory(props.appId, h))
        .catch(() => {});
    }, 300);
  };
  onCleanup(() => {
    clearTimeout(historyTimer);
    void flushHistory(props.appId);
  });

  // --- Crashed page ("Aw, Snap!") ------------------------------------------------------------

  /** The page's process went away: Chromium's sad tab is shown until it's reloaded. */
  const crash = () => (loadError()?.kind === "crash" ? loadError() : undefined);
  /** What the agent is told about a crashed page. */
  const crashNote = () => {
    const c = crash();
    return c
      ? `The page in this tab crashed ("${c.title}", ${c.code}). Reload it (the reload tool) or open another page to use it again.`
      : undefined;
  };
  /** When it was last reloaded from the sad tab: crashing again soon after says what to try, and isn't reloaded by itself. */
  let crashReloadedAt = 0;
  /** It crashed while it wasn't on screen: reloaded once when it's shown, like Chrome does. */
  let reloadWhenShown = false;
  function reloadCrashed() {
    reloadWhenShown = false;
    crashReloadedAt = Date.now();
    setLoadError();
    webview?.reload();
  }
  function crashed(e: RenderProcessGoneEvent) {
    const again = Date.now() - crashReloadedAt < CRASH_AGAIN_MS;
    const error = describeCrash(e.details.reason, e.details.exitCode, window.rune.window.platform, again);
    if (!error) return;
    ready = false;
    setLoading(false);
    stopUpgrading();
    setPickingIn(props.appId, false);
    setLoadError({ ...error, url: currentUrl() });
    reloadWhenShown = !props.active && !again;
    // Whoever waits for the page (the agent) gets its answer: it's gone.
    loaded();
  }
  createEffect(
    on(
      () => props.active,
      (active) => active && reloadWhenShown && crash() && reloadCrashed(),
      { defer: true },
    ),
  );

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
      const blocked = blockedNote();
      if (blocked) throw new Error(blocked);
      await loadApplied;
      return info();
    },
    reload: async () => {
      if (crash() && webview) {
        const done = waitForLoad();
        reloadCrashed();
        await done;
        await loadApplied;
        return info();
      }
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
    // Nothing to wait for without an address (once its history is back, if it has one).
    whenLoaded: () =>
      started.then(() =>
        src()
          ? Promise.race([firstLoad.then(() => loadApplied), new Promise<void>((r) => setTimeout(r, 15_000))])
          : undefined,
      ),
    saveState: async () => {
      if (!webview || !ready || crash()) return null;
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
        return !!webview && ready && !crash() && webview.isCurrentlyAudible();
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

  /**
   * Opens the tab's page: with its back/forward history when it has one (after a restart, an unloaded tab,
   * Ctrl+Shift+T), rebuilt by the main process in a fresh page; otherwise just the address.
   */
  async function start(url: string) {
    const kept = trimHistory(await historyOf(props.appId), url);
    // Something else was opened meanwhile, or the page needs the insecure-site checks first.
    if (src()) return;
    if (hasHistory(kept) && insecureAction(url, insecurePolicy()).kind === "allow") {
      const token = crypto.randomUUID();
      const ok = await window.rune.web.restoreHistory(token, kept).catch(() => false);
      if (src()) return;
      if (ok) return void setSrc(`about:blank#rune-restore=${token}`);
    }
    open(url);
  }
  // Not a blank tab meanwhile (no start page, no focused address bar).
  const [starting, setStarting] = createSignal(!!initialUrl);
  const started = initialUrl
    ? start(initialUrl)
        .catch(() => !src() && open(initialUrl))
        .finally(() => setStarting(false))
    : Promise.resolve();

  function attach(view: WebviewTag) {
    webview = view;
    view.addEventListener("render-process-gone", crashed);
    view.addEventListener("did-start-loading", () => {
      setLoading(true);
      setLoadError();
    });
    // Another page asked for (a link, the agent, an extension) while the HTTPS version was being tried: what
    // happens to that one isn't the attempt's.
    view.addEventListener("did-start-navigation", (e) => {
      if (upgrading && e.isMainFrame && !e.isInPlace && !sameUrl(e.url, upgrading.to)) stopUpgrading();
    });
    view.addEventListener("did-stop-loading", () => {
      setLoading(false);
      // Whatever got it there (history, a redirect, a page's own navigation), the page is where it says.
      // Not under the insecure-site warning: the address is the page warned about, not the failed HTTPS attempt.
      if (ready && !insecure() && view.getURL() && view.getURL() !== currentUrl()) {
        setCurrentUrl(view.getURL());
        if (!editing) setAddress(view.getURL());
      }
      // A page shown again from the back/forward cache doesn't report its title: browsing history needs it.
      const title = view.getTitle();
      if (ready && title && title !== view.getURL() && !/^file:/i.test(view.getURL()))
        updatePage(props.appId, { title });
      updateHistory();
      keepHistory();
      loaded();
    });
    view.addEventListener("did-fail-load", (e: DidFailLoadEvent) => {
      // The HTTPS version of an http:// page didn't load: the page has none (or a broken one).
      if (e.isMainFrame && upgrading && e.errorCode !== -3) return warn(upgrading.from, upgrading.to);
      // -3 is an aborted load (e.g. a new navigation replaced it): no error.
      const error = e.isMainFrame ? describeLoadError(e.errorCode, e.errorDescription, e.validatedURL) : null;
      if (error) {
        // A new tab whose first page failed may not have had dom-ready yet: the error page needs its id.
        if (contentsId() === null)
          try {
            setContentsId(view.getWebContentsId());
          } catch {}
        setLoadError({ ...error, url: e.validatedURL });
        if (!editing) setAddress(e.validatedURL);
      }
      loaded();
    });
    view.addEventListener("did-navigate", (e) => {
      // A page committed: the HTTPS version loaded, or something else replaced the warning.
      stopUpgrading();
      setInsecure(null);
      committed = true;
      navigated(e.url, false);
      applySiteZoom(props.appId, e.url);
      // A local file is named after itself, like in Chrome (text, images and PDFs have no title of their own).
      if (/^file:/i.test(e.url)) updatePage(props.appId, { title: fileNameOf(e.url) });
    });
    view.addEventListener("found-in-page", (e) => foundInPage(props.appId, e.result));
    view.addEventListener("did-navigate-in-page", (e) => {
      if (!e.isMainFrame) return;
      navigated(e.url, true);
      keepHistory();
    });
    view.addEventListener("page-title-updated", (e: PageTitleUpdatedEvent) => {
      updatePage(props.appId, { title: e.title });
      keepHistory();
    });
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

  // The address bar says when the page isn't secure: shown over plain HTTP (not a local one), or warned about.
  // Plain HTTP, or a certificate that isn't valid (its warning, or a site the user went on to anyway).
  const notSecure = () =>
    !!insecure() ||
    isInsecureUrl(currentUrl()) ||
    loadError()?.kind === "certificate" ||
    isUnsafe(workspaceId, currentUrl());

  // What the sidebar's top bar shows for this tab (components/TopBar.tsx): the address with the page's changes, and the extensions.
  onCleanup(
    registerChrome(props.appId, {
      url: () => address(),
      blank: () => !src() && !starting(),
      icon: addressIcon,
      notSecure,
      canBack: () => history().back,
      canForward: () => history().forward,
      loading,
      back: () => webview?.goBack(),
      forward: () => webview?.goForward(),
      reload: () => {
        const warning = insecure();
        if (warning) open(warning.url);
        else if (crash()) reloadCrashed();
        else webview?.reload();
      },
      stop: () => {
        stopUpgrading();
        webview?.stop();
      },
      go,
      // The site's settings behind its lock (or what the page is using right now: the camera…).
      identity: () => (
        <Show
          when={siteForUrl(currentUrl())}
          fallback={
            <Show when={spinner()} fallback={<Icon name={addressIcon()} size={13} />}>
              <Icon name="loader-circle" size={13} {...stylex.attrs(styles.spinning)} data-address-loading />
            </Show>
          }
        >
          <button
            type="button"
            title={
              siteStatusTitle(contentsId(), currentUrl()) ??
              (notSecure()
                ? "Not secure: see the site's settings, cookies and data"
                : "Site settings: what this site may use and do, its cookies and data")
            }
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSiteMenu(siteMenu() ? undefined : { x: r.left, y: r.bottom + 6 });
            }}
            {...stylex.attrs(
              addressButton.button,
              styles.identity,
              siteMenuOpen() && addressButton.on,
              notSecure() && styles.identityWarning,
              siteLive() && addressButton.badge,
              siteLive() && addressButton.accent,
              siteRefused() && styles.siteRefused,
            )}
            data-site-info-button
            data-site-in-use={siteUsage(contentsId(), currentUrl())?.inUse.join(" ") ?? ""}
            data-site-blocked={siteUsage(contentsId(), currentUrl())?.blocked.join(" ") ?? ""}
          >
            <SiteStatusIcon
              contentsId={contentsId()}
              url={currentUrl()}
              fallback={
                // While the page loads, a spinner in place of its icon (the address bar is the toolbar).
                <Show when={spinner()} fallback={<Icon name={addressIcon()} size={ADDRESS_ICON_SIZE} />}>
                  <Icon
                    name="loader-circle"
                    size={ADDRESS_ICON_SIZE}
                    {...stylex.attrs(styles.spinning)}
                    data-address-loading
                  />
                </Show>
              }
            />
          </button>
        </Show>
      ),
      addressExtras: () => (
        <>
          <ZoomBadge tabId={props.appId} />
          <BookmarkStar tabId={props.appId} url={currentUrl()} />
          <Show when={overridesHere().length}>
            <button
              type="button"
              title={`${overridesHere().length} of this page's responses are changed by the agent: see and remove them`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setOverridesMenu(overridesMenu() ? undefined : { x: r.left, y: r.bottom + 6 });
              }}
              {...stylex.attrs(
                addressButton.button,
                addressButton.badge,
                styles.overrides,
                overridesMenuOpen() && addressButton.on,
              )}
              data-overrides={overridesHere().length}
            >
              <Icon name="flask-conical" size={ADDRESS_ICON_SIZE} />
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
              {...stylex.attrs(
                addressButton.button,
                changesMenuOpen() && addressButton.on,
                overrideActive() && addressButton.accent,
              )}
              data-customized={overrideActive() ? "on" : "off"}
            >
              <Icon name="paintbrush" size={ADDRESS_ICON_SIZE} />
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
              <Show when={!src() && !starting()}>
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
          <PermissionPrompt contentsId={contentsId()} />
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
          <Show when={insecure()} keyed>
            {(warning) => (
              <InsecureWarning url={warning.url} failed={!!warning.attempt} onBack={leave} onContinue={proceed} />
            )}
          </Show>
          <Show when={insecure() ? undefined : loadError()} keyed>
            {(error) => (
              <LoadErrorPage
                error={error}
                url={error.url}
                contentsId={contentsId()}
                onReload={() =>
                  error.kind === "crash" ? reloadCrashed() : webview?.loadURL(error.url).catch(() => {})
                }
                onBack={() => {
                  setLoadError();
                  if (webview?.canGoBack()) webview.goBack();
                  else webview?.loadURL("about:blank").catch(() => {});
                }}
                onProceed={async () => {
                  const id = contentsId();
                  if (id === null || !(await window.rune.web.proceedAnyway(id, error.url))) return;
                  markUnsafe(workspaceId, error.url);
                  webview?.loadURL(error.url).catch(() => {});
                }}
              />
            )}
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
            workspaceId={() => sessionWorkspace(appById(props.appId))}
            onClose={() => setNetworkOpen(false)}
          />
        </Show>
      </div>
      <Show when={siteMenu() && siteForUrl(currentUrl())}>
        {(site) => (
          <SiteInfoPopover
            site={site()}
            workspaceId={workspaceId}
            contentsId={contentsId()}
            url={currentUrl()}
            position={siteMenu()!}
            onReload={() => webview?.reload()}
            onClose={() => setSiteMenu()}
          />
        )}
      </Show>
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

// Sites the user went on to although their certificate isn't valid (main/web.ts remembers it
// for the workspace until Rune Browser quits): the address bar warns while they're open.
const [unsafeSites, setUnsafeSites] = createSignal<string[]>([]);
const siteKey = (workspaceId: string, url: string) => `${workspaceId} ${hostOf(url)}`;
const markUnsafe = (workspaceId: string, url: string) =>
  setUnsafeSites((all) => [...new Set([...all, siteKey(workspaceId, url)])]);
const isUnsafe = (workspaceId: string, url: string) =>
  /^https:/i.test(url) && unsafeSites().includes(siteKey(workspaceId, url));

function StartPage(props: { onGo: (input: string) => boolean }) {
  return (
    <div {...stylex.attrs(styles.start)}>
      <Show when={isPrivate} fallback={<Icon name="globe" size={36} {...stylex.attrs(styles.startIcon)} />}>
        <Icon name="hat-glasses" size={36} {...stylex.attrs(styles.startIcon)} />
        <p {...stylex.attrs(styles.startText, styles.startPrivate)} data-private-start>
          You're in a private window. When you close it, its history, cookies and site data are deleted, and agents
          don't see it. Files you download stay.
        </p>
      </Show>
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

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

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
  // The agent's changes to this page's responses: in the warning color, with their number.
  overrides: {
    backgroundColor: {
      default: `color-mix(in srgb, ${colors.warning} 16%, transparent)`,
      ":hover": `color-mix(in srgb, ${colors.warning} 24%, transparent)`,
    },
    color: { default: colors.warning, ":hover": colors.warning },
  },
  // In place of the address field's icon, at its start.
  // Its icon where the field's icon is when there's no button (TopBar.tsx: the row's 11px padding).
  identity: { marginLeft: -5 },
  identityWarning: { color: { default: colors.warning, ":hover": colors.warning } },
  spinning: {
    color: colors.accent,
    animationName: spin,
    animationDuration: "0.8s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  siteRefused: { color: { default: colors.danger, ":hover": colors.danger } },
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
  startPrivate: { maxWidth: 420, textAlign: "center", lineHeight: 1.5, color: colors.text },
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
