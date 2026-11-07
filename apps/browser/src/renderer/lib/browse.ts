// What the website agent's browse tools (server: agent/browseTools.ts) run in
// a web tab's page: finding the element an action is about, filling fields,
// scrolling and waiting. Clicks, typing and keys are real input events, sent
// by the tab (WebTab's page handle).

export interface Locator {
  selector?: string | null;
  text?: string | null;
  index?: number | null;
  x?: number | null;
  y?: number | null;
  /** The element that has the focus. */
  focused?: boolean;
}

/** Runs in the page: the element for a locator, scrolled into view, described for Rune Browser's checks (agent/browseTools.ts: Target). */
export const targetScript = (locator: Locator) => `(() => {
  const loc = ${JSON.stringify(locator)};
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const labelOf = (el) => (el.getAttribute("aria-label") || (el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type) ? el.value : "") || el.innerText || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("placeholder") || (el.labels && el.labels[0] ? el.labels[0].innerText : "") || "").replace(/\\s+/g, " ").trim().slice(0, 160);
  let el = null;
  if (loc.focused) {
    el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    if (!el) return { error: "Nothing has the focus in the page." };
  } else if (loc.selector) {
    let all;
    try { all = [...document.querySelectorAll(loc.selector)]; } catch (e) { return { error: "Invalid selector: " + e.message }; }
    const shown = all.filter(visible);
    el = (shown.length ? shown : all)[loc.index || 0] || null;
    if (!el) return { error: all.length ? "Only " + all.length + " elements match " + loc.selector : "Nothing matches " + loc.selector };
  } else if (loc.text) {
    const want = loc.text.replace(/\\s+/g, " ").trim().toLowerCase();
    const candidates = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], input, select, textarea, label, summary, [onclick], [tabindex]")].filter(visible);
    const scored = candidates.map((c) => { const l = labelOf(c).toLowerCase(); return { c, s: l === want ? 2 : l.includes(want) ? 1 : 0, len: l.length }; }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.len - b.len);
    let match = scored[loc.index || 0] ? scored[loc.index || 0].c : null;
    // A label stands for its control.
    if (match instanceof HTMLLabelElement && match.control) match = match.control;
    el = match;
    if (!el) return { error: "No button, link or field says “" + loc.text + "”. Look at the page (get_page, screenshot) and use a selector." };
  } else if (typeof loc.x === "number" && typeof loc.y === "number") {
    el = document.elementFromPoint(loc.x, loc.y);
    if (!el) return { error: "Nothing at " + loc.x + "," + loc.y };
  } else {
    return { error: "Give a selector, text, or x and y." };
  }
  if (loc.selector || loc.text) {
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth) el.scrollIntoView({ block: "center", inline: "center" });
  }
  const r = el.getBoundingClientRect();
  const atPoint = typeof loc.x === "number" && typeof loc.y === "number" && !loc.selector && !loc.text;
  const x = atPoint ? loc.x : Math.round(r.left + r.width / 2);
  const y = atPoint ? loc.y : Math.round(r.top + r.height / 2);
  const form = el.form || el.closest("form");
  const formLabel = form ? (form.getAttribute("aria-label") || form.getAttribute("name") || form.id || [...form.querySelectorAll("button, input[type=submit]")].map(labelOf).filter(Boolean).join(" ")).slice(0, 160) : "";
  const payment = form ? !!form.querySelector("[autocomplete^=cc-], input[name*=card i], input[name*=cvc i], input[name*=cvv i], input[name*=iban i]") : false;
  return {
    x, y,
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    tag: el.tagName.toLowerCase(),
    type: (el instanceof HTMLInputElement ? el.type : el.getAttribute("role")) || el.tagName.toLowerCase(),
    label: labelOf(el),
    name: el.getAttribute("name") || el.id || "",
    autocomplete: el.getAttribute("autocomplete") || "",
    href: (el.closest("a") && el.closest("a").href) || "",
    form: form ? { action: form.getAttribute("action") || "", label: formLabel, payment } : null,
    url: location.href,
  };
})()`;

/** Runs in the page: puts the caret into the element at x,y, selecting what's in it when it should be replaced. */
export const focusScript = (x: number, y: number, clear: boolean) => `(() => {
  let el = document.elementFromPoint(${x}, ${y});
  while (el && !(el.matches("input, textarea, select, [contenteditable=''], [contenteditable=true]")) && el.parentElement) el = el.parentElement;
  if (!el || !el.matches("input, textarea, select, [contenteditable=''], [contenteditable=true]")) el = document.elementFromPoint(${x}, ${y});
  el.focus();
  if (${clear}) {
    if (typeof el.select === "function") el.select();
    else { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  } else if (typeof el.setSelectionRange === "function" && typeof el.value === "string") {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
  }
  return document.activeElement === el;
})()`;

/** Runs in the page: sets a field like the user would (checkboxes and radios are clicked, values go through the element's own setter). */
export const fillScript = (selector: string, value: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return "Nothing matches " + ${JSON.stringify(selector)};
  const value = ${JSON.stringify(value)};
  el.focus();
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const want = /^(true|1|yes|on|checked)$/i.test(value.trim());
    if (el.checked !== want) el.click();
    return null;
  }
  if (el instanceof HTMLSelectElement) {
    const option = [...el.options].find((o) => o.value === value) || [...el.options].find((o) => o.text.trim().toLowerCase() === value.trim().toLowerCase());
    if (!option) return "No option “" + value + "” in " + ${JSON.stringify(selector)} + " (options: " + [...el.options].map((o) => o.text.trim()).slice(0, 20).join(", ") + ")";
    el.value = option.value;
  } else if (el.isContentEditable) {
    el.textContent = value;
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return null;
})()`;

/** Runs in the page: scrolls by about a screen (or to an element). */
export const scrollScript = (direction: "down" | "up", pixels: number | null, selector: string | null) => `(() => {
  const sel = ${JSON.stringify(selector)};
  if (sel) { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: "center" }); }
  else window.scrollBy({ top: ${direction === "up" ? -1 : 1} * (${pixels ?? "null"} ?? Math.round(innerHeight * 0.85)) });
  return { scrollY: window.scrollY, pageHeight: document.documentElement.scrollHeight };
})()`;

/** Runs in the page: resolves true once the text or selector is there, false after the timeout. */
export const waitForScript = (
  text: string | null,
  selector: string | null,
  timeoutMs: number,
) => `new Promise((resolve) => {
  const text = ${JSON.stringify(text?.toLowerCase() ?? null)};
  const sel = ${JSON.stringify(selector)};
  const there = () => { try { return (sel ? !!document.querySelector(sel) : true) && (text ? (document.body?.innerText || "").toLowerCase().includes(text) : true); } catch { return false; } };
  if (there()) return resolve(true);
  const start = Date.now();
  const timer = setInterval(() => {
    if (there()) { clearInterval(timer); resolve(true); }
    else if (Date.now() - start > ${timeoutMs}) { clearInterval(timer); resolve(false); }
  }, 150);
})`;

/** Electron's names for keys (sendInputEvent), from the DOM's. */
export const keyCodeOf = (key: string) =>
  (
    ({
      ArrowDown: "Down",
      ArrowUp: "Up",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      " ": "Space",
      Esc: "Escape",
      Return: "Enter",
      Del: "Delete",
    }) as Record<string, string>
  )[key] ?? key;
