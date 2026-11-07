// The API endpoint map: what a site's API looks like, learned from the
// requests its pages make. Only shapes are kept, never values: a path becomes
// a template (/users/{id}), parameters and fields keep their name and kind of
// value (a number, a date, an email…), and credentials only their name. Shapes
// of the same endpoint merge as more requests are seen, so optional fields and
// alternatives show up over time. The main process turns captured requests
// into observations (main/network.ts); the server merges them (db/Endpoints.ts).
import { isSensitiveName } from "./network";

// --- Shapes ------------------------------------------------------------------------

/** What a string looks like, without what it says. */
export type StringFormat = "uuid" | "email" | "url" | "date" | "datetime" | "integer" | "decimal" | "hex" | "token";

export type Shape =
  | { t: "null" }
  | { t: "boolean" }
  | { t: "number"; int?: true }
  | { t: "string"; format?: StringFormat }
  | { t: "array"; items: Shape | null }
  /** `samples`: how many objects were merged into it; a field seen fewer times is optional. */
  | { t: "object"; fields: Record<string, Field>; samples: number }
  /** An object keyed by data (ids, emails, dates) rather than names. */
  | { t: "map"; values: Shape | null }
  | { t: "union"; of: Shape[] };

export interface Field {
  shape: Shape;
  seen: number;
  /** A credential (by its name): its value is never looked at. */
  secret?: true;
}

const MAX_DEPTH = 8;
const MAX_FIELDS = 150;
const MAX_UNION = 6;
/** More keys than this, and the object is a map. */
const MAP_KEYS = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const HEX = /^[0-9a-f]{16,}$/i;
/** Long runs of letters and digits mixed: ids, hashes, tokens. */
const TOKEN = /^(?=.*\d)(?=.*[a-z])[\w-]{20,}$/i;

export function stringFormat(value: string): StringFormat | undefined {
  if (UUID.test(value)) return "uuid";
  if (EMAIL.test(value)) return "email";
  if (/^https?:\/\//i.test(value)) return "url";
  if (DATE.test(value)) return "date";
  if (DATETIME.test(value)) return "datetime";
  if (/^-?\d{1,15}$/.test(value)) return "integer";
  if (/^-?\d+\.\d+$/.test(value)) return "decimal";
  if (HEX.test(value)) return "hex";
  if (TOKEN.test(value)) return "token";
  return undefined;
}

/** A key that's data rather than a name: an id, a number, an email, a date. */
const isDataKey = (key: string) => {
  const format = stringFormat(key);
  return format !== undefined && format !== "url";
};

/** The shape of a JSON value. */
export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined) return { t: "null" };
  if (typeof value === "boolean") return { t: "boolean" };
  if (typeof value === "number") return Number.isInteger(value) ? { t: "number", int: true } : { t: "number" };
  if (typeof value === "string") {
    const format = stringFormat(value);
    return format ? { t: "string", format } : { t: "string" };
  }
  if (depth >= MAX_DEPTH) return { t: "null" };
  if (Array.isArray(value)) {
    let items: Shape | null = null;
    // A sample of the items is enough to know their shape.
    for (const item of value.slice(0, 20)) items = merge(items, shapeOf(item, depth + 1));
    return { t: "array", items };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAP_KEYS || (entries.length > 0 && entries.some(([k]) => isDataKey(k)))) {
      let values: Shape | null = null;
      for (const [, v] of entries.slice(0, 20)) values = merge(values, shapeOf(v, depth + 1));
      return { t: "map", values };
    }
    const fields: Record<string, Field> = {};
    for (const [k, v] of entries.slice(0, MAX_FIELDS)) {
      fields[k] = isSensitiveName(k)
        ? { shape: { t: "string" }, seen: 1, secret: true }
        : { shape: shapeOf(v, depth + 1), seen: 1 };
    }
    return { t: "object", fields, samples: 1 };
  }
  return { t: "null" };
}

/** The shape of a text value from a URL or a form (they're all strings): what it holds. */
export function shapeOfText(value: string): Shape {
  if (value === "true" || value === "false") return { t: "boolean" };
  if (/^-?\d{1,15}$/.test(value)) return { t: "number", int: true };
  if (/^-?\d+\.\d+$/.test(value)) return { t: "number" };
  if (value === "") return { t: "string" };
  const format = stringFormat(value);
  return format ? { t: "string", format } : { t: "string" };
}

const members = (s: Shape): Shape[] => (s.t === "union" ? s.of : [s]);

/** Two shapes of the same thing as one (fields seen in only some become optional, different kinds a union). */
export function merge(a: Shape | null, b: Shape | null): Shape | null {
  if (!a) return b;
  if (!b) return a;
  if (a.t === "union" || b.t === "union" || a.t !== b.t) {
    const out: Shape[] = [];
    for (const s of [...members(a), ...members(b)]) {
      const i = out.findIndex((o) => o.t === s.t);
      if (i === -1) out.push(s);
      else out[i] = merge(out[i]!, s)!;
    }
    return out.length === 1 ? out[0]! : { t: "union", of: out.slice(0, MAX_UNION) };
  }
  switch (a.t) {
    case "number":
      return a.int && (b as typeof a).int ? a : { t: "number" };
    case "string": {
      const f = (b as typeof a).format;
      return a.format && a.format === f ? a : { t: "string" };
    }
    case "array":
      return { t: "array", items: merge(a.items, (b as typeof a).items) };
    case "map":
      return { t: "map", values: merge(a.values, (b as typeof a).values) };
    case "object": {
      const other = b as typeof a;
      const fields: Record<string, Field> = { ...a.fields };
      for (const [k, f] of Object.entries(other.fields)) {
        const mine = fields[k];
        fields[k] = mine
          ? {
              shape: merge(mine.shape, f.shape)!,
              seen: mine.seen + f.seen,
              ...(mine.secret || f.secret ? { secret: true as const } : {}),
            }
          : f;
      }
      const keys = Object.keys(fields);
      // A record that keeps growing new keys is a map after all.
      if (keys.length > MAP_KEYS) {
        let values: Shape | null = null;
        for (const k of keys.slice(0, 20)) values = merge(values, fields[k]!.shape);
        return { t: "map", values };
      }
      return { t: "object", fields, samples: a.samples + other.samples };
    }
    default:
      return a;
  }
}

/** Named parameters (query, form, headers): the same merge as an object's fields. */
export type Params = Record<string, Field>;

export function mergeParams(a: Params, b: Params): Params {
  const merged = merge({ t: "object", fields: a, samples: 0 }, { t: "object", fields: b, samples: 0 }) as
    Extract<Shape, { t: "object" }> | Extract<Shape, { t: "map" }>;
  return merged.t === "object" ? merged.fields : a;
}

// --- Paths ---------------------------------------------------------------------------

/** A path segment that's a value rather than a name: its placeholder. */
export function segmentPlaceholder(segment: string): string | null {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // keep it as it is
  }
  if (/^\d+$/.test(s)) return "{id}";
  if (UUID.test(s)) return "{uuid}";
  if (EMAIL.test(s)) return "{email}";
  if (DATE.test(s) || DATETIME.test(s)) return "{date}";
  if (HEX.test(s)) return "{hash}";
  if (TOKEN.test(s) || (/\d/.test(s) && /[a-z]/i.test(s) && s.length >= 10)) return "{id}";
  // Long text, or anything with spaces or @: data, not a route.
  if (s.length > 40 || /[\s@]/.test(s)) return "{value}";
  return null;
}

/** A path as a template: /users/123/posts → /users/{id}/posts. */
export function pathTemplate(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  return `/${segments.map((s) => segmentPlaceholder(s) ?? s).join("/")}`;
}

export const isPlaceholder = (segment: string) => /^\{\w+\}$/.test(segment);

/** Whether a template covers a path (its placeholders take any segment). */
export function templateMatches(template: string, path: string) {
  const t = template.split("/");
  const p = path.split("/");
  return t.length === p.length && t.every((s, i) => s === p[i] || (isPlaceholder(s) && p[i] !== ""));
}

// --- Observations ----------------------------------------------------------------------

/** One request, as shapes: what the main process sends to be merged into the map. */
export interface Observation {
  /** The API's host (api.example.com). */
  host: string;
  /** The site whose page made the request. */
  site: string;
  method: string;
  /** A template (see pathTemplate). */
  path: string;
  /** A GraphQL operation's name: each is an endpoint of its own. */
  operation: string | null;
  query: Params;
  /** The request's own headers (what the site's code adds; not the browser's). */
  headers: Params;
  requestType: string | null;
  requestBody: Shape | null;
  status: number | null;
  responseType: string | null;
  responseBody: Shape | null;
}

/** Headers the browser sets: not part of a site's API. */
const BROWSER_HEADERS =
  /^(:|accept|accept-encoding|accept-language|user-agent|referer|origin|host|connection|content-length|content-type|cookie|cache-control|pragma|priority|dnt|upgrade-insecure-requests|sec-|if-|te$|range$|purpose$|x-client-data$)/i;

/** Parameters by name, with the kind of value each held (credentials: only their name). */
function paramsOf(entries: Iterable<[string, string]>, keyAlone: boolean): Params {
  const out: Params = {};
  let count = 0;
  for (const [name, value] of entries) {
    if (++count > MAX_FIELDS) break;
    const field: Field = isSensitiveName(name, keyAlone)
      ? { shape: { t: "string" }, seen: 1, secret: true }
      : { shape: shapeOfText(value), seen: 1 };
    out[name] = out[name] ? { ...out[name]!, shape: merge(out[name]!.shape, field.shape)! } : field;
  }
  return out;
}

const mime = (type: string | undefined) => (type ?? "").split(";")[0]!.trim().toLowerCase() || null;

/** A body's shape: JSON, or a form's fields. Null for anything else. */
function bodyShape(body: string | null, type: string | null): Shape | null {
  if (body === null || !body.trim()) return null;
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || /json/.test(type ?? "")) {
    try {
      return shapeOf(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (/x-www-form-urlencoded/.test(type ?? "") || /^[\w.%[\]-]+=[^&\s]*(&[\w.%[\]-]+=[^&\s]*)*$/.test(trimmed)) {
    return { t: "object", fields: paramsOf(new URLSearchParams(trimmed), true), samples: 1 };
  }
  return null;
}

export interface CapturedRequest {
  method: string;
  url: string;
  /** The page's URL. */
  pageUrl: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  mimeType: string;
  responseBody: string | null;
}

/** A captured request as shapes, or null if it's not an API call worth mapping. */
export function observe(request: CapturedRequest): Observation | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  let site = "";
  try {
    site = new URL(request.pageUrl).hostname;
  } catch {
    site = url.hostname;
  }
  const headerType = Object.entries(request.requestHeaders).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  const requestType = mime(headerType);
  let requestBody = bodyShape(request.requestBody, requestType);
  // GraphQL: one URL, many operations; the query text itself isn't kept (it can hold values).
  let operation: string | null = null;
  if (request.requestBody && /graphql/i.test(url.pathname + (requestType ?? ""))) {
    try {
      const parsed = JSON.parse(request.requestBody) as { operationName?: unknown; variables?: unknown };
      if (typeof parsed.operationName === "string" && /^\w{1,100}$/.test(parsed.operationName))
        operation = parsed.operationName;
      requestBody = parsed.variables !== undefined ? shapeOf({ variables: parsed.variables }) : null;
    } catch {
      // not JSON
    }
  }
  if (!operation && url.searchParams.get("operationName") && /graphql/i.test(url.pathname)) {
    const name = url.searchParams.get("operationName")!;
    if (/^\w{1,100}$/.test(name)) operation = name;
  }
  const headers = paramsOf(
    Object.entries(request.requestHeaders).filter(([k]) => !BROWSER_HEADERS.test(k)),
    false,
  );
  // Header values don't matter, only that they're sent.
  for (const field of Object.values(headers)) if (!field.secret) field.shape = { t: "string" };
  const query = paramsOf(
    [...url.searchParams].filter(
      ([k]) => !(operation && ["query", "variables", "extensions", "operationName"].includes(k)),
    ),
    true,
  );
  const responseType = mime(request.mimeType);
  return {
    host: url.host,
    site,
    method: request.method.toUpperCase(),
    path: pathTemplate(url.pathname),
    operation,
    query,
    headers,
    requestType,
    requestBody,
    status: request.status,
    responseType,
    responseBody: bodyShape(request.responseBody, responseType),
  };
}

// --- The map ---------------------------------------------------------------------------

export interface EndpointResponse {
  status: number;
  type: string | null;
  shape: Shape | null;
  seen: number;
}

/** One endpoint of a site's API, everything seen of it merged. */
export interface Endpoint {
  id: string;
  workspaceId: string;
  host: string;
  method: string;
  path: string;
  operation: string | null;
  /** Sites whose pages called it. */
  sites: string[];
  query: Params;
  headers: Params;
  requestType: string | null;
  requestBody: Shape | null;
  /** By status code. */
  responses: EndpointResponse[];
  /** Requests seen. */
  seen: number;
  firstSeen: string;
  lastSeen: string;
}

/** A host's part of the map, for the list of sites. */
export interface EndpointHost {
  workspaceId: string;
  host: string;
  endpoints: number;
  requests: number;
  lastSeen: string;
  sites: string[];
}

/** An observation merged into an endpoint (a new one if `endpoint` is null). */
export function mergeObservation(endpoint: EndpointData | null, o: Observation): EndpointData {
  const responses = [...(endpoint?.responses ?? [])];
  if (o.status !== null) {
    const i = responses.findIndex((r) => r.status === o.status);
    if (i === -1) responses.push({ status: o.status, type: o.responseType, shape: o.responseBody, seen: 1 });
    else
      responses[i] = {
        status: o.status,
        type: responses[i]!.type ?? o.responseType,
        shape: merge(responses[i]!.shape, o.responseBody),
        seen: responses[i]!.seen + 1,
      };
    responses.sort((a, b) => a.status - b.status);
  }
  return {
    host: o.host,
    method: o.method,
    path: endpoint?.path ?? o.path,
    operation: o.operation,
    sites: [...new Set([...(endpoint?.sites ?? []), o.site])].slice(0, 20),
    query: mergeParams(endpoint?.query ?? {}, o.query),
    headers: mergeParams(endpoint?.headers ?? {}, o.headers),
    requestType: endpoint?.requestType ?? o.requestType,
    requestBody: merge(endpoint?.requestBody ?? null, o.requestBody),
    responses: responses.slice(0, 20),
    seen: (endpoint?.seen ?? 0) + 1,
  };
}

/**
 * Whether paths that differ in one segment are one endpoint with a parameter
 * there: true once enough different values were seen at that place
 * (/users/alice, /users/bob, /users/carol… → /users/{param}).
 */
export const COLLAPSE_AT = 4;

/** The template that covers `paths` (same length, differing in exactly one segment), or null. */
export function collapsed(paths: string[]): string | null {
  if (paths.length < COLLAPSE_AT) return null;
  const split = paths.map((p) => p.split("/"));
  const length = split[0]!.length;
  if (split.some((s) => s.length !== length)) return null;
  let at = -1;
  for (let i = 0; i < length; i++) {
    const values = new Set(split.map((s) => s[i]));
    if (values.size === 1) continue;
    if (at !== -1) return null;
    at = i;
  }
  if (at === -1 || split.some((s) => isPlaceholder(s[at]!))) return null;
  const template = [...split[0]!];
  template[at] = "{param}";
  return template.join("/");
}

// --- Reading it --------------------------------------------------------------------------

/** A shape as TypeScript-like text: `{ id: number; title: string; tags?: string[] }`. */
export function formatShape(shape: Shape | null, indent = ""): string {
  if (!shape) return "unknown";
  switch (shape.t) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "number":
      return shape.int ? "integer" : "number";
    case "string":
      return shape.format ? `string (${shape.format})` : "string";
    case "array": {
      const inner = formatShape(shape.items, indent);
      return /[\s|]/.test(inner) && !inner.startsWith("{") ? `Array<${inner}>` : `${inner}[]`;
    }
    case "map":
      return `{ [key: string]: ${formatShape(shape.values, indent)} }`;
    case "union":
      return shape.of.map((s) => formatShape(s, indent)).join(" | ");
    case "object": {
      const entries = Object.entries(shape.fields);
      if (!entries.length) return "{}";
      const next = `${indent}  `;
      const lines = entries.map(
        ([k, f]) =>
          `${next}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${f.seen < shape.samples ? "?" : ""}: ${
            f.secret ? "string (credential)" : formatShape(f.shape, next)
          };`,
      );
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
  }
}

/** Parameters as text: `page: integer, q?: string, api_key: credential`. */
export function formatParams(params: Params, total: number) {
  return Object.entries(params)
    .map(([k, f]) => `${k}${f.seen < total ? "?" : ""}: ${f.secret ? "credential" : formatShape(f.shape)}`)
    .join(", ");
}

/** An endpoint as text, for agents. */
export function describeEndpoint(e: Endpoint) {
  const lines = [`${e.method} https://${e.host}${e.path}${e.operation ? ` (GraphQL operation ${e.operation})` : ""}`];
  lines.push(`  seen ${e.seen}×, last ${e.lastSeen}`);
  if (Object.keys(e.query).length) lines.push(`  query: ${formatParams(e.query, e.seen)}`);
  if (Object.keys(e.headers).length) lines.push(`  headers: ${formatParams(e.headers, e.seen)}`);
  if (e.requestBody) lines.push(`  body (${e.requestType ?? "?"}): ${formatShape(e.requestBody, "  ")}`);
  for (const r of e.responses)
    lines.push(`  → ${r.status}${r.type ? ` ${r.type}` : ""}${r.shape ? `: ${formatShape(r.shape, "  ")}` : ""}`);
  return lines.join("\n");
}

export type EndpointData = Omit<Endpoint, "id" | "workspaceId" | "firstSeen" | "lastSeen">;

/** Two endpoints as one (paths that turned out to be one template). */
export function mergeEndpoints(a: EndpointData, b: EndpointData, path: string): EndpointData {
  const responses = [...a.responses];
  for (const r of b.responses) {
    const i = responses.findIndex((x) => x.status === r.status);
    if (i === -1) responses.push(r);
    else
      responses[i] = {
        status: r.status,
        type: responses[i]!.type ?? r.type,
        shape: merge(responses[i]!.shape, r.shape),
        seen: responses[i]!.seen + r.seen,
      };
  }
  responses.sort((x, y) => x.status - y.status);
  return {
    host: a.host,
    method: a.method,
    path,
    operation: a.operation,
    sites: [...new Set([...a.sites, ...b.sites])].slice(0, 20),
    query: mergeParams(a.query, b.query),
    headers: mergeParams(a.headers, b.headers),
    requestType: a.requestType ?? b.requestType,
    requestBody: merge(a.requestBody, b.requestBody),
    responses: responses.slice(0, 20),
    seen: a.seen + b.seen,
  };
}
