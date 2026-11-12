import { afterEach, describe, expect, test } from "bun:test";
import { passkeyShim, type PasskeyBridge } from "../src/extension-preload/passkeys";
import {
  accountsToChoose,
  adjustedTimeout,
  endFailure,
  failureText,
  isPinWarning,
  NOT_ALLOWED_MESSAGE,
  passkeySite,
  readRequestInfo,
  showsOwnPrompt,
  startDecision,
  waitingText,
} from "../src/shared/passkeys";

describe("passkeys: deciding", () => {
  test("Chromium's timeouts: the page's, between 10 seconds and 10 minutes, 10 minutes without one", () => {
    expect(adjustedTimeout()).toBe(600_000);
    expect(adjustedTimeout(4000)).toBe(10_000);
    expect(adjustedTimeout(60_000)).toBe(60_000);
    expect(adjustedTimeout(3_600_000)).toBe(600_000);
    expect(adjustedTimeout(Number.NaN)).toBe(600_000);
  });

  test("a request goes on with Rune's prompt, except on Windows (its own dialog)", () => {
    const info = { platformOnly: false };
    expect(startDecision({ platform: "linux", info, agentRunning: false, headless: false })).toEqual({
      allow: true,
      prompt: true,
    });
    expect(startDecision({ platform: "darwin", info, agentRunning: false, headless: false })).toEqual({
      allow: true,
      prompt: true,
    });
    expect(startDecision({ platform: "win32", info, agentRunning: false, headless: false })).toEqual({
      allow: true,
      prompt: false,
    });
    expect(showsOwnPrompt("win32")).toBe(false);
  });

  test("never while the agent works in the tab, never in headless tabs", () => {
    const info = { platformOnly: false };
    for (const platform of ["linux", "darwin", "win32"]) {
      expect(startDecision({ platform, info, agentRunning: true, headless: false })).toEqual({
        allow: false,
        failure: "agent",
      });
      expect(startDecision({ platform, info, agentRunning: false, headless: true })).toEqual({ allow: false });
    }
  });

  test("a passkey kept on this device: refused right away where there's none, Windows Hello otherwise", () => {
    const info = { platformOnly: true };
    expect(startDecision({ platform: "linux", info, agentRunning: false, headless: false })).toEqual({
      allow: false,
      failure: "platform",
    });
    expect(startDecision({ platform: "darwin", info, agentRunning: false, headless: false })).toEqual({
      allow: false,
      failure: "platform",
    });
    expect(startDecision({ platform: "win32", info, agentRunning: false, headless: false }).allow).toBe(true);
  });

  test("why a request failed, or nothing when it worked or the user (or the page) called it off", () => {
    const end = (
      outcome: Parameters<typeof endFailure>[0]["outcome"],
      more: { cancelled?: boolean; pin?: boolean } = {},
    ) => endFailure({ ceremony: "create", outcome, cancelled: false, pin: false, ...more });
    expect(end({ ok: true })).toBeNull();
    expect(end({ ok: false, error: "NotAllowedError" }, { cancelled: true })).toBeNull();
    expect(end({ ok: false, error: "AbortError" })).toBeNull();
    expect(end({ ok: false, error: "NotAllowedError" }, { pin: true })).toBe("pin");
    expect(end({ ok: false, error: "NotAllowedError", timedOut: true })).toBe("timeout");
    expect(end({ ok: false, error: "InvalidStateError" })).toBe("registered");
    expect(end({ ok: false, error: "NotAllowedError" })).toBe("failed");
    expect(end({ ok: false, error: "TypeError" })).toBeNull();
    expect(
      endFailure({ ceremony: "get", outcome: { ok: false, error: "InvalidStateError" }, cancelled: false, pin: false }),
    ).toBeNull();
  });

  test("Electron's console warning about a key's PIN", () => {
    expect(
      isPinWarning(
        "The security key needs its PIN to continue, but Electron does not support WebAuthn PIN entry (https://github.com/electron/electron/issues/24573). The request was cancelled.",
      ),
    ).toBe(true);
    expect(
      isPinWarning("publicKey.pubKeyCredParams is missing at least one of the default algorithm identifiers"),
    ).toBe(false);
  });
});

describe("passkeys: what the page says", () => {
  test("the site shown is the RP ID when the page may use it, else the page's host", () => {
    expect(passkeySite("", "https://github.com")).toBe("github.com");
    expect(passkeySite("example.com", "https://login.example.com")).toBe("example.com");
    expect(passkeySite("Example.COM", "https://example.com:8443")).toBe("example.com");
    expect(passkeySite("evil.com", "https://example.com")).toBe("example.com");
    expect(passkeySite("ample.com", "https://example.com")).toBe("example.com");
    expect(passkeySite("", "not a url")).toBe("");
  });

  test("the page's description of its request is checked and cut down", () => {
    expect(readRequestInfo(null)).toBeNull();
    expect(readRequestInfo({ ceremony: "delete" })).toBeNull();
    expect(readRequestInfo({ ceremony: "get", rpId: "x".repeat(1000), passkey: true, platformOnly: true })).toEqual({
      ceremony: "get",
      rpId: "x".repeat(256),
      passkey: false,
      platformOnly: false,
    });
    expect(
      readRequestInfo({ ceremony: "create", rpId: "example.com", passkey: true, platformOnly: true, timeout: 60000 }),
    ).toEqual({ ceremony: "create", rpId: "example.com", passkey: true, platformOnly: true, timeout: 60000 });
    expect(readRequestInfo({ ceremony: "create", timeout: "soon" })).toEqual({
      ceremony: "create",
      rpId: "",
      passkey: false,
      platformOnly: false,
    });
  });

  test("accounts to choose from: display name first, the user name under it", () => {
    expect(
      accountsToChoose([
        { credentialId: "a", name: "ada@example.com", displayName: "Ada Lovelace" },
        { credentialId: "b", name: "bob" },
        { credentialId: "c", name: "carol", displayName: "carol" },
        { credentialId: "d" },
      ]),
    ).toEqual([
      { credentialId: "a", name: "Ada Lovelace", detail: "ada@example.com" },
      { credentialId: "b", name: "bob", detail: "" },
      { credentialId: "c", name: "carol", detail: "" },
      { credentialId: "d", name: "Unnamed account", detail: "" },
    ]);
  });

  test("the prompt's words", () => {
    expect(waitingText({ ceremony: "get", passkey: false, site: "github.com" }, "linux").title).toBe(
      "Sign in to github.com with a security key",
    );
    expect(waitingText({ ceremony: "create", passkey: true, site: "github.com" }, "linux").title).toBe(
      "Create a passkey for github.com on a security key",
    );
    expect(waitingText({ ceremony: "create", passkey: false, site: "github.com" }, "linux").title).toBe(
      "Register a security key with github.com",
    );
    expect(waitingText({ ceremony: "get", passkey: false, site: "x" }, "darwin").note).toContain("iCloud Keychain");
    expect(failureText("platform", "github.com", "linux").body).toContain("on Linux");
    expect(failureText("platform", "github.com", "darwin").body).toContain("on macOS");
    expect(failureText("agent", "github.com", "linux").body).toContain("take over");
    expect(failureText("pin", "github.com", "linux").title).toBe("This security key needs its PIN");
  });
});

// --- The shim in the page ----------------------------------------------------------------------------

/** A page's world: CredentialsContainer whose native methods are `impl`. */
function fakePage(impl: (kind: "create" | "get", options: any) => Promise<unknown>) {
  const g = globalThis as any;
  const saved = {
    CredentialsContainer: g.CredentialsContainer,
    PublicKeyCredential: g.PublicKeyCredential,
    isSecureContext: g.isSecureContext,
  };
  class CredentialsContainer {
    create(options: any) {
      return impl("create", options);
    }
    get(options: any) {
      return impl("get", options);
    }
  }
  g.CredentialsContainer = CredentialsContainer;
  g.PublicKeyCredential = class {};
  g.isSecureContext = true;
  restore = () => Object.assign(g, saved);
  return new CredentialsContainer() as any;
}
let restore = () => {};
afterEach(() => restore());

function fakeBridge(answer: { id?: string; refused?: boolean } | null) {
  const started: Record<string, unknown>[] = [];
  const ended: [string, Record<string, unknown>][] = [];
  let cancel: (id: string) => void = () => {};
  const bridge: PasskeyBridge = {
    start: async (info) => (started.push(info), answer),
    end: (id, outcome) => void ended.push([id, outcome]),
    onCancel: (fn) => void (cancel = fn),
  };
  return { bridge, started, ended, cancel: (id: string) => cancel(id) };
}

const info = { notAllowed: NOT_ALLOWED_MESSAGE, timeouts: [50, 200] as [number, number] };
const pk = { challenge: new Uint8Array(32), rp: { id: "example.com", name: "x" }, user: {}, pubKeyCredParams: [] };

describe("passkeys: the shim in the page", () => {
  test("tells Rune Browser about a request, and how it ended", async () => {
    const credentials = fakePage(async () => "credential");
    const b = fakeBridge({ id: "p1" });
    passkeyShim(b.bridge, info);
    const result = await credentials.create({
      publicKey: { ...pk, authenticatorSelection: { residentKey: "required" }, timeout: 30_000 },
    });
    expect(result).toBe("credential");
    expect(b.started).toEqual([
      { ceremony: "create", rpId: "example.com", passkey: true, platformOnly: false, timeout: 30_000 },
    ]);
    expect(b.ended).toEqual([["p1", { ok: true }]]);
  });

  test("refused: NotAllowedError without asking the authenticator", async () => {
    let asked = false;
    const credentials = fakePage(async () => ((asked = true), "credential"));
    const b = fakeBridge({ refused: true });
    passkeyShim(b.bridge, info);
    const error = await credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("NotAllowedError");
    expect((error as DOMException).message).toBe(NOT_ALLOWED_MESSAGE);
    expect(asked).toBe(false);
  });

  test("cancelled from Rune Browser's prompt: the request is aborted, the page gets NotAllowedError", async () => {
    const credentials = fakePage(
      (_kind, options) =>
        new Promise((_, reject) =>
          options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const b = fakeBridge({ id: "p2" });
    passkeyShim(b.bridge, info);
    const pending = credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).catch((e: Error) => e);
    await Bun.sleep(5);
    b.cancel("p2");
    const error = (await pending) as DOMException;
    expect(error.name).toBe("NotAllowedError");
    expect(b.ended).toEqual([["p2", { ok: false, error: "NotAllowedError", timedOut: false }]]);
  });

  test("a request still waiting after its timeout is called off (Chromium waits on without an authenticator)", async () => {
    const credentials = fakePage(
      (_kind, options) =>
        new Promise((_, reject) =>
          options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const b = fakeBridge({ id: "p3" });
    passkeyShim({ ...b.bridge }, { ...info, timeouts: [10, 20] });
    const started = Date.now();
    const error = (await credentials
      .get({ publicKey: { challenge: new Uint8Array(32), timeout: 1 } })
      .catch((e: Error) => e)) as DOMException;
    expect(error.name).toBe("NotAllowedError");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(b.ended).toEqual([["p3", { ok: false, error: "NotAllowedError", timedOut: true }]]);
  });

  test("the page's own abort stays the page's: its reason, reported as AbortError", async () => {
    const credentials = fakePage(
      (_kind, options) =>
        new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason))),
    );
    const b = fakeBridge({ id: "p4" });
    passkeyShim(b.bridge, info);
    const controller = new AbortController();
    const pending = credentials
      .get({ publicKey: { challenge: new Uint8Array(32) }, signal: controller.signal })
      .catch((e: Error) => e);
    await Bun.sleep(5);
    controller.abort();
    const error = (await pending) as DOMException;
    expect(error.name).toBe("AbortError");
    expect(b.ended).toEqual([["p4", { ok: false, error: "AbortError" }]]);
  });

  test("passwords, conditional requests and calls with nothing to answer go straight to Chromium", async () => {
    const seen: unknown[] = [];
    const credentials = fakePage(async (_kind, options) => (seen.push(options), "native"));
    const b = fakeBridge({ id: "p5" });
    passkeyShim(b.bridge, info);
    await credentials.get({ password: true });
    await credentials.get({ publicKey: { challenge: new Uint8Array(32) }, mediation: "conditional" });
    await credentials.get();
    expect(seen.length).toBe(3);
    expect(b.started).toEqual([]);
  });

  test("Chromium's answer when Rune Browser doesn't answer (no main process): the request goes on alone", async () => {
    const credentials = fakePage(async () => "native");
    const b = fakeBridge(null);
    passkeyShim(b.bridge, info);
    expect(await credentials.get({ publicKey: { challenge: new Uint8Array(32) } })).toBe("native");
    expect(b.ended).toEqual([]);
  });

  test("installed once", () => {
    fakePage(async () => null);
    const b = fakeBridge(null);
    passkeyShim(b.bridge, info);
    const first = (globalThis as any).CredentialsContainer.prototype.get;
    passkeyShim(b.bridge, info);
    expect((globalThis as any).CredentialsContainer.prototype.get).toBe(first);
  });
});
