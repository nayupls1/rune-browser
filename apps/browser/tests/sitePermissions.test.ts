import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import tags from "lucide-static/tags.json";
import { siteSettings } from "../src/shared/browser";
import {
  LIVE_KEYS,
  mediaCheckTypes,
  pageBlockedScript,
  pageClaimDisplayExpression,
  pageHooksScript,
  pageStateExpression,
  pageStopExpression,
  permissionKeys,
  permissionSite,
  promptInfo,
  promptText,
  systemSettingsUrl,
} from "../src/shared/sitePermissions";

describe("site permission prompts", () => {
  test("they ask for the site settings' permissions, with their icons", () => {
    expect(permissionKeys).toEqual(
      expect.arrayContaining(["camera", "microphone", "location", "notifications", "screen"]),
    );
    expect(permissionKeys).not.toContain("javascript");
    for (const key of permissionKeys) {
      expect(tags).toHaveProperty(siteSettings[key].icon);
      const off = promptInfo(key).offIcon;
      if (off) expect(tags).toHaveProperty(off);
    }
    for (const key of LIVE_KEYS) expect(permissionKeys).toContain(key);
    // No "Allow this time" for notifications (they come after the page is gone) or screen sharing (always asks).
    expect(promptInfo("notifications").once).toBe(false);
    expect(promptInfo("screen").once).toBe(false);
    expect(promptInfo("camera").once).toBe(true);
  });

  test("a page's permissions belong to its site, like its site settings", () => {
    expect(permissionSite("https://www.meet.example.com/abc?x=1")).toBe("meet.example.com");
    expect(permissionSite("https://www.example.com/")).toBe("example.com");
    expect(permissionSite("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(permissionSite("file:///tmp/a.html")).toBe("");
    expect(permissionSite("rune://version")).toBe("");
    expect(permissionSite("chrome-extension://abc/popup.html")).toBe("");
    expect(permissionSite("not a url")).toBe("");
    expect(mediaCheckTypes("video")).toEqual(["video"]);
    expect(mediaCheckTypes("unknown")).toEqual([]);
  });

  test("prompt texts and where to allow devices on each OS", () => {
    expect(promptText(["camera", "microphone"])).toBe("Use your camera and microphone");
    expect(promptText(["location"])).toBe(siteSettings.location.about);
    expect(systemSettingsUrl("darwin", "camera")).toContain("Privacy_Camera");
    expect(systemSettingsUrl("win32", "microphone")).toBe("ms-settings:privacy-microphone");
    expect(systemSettingsUrl("linux", "camera")).toBeNull();
  });
});

/** A page's main world with just enough of the web platform for the hooks. */
function fakePage() {
  const listeners = new Map<object, string[]>();
  class Track {
    readyState = "live";
    constructor(readonly kind: string) {}
    stop() {
      this.readyState = "ended";
    }
    clone() {
      return new Track(this.kind);
    }
    dispatchEvent(e: { type: string }) {
      listeners.set(this, [...(listeners.get(this) ?? []), e.type]);
    }
  }
  class Stream {
    constructor(readonly tracks: Track[]) {}
    getTracks() {
      return this.tracks;
    }
    clone() {
      return new Stream(this.tracks.map((t) => new Track(t.kind)));
    }
  }
  class MediaDevices {
    getUserMedia(c: { video?: unknown; audio?: unknown }) {
      return Promise.resolve(
        new Stream([...(c.video ? [new Track("video")] : []), ...(c.audio ? [new Track("audio")] : [])]),
      );
    }
    getDisplayMedia() {
      return Promise.resolve(new Stream([new Track("video")]));
    }
  }
  let nextWatch = 0;
  const cleared: number[] = [];
  class Geolocation {
    watchPosition() {
      return ++nextWatch;
    }
    clearWatch(id: number) {
      cleared.push(id);
    }
    getCurrentPosition(ok: (p: unknown) => void) {
      setTimeout(() => ok({}), 0);
    }
  }
  class Notification {
    static get permission() {
      return context.nativeNotification;
    }
  }
  class PermissionStatus {
    constructor(private readonly native: string) {}
    get state() {
      return this.native;
    }
  }
  class Permissions {
    query(d: { name: string }) {
      return Promise.resolve(new PermissionStatus(context.nativeStates[d.name] ?? "denied"));
    }
  }
  class Navigator {
    webkitGetUserMedia() {
      throw new Error("the native one, past the hooks");
    }
  }
  const navigator = Object.assign(new Navigator(), {
    mediaDevices: new MediaDevices(),
    geolocation: new Geolocation(),
    permissions: new Permissions(),
  });
  const context: any = {
    MediaDevices,
    MediaStreamTrack: Track,
    MediaStream: Stream,
    Geolocation,
    Notification,
    Permissions,
    PermissionStatus,
    navigator,
    Navigator,
    DOMException,
    structuredClone,
    Promise,
    Event: class {
      constructor(readonly type: string) {}
    },
    WeakRef,
    setTimeout,
    nativeNotification: "denied",
    nativeStates: {} as Record<string, string>,
  };
  context.globalThis = context;
  context.frames = { length: 0 };
  createContext(context);
  runInContext(pageHooksScript(), context);
  // Running twice (a late injection) changes nothing.
  runInContext(pageHooksScript(), context);
  const run = <T>(code: string): T => runInContext(code, context);
  return { context, run, listeners, cleared };
}

describe("page hooks", () => {
  test("what isn't blocked reads as 'prompt', like in Chromium", async () => {
    const { context, run } = fakePage();
    expect(run<string>("Notification.permission")).toBe("default");
    expect(await run<Promise<string>>(`navigator.permissions.query({ name: "camera" }).then((s) => s.state)`)).toBe(
      "prompt",
    );
    run(pageBlockedScript(["camera", "notifications"]));
    expect(run<string>("Notification.permission")).toBe("denied");
    expect(await run<Promise<string>>(`navigator.permissions.query({ name: "camera" }).then((s) => s.state)`)).toBe(
      "denied",
    );
    expect(
      await run<Promise<string>>(`navigator.permissions.query({ name: "geolocation" }).then((s) => s.state)`),
    ).toBe("prompt");
    // Allowed reads as allowed; names without a setting are left alone.
    context.nativeNotification = "granted";
    context.nativeStates = { geolocation: "granted" };
    expect(run<string>("Notification.permission")).toBe("granted");
    expect(
      await run<Promise<string>>(`navigator.permissions.query({ name: "geolocation" }).then((s) => s.state)`),
    ).toBe("granted");
    expect(
      await run<Promise<string>>(`navigator.permissions.query({ name: "accelerometer" }).then((s) => s.state)`),
    ).toBe("denied");
  });

  test("counts the camera, microphone, screen and location in use, and stops them", async () => {
    const { run, listeners, cleared } = fakePage();
    const state = () => run<Record<string, number>>(pageStateExpression);
    expect(state()).toEqual({ camera: 0, microphone: 0, screen: 0, location: 0 });
    await run(`navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => (globalThis.cam = s))`);
    await run(`navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => (globalThis.screen = s))`);
    run(`globalThis.watch = navigator.geolocation.watchPosition(() => {})`);
    expect(state()).toEqual({ camera: 1, microphone: 1, screen: 1, location: 1 });
    // A clone is in use too; the page stopping a track counts.
    run(`globalThis.copy = cam.getTracks()[0].clone()`);
    expect(state().camera).toBe(2);
    run(`copy.stop()`);
    expect(state().camera).toBe(1);
    // Stopped by the user: the tracks end (with an "ended" event) and the watches are cleared.
    run(pageStopExpression(["camera", "location"]));
    expect(state()).toEqual({ camera: 0, microphone: 1, screen: 1, location: 0 });
    expect(run<string>(`cam.getTracks()[0].readyState`)).toBe("ended");
    expect(listeners.get(run(`cam.getTracks()[0]`))).toEqual(["ended"]);
    expect(cleared).toEqual([1]);
    run(pageStopExpression(["microphone", "screen"]));
    expect(state()).toEqual({ camera: 0, microphone: 0, screen: 0, location: 0 });
  });

  test("a frame of the page can add to what's in use, never hide it", async () => {
    const { context, run } = fakePage();
    await run(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => (globalThis.cam = s))`);
    const liar = {
      [Symbol.for("rune.sitePermissions")]: () => ({ camera: -5, microphone: "x" }),
      frames: { length: 0 },
    };
    context.frames = { length: 1, 0: liar };
    expect(run<Record<string, number>>(pageStateExpression)).toEqual({
      camera: 1,
      microphone: 0,
      screen: 0,
      location: 0,
    });
  });

  test("getUserMedia can't name a screen or window (Chrome's desktop sources), the old API neither", async () => {
    const { run } = fakePage();
    const tries = [
      `{ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: "screen:0:0" } } }`,
      `{ video: { chromeMediaSource: "tab" } }`,
      `{ audio: { optional: [{ chromeMediaSourceId: "x" }] }, video: true }`,
    ];
    for (const constraints of tries)
      expect(
        await run<Promise<string>>(
          `navigator.mediaDevices.getUserMedia(${constraints}).then(() => "ok", (e) => e.name)`,
        ),
      ).toBe("NotAllowedError");
    // A getter that only says "desktop" the second time it's read gets read once.
    expect(
      await run<Promise<string>>(`(() => {
        let reads = 0;
        const video = { get mandatory() { return ++reads > 1 ? { chromeMediaSource: "desktop" } : {}; } };
        return navigator.mediaDevices.getUserMedia({ video }).then(() => "ok " + reads, (e) => e.name);
      })()`),
    ).toBe("ok 1");
    expect(
      await run<Promise<string>>(`new Promise((resolve) => navigator.webkitGetUserMedia(
        { video: { mandatory: { chromeMediaSource: "desktop" } } }, () => resolve("ok"), (e) => resolve(e.name)))`),
    ).toBe("NotAllowedError");
    expect(
      await run<Promise<string>>(
        `new Promise((resolve) => navigator.webkitGetUserMedia({ video: true }, (s) => resolve("ok " + s.getTracks().length), (e) => resolve(e.name)))`,
      ),
    ).toBe("ok 1");
  });

  test("a screen permission request is let through once per waiting getDisplayMedia call", async () => {
    const { run } = fakePage();
    expect(run<boolean>(pageClaimDisplayExpression)).toBe(false);
    run(`globalThis.pending = navigator.mediaDevices.getDisplayMedia({ video: true })`);
    expect(run<boolean>(pageClaimDisplayExpression)).toBe(true);
    expect(run<boolean>(pageClaimDisplayExpression)).toBe(false);
    await run(`pending`);
    expect(run<boolean>(pageClaimDisplayExpression)).toBe(false);
  });
});
