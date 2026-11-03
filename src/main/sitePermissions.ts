// Site permissions in web tabs: Electron asks here whenever a page wants the
// camera, the microphone, location, notifications, screen sharing…, and
// checks here whenever a page looks. They're the site settings' permissions
// (Settings → Browser → Site settings, shared/browser.ts): what a site's
// settings or the default allow or block is answered right away, the rest
// prompts in the tab's window (components/SitePermissions.tsx), which saves
// the answer into the site's settings. A private window's answers are kept
// here only, until the last private window closes. "Allow this time" lasts as
// long as the tab stays on the site.
//
// What a tab uses (camera, microphone, screen, location) comes from hooks in
// its pages (pageHooksScript, over the DevTools protocol's Page domain). They
// are read only while something might be in use, and stopped from the address
// bar. Uses the hooks can't see (cross-origin frames) stay shown until the page
// goes away.
import {
  app,
  desktopCapturer,
  ipcMain,
  shell,
  systemPreferences,
  webContents,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Session,
  type Streams,
  type WebContents,
} from "electron";
import { PRIVATE_WORKSPACE } from "../shared/api";
import {
  fixedPermissionAllowed,
  permissionSettings,
  siteSetting,
  type BrowserSettings,
  type SiteDecision,
  type SiteDefault,
  type SiteSettingKey,
} from "../shared/browser";
import {
  LIVE_KEYS,
  isPermissionKey,
  mediaCheckTypes,
  pageBlockedScript,
  pageClaimDisplayExpression,
  pageHooksScript,
  pageStateExpression,
  pageStopExpression,
  permissionKeys,
  permissionSite,
  promptInfo,
  systemSettingsUrl,
  type LiveKey,
  type PromptAnswer,
  type ScreenPick,
  type ScreenPickRequest,
  type ScreenSource,
  type SitePermissionPrompt,
  type SitePermissionUsage,
  type SystemPermissionNotice,
} from "../shared/sitePermissions";
import * as cdp from "./cdp";
import type { AppWindows } from "./windows";

type Live = LiveKey;
const LIVE = LIVE_KEYS;
const isLive = (key: SiteSettingKey): key is Live => (LIVE as readonly string[]).includes(key);
/** A stream starts a moment after it's allowed; until the page's hooks see it, it counts as in use. */
const GRACE_MS = 4000;
const POLL_MS = 1000;
/** An answer counts until the window's settings with it arrive (they always come right after). */
const RECENT_MS = 10_000;
const ANSWERS: PromptAnswer[] = ["allow", "once", "block", "dismiss"];

interface Tab {
  contents: WebContents;
  /** A private window's tab: its answers are held here, and it doesn't inherit what normal windows allowed. */
  private: boolean;
  /** The site of the page shown ("": not a website). */
  site: string;
  /** "Allow this time", for `site`. */
  once: Set<SiteSettingKey>;
  /** Refused on this page. */
  blocked: Set<SiteSettingKey>;
  /** What the page's hooks counted last. */
  counts: Partial<Record<Live, number>>;
  /** Allowed recently; sticky ones were for frames the hooks can't reach, and stay until the page goes. */
  granted: Map<Live, { at: number; sticky: boolean }>;
  poll?: ReturnType<typeof setInterval>;
  reading: boolean;
  blockedScript?: string;
  blockedSync: Promise<void>;
  lastUsage: string;
  /** Counts the tab's pages, so a read that finishes after a navigation is dropped. */
  page: number;
}

interface Options {
  windows: AppWindows;
  /** The workspace of a web tab session (undefined: not a web tab session). */
  workspaceOf: (s: Session) => string | undefined;
  /** The browser settings in effect (main/browser.ts). */
  settings: () => BrowserSettings;
}

export function setupSitePermissions(options: Options) {
  const { windows } = options;
  /** To the window a page is in. */
  const sendTo = (contents: WebContents, channel: string, ...args: unknown[]) =>
    windows.of(contents)?.webContents.send(channel, ...args);
  const tabs = new Map<number, Tab>();
  /** Answers just given in a normal window, until its settings (it saves them there) arrive. */
  const recent = new Map<string, { decision: SiteDecision; at: number }>();
  /** Private windows' answers, by site: forgotten when the last private window closes. */
  const held = new Map<string, Partial<Record<SiteSettingKey, SiteDecision>>>();

  /**
   * What applies to a site for a permission in a tab: "Allow this time", then a private window's
   * answer, an answer just given, the site's settings, or the default. Private windows don't get what
   * normal ones allowed, only what they blocked (like Chrome's incognito); screen sharing always asks.
   */
  function settingFor(isPrivate: boolean, site: string, key: SiteSettingKey, tab?: Tab): SiteDefault {
    if (tab?.site === site && tab.once.has(key)) return "allow";
    const own = isPrivate ? held.get(site)?.[key] : undefined;
    const answered = recent.get(`${site} ${key}`);
    let value: SiteDefault =
      own ??
      (!isPrivate && answered && Date.now() - answered.at < RECENT_MS ? answered.decision : undefined) ??
      siteSetting(options.settings(), site, key);
    if (isPrivate && !own && value === "allow") value = "ask";
    return key === "screen" && value === "allow" ? "ask" : value;
  }

  const combine = (values: SiteDefault[]): SiteDefault =>
    values.includes("block") ? "block" : values.includes("ask") ? "ask" : "allow";

  const blockedFor = (isPrivate: boolean, site: string) =>
    site ? permissionKeys.filter((k) => settingFor(isPrivate, site, k) === "block") : [...permissionKeys];

  const isPrivateSession = (s: Session) => options.workspaceOf(s) === PRIVATE_WORKSPACE;

  // Private windows' answers go with the last of them.
  app.on("browser-window-created", (_event, win) => {
    win.once("closed", () => {
      if (!windows.all().some((w) => w !== win && !w.isDestroyed() && windows.isPrivate(w))) held.clear();
    });
  });

  // --- Tabs ------------------------------------------------------------------------------

  /** Starts handling a web tab: hooks in its pages, what it uses, its prompts. */
  function track(contents: WebContents) {
    if (tabs.has(contents.id) || contents.isDestroyed()) return;
    const tab: Tab = {
      contents,
      private: isPrivateSession(contents.session),
      site: "",
      once: new Set(),
      blocked: new Set(),
      counts: {},
      granted: new Map(),
      reading: false,
      blockedSync: Promise.resolve(),
      lastUsage: "",
      page: 0,
    };
    tabs.set(contents.id, tab);
    const id = contents.id;
    if (cdp.acquire(contents, "site-permissions")) {
      // The Page domain runs scripts in new documents (the Runtime domain stays off: sites can tell it's on).
      void cdp.send(contents, "Page.enable").catch(() => {});
      void cdp
        .send(contents, "Page.addScriptToEvaluateOnNewDocument", { source: pageHooksScript(), runImmediately: true })
        .catch(() => {});
    }
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) syncBlocked(tab, permissionSite(details.url));
    });
    contents.on("did-redirect-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) syncBlocked(tab, permissionSite(details.url));
    });
    contents.on("did-navigate", (_event, url) => {
      const site = permissionSite(url);
      // A new page: what the old one used and was refused is gone with it; "this time" lasts while on the site.
      if (site !== tab.site) tab.once.clear();
      tab.site = site;
      tab.page++;
      chosen.delete(id);
      tab.blocked.clear();
      tab.counts = {};
      tab.granted.clear();
      stopPolling(tab);
      dismissPrompts(id);
      cancelPicks(id);
      // In case the hooks weren't in yet when the page started (the tab's first page).
      void evaluate(tab, pageHooksScript());
      void evaluate(tab, pageBlockedScript(blockedFor(tab.private, site)));
      report(tab);
    });
    contents.once("destroyed", () => {
      stopPolling(tab);
      tabs.delete(id);
      chosen.delete(id);
      dismissPrompts(id);
      cancelPicks(id);
    });
  }

  const evaluate = <T>(tab: Tab, expression: string) =>
    tab.contents.isDestroyed() || !tab.contents.debugger.isAttached()
      ? Promise.resolve(null)
      : cdp
          .send<{ result?: { value?: T } }>(tab.contents, "Runtime.evaluate", { expression, returnByValue: true })
          .then((r) => r.result?.value ?? null)
          .catch(() => null);

  /** The blocked list the next page of the tab (on `origin`) starts with. */
  function syncBlocked(tab: Tab, site: string) {
    if (tab.contents.isDestroyed() || !tab.contents.debugger.isAttached()) return;
    const source = pageBlockedScript(blockedFor(tab.private, site));
    // One after the other, so a quick second navigation doesn't leave the first one's script behind.
    tab.blockedSync = tab.blockedSync.then(async () => {
      if (tab.contents.isDestroyed()) return;
      const previous = tab.blockedScript;
      tab.blockedScript = undefined;
      if (previous)
        await cdp
          .send(tab.contents, "Page.removeScriptToEvaluateOnNewDocument", { identifier: previous })
          .catch(() => {});
      const added = await cdp
        .send<{ identifier: string }>(tab.contents, "Page.addScriptToEvaluateOnNewDocument", { source })
        .catch(() => null);
      tab.blockedScript = added?.identifier;
    });
  }

  const inUse = (tab: Tab) => LIVE.filter((k) => (tab.counts[k] ?? 0) > 0 || tab.granted.has(k));

  function usageOf(tab: Tab): SitePermissionUsage {
    return {
      contentsId: tab.contents.id,
      site: tab.site,
      inUse: inUse(tab),
      blocked: [...tab.blocked],
      once: [...tab.once],
      held: tab.private ? { ...held.get(tab.site) } : {},
    };
  }

  /** Tells the window when what the tab uses or was refused changed. */
  function report(tab: Tab) {
    const usage = usageOf(tab);
    const json = JSON.stringify(usage);
    if (json === tab.lastUsage) return;
    tab.lastUsage = json;
    sendTo(tab.contents, "rune:site-permission-usage", usage);
  }

  /** Something was just allowed that the page may now be using. */
  function started(tab: Tab, kinds: SiteSettingKey[], sticky: boolean) {
    if (tab.contents.isDestroyed()) return;
    for (const kind of kinds) if (isLive(kind)) tab.granted.set(kind, { at: Date.now(), sticky });
    report(tab);
    watchUsage(tab);
  }

  function watchUsage(tab: Tab) {
    if (tab.poll) return;
    tab.poll = setInterval(() => void readUsage(tab), POLL_MS);
    setTimeout(() => void readUsage(tab), 300);
  }

  function stopPolling(tab: Tab) {
    if (tab.poll) clearInterval(tab.poll);
    tab.poll = undefined;
  }

  async function readUsage(tab: Tab) {
    if (tab.contents.isDestroyed()) return stopPolling(tab);
    if (tab.reading) return;
    const page = tab.page;
    tab.reading = true;
    const counts = await evaluate<Partial<Record<Live, number>>>(tab, pageStateExpression);
    tab.reading = false;
    if (tab.contents.isDestroyed()) return stopPolling(tab);
    // The tab moved on meanwhile: that was the old page.
    if (page !== tab.page) return;
    if (counts) {
      tab.counts = counts;
      // The hooks see it now, or it's been long enough that they would have.
      for (const [kind, grant] of tab.granted)
        if (!grant.sticky && ((counts[kind] ?? 0) > 0 || Date.now() - grant.at > GRACE_MS)) tab.granted.delete(kind);
    }
    report(tab);
    // Nothing to watch anymore; without the page's hooks (no DevTools connection), the grants stay until the page goes.
    // Grants for frames out of reach change nothing by being read again.
    const settled =
      counts && LIVE.every((k) => !((counts[k] ?? 0) > 0)) && [...tab.granted.values()].every((g) => g.sticky);
    if (settled || tab.contents.isDestroyed() || !tab.contents.debugger.isAttached()) stopPolling(tab);
  }

  /** The user stops what a tab uses (the address bar). */
  async function stop(tab: Tab, kinds: SiteSettingKey[]) {
    // A frame of another site (out of the hooks' reach) only stops with the page: reload it.
    if (kinds.some((k) => isLive(k) && tab.granted.get(k)?.sticky)) {
      for (const kind of kinds) tab.once.delete(kind);
      if (!tab.contents.isDestroyed()) tab.contents.reload();
      return;
    }
    await evaluate(tab, pageStopExpression(kinds));
    for (const kind of kinds) {
      tab.once.delete(kind);
      if (isLive(kind)) tab.granted.delete(kind);
    }
    await readUsage(tab);
    report(tab);
  }

  // --- Prompts ------------------------------------------------------------------------------

  const pending = new Map<string, { prompt: SitePermissionPrompt; waiters: ((answer: PromptAnswer) => void)[] }>();
  let promptIds = 0;

  function ask(tab: Tab, site: string, keys: SiteSettingKey[]): Promise<PromptAnswer> {
    if (!windows.of(tab.contents)) return Promise.resolve("dismiss");
    // The page asking again while it waits (or for part of it) joins the prompt on screen.
    for (const p of pending.values()) {
      if (
        p.prompt.contentsId === tab.contents.id &&
        p.prompt.site === site &&
        keys.every((k) => p.prompt.keys.includes(k))
      )
        return new Promise((resolve) => p.waiters.push(resolve));
    }
    const prompt: SitePermissionPrompt = {
      requestId: String(++promptIds),
      contentsId: tab.contents.id,
      site,
      keys,
      private: tab.private,
    };
    return new Promise((resolve) => {
      pending.set(prompt.requestId, { prompt, waiters: [resolve] });
      sendTo(tab.contents, "rune:site-permission-prompt", prompt);
    });
  }

  function answer(requestId: string, value: PromptAnswer) {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    // To every window: the tab may have moved to another one meanwhile.
    windows.broadcast("rune:site-permission-prompt-done", requestId);
    const { prompt } = p;
    const tab = tabs.get(prompt.contentsId);
    if (value === "allow" || value === "block") {
      // Screen sharing is never allowed for good: it always asks with the picker.
      const keys = prompt.keys.filter((k) => value === "block" || k !== "screen");
      for (const key of keys) {
        if (prompt.private) held.set(prompt.site, { ...held.get(prompt.site), [key]: value });
        else recent.set(`${prompt.site} ${key}`, { decision: value, at: Date.now() });
      }
      settingsChanged(prompt.site);
    } else if (value === "once" && tab && tab.site === prompt.site) {
      for (const key of prompt.keys) if (promptInfo(key).once) tab.once.add(key);
      report(tab);
    }
    for (const waiter of p.waiters) waiter(value);
  }

  /** The page went away: its prompts go with it. */
  function dismissPrompts(contentsId: number) {
    for (const [requestId, p] of [...pending]) if (p.prompt.contentsId === contentsId) answer(requestId, "dismiss");
  }

  // --- Requests and checks ------------------------------------------------------------------

  /** The operating system lets Rune Browser use the camera or microphone (macOS asks the first time). */
  async function systemAllows(tab: Tab, kind: "camera" | "microphone") {
    if (process.platform !== "darwin" && process.platform !== "win32") return true;
    let status = systemPreferences.getMediaAccessStatus(kind);
    if (status === "not-determined" && process.platform === "darwin")
      status = (await systemPreferences.askForMediaAccess(kind)) ? "granted" : "denied";
    if (status !== "denied" && status !== "restricted") return true;
    notice(tab, kind);
    return false;
  }

  function notice(tab: Tab, kind: SystemPermissionNotice["kind"]) {
    sendTo(tab.contents, "rune:site-permission-notice", {
      contentsId: tab.contents.id,
      kind,
      where: process.platform === "darwin" ? "System Settings" : "Settings",
    } satisfies SystemPermissionNotice);
  }

  async function request(
    s: Session,
    contents: WebContents,
    permission: string,
    details: Electron.PermissionRequest & { mediaTypes?: ("video" | "audio")[] },
  ): Promise<boolean> {
    const kinds = permissionSettings(permission, details.mediaTypes);
    if (!kinds) return fixedPermissionAllowed(permission);
    // Permissions belong to the site in the address bar, also when a frame in it asks (Chromium's delegation).
    const origin = permissionSite(contents.getURL());
    const tab = tabs.get(contents.id);
    if (!origin || options.workspaceOf(s) === undefined || !tab) return false;
    const settings = kinds.map((k) => settingFor(tab.private, origin, k, tab));
    const refused = kinds.filter((_, i) => settings[i] === "block");
    if (refused.length) {
      for (const kind of refused) tab.blocked.add(kind);
      report(tab);
      return false;
    }
    // Screen sharing asks with its picker, for a getDisplayMedia call the page really has waiting (Electron asks the
    // same for getUserMedia with a desktop source, which would share whatever screen or window the page names).
    if (permission === "display-capture")
      return (
        (await evaluate<boolean>(tab, pageClaimDisplayExpression)) === true &&
        askScreen(s, tab, origin, !!details.mediaTypes?.includes("audio"))
      );
    const undecided = kinds.filter((_, i) => settings[i] === "ask");
    if (undecided.length) {
      const reply = await ask(tab, origin, undecided);
      if (reply === "block") {
        for (const kind of undecided) tab.blocked.add(kind);
        report(tab);
      }
      if (reply !== "allow" && reply !== "once") return false;
      // The tab moved on while the user decided.
      if (contents.isDestroyed() || permissionSite(contents.getURL()) !== origin) return false;
    }
    for (const kind of kinds)
      if ((kind === "camera" || kind === "microphone") && !(await systemAllows(tab, kind))) return false;
    // Frames of another site are out of the hooks' reach: what they use shows until the page goes.
    started(tab, kinds, !details.isMainFrame && permissionSite(details.requestingUrl) !== origin);
    return true;
  }

  function check(
    s: Session,
    contents: WebContents | null,
    permission: string,
    requestingOrigin: string,
    details: Electron.PermissionCheckHandlerHandlerDetails,
  ): boolean {
    const kinds = permissionSettings(permission, permission === "media" ? mediaCheckTypes(details.mediaType) : []);
    if (!kinds) return fixedPermissionAllowed(permission);
    // Screen sharing is never allowed beforehand: it always goes through the picker.
    if (permission === "display-capture") return false;
    const live = contents && !contents.isDestroyed() ? contents : null;
    const site = permissionSite(live ? live.getURL() : (details.embeddingOrigin ?? requestingOrigin));
    if (!site || options.workspaceOf(s) === undefined) return false;
    const tab = live ? tabs.get(live.id) : undefined;
    const allowed = combine(kinds.map((k) => settingFor(isPrivateSession(s), site, k, tab))) === "allow";
    // Location is read without asking once it's allowed: watch for it.
    if (allowed && tab && kinds.includes("location")) watchUsage(tab);
    return allowed;
  }

  // --- Screen sharing -----------------------------------------------------------------------

  const picks = new Map<string, { contentsId: number; resolve: (pick: ScreenPick | null) => void }>();
  let pickIds = 0;
  const cancelPicks = (contentsId: number) => {
    for (const [id, p] of [...picks]) if (p.contentsId === contentsId) answerPick(id, null);
  };
  function answerPick(requestId: string, pick: ScreenPick | null) {
    const p = picks.get(requestId);
    if (!p) return;
    picks.delete(requestId);
    windows.broadcast("rune:screen-pick-done", requestId);
    p.resolve(pick);
  }

  /** Wayland: the system's picker chooses (desktopCapturer opens it), so Rune Browser only asks whether to. */
  const systemPicker = () => {
    if (process.platform !== "linux") return false;
    const ozone = app.commandLine.getSwitchValue("ozone-platform");
    return ozone === "wayland" || (!ozone && process.env.XDG_SESSION_TYPE === "wayland");
  };

  const withTimeout = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

  async function screenSources(
    s: Session,
  ): Promise<{ sources: ScreenSource[]; error?: string; desktop: Electron.DesktopCapturerSource[] }> {
    let desktop: Electron.DesktopCapturerSource[] = [];
    let error: string | undefined;
    try {
      desktop = await withTimeout(
        desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }),
        10_000,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // The workspace's web tabs can be shared too, like Chrome's tabs.
    const pages = webContents
      .getAllWebContents()
      .filter((c) => c.getType() === "webview" && c.session === s && !c.isDestroyed() && permissionSite(c.getURL()));
    const tabSources = await Promise.all(
      pages.map(async (c): Promise<ScreenSource | null> => {
        // Named before the capture: a tab closing meanwhile only drops itself.
        const name = c.getTitle() || c.getURL();
        const image = await withTimeout(c.capturePage(), 3000).catch(() => null);
        if (c.isDestroyed()) return null;
        return {
          id: `tab:${c.id}`,
          name,
          type: "tab",
          thumbnail: image && !image.isEmpty() ? image.resize({ width: 320 }).toDataURL() : "",
        };
      }),
    ).then((list) => list.filter((source) => source !== null));
    return {
      desktop,
      error,
      sources: [
        ...desktop.map((d): ScreenSource => ({
          id: d.id,
          name: d.name,
          type: d.id.startsWith("screen:") ? "screen" : "window",
          thumbnail: d.thumbnail.isEmpty() ? "" : d.thumbnail.toDataURL(),
        })),
        ...tabSources,
      ],
    };
  }

  /** What the user picked to share, until the page's getDisplayMedia gets it (by tab). */
  const chosen = new Map<number, { pick: ScreenPick; desktop: Electron.DesktopCapturerSource[]; portal: boolean }>();

  /**
   * The picker, when the page asks for the permission (so cancelling refuses it, like in Chromium);
   * false if nothing was picked.
   */
  async function askScreen(s: Session, tab: Tab, site: string, audio: boolean): Promise<boolean> {
    if (!windows.of(tab.contents)) return false;
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
      notice(tab, "screen");
      return false;
    }
    const contents = tab.contents;
    const portal = systemPicker();
    const found: { sources: ScreenSource[]; desktop: Electron.DesktopCapturerSource[]; error?: string } = portal
      ? { sources: [], desktop: [] }
      : await screenSources(s);
    if (contents.isDestroyed() || permissionSite(contents.getURL()) !== site) return false;
    const requestId = String(++pickIds);
    const pick = await new Promise<ScreenPick | null>((resolve) => {
      picks.set(requestId, { contentsId: contents.id, resolve });
      sendTo(contents, "rune:screen-pick", {
        requestId,
        contentsId: contents.id,
        site,
        sources: found.sources,
        audio,
        systemPicker: portal,
        ...(found.error ? { error: found.error } : {}),
      } satisfies ScreenPickRequest);
    });
    if (!pick || contents.isDestroyed() || permissionSite(contents.getURL()) !== site) return false;
    // Only something the picker offered.
    if (!portal && !found.sources.some((source) => source.id === pick.sourceId)) return false;
    chosen.set(contents.id, { pick, desktop: found.desktop, portal });
    return true;
  }

  /** The page's getDisplayMedia, after its permission: shares what was picked. */
  async function pickScreen(s: Session, request: DisplayMediaRequestHandlerHandlerRequest): Promise<Streams | null> {
    const contents = request.frame ? webContents.fromFrame(request.frame) : undefined;
    const tab = contents ? tabs.get(contents.id) : undefined;
    const origin = contents ? permissionSite(contents.getURL()) : "";
    if (!contents || !tab || !origin) return null;
    if (!chosen.has(contents.id) && !(await askScreen(s, tab, origin, request.audioRequested))) return null;
    const { pick, desktop, portal } = chosen.get(contents.id)!;
    chosen.delete(contents.id);
    // Electron throws when answering a frame that's gone.
    if (contents.isDestroyed() || request.frame?.isDestroyed()) return null;
    let streams: Streams | null = null;
    if (portal) {
      // The system's picker shows now; it returns what the user chose there.
      const fromPortal = await desktopCapturer.getSources({ types: ["screen", "window"] }).catch(() => []);
      if (fromPortal[0]) streams = { video: fromPortal[0] };
    } else if (pick.sourceId.startsWith("tab:")) {
      const shared = webContents.fromId(Number(pick.sourceId.slice(4)));
      if (shared && !shared.isDestroyed() && shared.getType() === "webview" && shared.session === s)
        streams = {
          video: shared.mainFrame,
          ...(pick.audio && request.audioRequested ? { audio: shared.mainFrame } : {}),
        };
    } else {
      const source = desktop.find((d) => d.id === pick.sourceId);
      // System audio can only be shared on Windows.
      if (source)
        streams = {
          video: source,
          ...(pick.audio && request.audioRequested && process.platform === "win32"
            ? { audio: "loopback" as const }
            : {}),
        };
    }
    // A frame of another site shares out of the hooks' reach: shown until the page goes.
    const frame = request.frame;
    if (streams) started(tab, ["screen"], !!frame?.parent && permissionSite(frame.url) !== origin);
    return streams;
  }

  // --- Settings -----------------------------------------------------------------------------

  /** Sites' settings changed (or one was just answered): open pages see the new blocked list, and stop what's now blocked. */
  function settingsChanged(site: string | null) {
    for (const tab of tabs.values()) {
      if (site !== null && tab.site !== site) continue;
      const blocked = blockedFor(tab.private, tab.site);
      void evaluate(tab, pageBlockedScript(blocked));
      syncBlocked(tab, tab.site);
      const nowBlocked = inUse(tab).filter((k) => blocked.includes(k));
      if (nowBlocked.length) void stop(tab, nowBlocked);
    }
  }

  /** The tab, when the message comes from the window it's in. */
  const tabFor = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, contentsId: unknown) => {
    const tab = typeof contentsId === "number" ? tabs.get(contentsId) : undefined;
    return tab && windows.of(tab.contents)?.webContents === event.sender ? tab : undefined;
  };

  ipcMain.handle("rune:site-permissions-pending", (event) =>
    [...pending.values()].map((p) => p.prompt).filter((prompt) => tabFor(event, prompt.contentsId)),
  );
  ipcMain.handle("rune:site-permissions-usage", (event, contentsId: unknown) => {
    const tab = tabFor(event, contentsId);
    return tab ? usageOf(tab) : null;
  });
  ipcMain.on("rune:site-permissions-reply", (event, requestId: unknown, value: unknown) => {
    const p = typeof requestId === "string" ? pending.get(requestId) : undefined;
    if (p && tabFor(event, p.prompt.contentsId) && ANSWERS.includes(value as PromptAnswer))
      answer(requestId as string, value as PromptAnswer);
  });
  ipcMain.handle("rune:site-permissions-stop", async (event, contentsId: unknown, kinds: unknown) => {
    const tab = tabFor(event, contentsId);
    if (!tab || !Array.isArray(kinds)) return;
    await stop(tab, kinds.filter(isPermissionKey));
  });
  ipcMain.on("rune:screen-pick-reply", (event, requestId: unknown, pick: unknown) => {
    const p = typeof requestId === "string" ? picks.get(requestId) : undefined;
    if (!p || !tabFor(event, p.contentsId)) return;
    const v = pick as { sourceId?: unknown; audio?: unknown } | null;
    answerPick(
      requestId as string,
      v && typeof v.sourceId === "string" ? { sourceId: v.sourceId, audio: v.audio === true } : null,
    );
  });
  ipcMain.on("rune:site-permissions-system-settings", (event, kind: unknown) => {
    if (!windows.isUi(event.sender) || !["camera", "microphone", "screen", "location"].includes(kind as string)) return;
    const url = systemSettingsUrl(process.platform, kind as SystemPermissionNotice["kind"]);
    if (url) void shell.openExternal(url);
  });

  return {
    track,
    /** For a web tab session's permission requests. */
    request: (s: Session, contents: WebContents, permission: string, details: Electron.PermissionRequest) =>
      request(s, contents, permission, details).catch((err) => {
        console.warn("A site's permission request failed:", err);
        return false;
      }),
    check,
    /** For a web tab session's getDisplayMedia. */
    pickScreen: (s: Session, req: DisplayMediaRequestHandlerHandlerRequest) =>
      pickScreen(s, req).catch((err) => {
        console.warn("Screen sharing failed:", err);
        return null;
      }),
    /** The browser settings' sites or defaults changed: answers just given are in them now. */
    sitesChanged() {
      recent.clear();
      settingsChanged(null);
    },
  };
}
