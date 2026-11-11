// The search engine's suggestions in the address bar, like Chrome's: what's
// typed may be sent (`maySuggestFor`), the request's URL (`suggestRequestUrl`),
// and the answer read defensively (`parseSuggestions`), since it comes from the
// network. The main process fetches them (main/searchSuggestions.ts); the
// address bar shows them (components/TopBar.tsx).

/** Suggestions shown at most. */
export const MAX_SEARCH_SUGGESTIONS = 5;
/** Longer than this, what's typed isn't sent (nor is a suggestion this long shown). */
export const MAX_SUGGEST_QUERY = 200;

/** Schemes that aren't web addresses: anything typed with one stays on this computer. */
const NON_WEB_SCHEME =
  /^(rune|file|about|chrome|chrome-extension|chrome-untrusted|devtools|view-source|javascript|data|blob|filesystem|mailto|tel|sms|ftp|ws|wss|intent|edge|brave|opera|vivaldi|extension|moz-extension):/i;

/** Names that only mean something on a local network ("localhost", "printer.local", "nas.home.arpa"). */
const LOCAL_NAME =
  /^localhost$|\.(localhost|local|localdomain|lan|home|home\.arpa|internal|intranet|corp|private|test)$/i;

/**
 * Whether what's typed in the address bar may be sent to the search engine for suggestions. Like Chrome,
 * and stricter: never anything with a scheme (`https://…` included: an address you're going to, often
 * with a path, a query or a token in it), credentials (`user:pass@host`), an email address, a file path,
 * a local or intranet address (localhost, `.local`, IP addresses, a name with a port), an address with a
 * path, a query or a fragment, or one long word that could be a key or a token. A plain site name
 * ("example.com") and words are sent.
 */
export function maySuggestFor(text: string): boolean {
  const q = text.trim();
  if (!q || q.length > MAX_SUGGEST_QUERY) return false;
  // Control characters: not something typed.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(q)) return false;
  if (NON_WEB_SCHEME.test(q)) return false;
  // Any scheme://, and protocol-relative //host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || q.startsWith("//")) return false;
  // File paths: /…, ~/…, ./…, ../…, C:\…, \\server\….
  if (/^(\/|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|\\\\)/i.test(q)) return false;
  const words = q.split(/\s+/);
  for (const word of words) {
    // An address with a scheme anywhere ("see https://…?token=…").
    if (/[a-z][a-z0-9+.-]*:\/\//i.test(word)) return false;
    // Credentials (user:pass@host) and email addresses.
    if (/^[^@/]+@[^@\s]+$/.test(word) || /^[^\s/]*:[^\s/]*@/.test(word)) return false;
  }
  if (words.length === 1) {
    const word = words[0]!;
    // One long word: a key, a token, a hash or an address too long to be a search.
    if (word.length >= 32) return false;
    const m = /^(\[[0-9a-f:.]+\]|[^/?#:]+)(:\d*)?([/?#].*)?$/i.exec(word);
    if (m) {
      const host = m[1]!.toLowerCase().replace(/\.$/, "");
      const port = m[2];
      const rest = m[3];
      // IPv6 and IPv4 addresses, also ones being typed ("192.168", "127.0.").
      if (host.startsWith("[") || /^\d{1,3}(\.\d{0,3}){1,3}$/.test(host)) return false;
      if (LOCAL_NAME.test(host)) return false;
      // A name with a port ("router:8080", "example.com:8443"): a server, likely a local one.
      if (port !== undefined) return false;
      // An address with a path, query or fragment ("intranet/wiki", "example.com/account?id=…"); a word
      // with a question mark ("why?") isn't one.
      const hostLike = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host);
      if (rest && hostLike && (host.includes(".") || rest.startsWith("/"))) return false;
    }
  }
  return true;
}

/** The URL to ask an engine (its suggest URL, %s for the words) for suggestions for what's typed. */
export const suggestRequestUrl = (template: string, query: string) =>
  template.replace("%s", encodeURIComponent(query.trim()));

/** A JSON answer from the network, read defensively (null: not JSON). Strips an anti-XSSI prefix (`)]}'`). */
function parseJson(body: string): unknown {
  const text = body.replace(/^\uFEFF/, "").replace(/^\)\]\}'?[^\n]*\n/, "");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * An engine's answer as suggestions: OpenSearch JSON (`[query, [suggestion…], …]`: Google, Bing,
 * DuckDuckGo's `type=list`, Brave, Kagi, Ecosia, Startpage), or a list of `{ phrase }` (DuckDuckGo's
 * default). Only strings, trimmed, single-line and not too long, none twice nor what's typed, at most
 * `max`. Anything else is no suggestions.
 */
export function parseSuggestions(body: string, query: string, max = MAX_SEARCH_SUGGESTIONS): string[] {
  const json = parseJson(body);
  if (!Array.isArray(json)) return [];
  let items: unknown[];
  if (json.length >= 2 && typeof json[0] === "string" && Array.isArray(json[1])) items = json[1];
  else if (json.every((x) => typeof x === "object" && x !== null && !Array.isArray(x)))
    items = json.map((x) => (x as { phrase?: unknown }).phrase);
  else return [];
  const typed = query.trim().toLowerCase();
  const seen = new Set<string>([typed]);
  const out: string[] = [];
  for (const item of items.slice(0, 100)) {
    if (out.length >= max) break;
    if (typeof item !== "string") continue;
    // Single line, no control or bidi override characters, collapsed spaces.
    // eslint-disable-next-line no-control-regex
    const text = item
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > MAX_SUGGEST_QUERY) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}
