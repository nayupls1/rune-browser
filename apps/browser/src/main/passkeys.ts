// Passkeys and security keys (WebAuthn) in web tabs. Chromium does the ceremony (origins, RP IDs,
// talking to the authenticators); Electron has none of Chrome's dialogs around it, so Rune Browser adds
// its own, as prompts over the tab (components/PasskeyPrompt.tsx, like the site permission prompts):
// - while a request waits for a security key (the page's shim, extension-preload/passkeys.ts, says when
//   one starts and ends): "Insert your security key and touch it", with Cancel. Not on Windows, whose
//   own dialog does it;
// - the account to sign in with when a security key holds several passkeys for the site (Electron's
//   select-webauthn-account; with none listening, it refuses every such sign-in);
// - why a request failed: the key wants its PIN (Electron can't ask for it; it says so in the page's
//   console), the page's timeout passed (Chromium waits on forever without an authenticator, so the
//   shim calls it off), a passkey kept on this device on Linux or macOS (there are none: refused right
//   away instead of waiting forever), the key's already registered.
// The website agent never completes a ceremony: while it works in a tab, requests there are refused
// (the tab says so, and the agent is told), and headless tabs (no sign-ins) get none at all (main/headless.ts
// also keeps real authenticators out of their reach).
import { ipcMain, webContents, type Session, type WebContents, type WebFrameMain } from "electron";
import {
  accountsToChoose,
  endFailure,
  isPinWarning,
  passkeySite,
  readRequestInfo,
  startDecision,
  type PasskeyCeremony,
  type PasskeyFailure,
  type PasskeyOutcome,
  type PasskeyPrompt,
  type PasskeyReply,
} from "../shared/passkeys";
import type { AppWindows } from "./windows";

interface Options {
  windows: AppWindows;
  /** The workspace of a web tab session (undefined: not a web tab session). */
  workspaceOf: (s: Session) => string | undefined;
  /** Headless tabs (main/headless.ts): no sign-ins. */
  isHeadless: (contents: WebContents) => boolean;
}

/** A request the shim let through. */
interface Ceremony {
  id: string;
  contents: WebContents;
  frame: WebFrameMain;
  ceremony: PasskeyCeremony;
  site: string;
  /** The user cancelled it in the prompt. */
  cancelled: boolean;
  /** Electron said the key wanted its PIN. */
  pin: boolean;
  /** Rune Browser's prompt shows while it waits. */
  prompted: boolean;
}

/** An account picker waiting for the user. */
interface Choice {
  contentsId: number;
  callback: (credentialId?: string | null) => void;
  ceremony?: Ceremony;
}

const originOf = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
};

export function setupPasskeys(options: Options) {
  const { windows } = options;
  const ceremonies = new Map<string, Ceremony>();
  const choices = new Map<string, Choice>();
  /** The prompt each tab shows (one at a time: Chromium runs one request per frame, and a tab rarely has two). */
  const prompts = new Map<number, PasskeyPrompt>();
  /** Tabs whose website agent is working (the window says so). */
  const agentRunning = new Set<number>();
  const tracked = new Set<number>();
  let ids = 0;

  const sendTo = (contents: WebContents, channel: string, ...args: unknown[]) =>
    windows.of(contents)?.webContents.send(channel, ...args);

  function show(contents: WebContents, prompt: PasskeyPrompt) {
    if (contents.isDestroyed()) return;
    prompts.set(contents.id, prompt);
    sendTo(contents, "rune:passkey-prompt", prompt);
  }

  /** Takes a tab's prompt away (only `requestId`'s, if given). */
  function hide(contentsId: number, requestId?: string) {
    const prompt = prompts.get(contentsId);
    if (!prompt || (requestId !== undefined && prompt.requestId !== requestId)) return;
    prompts.delete(contentsId);
    // To every window: the tab may have moved to another one meanwhile.
    windows.broadcast("rune:passkey-prompt-done", prompt.requestId);
  }

  function fail(contents: WebContents, site: string, failure: PasskeyFailure, requestId = `f${++ids}`) {
    show(contents, { requestId, contentsId: contents.id, site, kind: "failed", failure });
  }

  /**
   * Per tab that uses WebAuthn, once: Electron's console warning about a PIN, and the page going away. (Tabs have
   * many "destroyed" listeners already: closed ones are swept instead.)
   */
  function track(contents: WebContents) {
    if (tracked.has(contents.id)) return;
    tracked.add(contents.id);
    const id = contents.id;
    contents.on("console-message", (event) => {
      if (event.level !== "warning" || !isPinWarning(event.message)) return;
      for (const c of ceremonies.values()) if (c.contents.id === id) c.pin = true;
    });
    contents.on("did-navigate", () => {
      hide(id);
      for (const [requestId, choice] of [...choices]) if (choice.contentsId === id) answerChoice(requestId);
    });
  }

  /** Forgets what belonged to tabs that closed. */
  function sweep() {
    const gone = (id: number) => !webContents.fromId(id);
    for (const id of tracked) if (gone(id)) tracked.delete(id);
    for (const id of agentRunning) if (gone(id)) agentRunning.delete(id);
    for (const id of prompts.keys()) if (gone(id)) prompts.delete(id);
    for (const [requestId, c] of [...ceremonies]) if (c.contents.isDestroyed()) ceremonies.delete(requestId);
    for (const [requestId, choice] of [...choices]) if (gone(choice.contentsId)) answerChoice(requestId);
  }

  /** The web tab a frame's message comes from, with its origin; null if it isn't one. */
  function callerOf(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
    const contents = event.sender;
    const frame = event.senderFrame;
    if (!frame || frame.isDestroyed() || contents.isDestroyed()) return null;
    if (options.workspaceOf(contents.session) === undefined) return null;
    const origin = originOf(frame.url);
    return origin ? { contents, frame, origin } : null;
  }

  ipcMain.handle("passkeys:start", (event, raw: unknown) => {
    const caller = callerOf(event);
    const info = readRequestInfo(raw);
    if (!caller || !info) return null;
    sweep();
    const { contents, frame } = caller;
    const site = passkeySite(info.rpId, caller.origin);
    const headless = options.isHeadless(contents) || contents.getType() !== "webview";
    const decision = startDecision({
      platform: process.platform,
      info,
      agentRunning: agentRunning.has(contents.id),
      headless,
    });
    if (!decision.allow) {
      if (decision.failure && !headless) fail(contents, site, decision.failure);
      return { refused: true };
    }
    track(contents);
    const ceremony: Ceremony = {
      id: `p${++ids}`,
      contents,
      frame,
      ceremony: info.ceremony,
      site,
      cancelled: false,
      pin: false,
      prompted: decision.prompt,
    };
    ceremonies.set(ceremony.id, ceremony);
    if (decision.prompt)
      show(contents, {
        requestId: ceremony.id,
        contentsId: contents.id,
        site,
        kind: "waiting",
        ceremony: info.ceremony,
        passkey: info.passkey,
      });
    return { id: ceremony.id };
  });

  ipcMain.on("passkeys:end", (event, id: unknown, raw: unknown) => {
    const c = typeof id === "string" ? ceremonies.get(id) : undefined;
    // Only from the frame that started it.
    if (!c || event.sender !== c.contents || event.senderFrame !== c.frame) return;
    ceremonies.delete(c.id);
    const v = (raw ?? {}) as Record<string, unknown>;
    const outcome: PasskeyOutcome = {
      ok: v.ok === true,
      ...(typeof v.error === "string" ? { error: v.error.slice(0, 64) } : {}),
      ...(v.timedOut === true ? { timedOut: true } : {}),
    };
    hide(c.contents.id, c.id);
    // An account picker still showing (the page called the request off): Electron wants its answer all the same.
    for (const [choiceId, choice] of [...choices]) if (choice.ceremony === c) answerChoice(choiceId);
    // Failures are explained where Rune Browser's prompt was showing (Windows' dialog explains its own).
    const failure = c.prompted
      ? endFailure({ ceremony: c.ceremony, outcome, cancelled: c.cancelled, pin: c.pin })
      : null;
    if (failure && !c.contents.isDestroyed()) fail(c.contents, c.site, failure, c.id);
  });

  /** Calls off the request behind a prompt (Cancel): the page gets NotAllowedError, like Chrome's cancel. */
  function cancel(requestId: string) {
    const c = ceremonies.get(requestId);
    if (c) {
      c.cancelled = true;
      if (!c.frame.isDestroyed()) c.frame.send("passkeys:cancel", c.id);
    }
    for (const [choiceId, choice] of [...choices])
      if (choiceId === requestId || (c && choice.ceremony === c)) answerChoice(choiceId);
  }

  function answerChoice(requestId: string, credentialId?: string) {
    const choice = choices.get(requestId);
    if (!choice) return;
    choices.delete(requestId);
    try {
      choice.callback(credentialId);
    } catch (err) {
      console.warn("Answering a passkey account choice failed:", err);
    }
  }

  /**
   * A security key gave several passkeys for the site (Electron asks for one even when it's alone): the user
   * picks the account. Never while the agent works in the tab.
   */
  function selectAccount(
    details: Electron.SelectWebauthnAccountDetails,
    callback: (credentialId?: string | null) => void,
  ) {
    const frame = details.frame;
    const contents = frame && !frame.isDestroyed() ? webContents.fromFrame(frame) : undefined;
    if (!contents || contents.isDestroyed() || options.isHeadless(contents) || agentRunning.has(contents.id))
      return callback();
    const accounts = accountsToChoose(details.accounts);
    if (!accounts.length) return callback();
    const ceremony = [...ceremonies.values()].find((c) => c.frame === frame && !c.cancelled);
    // One account: the user touched their key for it already, as Chrome goes on.
    if (accounts.length === 1) return callback(accounts[0]!.credentialId);
    if (!windows.of(contents)) return callback();
    track(contents);
    const requestId = ceremony?.id ?? `a${++ids}`;
    choices.set(requestId, { contentsId: contents.id, callback, ceremony });
    const site = ceremony?.site ?? passkeySite(details.relyingPartyId, originOf(frame?.url ?? ""));
    show(contents, { requestId, contentsId: contents.id, site, kind: "account", accounts });
  }

  /** Web tab sessions (and the private one): set up once each. */
  const sessions = new WeakSet<Session>();
  function attach(s: Session) {
    if (sessions.has(s)) return;
    sessions.add(s);
    s.on("select-webauthn-account", (_event, details, callback) => {
      try {
        selectAccount(details, callback);
      } catch (err) {
        console.warn("Choosing a passkey account failed:", err);
        callback();
      }
    });
  }

  // --- The window -----------------------------------------------------------------------------------

  const tabFor = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, contentsId: unknown) => {
    const contents = typeof contentsId === "number" ? webContents.fromId(contentsId) : undefined;
    return contents && !contents.isDestroyed() && windows.of(contents)?.webContents === event.sender
      ? contents
      : undefined;
  };

  ipcMain.handle("rune:passkeys-pending", (event) =>
    [...prompts.values()].filter((prompt) => tabFor(event, prompt.contentsId)),
  );
  ipcMain.on("rune:passkeys-agent", (event, contentsId: unknown, running: unknown) => {
    const contents = tabFor(event, contentsId);
    if (!contents) return;
    sweep();
    if (running === true) agentRunning.add(contents.id);
    else agentRunning.delete(contents.id);
  });
  ipcMain.on("rune:passkeys-reply", (event, requestId: unknown, value: unknown) => {
    if (typeof requestId !== "string" || !value || typeof value !== "object") return;
    const prompt = [...prompts.values()].find((p) => p.requestId === requestId);
    if (!prompt || !tabFor(event, prompt.contentsId)) return;
    const reply = value as PasskeyReply;
    if (reply.action === "account" && prompt.kind === "account") {
      const credentialId = (reply as { credentialId?: unknown }).credentialId;
      if (typeof credentialId !== "string" || !prompt.accounts.some((a) => a.credentialId === credentialId)) return;
      // The request finishes on its own now (passkeys:end).
      hide(prompt.contentsId, requestId);
      answerChoice(requestId, credentialId);
    } else if (reply.action === "cancel") {
      hide(prompt.contentsId, requestId);
      cancel(requestId);
    } else if (reply.action === "dismiss" && prompt.kind === "failed") hide(prompt.contentsId, requestId);
  });

  return { attach };
}
