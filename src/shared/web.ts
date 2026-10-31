// Helpers for web tabs shared by the renderer and the website agent.
import type { PageChange, PageChangeAction, PageChangeSpec, PageScope } from "./api";
import { searchEngines, type Settings } from "./settings";

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

/**
 * Turns address bar input into a URL: URLs stay as they are, things that look
 * like a domain get https:// (http:// for local addresses), local paths become
 * file:// URLs, anything else is searched for.
 */
export function normalizeUrl(input: string, engine: Settings["web"]["searchEngine"] = "duckduckgo") {
  const text = input.trim();
  if (!text) return "";
  if (/^(https?:\/\/|about:|file:\/\/)/i.test(text)) return text;
  if (/^(\/[^/\s]|[a-z]:[\\/])/i.test(text)) return fileUrl(text);
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(text);
  if (local) return `http://${text}`;
  const looksLikeHost =
    !/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text);
  if (looksLikeHost) return `https://${text}`;
  return searchEngines[engine].url.replace("%s", encodeURIComponent(text));
}

/**
 * Wraps a site override's JavaScript for injection. It runs once per page load;
 * `onElement(selector, fn)` calls `fn` for every matching element, now and
 * whenever the page adds more (single-page apps re-render all the time).
 * Evaluates to an error message or null.
 */
export function overrideScript(js: string) {
  return `(() => {
  const onElement = (selector, fn) => {
    const seen = new WeakSet();
    let queued = false;
    const run = () => {
      queued = false;
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        try { fn(el); } catch (e) { console.error("[Rune Browser override]", e); }
      }
    };
    run();
    new MutationObserver(() => {
      if (!queued) { queued = true; requestAnimationFrame(run); }
    }).observe(document.documentElement, { childList: true, subtree: true });
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
      `button.rune-button { font: 500 13px/1.2 system-ui, sans-serif; padding: 5px 12px; margin: 4px; border-radius: 6px; border: 1px solid rgba(0,0,0,.15); background: #6d4aff; color: #fff; cursor: pointer; }`,
    );
  }
  return rules.join("\n");
}

/** The page's state for page changes (shared by the scripts below). */
const CHANGES_STATE = `(window.__runeChanges || (window.__runeChanges = { active: new Map(), handlers: {}, errors: {} }))`;

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
  // Runs fn now and whenever the page changes (batched per frame).
  const watch = (id, options, fn) => {
    let queued = false;
    const run = () => {
      queued = false;
      try { fn(); delete s.errors[id]; } catch (e) { s.errors[id] = String((e && e.message) || e); }
    };
    run();
    const observer = new MutationObserver(() => {
      if (!queued) { queued = true; requestAnimationFrame(run); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, ...options });
    return () => observer.disconnect();
  };
  const place = (anchor, node, position) => {
    if (position === "before") anchor.before(node);
    else if (position === "prepend") anchor.prepend(node);
    else if (position === "append") anchor.append(node);
    else anchor.after(node);
  };
  const ours = (el) => !!(el.closest && el.closest("[" + ATTR + "]"));
  for (const c of want) {
    if (s.active.has(c.id)) continue;
    let undo = () => {};
    if (c.action === "text") {
      const original = new Map();
      const stop = watch(c.id, { characterData: true }, () => {
        for (const el of document.querySelectorAll(c.selector)) {
          if (ours(el)) continue;
          if (!original.has(el)) original.set(el, el.textContent);
          if (el.textContent !== c.value) el.textContent = c.value;
        }
      });
      undo = () => { stop(); for (const [el, text] of original) if (el.isConnected) el.textContent = text; };
    } else if (c.action === "attribute") {
      const original = new Map();
      const stop = watch(c.id, { attributes: true, attributeFilter: [c.name] }, () => {
        for (const el of document.querySelectorAll(c.selector)) {
          if (ours(el)) continue;
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
      const stop = watch(c.id, {}, () => {
        // Elements the page replaced: their additions go with them.
        for (const [anchor, node] of made) if (!anchor.isConnected) { node.remove(); made.delete(anchor); }
        for (const anchor of document.querySelectorAll(c.selector)) {
          if (ours(anchor)) continue;
          const node = made.get(anchor);
          if (node && node.isConnected) continue;
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
