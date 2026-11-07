// What a page looked like when its tab was unloaded (lib/unload.ts): where it
// was scrolled to and what was typed into it, so it comes back the same when
// the tab is opened again. Kept in memory only, and never passwords, hidden
// or file inputs, or card numbers.

export interface SavedPage {
  url: string;
  scrollX: number;
  scrollY: number;
  /** Scrolled elements other than the page (single-page apps often scroll a container). */
  scrollers: { selector: string; top: number; left: number }[];
  /** Fields the user changed. */
  fields: { selector: string; value?: string; checked?: boolean; html?: string }[];
}

const saved = new Map<string, SavedPage>();

export const savePage = (tabId: string, page: SavedPage) => saved.set(tabId, page);
/** The state saved for a tab, once (it's restored on the next load). */
export function takeSavedPage(tabId: string) {
  const page = saved.get(tabId);
  saved.delete(tabId);
  return page;
}
export const peekSavedPage = (tabId: string) => saved.get(tabId);
export const forgetSavedPage = (tabId: string) => saved.delete(tabId);

// A selector that finds the element again: its id if that's unique, else its path from the body.
const selectorFn = `function selectorOf(el) {
  if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) { parts.unshift("#" + CSS.escape(node.id)); break; }
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [];
    parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : tag);
  }
  return parts.join(" > ");
}`;

/** Runs in the page; returns a SavedPage. */
export const captureScript = `(() => {
  ${selectorFn}
  const skipTypes = new Set(["password", "hidden", "file", "submit", "button", "reset", "image"]);
  const secret = (el) => /^(cc-|one-time-code)/.test(el.getAttribute("autocomplete") || "") || /card|cvc|cvv|iban/i.test(el.name || "");
  const fields = [];
  for (const el of document.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
    if (fields.length >= 200) break;
    if (el instanceof HTMLInputElement) {
      if (skipTypes.has(el.type) || secret(el)) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked !== el.defaultChecked) fields.push({ selector: selectorOf(el), checked: el.checked });
      } else if (el.value !== el.defaultValue && el.value.length <= 100000) fields.push({ selector: selectorOf(el), value: el.value });
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue && el.value.length <= 100000 && !secret(el)) fields.push({ selector: selectorOf(el), value: el.value });
    } else if (el instanceof HTMLSelectElement) {
      if ([...el.options].some((o) => o.selected !== o.defaultSelected)) fields.push({ selector: selectorOf(el), value: el.value });
    } else if (el.isContentEditable && el === document.activeElement && el.innerHTML.length <= 100000) {
      fields.push({ selector: selectorOf(el), html: el.innerHTML });
    }
  }
  const scrollers = [];
  for (const el of document.querySelectorAll("body *")) {
    if (scrollers.length >= 20) break;
    if ((el.scrollTop > 0 || el.scrollLeft > 0) && el.scrollHeight > el.clientHeight) {
      scrollers.push({ selector: selectorOf(el), top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return { url: location.href, scrollX: window.scrollX, scrollY: window.scrollY, scrollers, fields };
})()`;

/**
 * Runs in the page: puts the saved state back. Pages that render late
 * (single-page apps) get a few seconds for the elements to show up. Values go
 * in through the elements' own setters with input events, so frameworks see them.
 */
export const restoreScript = (page: SavedPage) => `(async () => {
  const page = ${JSON.stringify(page)};
  const set = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  };
  const pending = new Set([...page.fields, ...page.scrollers]);
  const deadline = Date.now() + 5000;
  let tall = false;
  for (;;) {
    for (const f of page.fields) {
      if (!pending.has(f)) continue;
      const el = document.querySelector(f.selector);
      if (!el) continue;
      pending.delete(f);
      try {
        if (f.checked !== undefined) { if (el.checked !== f.checked) el.click(); }
        else if (f.html !== undefined) el.innerHTML = f.html;
        else set(el, f.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    }
    for (const s of page.scrollers) {
      if (!pending.has(s)) continue;
      const el = document.querySelector(s.selector);
      if (!el || el.scrollHeight - el.clientHeight < s.top) continue;
      pending.delete(s);
      el.scrollTo(s.left, s.top);
    }
    tall = document.documentElement.scrollHeight - window.innerHeight >= page.scrollY;
    if (tall) window.scrollTo(page.scrollX, page.scrollY);
    if ((tall && !pending.size) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!tall) window.scrollTo(page.scrollX, page.scrollY);
  return pending.size;
})()`;

/** Runs in a page: what it shows, as text (the main content if it has one), for shared tab context (lib/sharing.ts). */
export const readPageScript = `(() => {
  const main = document.querySelector("main, article, [role=main]") || document.body;
  const text = (main ? main.innerText : "").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  const selection = String(window.getSelection() || "").trim();
  return { url: location.href, title: document.title, text: text.slice(0, ${30_000}), selection: selection.slice(0, 5000) };
})()`;
