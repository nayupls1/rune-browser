// Passkeys and security keys (WebAuthn) in websites' frames: navigator.credentials.create()/get() with
// `publicKey` still go to Chromium, which does the ceremony; this only tells the main process
// (main/passkeys.ts) when one starts and ends, so Rune Browser can show its prompt while it waits
// (Electron has none of Chrome's dialogs), call it off when the user cancels or the page's timeout
// passes (Chromium waits on forever without an authenticator), and refuse it while the website agent
// works in the tab.
//
// This function runs in the site's own world (injected by the preload with contextBridge.executeInMainWorld),
// so it can't use anything from outside itself. Password manager extensions that provide passkeys replace
// navigator.credentials' methods in the page too: a request they handle never gets here; the ones they hand
// on to the browser do.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PasskeyBridge {
  /** A request starts: its id, or `refused` (the main process says why in the tab). */
  start: (info: Record<string, unknown>) => Promise<{ id?: string; refused?: boolean } | null>;
  end: (id: string, outcome: Record<string, unknown>) => void;
  /** The user cancelled a request in Rune Browser's prompt. */
  onCancel: (fn: (id: string) => void) => void;
}

export interface PasskeyShimInfo {
  /** Chromium's NotAllowedError message. */
  notAllowed: string;
  /** Chromium's timeouts: [lower, upper] in ms (shared/passkeys.ts' adjustedTimeout). */
  timeouts: [number, number];
}

export function passkeyShim(bridge: PasskeyBridge, info: PasskeyShimInfo) {
  // Runs on its own in the site's world: only what's defined in here exists.
  const g: any = globalThis;
  const CC = g.CredentialsContainer;
  if (!CC || !g.isSecureContext || !g.PublicKeyCredential) return;
  const marker = Symbol.for("rune.passkeys");
  if (CC.prototype[marker]) return;
  Object.defineProperty(CC.prototype, marker, { value: true });

  const cancels = new Map<string, () => void>();
  bridge.onCancel((id) => cancels.get(id)?.());

  const timeoutOf = (value: unknown) => {
    const [lower, upper] = info.timeouts;
    return typeof value === "number" && Number.isFinite(value) ? Math.min(upper, Math.max(lower, value)) : upper;
  };
  const describe = (ceremony: "create" | "get", pk: any) => {
    const selection = (ceremony === "create" && pk.authenticatorSelection) || {};
    return {
      ceremony,
      rpId: String((ceremony === "create" ? pk.rp?.id : pk.rpId) ?? ""),
      passkey:
        selection.residentKey === "required" || selection.residentKey === "preferred" || !!selection.requireResidentKey,
      platformOnly: selection.authenticatorAttachment === "platform",
      timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
    };
  };

  const wrap = (ceremony: "create" | "get") => {
    const native = CC.prototype[ceremony];
    if (typeof native !== "function") return;
    const run = async (self: any, options: any, args: IArguments) => {
      const pk = options.publicKey;
      let ticket: { id?: string; refused?: boolean } | null = null;
      try {
        ticket = await bridge.start(describe(ceremony, pk));
      } catch {
        ticket = null;
      }
      if (ticket?.refused) throw new DOMException(info.notAllowed, "NotAllowedError");
      // Nothing to report to (the main process didn't answer): Chromium alone.
      if (!ticket?.id) return native.apply(self, args);
      const id = ticket.id;
      const own = new AbortController();
      let cancelled = false;
      let timedOut = false;
      cancels.set(id, () => {
        cancelled = true;
        own.abort();
      });
      // A little after Chromium's own timeout, which it doesn't keep without an authenticator.
      const timer = setTimeout(
        () => {
          timedOut = true;
          own.abort();
        },
        timeoutOf(pk.timeout) + 1000,
      );
      const signal: AbortSignal = options.signal ? AbortSignal.any([own.signal, options.signal]) : own.signal;
      try {
        const result = await native.call(self, { ...options, signal });
        bridge.end(id, { ok: true });
        return result;
      } catch (err: any) {
        // Called off by Rune Browser (not by the page): what Chromium says when the user cancels or time runs out.
        if (own.signal.aborted && !options.signal?.aborted) {
          bridge.end(id, { ok: false, error: "NotAllowedError", timedOut: timedOut && !cancelled });
          throw new DOMException(info.notAllowed, "NotAllowedError");
        }
        bridge.end(id, { ok: false, error: String(err?.name ?? "Error") });
        throw err;
      } finally {
        clearTimeout(timer);
        cancels.delete(id);
      }
    };
    const methods = {
      [ceremony](this: any, options?: any) {
        // Not a WebAuthn request (passwords, federated, OTP…), conditional ones (passkeys offered as you type a
        // username, which wait quietly), one already called off, or a call Chromium will refuse anyway: as is.
        if (
          !(this instanceof CC) ||
          !options ||
          typeof options !== "object" ||
          !options.publicKey ||
          typeof options.publicKey !== "object" ||
          options.mediation === "conditional" ||
          options.signal?.aborted
        )
          return native.apply(this, arguments as any);
        return run(this, options, arguments);
      },
    };
    Object.defineProperty(CC.prototype, ceremony, {
      value: methods[ceremony],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };
  wrap("create");
  wrap("get");
}
