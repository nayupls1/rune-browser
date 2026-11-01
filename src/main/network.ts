// The network layer of web tabs. Traffic is captured over the DevTools protocol
// into a bounded log per tab (bodies of structured responses only, within a
// memory budget), replayed with the workspace's session (cookies come from the
// session, other credentials stay in this process), and changed by rules
// (block, set headers), which Rune Browser's built-in extension applies as
// declarativeNetRequest rules (see extensions/builtin.ts).
//
// The Rune Browser window reads it over IPC. Credentials leave this process only
// when the user asks to see them (reveal); the website agent gets everything
// redacted, and saved requests carry their credentials sealed with a key only
// this process uses.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  ipcMain,
  webContents,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import type {
  NetworkFilter,
  NetworkRule,
  ReplayOverrides,
  ReplayResult,
  ReplayTarget,
  RequestDraft,
} from "../shared/api";
import {
  BodyBudget,
  isSensitiveName,
  isStructured,
  redactBody,
  redactHeaders,
  redactUrl,
  REDACTED,
  TrafficLog,
  urlMatcher,
  type Captured,
} from "../shared/network";
import { observe, type Observation } from "../shared/endpoints";
import * as cdp from "./cdp";
import { loadSecretsKey } from "./secretsKey";

const MAX_REQUEST_BODY = 64 * 1024;
const MAX_REPLAY_BODY = 512 * 1024;
const SKIPPED_SCHEMES = /^(data|blob|chrome-extension|devtools):/i;
/**
 * Never sent along on a replay: the network stack sets them, or refuses them
 * (Sec-Fetch-*, Origin, Host). Cookies come from the session.
 */
const HOP_HEADERS =
  /^(:|host$|origin$|sec-fetch-|content-length$|connection$|keep-alive$|transfer-encoding$|upgrade$|te$|trailer$|accept-encoding$|cookie$)/i;

interface CompiledRule {
  rule: NetworkRule;
  matches: (url: string) => boolean;
}

export interface NetworkOptions {
  getWindow: () => BrowserWindow | undefined;
  /** The session of a workspace's web tabs (set up on first use). */
  webSession: (workspaceId: string) => Session;
  /** The workspace a web tab session belongs to, or undefined for other sessions. */
  workspaceOf: (session: Session) => string | undefined;
  /** Puts the rules into effect. */
  applyRules: (rules: NetworkRule[]) => void;
  /** A web tab's API call, as shapes (no values), for the API map. */
  onApiCall?: (workspaceId: string, observation: Observation) => void;
}

export function setupNetwork(options: NetworkOptions) {
  const { getWindow } = options;
  const budget = new BodyBudget();
  const logs = new Map<number, TrafficLog>();
  /** What marks a tab's requests as answered by a response override: DevTools request id → its title. */
  const markers = new Map<number, (requestId: string, title: string) => void>();
  const detachers = new Map<number, () => void>();
  let recording = true;
  let rules: CompiledRule[] = [];

  // --- Rules ----------------------------------------------------------------------------

  const rulesFor = (workspaceId: string | undefined, url: string) =>
    workspaceId === undefined
      ? []
      : rules.filter(
          (r) =>
            r.rule.enabled && (r.rule.workspaceId === null || r.rule.workspaceId === workspaceId) && r.matches(url),
        );

  // --- Capture --------------------------------------------------------------------------

  const notifyTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const notify = (id: number) => {
    if (notifyTimers.has(id)) return;
    notifyTimers.set(
      id,
      setTimeout(() => {
        notifyTimers.delete(id);
        getWindow()?.webContents.send("rune:network-changed", id);
      }, 300),
    );
  };

  /** Starts recording a web tab's traffic. */
  function watch(contents: WebContents) {
    if (!recording || logs.has(contents.id) || contents.isDestroyed()) return;
    const dbg = contents.debugger;
    if (!cdp.acquire(contents, "network")) return;
    const id = contents.id;
    const log = new TrafficLog(budget);
    logs.set(id, log);
    const workspaceId = options.workspaceOf(contents.session);
    // DevTools request id → the entry (redirects reuse the id, so it moves on to the next entry).
    const current = new Map<string, Captured>();
    // Extra headers (with cookies) can arrive before or after the request they belong to.
    const early = new Map<string, { request?: Record<string, string>; response?: Record<string, string> }>();

    const send = <T>(method: string, params: object) => dbg.sendCommand(method, params) as Promise<T>;
    /** An API call of a web tab (fetch, XHR, structured data) that finished: into the API map, as shapes. */
    const mapped = (entry: Captured) => {
      if (workspaceId === undefined || !options.onApiCall || entry.status === null || entry.error) return;
      if (!["XHR", "Fetch", "EventSource"].includes(entry.type) && !isStructured(entry.mimeType, entry.type)) return;
      try {
        const observation = observe({
          method: entry.method,
          url: entry.url,
          pageUrl: contents.isDestroyed() ? entry.url : contents.getURL(),
          requestHeaders: entry.requestHeaders,
          requestBody: entry.requestBody,
          status: entry.status,
          mimeType: entry.mimeType,
          responseBody: entry.responseBody,
        });
        if (observation) options.onApiCall(workspaceId, observation);
      } catch (err) {
        console.warn("Mapping an API call failed:", err);
      }
    };
    // Overrides pause requests before they're sent, so the mark can come first.
    const marks = new Map<string, string>();
    markers.set(id, (requestId, title) => {
      const entry = current.get(requestId);
      if (entry) entry.override = title;
      else {
        if (marks.size > 500) marks.clear();
        marks.set(requestId, title);
      }
    });
    const finish = (requestId: string) => {
      current.delete(requestId);
      marks.delete(requestId);
      early.delete(requestId);
      if (early.size > 2000) early.clear();
    };

    const onMessage = (_event: unknown, method: string, p: any) => {
      switch (method) {
        case "Network.requestWillBeSent": {
          // Extensions' own requests (an options page in a tab) aren't the site's.
          if (SKIPPED_SCHEMES.test(p.request.url) || SKIPPED_SCHEMES.test(p.documentURL ?? "")) return;
          const previous = current.get(p.requestId);
          if (previous && p.redirectResponse) {
            previous.status = p.redirectResponse.status;
            previous.mimeType = p.redirectResponse.mimeType ?? "";
            previous.responseHeaders = { ...previous.responseHeaders, ...p.redirectResponse.headers };
            previous.durationMs = Math.round((p.timestamp - previous.startTs) * 1000);
            previous.bodyNote = "A redirect";
          }
          const postData: string | undefined = p.request.postData;
          const rule = rulesFor(workspaceId, p.request.url)[0]?.rule.pattern ?? null;
          const entry = log.add({
            method: p.request.method,
            url: p.request.url,
            type: p.type ?? "Other",
            status: null,
            mimeType: "",
            size: 0,
            startedAt: Math.round((p.wallTime ?? Date.now() / 1000) * 1000),
            startTs: p.timestamp,
            durationMs: null,
            error: null,
            rule,
            override: marks.get(p.requestId) ?? previous?.override ?? null,
            requestHeaders: { ...p.request.headers, ...early.get(p.requestId)?.request },
            responseHeaders: {},
            requestBody: postData === undefined ? null : postData.slice(0, MAX_REQUEST_BODY),
            responseBody: null,
            bodyNote: null,
          });
          current.set(p.requestId, entry);
          if (p.request.hasPostData && postData === undefined) {
            void send<{ postData: string }>("Network.getRequestPostData", { requestId: p.requestId })
              .then((r) => void (entry.requestBody = r.postData.slice(0, MAX_REQUEST_BODY)))
              .catch(() => {});
          }
          break;
        }
        case "Network.requestWillBeSentExtraInfo": {
          const entry = current.get(p.requestId);
          if (entry) entry.requestHeaders = { ...entry.requestHeaders, ...p.headers };
          else early.set(p.requestId, { ...early.get(p.requestId), request: p.headers });
          return;
        }
        case "Network.responseReceived": {
          const entry = current.get(p.requestId);
          if (!entry) return;
          entry.status = p.response.status;
          entry.mimeType = p.response.mimeType ?? "";
          entry.responseHeaders = {
            ...p.response.headers,
            ...early.get(p.requestId)?.response,
            ...entry.responseHeaders,
          };
          break;
        }
        case "Network.responseReceivedExtraInfo": {
          const entry = current.get(p.requestId);
          if (entry) entry.responseHeaders = { ...entry.responseHeaders, ...p.headers };
          else early.set(p.requestId, { ...early.get(p.requestId), response: p.headers });
          return;
        }
        case "Network.loadingFinished": {
          const entry = current.get(p.requestId);
          if (!entry) return;
          finish(p.requestId);
          entry.size = p.encodedDataLength ?? 0;
          entry.durationMs = Math.round((p.timestamp - entry.startTs) * 1000);
          if (!isStructured(entry.mimeType, entry.type)) {
            entry.bodyNote = "Not kept: only structured data (JSON, XML, forms, text) is";
            mapped(entry);
          } else if (entry.size > log.limits.body) {
            entry.bodyNote = "Too large to keep";
            mapped(entry);
          } else {
            void send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: p.requestId })
              .then((r) => {
                if (r.base64Encoded) entry.bodyNote = "Binary";
                else log.setBody(entry, r.body);
                mapped(entry);
                notify(id);
              })
              .catch(() => {
                entry.bodyNote = "No longer available";
                mapped(entry);
              });
          }
          break;
        }
        case "Network.loadingFailed": {
          const entry = current.get(p.requestId);
          if (!entry) return;
          finish(p.requestId);
          entry.durationMs = Math.round((p.timestamp - entry.startTs) * 1000);
          entry.error = p.canceled
            ? "Canceled"
            : /ERR_BLOCKED_BY_CLIENT/.test(p.errorText ?? "")
              ? entry.rule
                ? "Blocked by a rule"
                : "Blocked by an extension"
              : p.blockedReason
                ? `Blocked (${p.blockedReason})`
                : (p.errorText ?? "Failed");
          break;
        }
        default:
          return;
      }
      notify(id);
    };

    dbg.on("message", onMessage);
    const stop = () => {
      dbg.removeListener("message", onMessage);
      log.dispose();
      logs.delete(id);
      markers.delete(id);
      detachers.delete(id);
    };
    detachers.set(id, () => {
      stop();
      // The agents' DevTools may still use the connection.
      void send("Network.disable", {}).catch(() => {});
      cdp.release(contents, "network");
    });
    dbg.once("detach", stop);
    contents.once("destroyed", stop);
    // Chrome's own buffers for bodies stay small: they're only read right when a response finishes.
    send("Network.enable", {
      maxTotalBufferSize: 8_000_000,
      maxResourceBufferSize: 2_000_000,
      maxPostDataSize: MAX_REQUEST_BODY,
    }).catch((err) => console.warn("Can't record the traffic of a web tab:", err));
  }

  function setRecording(enabled: boolean) {
    if (enabled === recording) return;
    recording = enabled;
    if (!enabled) {
      for (const detach of [...detachers.values()]) detach();
      return;
    }
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() === "webview") watch(contents);
    }
  }

  // --- Sealing credentials ----------------------------------------------------------------

  let sealKey: Buffer | null | undefined;
  const key = () => {
    if (sealKey === undefined) {
      const secrets = loadSecretsKey();
      sealKey = secrets ? createHash("sha256").update(`rune-network-seal-v1:${secrets.key}`).digest() : null;
    }
    return sealKey;
  };

  interface Sealed {
    headers: Record<string, string>;
    params: Record<string, string>;
    body: string | null;
  }

  function seal(value: Sealed) {
    const k = key();
    if (!k) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", k, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  function unseal(sealed: string): Sealed | null {
    const k = key();
    if (!k) return null;
    try {
      const raw = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    } catch {
      return null;
    }
  }

  /** A captured request without its credentials, which are sealed (headers, URL parameters, a body with a password…). */
  function draft(entry: Captured): RequestDraft {
    const headers: Record<string, string> = {};
    const secret: Sealed = { headers: {}, params: {}, body: null };
    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      if (HOP_HEADERS.test(name)) continue;
      if (isSensitiveName(name)) secret.headers[name] = value;
      else headers[name] = value;
    }
    let url = entry.url;
    try {
      const parsed = new URL(entry.url);
      for (const [name, value] of [...parsed.searchParams]) {
        if (!isSensitiveName(name, true)) continue;
        secret.params[name] = value;
        parsed.searchParams.set(name, REDACTED);
      }
      url = parsed.toString();
    } catch {
      // keep it as it is
    }
    let body = entry.requestBody;
    if (body !== null) {
      const redacted = redactBody(body, entry.requestHeaders["content-type"] ?? entry.requestHeaders["Content-Type"]);
      if (redacted !== body) {
        secret.body = body;
        body = redacted;
      }
    }
    const hasSecrets =
      Object.keys(secret.headers).length > 0 || Object.keys(secret.params).length > 0 || secret.body !== null;
    return { method: entry.method, url, headers, body, sealed: hasSecrets ? seal(secret) : null };
  }

  /** Puts a draft's sealed credentials back. */
  function open(d: RequestDraft) {
    const secret = d.sealed ? unseal(d.sealed) : null;
    let url = d.url;
    if (secret && Object.keys(secret.params).length) {
      const parsed = new URL(d.url);
      for (const [name, value] of Object.entries(secret.params))
        if (parsed.searchParams.has(name)) parsed.searchParams.set(name, value);
      url = parsed.toString();
    }
    return { method: d.method, url, headers: { ...d.headers, ...secret?.headers }, body: secret?.body ?? d.body };
  }

  // --- Replay ------------------------------------------------------------------------------

  async function replay(
    s: Session,
    request: { method: string; url: string; headers: Record<string, string>; body: string | null },
    overrides: ReplayOverrides,
    reveal: boolean,
  ): Promise<ReplayResult> {
    const url = overrides.url ?? request.url;
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) requests can be sent");
    const method = (overrides.method ?? request.method).toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) if (!HOP_HEADERS.test(name)) headers[name] = value;
    setHeaders(headers, overrides.headers ?? {});
    // The rules apply here too (DNR only sees the pages' own requests).
    const matched = rulesFor(options.workspaceOf(s), url);
    const blocking = matched.find((r) => r.rule.action === "block");
    if (blocking) throw new Error(`Blocked by a rule (${blocking.rule.pattern})`);
    for (const { rule } of matched) setHeaders(headers, rule.requestHeaders);
    const body = overrides.body !== undefined ? overrides.body : request.body;
    const started = Date.now();
    const res = await s.fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" || body === null ? undefined : body,
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const textual = isStructured(mimeType, "Fetch") || /^text\//i.test(mimeType) || /javascript/i.test(mimeType);
    let size = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REPLAY_BODY) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        if (textual) chunks.push(value);
      }
    }
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, name) => (responseHeaders[name] = value));
    const text = textual ? Buffer.concat(chunks).toString("utf8") : null;
    return {
      url: reveal ? res.url : redactUrl(res.url),
      status: res.status,
      statusText: res.statusText,
      mimeType,
      headers: reveal ? responseHeaders : redactHeaders(responseHeaders),
      body: text === null ? null : reveal ? text : redactBody(text, mimeType),
      truncated,
      size,
      durationMs: Date.now() - started,
      redacted: !reveal,
    };
  }

  // --- IPC from the Rune Browser window ----------------------------------------------------------

  const fromWindow = (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => event.sender === getWindow()?.webContents;
  /** A web tab of the window that asks. */
  const guest = (event: IpcMainInvokeEvent, id: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!fromWindow(event) || !target || target.getType() !== "webview" || target.hostWebContents !== event.sender)
      throw new Error("Unknown page");
    return target;
  };
  const logOf = (event: IpcMainInvokeEvent, id: unknown) => {
    const target = guest(event, id);
    const log = logs.get(target.id);
    return { target, log };
  };

  ipcMain.handle("rune:network-list", (event, id: unknown, filter: unknown) => {
    const { log } = logOf(event, id);
    return log ? log.list((filter ?? {}) as NetworkFilter) : [];
  });
  ipcMain.handle("rune:network-get", (event, id: unknown, entryId: unknown, reveal: unknown) => {
    const { log } = logOf(event, id);
    return log && typeof entryId === "string" ? log.detail(entryId, reveal !== true) : null;
  });
  ipcMain.handle("rune:network-clear", (event, id: unknown) => {
    logOf(event, id).log?.clear("The user cleared the log.");
  });
  ipcMain.handle("rune:network-use", (event, id: unknown, entryId: unknown, chat: unknown) => {
    const { log } = logOf(event, id);
    if (typeof entryId !== "string" || typeof chat !== "string") throw new Error("Bad request");
    if (!log) return { gone: "This tab's traffic isn't being recorded (it can be turned off in Settings)." };
    const entry = log.detail(entryId);
    if (!entry) return { gone: log.whyGone(entryId) };
    log.keep([entryId], chat);
    return { entry };
  });
  ipcMain.handle("rune:network-draft", (event, id: unknown, entryId: unknown) => {
    const entry = typeof entryId === "string" ? logOf(event, id).log?.get(entryId) : undefined;
    if (!entry) throw new Error("That request is no longer in the log");
    return draft(entry);
  });
  ipcMain.handle("rune:network-replay", async (event, target: ReplayTarget, overrides: unknown, reveal: unknown) => {
    const changes = (overrides ?? {}) as ReplayOverrides;
    if (target && "webContentsId" in target) {
      const { target: contents, log } = logOf(event, target.webContentsId);
      const entry = log?.get(target.id);
      if (!entry) throw new Error("That request is no longer in the log");
      return replay(
        contents.session,
        { method: entry.method, url: entry.url, headers: entry.requestHeaders, body: entry.requestBody },
        changes,
        reveal === true,
      );
    }
    if (!fromWindow(event) || !target || typeof target.workspaceId !== "string" || !/^[\w-]+$/.test(target.workspaceId))
      throw new Error("Unknown workspace");
    return replay(options.webSession(target.workspaceId), open(target.draft), changes, reveal === true);
  });
  ipcMain.on("rune:network-rules", (event, list: unknown) => {
    if (!fromWindow(event) || !Array.isArray(list)) return;
    rules = (list as NetworkRule[]).map((rule) => ({ rule, matches: urlMatcher(rule.pattern) }));
    options.applyRules(list as NetworkRule[]);
  });
  ipcMain.on("rune:network-recording", (event, enabled: unknown) => {
    if (fromWindow(event)) setRecording(enabled !== false);
  });

  return {
    watch,
    markOverridden: (webContentsId: number, requestId: string, title: string) =>
      markers.get(webContentsId)?.(requestId, title),
  };
}

/** Sets headers case-insensitively; null removes one. */
function setHeaders(headers: Record<string, string>, changes: Record<string, string | null>) {
  for (const [name, value] of Object.entries(changes)) {
    for (const existing of Object.keys(headers))
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    if (value !== null) headers[name] = value;
  }
}
