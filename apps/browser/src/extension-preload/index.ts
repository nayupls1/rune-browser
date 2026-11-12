// Preload of web tab sessions, for service workers and frames. chrome-extension:// pages and workers get the
// missing chrome.* APIs (see shim.ts; not Chromium's PDF viewer), websites' pages and workers the Push API
// (see push.ts), websites' frames Rune Browser's prompts around passkeys (see passkeys.ts), each talking to
// the main process over IPC.
import { contextBridge, ipcRenderer } from "electron";
import { BUILTIN_EXTENSION_ID, extensionIdOf, PERMISSIONS_WITHOUT_API } from "../shared/extensions";
import { adjustedTimeout, NOT_ALLOWED_MESSAGE } from "../shared/passkeys";
import { PUSH_ERRORS, SILENT_PUSH_MESSAGE, SUPPORTED_ENCODINGS } from "../shared/push";
import { passkeyShim, type PasskeyBridge } from "./passkeys";
import { pushShim, type PushBridge } from "./push";
import { shim, type ShimBridge } from "./shim";

const worker = process.type === "service-worker";

function href(): string {
  if (!worker) return String(location.href);
  try {
    return String(contextBridge.executeInMainWorld({ func: () => String(location.href) }));
  } catch {
    return "";
  }
}

const id = extensionIdOf(href());
/** Chromium's PDF viewer, a component extension: Electron gives it its own APIs, which the shim would break. */
const PDF_VIEWER = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

if (id && id !== PDF_VIEWER) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const bridge: ShimBridge = {
    // The main process hooks a worker's IPC as it starts: early calls may come before that.
    call: async (method, args) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await ipcRenderer.invoke("crx:call", method, args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt < 40 && /No handler registered/i.test(message)) {
            await sleep(50);
            continue;
          }
          return { error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") };
        }
      }
    },
    onEvent: (fn) => {
      ipcRenderer.on("crx:event", (_event, name: string, args: unknown[]) => fn(name, args));
    },
  };
  contextBridge.executeInMainWorld({
    func: shim,
    args: [bridge, { id, worker, builtin: id === BUILTIN_EXTENSION_ID, withoutApi: [...PERMISSIONS_WITHOUT_API] }],
  });
}

// Websites (http and https; the API only exists in secure contexts): the Push API through Rune Browser's push
// service (main/push.ts). A worker's calls go to its own ServiceWorkerMain, hooked as it starts: early calls may
// come before that.
if (/^https?:/i.test(href())) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const bridge: PushBridge = {
    call: async (method, args) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await ipcRenderer.invoke("push:call", method, args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (worker && attempt < 40 && /No handler registered/i.test(message)) {
            await sleep(50);
            continue;
          }
          return { error: PUSH_ERRORS.noService };
        }
      }
    },
    onEvent: (fn) => {
      if (worker) ipcRenderer.on("push:event", (_event, value: unknown) => fn(value));
    },
  };
  try {
    contextBridge.executeInMainWorld({
      func: pushShim,
      args: [
        bridge,
        { worker, encodings: [...SUPPORTED_ENCODINGS], errors: { ...PUSH_ERRORS }, silentMessage: SILENT_PUSH_MESSAGE },
      ],
    });
  } catch (err) {
    console.warn("Rune Browser's Push API didn't start:", err);
  }
}

// Websites' frames: passkeys and security keys (WebAuthn) still go to Chromium; the main process (main/passkeys.ts)
// hears when one starts and ends, to show its prompt, call it off, or refuse it while the website agent works.
if (!worker && /^https?:/i.test(href())) {
  const cancelled = new Set<(id: string) => void>();
  ipcRenderer.on("passkeys:cancel", (_event, id: unknown) => {
    if (typeof id === "string") for (const fn of cancelled) fn(id);
  });
  const bridge: PasskeyBridge = {
    start: (info) => ipcRenderer.invoke("passkeys:start", info).catch(() => null),
    end: (id, outcome) => ipcRenderer.send("passkeys:end", id, outcome),
    onCancel: (fn) => void cancelled.add(fn),
  };
  try {
    contextBridge.executeInMainWorld({
      func: passkeyShim,
      args: [bridge, { notAllowed: NOT_ALLOWED_MESSAGE, timeouts: [adjustedTimeout(0), adjustedTimeout()] }],
    });
  } catch (err) {
    console.warn("Rune Browser's passkey prompts didn't start:", err);
  }
}
