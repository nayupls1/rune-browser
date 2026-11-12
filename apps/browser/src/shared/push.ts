// Web push (the Push API) through ntfy: what's shared by the main process (main/push.ts), the page and worker
// API (extension-preload/push.ts) and Settings. Sites subscribe with pushManager.subscribe() as in Chrome; each
// subscription gets its own ntfy topic, whose address is the subscription's endpoint, and its own keys. Their
// server sends Web Push messages (RFC 8030, encrypted with RFC 8291's aes128gcm) to that address; ntfy keeps
// them (12 hours on ntfy.sh) and passes them on to Rune Browser, which decrypts them and wakes the site's service
// worker with a `push` event.
import type { BrowserSettings } from "./browser";

/** The public ntfy server, the default. */
export const NTFY_SH = "https://ntfy.sh";

/**
 * ntfy.sh charges UnifiedPush messages to the subscriber (Rune Browser) instead of the site's server, which
 * would hit its rate limits at once, only for topics of this exact form: "up" and 12 more characters (ntfy's
 * `isUnifiedPushTopic`). Others are refused with a 507 when published to with `?up=1`. 12 letters and digits
 * are 71 bits: not guessable over the network, and a topic only carries encrypted messages anyway (a message
 * needs the subscription's auth secret to be read, or to be taken as genuine).
 */
export const TOPIC_LENGTH = 14;
const TOPIC_PREFIX = "up";
const TOPIC_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const isTopic = (topic: unknown): topic is string =>
  typeof topic === "string" && /^up[A-Za-z0-9]{12}$/.test(topic);

/** A new topic from a source of random bytes (crypto's getRandomValues/randomBytes); unbiased. */
export function newTopic(randomBytes: (n: number) => Uint8Array): string {
  let out = TOPIC_PREFIX;
  while (out.length < TOPIC_LENGTH) {
    for (const b of randomBytes(32)) {
      // 248 = 4 × 62: the bytes above it would favor the first letters.
      if (b < 248 && out.length < TOPIC_LENGTH) out += TOPIC_ALPHABET[b % 62];
    }
  }
  return out;
}

/** A subscription's endpoint: where the site's server sends its messages (`up=1`: ntfy's UnifiedPush mode). */
export const endpointFor = (server: string, topic: string) => `${server}/${topic}?up=1`;

/** Loopback addresses: the only ones a custom server may use plain http on. */
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Your own ntfy server's address, checked and normalized (no trailing slash, query or hash), or null: an https
 * address (plain http only for this computer), without credentials.
 */
export function validPushServer(text: string): string | null {
  const value = text.trim();
  if (!value || value.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = LOOPBACK_HOST.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The ntfy server push goes through, or null: push is off, or your own server's address isn't valid (yet). */
export function pushServerOf(browser: Pick<BrowserSettings, "push">): string | null {
  const { service, server } = browser.push;
  if (service === "off") return null;
  if (service === "ntfy") return NTFY_SH;
  return validPushServer(server);
}

// --- ntfy's JSON stream -------------------------------------------------------------------------

export type NtfyEvent =
  | { kind: "message"; id: string; time: number; topic: string; body: Uint8Array }
  | { kind: "open" | "keepalive"; time: number };

/** Bigger than a Web Push message can be (4096 bytes; ntfy's limit too), with base64's growth. */
const MAX_MESSAGE_TEXT = 8192;

/** Decodes standard or URL-safe base64 (with or without padding); null if it isn't base64. */
export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\r\n]/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean) || clean.replace(/=+$/, "").length % 4 === 1) return null;
  const standard = clean.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  try {
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** URL-safe base64 without padding, as the Push API's keys and endpoints use it. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * One line of ntfy's JSON stream (`GET /<topics>/json`), read defensively since it comes from the network: a
 * message with its body as bytes (UnifiedPush messages that aren't text come base64-encoded, `encoding:
 * "base64"`), the stream opening, or a keepalive; null for anything else (messages with attachments, other
 * events, lines that aren't JSON).
 */
export function parseNtfyLine(line: string): NtfyEvent | null {
  if (!line.trim() || line.length > MAX_MESSAGE_TEXT * 2) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const time = typeof v.time === "number" && Number.isFinite(v.time) && v.time > 0 ? Math.floor(v.time) : null;
  if (time === null) return null;
  if (v.event === "open" || v.event === "keepalive") return { kind: v.event, time };
  if (v.event !== "message") return null;
  if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.id)) return null;
  if (!isTopic(v.topic) || typeof v.message !== "string" || v.message.length > MAX_MESSAGE_TEXT) return null;
  // Too big for a message, ntfy turned it into an attachment: not a Web Push message.
  if (v.attachment !== undefined) return null;
  if (v.encoding !== undefined && v.encoding !== "base64" && v.encoding !== "") return null;
  const body = v.encoding === "base64" ? decodeBase64(v.message) : new TextEncoder().encode(v.message);
  if (!body) return null;
  return { kind: "message", id: v.id, time, topic: v.topic, body };
}

// --- What pages see -----------------------------------------------------------------------------

/** What `PushManager.supportedContentEncodings` says, like Chrome (only aes128gcm arrives through ntfy). */
export const SUPPORTED_ENCODINGS = ["aes128gcm", "aesgcm"] as const;

/** Chrome's errors, word for word (Chromium's push_messaging_utils.cc and blink's push_manager.cc). */
export const PUSH_ERRORS = {
  permissionDenied: { name: "NotAllowedError", message: "Registration failed - permission denied" },
  noService: { name: "AbortError", message: "Registration failed - push service not available" },
  noKey: {
    name: "AbortError",
    message: "Registration failed - missing applicationServerKey, and manifest empty or missing",
  },
  keyMismatch: {
    name: "InvalidStateError",
    message:
      "Registration failed - A subscription with a different applicationServerKey (or gcm_sender_id) already exists; to change the applicationServerKey, unsubscribe then resubscribe.",
  },
  storage: { name: "AbortError", message: "Registration failed - storage error" },
  noWorker: { name: "AbortError", message: "Subscription failed - no active Service Worker" },
  invalidKey: { name: "InvalidAccessError", message: "The provided applicationServerKey is not valid." },
  keyEncoding: {
    name: "InvalidCharacterError",
    message: "The provided applicationServerKey is not encoded as base64url without padding.",
  },
  silentState: {
    name: "NotSupportedError",
    message: "Push subscriptions that don't enable userVisibleOnly are not supported.",
  },
  noNotificationPermission: {
    name: "TypeError",
    message: "No notification permission has been granted for this origin.",
  },
  openWindow: { name: "InvalidAccessError", message: "Not allowed to open a window." },
  focus: { name: "InvalidAccessError", message: "Not allowed to focus a window." },
} as const;
export type PushError = { name: string; message: string };

/** What Chrome logs to the console for `subscribe({ userVisibleOnly: false })`, before refusing it. */
export const SILENT_PUSH_MESSAGE =
  "Chrome currently only supports the Push API for subscriptions that will result in user-visible messages. You can indicate this by calling pushManager.subscribe({userVisibleOnly: true}) instead. See https://goo.gl/yqv4Q4 for more details.";

/** A subscription as pages get it (`PushSubscription`: endpoint, keys, the options it was made with). */
export interface PushSubscriptionInfo {
  endpoint: string;
  /** The subscription's public key (P-256, uncompressed), base64url. */
  p256dh: string;
  /** Its 16-byte auth secret, base64url. */
  auth: string;
  /** The site's applicationServerKey, base64url. */
  key: string;
}

/** A subscription as Settings lists it (a site's settings): no keys. */
export interface PushSubscriptionSummary {
  id: string;
  workspaceId: string;
  origin: string;
  scope: string;
  createdAt: number;
}

/** A notification a site's service worker (or page) showed, as `getNotifications()` and its events get it. */
export interface PushNotificationInfo {
  id: string;
  title: string;
  body: string;
  tag: string;
  /** The notification's `data`, as JSON. */
  data: string;
  icon: string;
  badge: string;
  image: string;
  lang: string;
  dir: "auto" | "ltr" | "rtl";
  timestamp: number;
  renotify: boolean;
  silent: boolean | null;
  requireInteraction: boolean;
  actions: { action: string; title: string; icon: string }[];
}

/** A notification's options from a page, checked and cut to size (`showNotification(title, options)`). */
export function notificationFrom(id: string, title: unknown, options: unknown, now: number): PushNotificationInfo {
  const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const url = (v: unknown) => (typeof v === "string" && /^(https?:|data:image\/)/i.test(v) ? v.slice(0, 100_000) : "");
  const actions = Array.isArray(o.actions) ? o.actions : [];
  return {
    id,
    title: text(title, 1000),
    body: text(o.body, 5000),
    tag: text(o.tag, 1000),
    data: typeof o.data === "string" && o.data.length <= 1_000_000 ? o.data : "null",
    icon: url(o.icon),
    badge: url(o.badge),
    image: url(o.image),
    lang: text(o.lang, 50),
    dir: o.dir === "ltr" || o.dir === "rtl" ? o.dir : "auto",
    timestamp: typeof o.timestamp === "number" && Number.isFinite(o.timestamp) ? o.timestamp : now,
    renotify: o.renotify === true,
    silent: typeof o.silent === "boolean" ? o.silent : null,
    requireInteraction: o.requireInteraction === true,
    actions: actions.slice(0, 2).flatMap((a: unknown) => {
      if (!a || typeof a !== "object") return [];
      const v = a as Record<string, unknown>;
      return typeof v.action === "string" && typeof v.title === "string"
        ? [{ action: v.action.slice(0, 200), title: v.title.slice(0, 200), icon: url(v.icon) }]
        : [];
    }),
  };
}
