// Scripts run inside web pages (webview.executeJavaScript) for picking
// elements. They run in the page's own world, so everything they report is
// treated as page data.
import { base } from "../../shared/theme";
import { inspectedStyles } from "../../shared/web";

// Rune's accent, readable on any page (a fixed color: pages don't get the user's theme).
const ACCENT = base.light.accent;

/**
 * Lets the user hover and click an element. Evaluates to a promise of its
 * ElementInfo, or null when cancelled (Escape or `cancelPickScript`).
 */
export const pickScript = `(() => new Promise((resolve) => {
  window.__runePicker?.cancel();
  const KEYS = ${JSON.stringify(inspectedStyles)};
  const root = document.documentElement;
  const box = document.createElement("div");
  const label = document.createElement("div");
  const layer = "position:fixed;z-index:2147483647;pointer-events:none;display:none;box-sizing:border-box;";
  box.style.cssText = layer + "border:2px solid ${ACCENT};background:${ACCENT}1f;border-radius:3px;";
  label.style.cssText = layer + "background:${ACCENT};color:#fff;font:600 11px/18px system-ui,sans-serif;padding:0 6px;border-radius:3px;white-space:nowrap;";
  root.append(box, label);
  const cursor = root.style.cursor;
  root.style.cursor = "crosshair";
  let current = null;

  const esc = (s) => CSS.escape(s);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  // Generated class names (css-1x2y3z, sc-abc, jsx-123…) change between builds.
  const stableClass = (c) => /^[a-zA-Z][\\w-]{1,30}$/.test(c) && !/\\d{3}|^(css|sc|jsx|svelte|emotion|tw)-|__[\\w-]*\\d|[a-zA-Z]\\d[a-zA-Z]\\d/.test(c);
  const anchor = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && !/\\d{3}/.test(el.id) && unique("#" + esc(el.id))) return "#" + esc(el.id);
    for (const attr of ["data-testid", "data-test", "data-qa", "aria-label", "name", "role"]) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) {
        const sel = tag + "[" + attr + '="' + v.replace(/"/g, '\\\\"') + '"]';
        if (unique(sel)) return sel;
      }
    }
    return null;
  };
  const selectorFor = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== root; node = node.parentElement) {
      const a = anchor(node);
      if (a) { parts.unshift(a); break; }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter(stableClass).slice(0, 2);
      part += classes.map((c) => "." + esc(c)).join("");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1 && !(classes.length && unique([part, ...parts].join(" > ")))) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) break;
    }
    return parts.join(" > ");
  };
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + [...el.classList].slice(0, 2).map((c) => "." + c).join("");
  const info = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const html = el.outerHTML;
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: text.length > 300 ? text.slice(0, 300) + "…" : text,
      html: html.length > 4000 ? html.slice(0, 4000) + "…" : html,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      styles: Object.fromEntries(KEYS.map((k) => [k, cs.getPropertyValue(k)])),
    };
  };

  const show = (el) => {
    const r = el.getBoundingClientRect();
    box.style.display = label.style.display = "block";
    Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    label.textContent = describe(el) + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    Object.assign(label.style, { left: Math.max(0, r.left) + "px", top: (r.top > 22 ? r.top - 20 : r.bottom + 2) + "px" });
  };
  const onMove = (e) => {
    const el = e.composedPath()[0];
    if (!(el instanceof Element) || el === current) return;
    current = el;
    show(el);
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onClick = (e) => {
    block(e);
    const el = e.composedPath()[0];
    finish(el instanceof Element ? el : current);
  };
  const onKey = (e) => { if (e.key === "Escape") { block(e); finish(null); } };
  const events = { mousemove: onMove, click: onClick, keydown: onKey, mousedown: block, mouseup: block, pointerdown: block, pointerup: block, auxclick: block, contextmenu: block };
  for (const [type, fn] of Object.entries(events)) addEventListener(type, fn, true);

  function finish(el) {
    for (const [type, fn] of Object.entries(events)) removeEventListener(type, fn, true);
    box.remove();
    label.remove();
    root.style.cursor = cursor;
    window.__runePicker = null;
    if (!el) return resolve(null);
    if (!document.getElementById("rune-picked-style")) {
      const style = document.createElement("style");
      style.id = "rune-picked-style";
      style.textContent = "[data-rune-picked]{outline:2px solid ${ACCENT} !important;outline-offset:2px !important}";
      root.append(style);
    }
    el.setAttribute("data-rune-picked", "");
    resolve(info(el));
  }
  window.__runePicker = { cancel: () => finish(null) };
}))()`;

export const cancelPickScript = `(() => { window.__runePicker?.cancel(); return true; })()`;

/** Removes the outline from picked elements (all, or the ones matching `selector`). */
export const unmarkScript = (selector?: string) => `(() => {
  const sel = ${JSON.stringify(selector ?? null)};
  for (const el of document.querySelectorAll("[data-rune-picked]")) {
    try { if (!sel || el.matches(sel)) el.removeAttribute("data-rune-picked"); } catch {}
  }
  return true;
})()`;
