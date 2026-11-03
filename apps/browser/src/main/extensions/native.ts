// Native messaging: extensions talking to programs installed for them (password
// managers, download helpers…). Hosts are found the way Chrome finds them, in
// Rune Browser's own folder first and then the browsers' (so what was set up for
// Chrome keeps working), and only the extensions a host lists may start it.
// Messages are JSON with a 32-bit length in front, over the program's stdio.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { browserDirs, nativeHostsDir } from "./browsers";
import { readJson } from "./registry";

interface HostManifest {
  name: string;
  path: string;
  type?: string;
  allowed_origins?: string[];
}

const MAX_MESSAGE = 64 * 1024 * 1024;

/** Folders with host manifests, best first. */
function hostDirs() {
  const dirs = [nativeHostsDir()];
  for (const { dir } of browserDirs()) dirs.push(join(dir, "NativeMessagingHosts"));
  if (process.platform === "linux") {
    dirs.push(
      "/etc/opt/chrome/native-messaging-hosts",
      "/etc/chromium/native-messaging-hosts",
      "/etc/opt/edge/native-messaging-hosts",
      "/etc/opt/brave/native-messaging-hosts",
    );
  } else if (process.platform === "darwin") {
    dirs.push(
      "/Library/Google/Chrome/NativeMessagingHosts",
      "/Library/Application Support/Chromium/NativeMessagingHosts",
      join(homedir(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts"),
    );
  }
  return dirs;
}

/** The host manifest for a name that lets this extension in, or null. */
export function findHost(name: string, extensionId: string): HostManifest | null {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(name)) return null;
  const origin = `chrome-extension://${extensionId}/`;
  for (const dir of hostDirs()) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) continue;
    const host = readJson<HostManifest>(file);
    if (!host || host.name !== name || typeof host.path !== "string") continue;
    if (!host.allowed_origins?.includes(origin)) continue;
    return { ...host, path: isAbsolute(host.path) ? host.path : resolve(dirname(file), host.path) };
  }
  return null;
}

/** Whether any host lets this extension in. */
export function hasHostsFor(extensionId: string) {
  const origin = `chrome-extension://${extensionId}/`;
  for (const dir of hostDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files)
      if (f.endsWith(".json") && readJson<HostManifest>(join(dir, f))?.allowed_origins?.includes(origin)) return true;
  }
  return false;
}

/** The environment hosts get: Rune Browser's own variables stay out. */
function hostEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("RUNE_") && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  return env;
}

export interface NativePort {
  post: (message: unknown) => void;
  close: () => void;
}

/**
 * Starts a host and connects to it. `onMessage` gets each message, `onClose`
 * once, with an error message when it didn't end well.
 */
export function connectNative(
  name: string,
  extensionId: string,
  onMessage: (message: unknown) => void,
  onClose: (error: string | null) => void,
): NativePort {
  const host = findHost(name, extensionId);
  let closed = false;
  const close = (error: string | null) => {
    if (closed) return;
    closed = true;
    onClose(error);
  };
  if (!host) {
    queueMicrotask(() => close("Specified native messaging host not found."));
    return { post: () => {}, close: () => {} };
  }
  const args = [`chrome-extension://${extensionId}/`];
  if (process.platform === "win32") args.push("--parent-window=0");
  let child: ChildProcess;
  try {
    child = spawn(host.path, args, {
      cwd: dirname(host.path),
      env: hostEnv(),
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
  } catch {
    queueMicrotask(() => close("Failed to start native messaging host."));
    return { post: () => {}, close: () => {} };
  }
  let buffer = Buffer.alloc(0);
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE) {
        child.kill();
        return close("Error when communicating with the native messaging host.");
      }
      if (buffer.length < 4 + length) break;
      const text = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(text));
      } catch {
        child.kill();
        return close("Error when communicating with the native messaging host.");
      }
    }
  });
  child.on("error", () => close("Failed to start native messaging host."));
  child.on("exit", () => close("Native host has exited."));
  child.stdin!.on("error", () => {});
  return {
    post: (message) => {
      if (closed) return;
      const body = Buffer.from(JSON.stringify(message), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      child.stdin!.write(Buffer.concat([head, body]));
    },
    close: () => {
      closed = true;
      child.stdin!.end();
      setTimeout(() => child.kill(), 1000).unref();
    },
  };
}

/** chrome.runtime.sendNativeMessage: one message, one reply. */
export function sendNativeMessage(name: string, extensionId: string, message: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let done = false;
    const port = connectNative(
      name,
      extensionId,
      (reply) => {
        if (done) return;
        done = true;
        port.close();
        resolvePromise(reply);
      },
      (error) => {
        if (done) return;
        done = true;
        reject(new Error(error ?? "Native host has exited."));
      },
    );
    port.post(message);
  });
}
