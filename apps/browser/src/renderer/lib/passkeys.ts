// Passkeys and security keys in this window's web tabs (main/passkeys.ts decides): the prompt each
// tab shows while a page's WebAuthn request waits, the account picker, and why one failed.
import { createSignal } from "solid-js";
import type { PasskeyPrompt, PasskeyReply } from "../../shared/passkeys";

const bridge = window.rune.web.passkeys;

const [prompts, setPrompts] = createSignal<PasskeyPrompt[]>([]);

/** A tab shows one prompt: a newer one replaces it. */
const addPrompt = (prompt: PasskeyPrompt) =>
  setPrompts((list) => [...list.filter((p) => p.contentsId !== prompt.contentsId), prompt]);

bridge.onPrompt(addPrompt);
bridge.onPromptDone((requestId) => setPrompts((list) => list.filter((p) => p.requestId !== requestId)));
// After the window reloaded: what's still showing.
void bridge.pending().then((list) => list.forEach(addPrompt));

export const passkeyPromptFor = (contentsId: number | null) =>
  contentsId === null ? undefined : prompts().find((p) => p.contentsId === contentsId);

export function replyToPasskeyPrompt(prompt: PasskeyPrompt, reply: PasskeyReply) {
  setPrompts((list) => list.filter((p) => p.requestId !== prompt.requestId));
  bridge.reply(prompt.requestId, reply);
}

/** Tells main whether the website agent works in a tab (its pages' requests are refused meanwhile). */
export const setAgentRunning = (contentsId: number, running: boolean) => bridge.agentRunning(contentsId, running);
