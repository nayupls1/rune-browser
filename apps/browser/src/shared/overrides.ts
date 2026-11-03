// Response overrides: what a web tab's API requests return can be replaced
// (status, headers, body), made to fail, slowed down or left hanging, so a page
// can be put in any state. Electron's main process applies them
// (main/overrides.ts); these are the parts that don't need it: checking,
// matching and describing them, and the headers of an answer.
import type { OverrideFailure, OverrideScope, ResponseOverride, ResponseOverrideSpec } from "./api";
import { urlMatcher } from "./network";
import { hostOf } from "./web";

export const MAX_OVERRIDE_BODY = 1_000_000;
export const MAX_OVERRIDE_DELAY = 120_000;
/** Overrides per workspace. */
export const MAX_OVERRIDES = 200;

export const overrideFailures: Record<OverrideFailure, string> = {
  Failed: "Network error",
  TimedOut: "Timed out",
  ConnectionRefused: "Connection refused",
  InternetDisconnected: "Offline",
  NameNotResolved: "Server not found",
  Aborted: "Aborted",
};

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/** A spec with every field, from one that may leave some out. */
export function overrideSpec(input: Partial<ResponseOverrideSpec> & Pick<ResponseOverrideSpec, "pattern">) {
  const spec: ResponseOverrideSpec = {
    title: (input.title ?? "").trim().slice(0, 120) || input.pattern.trim().slice(0, 120),
    scope: input.scope ?? { type: "workspace" },
    pattern: input.pattern.trim(),
    method: input.method ? input.method.toUpperCase() : null,
    kind: input.kind ?? "respond",
    status: input.status ?? null,
    headers: input.headers ?? {},
    body: input.body ?? null,
    failure: input.failure ?? "Failed",
    delayMs: Math.round(input.delayMs ?? 0),
    expiresAt: input.expiresAt ?? null,
  };
  return spec;
}

/** What's wrong with a spec; null if it's fine. */
export function overrideProblem(spec: ResponseOverrideSpec): string | null {
  if (!spec.pattern.trim()) return "A pattern of the requests to answer is needed";
  if (spec.pattern.length > 1000) return "The pattern is too long";
  if (spec.method !== null && !/^[A-Z]{1,16}$/.test(spec.method)) return "Invalid method";
  if (spec.scope.type === "site" && !/^[\w.-]+(:\d+)?$/.test(spec.scope.host)) return "Invalid site";
  if (spec.scope.type === "tab" && !/^[\w-]{1,100}$/.test(spec.scope.tabId)) return "Invalid tab";
  if (spec.status !== null && (!Number.isInteger(spec.status) || spec.status < 200 || spec.status > 599))
    return "The status must be between 200 and 599";
  if (spec.body !== null && spec.body.length > MAX_OVERRIDE_BODY) return "The body is too large (1 MB at most)";
  const names = Object.keys(spec.headers);
  if (names.length > 50) return "Too many headers";
  const bad = names.find((n) => !HEADER_NAME.test(n));
  if (bad !== undefined) return `Invalid header name: ${bad.slice(0, 100)}`;
  if (Object.values(spec.headers).some((v) => v !== null && /[\r\n]/.test(v)))
    return "Header values can't contain line breaks";
  if (!(spec.failure in overrideFailures)) return "Unknown failure";
  if (!Number.isFinite(spec.delayMs) || spec.delayMs < 0 || spec.delayMs > MAX_OVERRIDE_DELAY)
    return "The delay must be between 0 and 120 seconds";
  if (spec.expiresAt !== null && Number.isNaN(Date.parse(spec.expiresAt))) return "Invalid expiry";
  if (spec.kind === "respond" && spec.status === null && spec.body === null && !names.length && !spec.delayMs)
    return "It changes nothing: set a status, headers, a body or a delay";
  return null;
}

/** Not expired. */
export const isLive = (o: Pick<ResponseOverride, "expiresAt">, now = Date.now()) =>
  o.expiresAt === null || Date.parse(o.expiresAt) > now;

/**
 * Whether an override covers a page: tab scopes by `inTab` (the caller knows
 * which tab a page is), site scopes by the page's host.
 */
export function scopeCovers(scope: OverrideScope, pageUrl: string, inTab: (tabId: string) => boolean) {
  if (scope.type === "workspace") return true;
  if (scope.type === "tab") return inTab(scope.tabId);
  return hostOf(pageUrl) === scope.host;
}

const matchers = new Map<string, (url: string) => boolean>();
const matcherOf = (pattern: string) => {
  let m = matchers.get(pattern);
  if (!m) {
    if (matchers.size > 2000) matchers.clear();
    m = urlMatcher(pattern);
    matchers.set(pattern, m);
  }
  return m;
};

/** Whether an override answers a request (its scope is checked separately: scopeCovers). */
export const requestMatches = (o: Pick<ResponseOverrideSpec, "pattern" | "method">, method: string, url: string) =>
  (o.method === null || o.method === method.toUpperCase()) && matcherOf(o.pattern)(url);

/** "Body replaced · 500 · 2 s late", "Fails: Timed out", "Never answers". */
export function describeOverride(o: ResponseOverrideSpec) {
  if (o.kind === "hang") return "Never answers (keeps loading)";
  const late = o.delayMs ? `${o.delayMs >= 1000 ? `${+(o.delayMs / 1000).toFixed(1)} s` : `${o.delayMs} ms`} late` : "";
  if (o.kind === "fail") return [`Fails: ${overrideFailures[o.failure]}`, late].filter(Boolean).join(" · ");
  const headers = Object.keys(o.headers).length;
  return (
    [
      o.status !== null ? `Status ${o.status}` : "",
      o.body !== null ? (o.body === "" ? "Empty body" : "Body replaced") : "",
      headers ? `${headers} header${headers === 1 ? "" : "s"}` : "",
      late,
    ]
      .filter(Boolean)
      .join(" · ") || "Unchanged"
  );
}

/** Where it applies, for people: "This tab", "Pages of example.com", "Every tab in the workspace". */
export const scopeName = (scope: OverrideScope, tabName?: string) =>
  scope.type === "tab"
    ? tabName
      ? `The tab ${tabName}`
      : "One tab"
    : scope.type === "site"
      ? `Pages of ${scope.host}`
      : "Every tab in the workspace";

/** Answered without the site: the request never goes out. */
export const answersAlone = (o: ResponseOverrideSpec) => o.kind !== "respond" || (o.status !== null && o.body !== null);

export function guessContentType(body: string) {
  const t = body.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && isJson(t)) return "application/json; charset=utf-8";
  if (t.startsWith("<")) return /^<(!doctype|html)/i.test(t) ? "text/html; charset=utf-8" : "application/xml";
  return "text/plain; charset=utf-8";
}

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

export type HeaderList = { name: string; value: string }[];

const setHeader = (list: HeaderList, name: string, value: string | null) => {
  const rest = list.filter((h) => h.name.toLowerCase() !== name.toLowerCase());
  return value === null ? rest : [...rest, { name, value }];
};
const has = (list: HeaderList, name: string) => list.some((h) => h.name.toLowerCase() === name.toLowerCase());

/**
 * The headers of an answer. `site`: the site's own (null when the request
 * never went out). A replaced body drops what described the old one; an answer
 * made up for a cross-origin request allows the page to read it (CORS).
 */
export function answerHeaders(
  o: Pick<ResponseOverrideSpec, "headers" | "body">,
  site: HeaderList | null,
  request: { url: string; origin: string | null },
): HeaderList {
  let list: HeaderList = site ? [...site] : [];
  if (o.body !== null) {
    for (const name of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5"])
      list = setHeader(list, name, null);
    if (!site || !has(list, "content-type")) list = setHeader(list, "content-type", guessContentType(o.body));
  }
  if (!site) {
    list = setHeader(list, "cache-control", "no-store");
    const crossOrigin = request.origin !== null && request.origin !== originOf(request.url);
    if (crossOrigin) {
      list = setHeader(list, "access-control-allow-origin", request.origin);
      list = setHeader(list, "access-control-allow-credentials", "true");
      list = setHeader(list, "access-control-expose-headers", "*");
    }
  }
  for (const [name, value] of Object.entries(o.headers)) list = setHeader(list, name, value);
  return list;
}

/** The answer to a CORS preflight for a request an override makes up (the site may not even be there). */
export const preflightHeaders = (origin: string, method: string, headers: string): HeaderList => [
  { name: "access-control-allow-origin", value: origin },
  { name: "access-control-allow-credentials", value: "true" },
  { name: "access-control-allow-methods", value: method || "GET, POST, PUT, PATCH, DELETE" },
  ...(headers ? [{ name: "access-control-allow-headers", value: headers }] : []),
  { name: "access-control-max-age", value: "0" },
];

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
