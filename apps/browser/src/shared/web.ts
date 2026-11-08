// Helpers for web tabs shared by the renderer and the website agent.
import type { PageChange, PageChangeAction, PageChangeSpec, PageScope } from "./api";
import { searchEngines } from "./browser";
import { isLocalHost } from "./insecure";
import { parseInternalUrl } from "./internalPages";
import { base } from "./theme";

/** Computed styles reported for picked and inspected elements. */
export const inspectedStyles = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
] as const;

export function hostOf(url: string | null | undefined) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** A local file's file:// URL ("C:\\x\\y.pdf" → "file:///C:/x/y.pdf"). */
export function fileUrl(path: string) {
  const slashed = path.replace(/\\/g, "/");
  const absolute = slashed.startsWith("/") ? slashed : `/${slashed}`;
  return `file://${encodeURI(absolute).replace(/[?#]/g, encodeURIComponent)}`;
}

/** A file's name from its path or file:// URL. */
export const fileNameOf = (path: string) => {
  const last = path.replace(/\\/g, "/").split("/").pop() ?? path;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

const VIEWABLE_EXTENSIONS =
  /\.(pdf|png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|ogv|mov|m4v|mp3|wav|ogg|oga|flac|m4a|aac|opus|txt|text|log|md|markdown|csv|tsv|json|xml|ya?ml|toml|ini|html?|xhtml|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql)$/i;

/** Whether a browser tab can show a file (PDFs, images, video, audio, text, pages); others are downloaded. */
export const isViewableFile = (name: string, mime = "") =>
  /^(image|video|audio|text)\//.test(mime) ||
  /^application\/(pdf|json|xml|xhtml\+xml|javascript)$/.test(mime) ||
  VIEWABLE_EXTENSIONS.test(name);

/** Why a page can't be loaded in a headless tab, or null. */
export function headlessUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a valid URL.";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "Only websites (http or https) can be opened in a headless tab.";
  if (isLocalHost(parsed.hostname))
    return "Headless tabs don't open this computer or the local network, only websites.";
  return null;
}

/**
 * Turns address bar input into a URL: URLs stay as they are, things that look
 * like a domain get https:// (http:// for local addresses), local paths become
 * file:// URLs, internal pages (chrome://, about:version) their rune:// address,
 * anything else is searched for (with the search URL's %s).
 */
export function normalizeUrl(input: string, searchUrl: string = searchEngines.duckduckgo.url) {
  const text = input.trim();
  if (!text) return "";
  const internal = parseInternalUrl(text);
  if (internal) return internal.url;
  if (/^(https?:\/\/|about:|file:\/\/)/i.test(text)) return text;
  if (/^(\/[^/\s]|[a-z]:[\\/])/i.test(text)) return fileUrl(text);
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(text);
  if (local) return `http://${text}`;
  const looksLikeHost =
    !/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text);
  if (looksLikeHost) return `https://${text}`;
  return searchUrl.replace("%s", encodeURIComponent(text));
}

/** The page's state for page changes and overrides (shared by the scripts below). */
const CHANGES_STATE = `(window.__runeChanges || (window.__runeChanges = { active: new Map(), handlers: {}, errors: {} }))`;

/** How often an element that is still hydrating is looked at again. */
const READY_RETRY_MS = 250;
/** An element is changed after this long even if it still looks like it's hydrating (a framework that failed to load). */
const READY_MAX_WAIT_MS = 10_000;

/**
 * Runs in the page, once per document: adds `whenSettled(fn, quick)` and `ready(el)` to the page's state.
 *
 * Frameworks (React, Vue, Svelte…) hydrate server-rendered pages: they walk the DOM the server sent and
 * expect it unchanged. A node added, moved or rewritten under them makes hydration fail, and they render
 * it all again (losing the change, and the page's state) or break. So page changes and overrides only
 * change the DOM
 * - once the page has settled: loaded and its scripts idle (8 seconds at most, for a page that never
 *   finishes loading). Overrides' onElement (`quick`) doesn't wait for that on a page that wasn't
 *   server-rendered by a framework it knows: there's nothing to hydrate, and it runs at DOM ready;
 * - and only elements that are hydrated. React marks its root when hydration starts and each element
 *   when it reaches it; server-rendered Suspense boundaries (<!--$--> … <!--/$-->) hydrate later, one by
 *   one. Frameworks that haven't started yet (Next.js, Remix, Nuxt, Solid) are waited for, at most
 *   READY_MAX_WAIT_MS after the page settled for the whole page. Vue 2's and Astro's islands drop an
 *   attribute when they hydrate. Content a framework doesn't own (dangerouslySetInnerHTML, other scripts'
 *   elements) is ready as soon as its owner is. An element still waiting after READY_MAX_WAIT_MS is
 *   changed anyway (a framework that failed). Once ready, an element stays ready: a framework that
 *   renders again makes new elements.
 */
const PAGE_READY = `(s) => {
  if (s.whenSettled) return;
  let settledAt = 0;
  const pending = [];
  const settle = () => {
    if (settledAt) return;
    settledAt = Date.now();
    for (const fn of pending.splice(0)) fn();
  };
  const idle = () => (window.requestIdleCallback ? requestIdleCallback(settle, { timeout: 2000 }) : setTimeout(settle, 100));
  if (document.readyState === "complete") idle(); else window.addEventListener("load", idle, { once: true });
  setTimeout(settle, 8000);

  const keyed = (node, prefixes) => {
    try { return Object.keys(node).some((k) => prefixes.some((p) => k.startsWith(p))); } catch (e) { return false; }
  };
  const byId = (id) => (document.getElementById ? document.getElementById(id) : null);
  // React 17+ (and 16's legacy roots): its root, and an element it has rendered or hydrated.
  const CONTAINER = ["__reactContainer$", "_reactRootContainer"];
  const FIBER = ["__reactFiber$", "__reactInternalInstance$"];
  const fiber = (node) => keyed(node, FIBER);
  const boundary = (node) => node.nodeType === 8 && /^\\$[?!~]?$/.test(node.data);
  // Whether the page was server-rendered by a framework that hydrates it.
  const serverRendered = () =>
    !!(window.__NEXT_DATA__ || window.__next_f || byId("__NEXT_DATA__") || window.__NUXT__ || byId("__NUXT_DATA__") ||
      window.__remixContext || window.__reactRouterContext || window._$HY || byId("___gatsby") ||
      (document.querySelector && document.querySelector("[data-server-rendered], astro-island, [ng-server-context], [ngh], [data-sveltekit-hydrate]")) ||
      window.__VP_HASH_MAP__ || window.__VP_SITE_DATA__ || Object.keys(window).some((k) => k.startsWith("__sveltekit_")) ||
      serverComments());
  // Comments server renderers leave: Vue 3's fragments (<!--[-->), Fresh's islands (<!--frsh-…-->), React's
  // Suspense boundaries. A look at the first ones only.
  const serverComments = () => {
    if (!document.createTreeWalker || !document.documentElement) return false;
    const walker = document.createTreeWalker(document.documentElement, 128);
    for (let i = 0; i < 500 && walker.nextNode(); i++)
      if (/^(\\[|frsh-|\\$[?!~]?$)/.test(walker.currentNode.data)) return true;
    return false;
  };
  // A framework the page needs that hasn't started (or finished) hydrating; given up on for the whole
  // page READY_MAX_WAIT_MS after it settled.
  const starting = () => {
    if (settledAt && Date.now() - settledAt > ${READY_MAX_WAIT_MS}) return false;
    if (window._$HY && !window._$HY.done) return true;
    const nuxt = (window.__NUXT__ || byId("__NUXT_DATA__")) && byId("__nuxt");
    if (nuxt && !nuxt.__vue_app__ && !nuxt.__vue__ && !window.$nuxt) return true;
    if (!(window.__next_f || window.__remixContext || window.__reactRouterContext || byId("__NEXT_DATA__"))) return false;
    const next = byId("__next");
    return !keyed(document, CONTAINER) && !(next && (keyed(next, CONTAINER) || fiber(next.firstElementChild || next)));
  };
  const reactPending = (el) => {
    if (fiber(el)) return false;
    let root = null;
    for (let n = el.parentNode; n; n = n.parentNode) if (keyed(n, CONTAINER)) { root = n; break; }
    if (!root) return false;
    // The closest element React has hydrated; none means the root itself is still hydrating.
    let owner = el.parentNode;
    while (owner && owner !== root && !fiber(owner)) owner = owner.parentNode;
    if (!owner || owner === root) return true;
    // A Suspense boundary between the two that hasn't hydrated yet.
    for (let n = el; n && n !== owner; n = n.parentNode)
      for (let p = n.previousSibling; p; p = p.previousSibling) {
        if (p.nodeType !== 8) continue;
        if (p.data === "/$") break;
        if (boundary(p)) return true;
      }
    return false;
  };
  const islandPending = (el) => !!(el.closest && el.closest("[data-server-rendered], astro-island[ssr]"));

  s.whenSettled = (fn, quick) => {
    if (settledAt) return fn();
    if (quick) {
      const now = () => (serverRendered() ? pending.push(fn) : fn());
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", now, { once: true });
      else now();
      return;
    }
    pending.push(fn);
  };
  const readied = new WeakSet();
  const since = new WeakMap();
  s.ready = (el) => {
    if (!el || readied.has(el)) return true;
    if (starting() || reactPending(el) || islandPending(el)) {
      const first = since.get(el);
      if (first === undefined) { since.set(el, Date.now()); return false; }
      if (Date.now() - first <= ${READY_MAX_WAIT_MS}) return false;
    }
    readied.add(el);
    return true;
  };
  // Whether an element has server-rendered Suspense boundaries inside (its text nodes are checked one by
  // one then). Looked up once per element.
  const boundaries = new WeakMap();
  s.hasBoundary = (el) => {
    if (boundaries.has(el)) return boundaries.get(el);
    let found = false;
    const walker = document.createTreeWalker(el, 128);
    while (!found && walker.nextNode()) found = boundary(walker.currentNode);
    boundaries.set(el, found);
    return found;
  };
}`;

/**
 * Wraps a site override's JavaScript for injection. It runs once per page load;
 * `onElement(selector, fn)` calls `fn` for every matching element once it's
 * safe to change (at DOM ready, or on a server-rendered page once it's settled
 * and the element is hydrated: see `PAGE_READY`), and whenever the page adds
 * more (single-page apps re-render all the time).
 * Evaluates to an error message or null.
 */
export function overrideScript(js: string) {
  return `(() => {
  const __rune = ${CHANGES_STATE};
  (${PAGE_READY})(__rune);
  const onElement = (selector, fn) => {
    const seen = new WeakSet();
    let queued = false;
    let retry = null;
    const run = () => {
      queued = false;
      let waiting = false;
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        if (!__rune.ready(el)) { waiting = true; continue; }
        seen.add(el);
        try { fn(el); } catch (e) { console.error("[Rune Browser override]", e); }
      }
      // Hydration doesn't change the DOM, so nothing would tell us when it's done: look again shortly.
      if (waiting && !retry) retry = setTimeout(() => { retry = null; run(); }, ${READY_RETRY_MS});
    };
    __rune.whenSettled(() => {
      run();
      new MutationObserver(() => {
        if (!queued) { queued = true; requestAnimationFrame(run); }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }, true);
  };
  try {
${js}
  } catch (e) {
    console.error("[Rune Browser override]", e);
    return String((e && e.stack) || e);
  }
  return null;
})()`;
}

// --- Page changes ------------------------------------------------------------------------

/** "example.com/news": a page's host and path, without a trailing slash (what page scopes match). */
export function pageKey(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/**
 * A scope pattern as a regex over host + path. `*` matches anything, a
 * leading `*.` also the bare domain, and a pattern without a path covers the
 * whole site: "*.example.com" ≈ "*.example.com/*".
 */
export function patternRegex(pattern: string): RegExp | null {
  let p = pattern.trim().replace(/^(\*|https?):\/\//i, "");
  if (!p || p.length > 500) return null;
  if (!p.includes("/")) p += "/*";
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const subdomains = p.startsWith("*.");
  const body = (subdomains ? p.slice(2) : p).split("*").map(escape).join(".*");
  return new RegExp(`^${subdomains ? "(?:[^/]*\\.)?" : ""}${body}$`, "i");
}

/** Whether a page change applies to a URL (web pages only). */
export function scopeMatches(scope: PageScope, url: string) {
  if (!/^https?:/i.test(url)) return false;
  if (scope.type === "page") return pageKey(url) === scope.value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (scope.type === "site") return hostOf(url) === scope.value;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "/";
    }
  })();
  return patternRegex(scope.value)?.test(`${hostOf(url)}${path}`) ?? false;
}

/** "This page", "example.com" or the pattern, for people. */
export function scopeLabel(scope: PageScope, url?: string) {
  if (scope.type === "page") return url && pageKey(url) === scope.value ? "This page" : scope.value;
  if (scope.type === "site") return url && hostOf(url) === scope.value ? `All of ${scope.value}` : scope.value;
  return `Sites like ${scope.value}`;
}

const SELECTOR_ACTIONS = new Set<PageChangeAction>(["hide", "style", "text", "attribute", "insert", "button"]);
const ACTIONS = new Set<PageChangeAction>([...SELECTOR_ACTIONS, "css", "script"]);
const POSITIONS = new Set(["before", "after", "prepend", "append"]);

/** What's wrong with a page change, if anything (JavaScript syntax is checked by the server). */
export function pageChangeProblem(c: PageChangeSpec): string | null {
  if (!c.title?.trim()) return "Give it a short title";
  if (c.title.length > 120) return "The title is too long";
  if (!c.scope || !["page", "site", "pattern"].includes(c.scope.type))
    return "scope.type must be page, site or pattern";
  const value = c.scope.value?.trim() ?? "";
  if (!value || value.length > 500) return "scope.value is missing";
  if (c.scope.type === "site" && !/^[a-z0-9.-]+$/i.test(value)) return "A site is a host name, like example.com";
  if (c.scope.type === "page" && !/^[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(value.replace(/^https?:\/\//i, "")))
    return "A page is a host and path, like example.com/news";
  if (c.scope.type === "pattern" && (!patternRegex(value) || /\s/.test(value)))
    return "Patterns look like *.example.com/* or example.com/docs/*";
  if (!ACTIONS.has(c.action)) return `action must be one of ${[...ACTIONS].join(", ")}`;
  if (SELECTOR_ACTIONS.has(c.action) && !c.selector?.trim()) return `${c.action} needs a selector`;
  if ((c.selector?.length ?? 0) > 2000) return "The selector is too long";
  if (c.action !== "hide" && c.action !== "text" && !c.value?.trim()) return `${c.action} needs a value`;
  if (c.action === "text" && typeof c.value !== "string") return "text needs a value (the new text)";
  if ((c.value?.length ?? 0) > 100_000) return "The value is too long";
  if (c.action === "attribute" && !/^[a-z_:][\w:.-]*$/i.test(c.name ?? "")) return "attribute needs a name";
  if (c.action === "attribute" && /^on/i.test(c.name ?? "")) return "Use a button for behavior, not on* attributes";
  if (c.position !== undefined && !POSITIONS.has(c.position))
    return "position must be before, after, prepend or append";
  if (c.action === "button" && !c.onClick?.trim()) return "A button needs onClick (JavaScript run on click)";
  if ((c.onClick?.length ?? 0) > 50_000) return "onClick is too long";
  return null;
}

/** The fields of a page change, without extras (for storing and comparing). */
export function pageChangeSpec(c: PageChangeSpec): PageChangeSpec {
  return {
    title: c.title.trim(),
    scope: {
      type: c.scope.type,
      // Pages are matched by host and path (no scheme, port, query or trailing slash).
      value:
        c.scope.type === "page"
          ? c.scope.value
              .trim()
              .replace(/^https?:\/\//i, "")
              .replace(/^([^/:]+):\d+/, "$1")
              .replace(/[?#].*$/, "")
              .replace(/\/+$/, "")
          : c.scope.value.trim(),
    },
    action: c.action,
    ...(SELECTOR_ACTIONS.has(c.action) ? { selector: c.selector!.trim() } : {}),
    ...(c.action !== "hide" && c.value !== undefined ? { value: c.value } : {}),
    ...(c.action === "attribute" ? { name: c.name } : {}),
    ...((c.action === "insert" || c.action === "button") && c.position ? { position: c.position } : {}),
    ...(c.action === "button" ? { onClick: c.onClick } : {}),
  };
}

/** The CSS of the active changes (hide, style, css; and the default look of added buttons). */
export function pageChangesCss(changes: readonly PageChange[]) {
  const rules = changes.flatMap((c) =>
    c.action === "hide"
      ? [`/* rune:${c.id} */ ${c.selector} { display: none !important; }`]
      : c.action === "style"
        ? [`/* rune:${c.id} */ ${c.selector} { ${c.value} }`]
        : c.action === "css"
          ? [`/* rune:${c.id} */\n${c.value}`]
          : [],
  );
  if (changes.some((c) => c.action === "button")) {
    rules.unshift(
      `button.rune-button { font: 500 13px/1.2 system-ui, sans-serif; padding: 5px 12px; margin: 4px; border-radius: 6px; border: 1px solid rgba(0,0,0,.15); background: ${base.light.accent}; color: #fff; cursor: pointer; }`,
    );
  }
  return rules.join("\n");
}

/** The DOM changes (text, attribute, insert, button) to apply: undoes the rest. Evaluates to { [id]: error }. */
export function pageChangesScript(changes: readonly PageChange[]) {
  const dom = changes
    .filter((c) => c.action === "text" || c.action === "attribute" || c.action === "insert" || c.action === "button")
    .map((c) => pageChangeSpecWithId(c));
  return `(() => {
  const ATTR = "data-rune-change";
  const s = ${CHANGES_STATE};
  const want = ${JSON.stringify(dom)};
  const keyOf = (c) => JSON.stringify(c);
  for (const [id, entry] of s.active) {
    const c = want.find((w) => w.id === id);
    if (c && keyOf(c) === entry.key) continue;
    try { entry.undo(); } catch (e) {}
    s.active.delete(id);
    delete s.errors[id];
  }
  if (!s.html) {
    try {
      const policy = window.trustedTypes && window.trustedTypes.createPolicy("rune-changes", { createHTML: (x) => x });
      s.html = (x) => (policy ? policy.createHTML(x) : x);
    } catch (e) {
      s.html = (x) => x;
    }
  }
  (${PAGE_READY})(s);
  // Runs fn once the page has settled and whenever it changes (batched per frame). fn gets \`ready(el)\`:
  // elements that aren't ready (still hydrating) are left for now and looked at again shortly, since
  // hydration doesn't change the DOM.
  const watch = (id, options, fn) => {
    let queued = false;
    let observer = null;
    let stopped = false;
    let retry = null;
    const run = () => {
      queued = false;
      if (stopped) return;
      let waiting = false;
      const ready = (el) => {
        if (s.ready(el)) return true;
        waiting = true;
        return false;
      };
      try { fn(ready); delete s.errors[id]; } catch (e) { s.errors[id] = String((e && e.message) || e); }
      if (waiting && !retry) retry = setTimeout(() => { retry = null; run(); }, ${READY_RETRY_MS});
    };
    s.whenSettled(() => {
      if (stopped) return;
      run();
      observer = new MutationObserver(() => {
        if (!queued) { queued = true; requestAnimationFrame(run); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, ...options });
    });
    return () => {
      stopped = true;
      clearTimeout(retry);
      if (observer) observer.disconnect();
    };
  };
  const place = (anchor, node, position) => {
    if (position === "before") anchor.before(node);
    else if (position === "prepend") anchor.prepend(node);
    else if (position === "append") anchor.append(node);
    else anchor.after(node);
  };
  const ours = (el) => !!(el && el.closest && el.closest("[" + ATTR + "]"));
  for (const c of want) {
    if (s.active.has(c.id)) continue;
    // A selector that doesn't parse is reported now, not once the page has settled.
    try { document.querySelector(c.selector); } catch (e) { s.errors[c.id] = String((e && e.message) || e); }
    let undo = () => {};
    if (c.action === "text") {
      // The page's own text nodes are changed in place, never replaced: frameworks keep references to
      // them, and one they no longer find breaks their next update (React's "removeChild" errors). The
      // first one with text gets the new text, the others with text are emptied; elements inside stay.
      const original = new Map();
      // With a Suspense boundary inside that may not be hydrated yet, each text node's element is checked too.
      const textNodes = (el, ready) => {
        const deep = s.hasBoundary(el);
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
          const parent = walker.currentNode.parentElement;
          if (ours(parent)) continue;
          if (deep && parent !== el && !ready(parent)) return null;
          nodes.push(walker.currentNode);
        }
        return nodes;
      };
      const set = (node, value) => {
        if (!original.has(node)) original.set(node, node.nodeValue);
        if (node.nodeValue !== value) node.nodeValue = value;
      };
      const stop = watch(c.id, { characterData: true }, (ready) => {
        for (const el of document.querySelectorAll(c.selector)) {
          // One inside another that matches is covered by it (and both changing it would never settle).
          if (ours(el) || (el.parentElement && el.parentElement.closest(c.selector))) continue;
          if (!ready(el)) continue;
          const nodes = textNodes(el, ready);
          if (!nodes) continue;
          const main = nodes.find((n) => n.nodeValue.trim()) || nodes[0];
          if (!main) {
            const added = document.createTextNode(c.value);
            original.set(added, null);
            el.append(added);
            continue;
          }
          set(main, c.value);
          for (const node of nodes) if (node !== main && node.nodeValue.trim()) set(node, "");
        }
      });
      undo = () => {
        stop();
        for (const [node, value] of original) {
          if (!node.isConnected) continue;
          if (value === null) node.remove(); else node.nodeValue = value;
        }
      };
    } else if (c.action === "attribute") {
      const original = new Map();
      const stop = watch(c.id, { attributes: true, attributeFilter: [c.name] }, (ready) => {
        for (const el of document.querySelectorAll(c.selector)) {
          if (ours(el) || !ready(el)) continue;
          if (!original.has(el)) original.set(el, el.getAttribute(c.name));
          if (el.getAttribute(c.name) !== c.value) el.setAttribute(c.name, c.value);
        }
      });
      undo = () => {
        stop();
        for (const [el, value] of original) {
          if (!el.isConnected) continue;
          if (value === null) el.removeAttribute(c.name); else el.setAttribute(c.name, value);
        }
      };
    } else {
      const made = new Map();
      const create = () => {
        let node;
        if (c.action === "button") {
          node = document.createElement("button");
          node.type = "button";
          node.className = "rune-button";
          node.textContent = c.value;
          node.addEventListener("click", (event) => {
            const handler = s.handlers[c.id];
            if (!handler) return;
            try { handler.call(node, event, node); } catch (e) { console.error("[Rune Browser page change]", e); }
          });
        } else {
          const template = document.createElement("template");
          template.innerHTML = s.html(c.value);
          const elements = template.content.children;
          if (elements.length === 1 && template.content.childNodes.length === 1) node = elements[0];
          else {
            node = document.createElement("span");
            node.style.display = "contents";
            node.append(template.content);
          }
        }
        node.setAttribute(ATTR, c.id);
        return node;
      };
      const inside = c.position === "prepend" || c.position === "append";
      const stop = watch(c.id, {}, (ready) => {
        // Elements the page replaced: their additions go with them.
        for (const [anchor, node] of made) if (!anchor.isConnected) { node.remove(); made.delete(anchor); }
        for (const anchor of document.querySelectorAll(c.selector)) {
          if (ours(anchor)) continue;
          const node = made.get(anchor);
          if (node && node.isConnected) continue;
          // Next to it goes into its parent, which has to be hydrated too.
          if (!ready(anchor) || (!inside && anchor.parentElement && !ready(anchor.parentElement))) continue;
          const fresh = create();
          place(anchor, fresh, c.position || "after");
          made.set(anchor, fresh);
        }
      });
      undo = () => {
        stop();
        for (const node of made.values()) node.remove();
        for (const node of document.querySelectorAll("[" + ATTR + '="' + c.id + '"]')) node.remove();
      };
    }
    s.active.set(c.id, { key: keyOf(c), undo });
  }
  const errors = {};
  for (const c of want) if (s.errors[c.id]) errors[c.id] = s.errors[c.id];
  return errors;
})()`;
}

const pageChangeSpecWithId = (c: PageChange) => ({ id: c.id, ...pageChangeSpec(c) });

/** Registers a button's click handler (a separate script, so a syntax error only breaks that one). */
export function pageChangeHandlerScript(c: PageChange) {
  return `(() => {
  const s = ${CHANGES_STATE};
  s.handlers[${JSON.stringify(c.id)}] = function (event, button) {
${c.onClick ?? ""}
  };
  return null;
})()`;
}
