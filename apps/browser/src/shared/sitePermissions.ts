// Site permission prompts in web tabs: what's asked (the permissions among
// the site settings, shared/browser.ts), what the main process and the window
// say to each other about it (main/sitePermissions.ts decides, the window
// asks: components/SitePermissions.tsx), and the script in pages that makes
// them see what Chromium would and tells what they use.
import { siteOf, siteSettingKeys, siteSettings, type SiteSettingKey } from "./browser";

/** How a permission is asked for and shown, besides its site setting. */
export interface PromptInfo {
  /** Crossed out: blocked on the page. */
  offIcon?: string;
  /** Offered as "Allow this time" (not for notifications, which arrive after the page is gone, or screen sharing). */
  once: boolean;
  /** Something a page uses for a while: shown in the address bar while it does, and stoppable. */
  live?: boolean;
}

const prompts: Partial<Record<SiteSettingKey, Partial<PromptInfo>>> = {
  camera: { offIcon: "camera-off", live: true },
  microphone: { offIcon: "mic-off", live: true },
  location: { offIcon: "map-pin-off", live: true },
  notifications: { offIcon: "bell-off", once: false },
  screen: { offIcon: "monitor-off", once: false, live: true },
};

export const promptInfo = (key: SiteSettingKey): PromptInfo => ({ once: true, ...prompts[key] });

/** The site settings sites ask for (the others, JavaScript, images and sound, are content settings). */
export const permissionKeys = siteSettingKeys.filter((k) => siteSettings[k].kind === "permission");

/** What a page uses for a while (camera, microphone, location, screen sharing). */
export const LIVE_KEYS = ["camera", "microphone", "screen", "location"] as const satisfies readonly SiteSettingKey[];
export type LiveKey = (typeof LIVE_KEYS)[number];

export const isPermissionKey = (value: unknown): value is SiteSettingKey =>
  typeof value === "string" && (permissionKeys as string[]).includes(value);

/** The site a page's permissions belong to (like its site settings: the host without "www."), or "" when it's not a website. */
export function permissionSite(url: string | null | undefined) {
  try {
    const u = new URL(url ?? "");
    return /^https?:$/.test(u.protocol) ? siteOf(u.hostname) : "";
  } catch {
    return "";
  }
}

/** A media check names one type ("video", "audio" or "unknown"). */
export const mediaCheckTypes = (mediaType: string | undefined) =>
  mediaType === "video" || mediaType === "audio" ? [mediaType] : [];

/** "Use your camera and microphone", "See where you are". */
export function promptText(keys: readonly SiteSettingKey[]) {
  if (keys.length === 2 && keys.includes("camera") && keys.includes("microphone"))
    return "Use your camera and microphone";
  return keys.map((k) => siteSettings[k].about).join(", ");
}

// --- Between the main process and the window ----------------------------------------------

/** A site asks for something the user hasn't decided yet. */
export interface SitePermissionPrompt {
  requestId: string;
  /** The web tab's webContents. */
  contentsId: number;
  site: string;
  keys: SiteSettingKey[];
  /** In a private window: what's chosen lasts until the private windows close. */
  private: boolean;
}

export type PromptAnswer = "allow" | "once" | "block" | "dismiss";

/** What a tab's page is doing with its permissions, for the address bar. */
export interface SitePermissionUsage {
  contentsId: number;
  site: string;
  /** In use right now (camera, microphone, location, screen sharing). */
  inUse: LiveKey[];
  /** Asked for and refused on this page. */
  blocked: SiteSettingKey[];
  /** Allowed only for this visit ("Allow this time"). */
  once: SiteSettingKey[];
  /** Chosen in a private window: kept until the private windows close. */
  held: Partial<Record<SiteSettingKey, "allow" | "block">>;
}

/** The operating system hasn't given Rune Browser access to a device. */
export interface SystemPermissionNotice {
  contentsId: number;
  kind: "camera" | "microphone" | "screen" | "location";
  /** The OS's name for where to allow it ("System Settings"). */
  where: string;
}

/** Something to share in the screen picker. */
export interface ScreenSource {
  id: string;
  name: string;
  type: "screen" | "window" | "tab";
  /** A data: URL ("" when there's none). */
  thumbnail: string;
}

export interface ScreenPickRequest {
  requestId: string;
  contentsId: number;
  site: string;
  sources: ScreenSource[];
  audio: boolean;
  /** The system's own picker comes next (Wayland): the list has just that entry. */
  systemPicker: boolean;
  /** Getting the sources failed. */
  error?: string;
}

export interface ScreenPick {
  sourceId: string;
  audio: boolean;
}

// --- In the page ------------------------------------------------------------------------

/** The page's global its hooks hang off (main world; harmless if the page calls it, it only touches its own state). */
export const PAGE_HOOK = "rune.sitePermissions";

/** Permissions API names → settings, for what `navigator.permissions.query` reports. */
const queryNames: Record<string, SiteSettingKey> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "location",
  notifications: "notifications",
  push: "notifications",
  "display-capture": "screen",
  "clipboard-read": "clipboard",
  midi: "midi",
  "idle-detection": "idle",
  "window-management": "windows",
  "local-fonts": "fonts",
  "storage-access": "storage",
  "local-network-access": "localNetwork",
  "speaker-selection": "microphone",
};

/**
 * Runs in every page of a web tab (main world, before the page's scripts), for
 * two things Electron doesn't do:
 *
 * - **Ask vs. blocked.** Electron's permission checks only say yes or no, so a
 *   page would see "denied" for everything it hasn't been allowed yet, and many
 *   sites then never ask. Here what's not blocked reads as "prompt" (and
 *   `Notification.permission` as "default"), like in Chromium.
 * - **In use.** It keeps the camera, microphone and screen tracks the page got,
 *   and its location watches, so the address bar can show what's in use (the
 *   main process reads it while something might be) and the user can stop it.
 */
export function pageHooksScript() {
  return `(() => {
  const KEY = Symbol.for(${JSON.stringify(PAGE_HOOK)});
  if (globalThis[KEY]) return;
  const queryNames = ${JSON.stringify(queryNames)};
  let blocked = new Set();
  // The platform's own functions, taken before the page runs: a page overriding them can't hide what it uses.
  const mst = globalThis.MediaStreamTrack && MediaStreamTrack.prototype;
  const ms = globalThis.MediaStream && MediaStream.prototype;
  const getter = (proto, name) => (proto && Object.getOwnPropertyDescriptor(proto, name)?.get) || null;
  const readyStateOf = getter(mst, "readyState");
  const kindOf = getter(mst, "kind");
  const getTracks = ms && ms.getTracks;
  const tracksOf = (stream) => (getTracks ? getTracks.call(stream) : stream.getTracks());
  const stateOf = (track) => (readyStateOf ? readyStateOf.call(track) : track.readyState);
  const trackKind = (track) => (kindOf ? kindOf.call(track) : track.kind);
  // Weakly: a track the page lets go of is collected (and its device let go) as without the hooks.
  const tracks = new Set();
  const kinds = new WeakMap();
  const watches = new Set();
  let reading = 0;
  const keep = (track, kind) => { kinds.set(track, kind); tracks.add(new WeakRef(track)); };
  const trackKinds = (stream, screen) => {
    for (const track of tracksOf(stream)) keep(track, screen ? "screen" : trackKind(track) === "video" ? "camera" : "microphone");
    return stream;
  };
  const live = () => {
    const out = [];
    for (const ref of tracks) {
      const track = ref.deref();
      if (!track || stateOf(track) === "ended" || !kinds.has(track)) tracks.delete(ref);
      else out.push([track, kinds.get(track)]);
    }
    return out;
  };
  // getUserMedia with Chrome's desktop and tab sources would share whatever screen or window the page names
  // (Electron asks for them like for getDisplayMedia): refused, as Chrome refuses them to web pages. The check runs
  // on a plain copy, which is what goes on, so getters can't answer differently the second time.
  const refusal = () => new DOMException("Screen sharing goes through getDisplayMedia", "NotAllowedError");
  const desktopSource = (c) => !!c && typeof c === "object" && ["video", "audio"].some((k) => {
    const t = c[k];
    if (!t || typeof t !== "object") return false;
    const all = [t, t.mandatory, ...(Array.isArray(t.optional) ? t.optional : []), ...(Array.isArray(t.advanced) ? t.advanced : [])];
    return all.some((o) => o && typeof o === "object" && ("chromeMediaSource" in o || "chromeMediaSourceId" in o));
  });
  const md = globalThis.MediaDevices && MediaDevices.prototype;
  if (md && md.getUserMedia) {
    const getUserMedia = md.getUserMedia;
    md.getUserMedia = function (constraints, ...rest) {
      let plain;
      try { plain = constraints === undefined ? undefined : structuredClone(constraints); } catch { return Promise.reject(new TypeError("Invalid constraints")); }
      if (desktopSource(plain)) return Promise.reject(refusal());
      return getUserMedia.call(this, plain, ...rest).then((s) => trackKinds(s, false));
    };
    // The old callback versions go the same way.
    const nav = globalThis.Navigator && Navigator.prototype;
    for (const name of ["getUserMedia", "webkitGetUserMedia"]) {
      if (!nav || typeof nav[name] !== "function") continue;
      nav[name] = function (constraints, ok, fail) {
        md.getUserMedia.call(this.mediaDevices, constraints).then(
          (s) => { if (typeof ok === "function") ok(s); },
          (e) => { if (typeof fail === "function") fail(e); },
        );
      };
    }
  }
  // getDisplayMedia calls waiting for their answer: the main process only shows its picker for one of them.
  const displayCalls = new Set();
  const unclaimed = new Set();
  if (md && md.getDisplayMedia) {
    const getDisplayMedia = md.getDisplayMedia;
    md.getDisplayMedia = function (...args) {
      const call = {};
      displayCalls.add(call);
      unclaimed.add(call);
      const done = () => { displayCalls.delete(call); unclaimed.delete(call); };
      let promise;
      try { promise = getDisplayMedia.apply(this, args); } catch (e) { done(); throw e; }
      return promise.then((s) => { done(); return trackKinds(s, true); }, (e) => { done(); throw e; });
    };
  }
  const stopTrack = mst && mst.stop;
  if (mst) {
    const clone = mst.clone;
    mst.stop = function () { kinds.delete(this); return stopTrack.call(this); };
    mst.clone = function () { const copy = clone.call(this); if (kinds.has(this)) keep(copy, kinds.get(this)); return copy; };
  }
  if (ms && ms.clone) {
    const clone = ms.clone;
    ms.clone = function () {
      const copy = clone.call(this);
      const from = tracksOf(this);
      tracksOf(copy).forEach((track, i) => { if (from[i] && kinds.has(from[i])) keep(track, kinds.get(from[i])); });
      return copy;
    };
  }
  const geo = globalThis.Geolocation && Geolocation.prototype;
  const clearWatch = geo && geo.clearWatch;
  if (geo) {
    const watchPosition = geo.watchPosition;
    const getCurrentPosition = geo.getCurrentPosition;
    geo.watchPosition = function (...args) { const id = watchPosition.apply(this, args); watches.add(id); return id; };
    geo.clearWatch = function (id) { watches.delete(id); return clearWatch.call(this, id); };
    geo.getCurrentPosition = function (ok, fail, options) {
      reading++;
      let done = false;
      const end = () => { if (!done) { done = true; reading--; } };
      setTimeout(end, 30000);
      return getCurrentPosition.call(
        this,
        (p) => { end(); if (typeof ok === "function") ok(p); },
        (e) => { end(); if (typeof fail === "function") fail(e); },
        options,
      );
    };
  }
  const ownState = () => {
    const counts = { camera: 0, microphone: 0, screen: 0, location: watches.size + reading };
    for (const [, kind] of live()) counts[kind]++;
    return counts;
  };
  const stopOwn = (which) => {
    for (const [track, kind] of live()) {
      if (!which.includes(kind)) continue;
      kinds.delete(track);
      stopTrack ? stopTrack.call(track) : track.stop();
      // Like when the device goes away, so the page notices.
      track.dispatchEvent(new Event("ended"));
    }
    if (which.includes("location") && clearWatch) {
      for (const id of watches) clearWatch.call(navigator.geolocation, id);
      watches.clear();
    }
  };
  /** This frame and its same-origin frames (cross-origin ones can't be reached from here). */
  const eachFrame = (fn) => {
    const visit = (win) => {
      try {
        const hook = win[KEY];
        if (hook) fn(hook);
      } catch {}
      for (let i = 0; i < win.frames.length; i++) {
        try { visit(win.frames[i]); } catch {}
      }
    };
    visit(globalThis);
  };
  const N = globalThis.Notification;
  if (N) {
    const desc = Object.getOwnPropertyDescriptor(N, "permission");
    if (desc && desc.get) {
      const get = desc.get;
      Object.defineProperty(N, "permission", { ...desc, get() { const v = get.call(this); return v === "denied" && !blocked.has("notifications") ? "default" : v; } });
    }
  }
  const perms = globalThis.Permissions && Permissions.prototype;
  const ps = globalThis.PermissionStatus && PermissionStatus.prototype;
  const stateGet = ps && Object.getOwnPropertyDescriptor(ps, "state")?.get;
  if (perms && perms.query && stateGet) {
    const query = perms.query;
    perms.query = function (descriptor, ...rest) {
      return query.call(this, descriptor, ...rest).then((status) => {
        const kind = descriptor && queryNames[descriptor.name];
        if (kind) Object.defineProperty(status, "state", { configurable: true, get() { const v = stateGet.call(this); return v === "denied" && !blocked.has(kind) ? "prompt" : v; } });
        return status;
      });
    };
  }
  Object.defineProperty(globalThis, KEY, {
    value: (command, arg) => {
      if (command === "blocked") { blocked = new Set(arg); return; }
      if (command === "state") {
        const total = { camera: 0, microphone: 0, screen: 0, location: 0 };
        // Frames only add (a page can't cancel out what its other frames use).
        eachFrame((hook) => { const s = hook("own") || {}; for (const k in total) total[k] += Math.max(0, Number(s[k]) || 0); });
        return total;
      }
      if (command === "own") return ownState();
      if (command === "stop") return eachFrame((hook) => hook("stopOwn", arg));
      if (command === "stopOwn") return stopOwn(arg);
      if (command === "claimDisplay") {
        let claimed = false;
        eachFrame((hook) => { if (!claimed) claimed = hook("claimOwn") === true; });
        return claimed;
      }
      if (command === "claimOwn") {
        const call = unclaimed.values().next().value;
        if (!call) return false;
        unclaimed.delete(call);
        return true;
      }
    },
  });
})();`;
}

/** Tells the page which permissions are blocked for it (the rest read as "prompt" until allowed). */
export const pageBlockedScript = (blocked: readonly SiteSettingKey[]) =>
  `globalThis[Symbol.for(${JSON.stringify(PAGE_HOOK)})]?.("blocked", ${JSON.stringify(blocked)});`;

/** Reads what the page uses: { camera, microphone, screen, location } counts. */
export const pageStateExpression = `globalThis[Symbol.for(${JSON.stringify(PAGE_HOOK)})]?.("state") ?? null`;

/** Stops the page's tracks or location watches of these kinds. */
export const pageStopExpression = (kinds: readonly SiteSettingKey[]) =>
  `globalThis[Symbol.for(${JSON.stringify(PAGE_HOOK)})]?.("stop", ${JSON.stringify(kinds)})`;

/** Takes one of the page's waiting getDisplayMedia calls (true), so a screen permission request is really one. */
export const pageClaimDisplayExpression = `globalThis[Symbol.for(${JSON.stringify(PAGE_HOOK)})]?.("claimDisplay") === true`;

/** Where each OS lets apps use a device, when it hasn't given Rune Browser access. */
export function systemSettingsUrl(platform: string, kind: SystemPermissionNotice["kind"]): string | null {
  if (platform === "darwin") {
    const pane = {
      camera: "Privacy_Camera",
      microphone: "Privacy_Microphone",
      screen: "Privacy_ScreenCapture",
      location: "Privacy_LocationServices",
    }[kind];
    return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
  }
  if (platform === "win32") {
    return {
      camera: "ms-settings:privacy-webcam",
      microphone: "ms-settings:privacy-microphone",
      screen: null,
      location: "ms-settings:privacy-location",
    }[kind];
  }
  return null;
}
