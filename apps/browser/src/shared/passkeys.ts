// Passkeys and security keys (WebAuthn) in web tabs: what Rune Browser shows while a page's
// navigator.credentials.create()/get() waits for an authenticator, the account picker Electron asks
// for when a security key holds several passkeys, and the messages when one can't be used
// (main/passkeys.ts decides, components/PasskeyPrompt.tsx shows them).
//
// Chromium does the ceremony itself (origins, RP IDs, the authenticators); Electron has none of
// Chrome's dialogs around it. What's there per platform: security keys over USB on every platform
// (touch only: Electron can't ask for a PIN), Windows' own dialog on Windows (Windows Hello, keys
// with their PIN, phones), no passkeys stored on Linux or macOS (Rune Browser isn't signed with the
// entitlements Electron's Touch ID and platform passkeys need), and no phones (hybrid) outside
// Windows.

export type PasskeyCeremony = "create" | "get";

/** What the page's request is about, as the shim in the page reads it (extension-preload/passkeys.ts). */
export interface PasskeyRequestInfo {
  ceremony: PasskeyCeremony;
  /** The RP ID the page asked for ("" when it didn't name one: its own host). */
  rpId: string;
  /** A passkey (discoverable credential), not only a second factor: create with residentKey required/preferred. */
  passkey: boolean;
  /** create: only an authenticator built into this device will do (authenticatorAttachment "platform"). */
  platformOnly: boolean;
  /** The page's timeout (ms), if it gave one. */
  timeout?: number;
}

/** Why a request couldn't go on, as the prompt explains it. */
export type PasskeyFailure =
  /** The website agent is working in the tab: agents never sign in. */
  | "agent"
  /** A passkey kept on this device, which Rune Browser can't do here. */
  | "platform"
  /** The security key wants its PIN, which Electron can't ask for. */
  | "pin"
  /** Nothing answered before the page's timeout. */
  | "timeout"
  /** create: this key already holds a credential for the account. */
  | "registered"
  /** Refused otherwise (the key, or the site's options). */
  | "failed";

export interface PasskeyAccount {
  credentialId: string;
  /** What to show first: the display name, else the user name. */
  name: string;
  /** The user name under it, when it's not what's shown already. */
  detail: string;
}

/** A prompt over a web tab, like the site permission prompts. */
export type PasskeyPrompt = {
  requestId: string;
  contentsId: number;
  /** The site (RP ID) the request is for. */
  site: string;
} & (
  | { kind: "waiting"; ceremony: PasskeyCeremony; passkey: boolean }
  | { kind: "account"; accounts: PasskeyAccount[] }
  | { kind: "failed"; failure: PasskeyFailure }
);

/** The user's answer to a prompt. */
export type PasskeyReply = { action: "cancel" } | { action: "dismiss" } | { action: "account"; credentialId: string };

/** How a request the shim let through ended. */
export interface PasskeyOutcome {
  ok: boolean;
  /** The DOMException's name when it failed. */
  error?: string;
  /** The shim gave up after the request's timeout (Chromium didn't). */
  timedOut?: boolean;
}

/**
 * Chromium's timeout for a request (AdjustTimeout in content/browser/webauth/authenticator_common_impl.cc):
 * the page's, between 10 seconds and 10 minutes; 10 minutes when it gave none.
 */
export function adjustedTimeout(timeout?: number) {
  const lower = 10_000;
  const upper = 600_000;
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) return upper;
  return Math.min(upper, Math.max(lower, timeout));
}

/**
 * Rune Browser shows its own prompt while a request waits: not on Windows, whose own dialog does that
 * (and asks for a key's PIN, offers Windows Hello and phones).
 */
export const showsOwnPrompt = (platform: string) => platform !== "win32";

/** Passkeys kept on this device: only Windows Hello here (Linux has none; macOS's need entitlements Rune lacks). */
export const hasPlatformAuthenticator = (platform: string) => platform === "win32";

/** Whether a request can go on, and whether Rune Browser shows its prompt while it waits. */
export function startDecision(options: {
  platform: string;
  info: Pick<PasskeyRequestInfo, "platformOnly">;
  agentRunning: boolean;
  headless: boolean;
}): { allow: true; prompt: boolean } | { allow: false; failure?: PasskeyFailure } {
  // Headless tabs have no sign-ins, and nobody would see a prompt.
  if (options.headless) return { allow: false };
  if (options.agentRunning) return { allow: false, failure: "agent" };
  // Chromium would wait for an authenticator that isn't there until the page gives up (or forever).
  if (options.info.platformOnly && !hasPlatformAuthenticator(options.platform))
    return { allow: false, failure: "platform" };
  return { allow: true, prompt: showsOwnPrompt(options.platform) };
}

/**
 * What the prompt says after a request the shim let through ended (null: nothing, it worked or the
 * user cancelled it). `pin`: Electron said in the page's console that the key wanted its PIN.
 */
export function endFailure(options: {
  ceremony: PasskeyCeremony;
  outcome: PasskeyOutcome;
  cancelled: boolean;
  pin: boolean;
}): PasskeyFailure | null {
  const { outcome } = options;
  if (outcome.ok || options.cancelled) return null;
  if (options.pin) return "pin";
  if (outcome.timedOut) return "timeout";
  // The page called it off itself (AbortSignal): its business.
  if (outcome.error === "AbortError") return null;
  if (outcome.error === "InvalidStateError" && options.ceremony === "create") return "registered";
  if (outcome.error === "NotAllowedError") return "failed";
  // Bad options (TypeError, SecurityError for an RP ID the page can't use…): the page's console says why.
  return null;
}

/** Electron's console warning when a security key needs its PIN (electron_authenticator_request_client_delegate.cc). */
export const isPinWarning = (message: string) => /security key needs its PIN/i.test(message);

/**
 * The site to show: the RP ID the page asked for when it's the page's host or a domain the host is
 * in (Chromium refuses any other), else the host.
 */
export function passkeySite(rpId: string, origin: string) {
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
  const rp = rpId.trim().toLowerCase();
  return rp && (rp === host || host.endsWith(`.${rp}`)) ? rp : host;
}

const cut = (value: unknown, max = 256) => (typeof value === "string" ? value.slice(0, max) : "");

/** The page's description of its request (untrusted), or null. */
export function readRequestInfo(raw: unknown): PasskeyRequestInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.ceremony !== "create" && v.ceremony !== "get") return null;
  const timeout = typeof v.timeout === "number" && Number.isFinite(v.timeout) ? v.timeout : undefined;
  return {
    ceremony: v.ceremony,
    rpId: cut(v.rpId),
    passkey: v.ceremony === "create" && v.passkey === true,
    platformOnly: v.ceremony === "create" && v.platformOnly === true,
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/** The accounts of Electron's select-webauthn-account, to choose from. */
export function accountsToChoose(
  accounts: readonly { credentialId: string; name?: string; displayName?: string }[],
): PasskeyAccount[] {
  return accounts.map((a) => {
    const name = cut(a.name, 200).trim();
    const display = cut(a.displayName, 200).trim();
    return {
      credentialId: a.credentialId,
      name: display || name || "Unnamed account",
      detail: display && name && name !== display ? name : "",
    };
  });
}

/** What the prompt says while a request waits for a security key. */
export function waitingText(prompt: { ceremony: PasskeyCeremony; passkey: boolean; site: string }, platform: string) {
  const title =
    prompt.ceremony === "get"
      ? `Sign in to ${prompt.site} with a security key`
      : prompt.passkey
        ? `Create a passkey for ${prompt.site} on a security key`
        : `Register a security key with ${prompt.site}`;
  const synced = platform === "darwin" ? "iCloud Keychain" : "Google Password Manager";
  return {
    title,
    body: "Insert your security key and touch it.",
    note: `Passkeys on your phone or in ${synced} can't be used in Rune Browser. A password manager extension's passkeys can.`,
  };
}

const systemName = (platform: string) =>
  platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : "this system";

/** What the prompt says when a request couldn't be used. */
export function failureText(failure: PasskeyFailure, site: string, platform: string) {
  const instead =
    "Use a security key, a password manager extension's passkeys (Bitwarden, 1Password…), or sign in another way.";
  switch (failure) {
    case "agent":
      return {
        title: "The agent can't sign in for you",
        body: `${site} asked for a passkey or security key. Agents never sign in: take over to sign in yourself.`,
      };
    case "platform":
      return {
        title: "No passkeys on this device",
        body: `${site} wants a passkey kept on this computer, which Rune Browser can't do on ${systemName(platform)} yet. ${instead}`,
      };
    case "pin":
      return {
        title: "This security key needs its PIN",
        body: `Rune Browser can't ask for a security key's PIN yet, so ${site} couldn't use it. Use a key without a PIN, a password manager extension's passkeys, or sign in another way.`,
      };
    case "timeout":
      return {
        title: "No security key answered",
        body: `${site} stopped waiting. Insert your security key, touch it when it blinks, and try again.`,
      };
    case "registered":
      return { title: "Already registered", body: `This security key is already registered with ${site}.` };
    case "failed":
      return {
        title: "Couldn't use the security key",
        body: `The key or ${site} refused the request. A key that needs its PIN can't be used yet: Rune Browser can't ask for one. Try again, or sign in another way.`,
      };
  }
}

/** What the website agent is told when the page it uses asked for a passkey (instead of getting one). */
export const AGENT_PASSKEY_NOTE =
  "The page asked to sign in with a passkey or security key. Agents never do that: ask the user to sign in themselves (they can take over), then go on.";

/** The page's error when Rune Browser called a request off (Chromium's, word for word). */
export const NOT_ALLOWED_MESSAGE =
  "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
