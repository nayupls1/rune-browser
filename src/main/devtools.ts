// DevTools for the agents: what Chrome's DevTools shows about a page, over the
// DevTools protocol (cdp.ts), for app previews and web tabs. Console messages
// and errors, metrics and web vitals, performance traces (analyzed here, the
// trace saved for Chrome DevTools), the accessibility tree, an element's CSS
// rules and box model, cookies and storage, code coverage, and emulating
// devices, slow networks and CPUs, and media features.
//
// The Rune Browser window asks over IPC (the server's agent tools → the hub → the
// renderer → here). Web tabs are the user's own pages, with their logins:
// cookie values never leave this process, and storage values, console text
// and URLs are shown with tokens redacted. Console capture starts on web tabs
// only once an agent asks for it (pages can notice it).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain, webContents, type BrowserWindow, type WebContents } from "electron";
import { isSensitiveName, REDACTED, redactTokens, redactUrl } from "../shared/network";
import { analyzeTrace, describeTrace, type TraceEvent } from "../shared/trace";
import * as cdp from "./cdp";

const MAX_CONSOLE = 500;
const MAX_TEXT = 2000;
const KEEP_TRACES = 20;

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  source?: string;
}

interface ConsoleLog {
  entries: ConsoleEntry[];
  since: number;
}

/** Devices to emulate: viewport, pixel ratio, touch and user agent. */
const devices: Record<string, { width: number; height: number; scale: number; mobile: boolean; userAgent?: string }> = {
  "iphone-15": {
    width: 393,
    height: 852,
    scale: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  "iphone-se": {
    width: 375,
    height: 667,
    scale: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  "pixel-8": {
    width: 412,
    height: 915,
    scale: 2.625,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    width: 820,
    height: 1180,
    scale: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  laptop: { width: 1366, height: 768, scale: 1, mobile: false },
  desktop: { width: 1920, height: 1080, scale: 1, mobile: false },
};

/** Network speeds: latency (ms) and throughput (bytes/s), as DevTools' presets. */
const networks: Record<string, { offline: boolean; latency: number; download: number; upload: number }> = {
  offline: { offline: true, latency: 0, download: 0, upload: 0 },
  "slow-3g": { offline: false, latency: 2000, download: (400 * 1024) / 8, upload: (400 * 1024) / 8 },
  "fast-3g": { offline: false, latency: 563, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  "slow-4g": { offline: false, latency: 150, download: (9 * 1024 * 1024) / 8, upload: (9 * 1024 * 1024) / 8 },
  none: { offline: false, latency: 0, download: -1, upload: -1 },
};

const TRACE_CATEGORIES = [
  "-*",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "toplevel",
  "blink.console",
  "blink.user_timing",
  "latencyInfo",
  "loading",
  "v8.execute",
  "v8",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.gc",
];

const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}…` : text);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A console argument as text, like the console shows it. */
function remoteText(arg: any): string {
  if (!arg) return "";
  if (arg.type === "string") return arg.value;
  if (arg.unserializableValue) return arg.unserializableValue;
  if ("value" in arg && arg.type !== "object") return String(arg.value);
  const preview = arg.preview;
  if (preview?.properties) {
    const props = preview.properties
      .map((p: any) => `${p.name}: ${p.type === "string" ? JSON.stringify(p.value) : p.value}`)
      .join(", ");
    return preview.subtype === "array"
      ? `[${props}${preview.overflow ? ", …" : ""}]`
      : `{${props}${preview.overflow ? ", …" : ""}}`;
  }
  return arg.description ?? arg.className ?? arg.type;
}

export interface DevtoolsOptions {
  getWindow: () => BrowserWindow | undefined;
  /** Web tabs, as opposed to app previews. */
  isWebTab: (contents: WebContents) => boolean;
}

export function setupDevtools(options: DevtoolsOptions) {
  const consoles = new Map<number, ConsoleLog>();
  const emulated = new Map<number, Record<string, unknown>>();
  const tracing = new Set<number>();
  const tracesDir = join(app.getPath("userData"), "data", "traces");

  /** Text from a web tab with tokens taken out. App previews are the agent's own app. */
  const safe = (contents: WebContents, text: string) => (options.isWebTab(contents) ? redactTokens(text) : text);
  const safeUrl = (contents: WebContents, url: string) => (options.isWebTab(contents) ? redactUrl(url) : url);

  /** Starts keeping a page's console messages and uncaught errors (from now on). */
  function captureConsole(contents: WebContents) {
    if (consoles.has(contents.id) || !cdp.acquire(contents, "console")) return;
    const log: ConsoleLog = { entries: [], since: Date.now() };
    consoles.set(contents.id, log);
    const add = (entry: ConsoleEntry) => {
      log.entries.push({
        ...entry,
        text: clip(safe(contents, entry.text)),
        ...(entry.source ? { source: safeUrl(contents, entry.source) } : {}),
      });
      if (log.entries.length > MAX_CONSOLE) log.entries.splice(0, log.entries.length - MAX_CONSOLE);
    };
    const where = (url?: string, line?: number) =>
      url ? `${url}${typeof line === "number" ? `:${line + 1}` : ""}` : undefined;
    const onMessage = (_event: unknown, method: string, p: any) => {
      if (method === "Runtime.consoleAPICalled") {
        const frame = p.stackTrace?.callFrames?.[0];
        const level = p.type === "warning" ? "warn" : p.type === "assert" ? "error" : p.type;
        add({
          at: Math.round(p.timestamp ?? Date.now()),
          level,
          text: (p.args ?? []).map(remoteText).join(" "),
          source: where(frame?.url, frame?.lineNumber),
        });
      } else if (method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails ?? {};
        const description = d.exception?.description ?? d.text ?? "Uncaught error";
        add({
          at: Math.round(p.timestamp ?? Date.now()),
          level: "exception",
          text: description,
          source: where(d.url, d.lineNumber),
        });
      } else if (method === "Log.entryAdded") {
        const e = p.entry ?? {};
        add({
          at: Math.round(e.timestamp ?? Date.now()),
          level: e.level === "warning" ? "warn" : e.level,
          text: `[${e.source}] ${e.text}`,
          source: where(e.url, e.lineNumber),
        });
      }
    };
    const navigated = (_event: unknown, url: string) =>
      add({ at: Date.now(), level: "info", text: `— Navigated to ${url}` });
    contents.debugger.on("message", onMessage);
    contents.on("did-navigate", navigated);
    const stop = () => {
      consoles.delete(contents.id);
      if (contents.isDestroyed()) return;
      contents.debugger.removeListener("message", onMessage);
      contents.removeListener("did-navigate", navigated);
    };
    contents.once("destroyed", stop);
    contents.debugger.once("detach", stop);
    void cdp.send(contents, "Runtime.enable").catch(() => {});
    void cdp.send(contents, "Log.enable").catch(() => {});
  }

  /** Runs JavaScript in the page and returns its value (awaited). */
  const evaluate = async <T>(contents: WebContents, expression: string): Promise<T> => {
    const r = await cdp.send(contents, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 10_000,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value as T;
  };

  /** The node of the first element matching `selector` (DOM domain on). */
  const nodeFor = async (contents: WebContents, selector: string) => {
    const { root } = await cdp.send(contents, "DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send(contents, "DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`Nothing matches ${selector}`);
    return nodeId as number;
  };

  /** Reloads and waits for the load (bounded). */
  const reloadAndWait = (contents: WebContents, timeoutMs = 30_000) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        contents.removeListener("did-finish-load", done);
        contents.removeListener("did-fail-load", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      contents.once("did-finish-load", done);
      contents.once("did-fail-load", done);
      contents.reload();
    });

  const commands: Record<string, (contents: WebContents, params: any) => Promise<unknown>> = {
    async console(contents, params: { level?: string; limit?: number; clear?: boolean }) {
      const started = !consoles.has(contents.id);
      captureConsole(contents);
      const log = consoles.get(contents.id);
      if (!log) throw new Error("Can't read this page's console");
      const levels =
        params.level === "errors"
          ? ["error", "exception"]
          : params.level === "warnings"
            ? ["error", "exception", "warn"]
            : null;
      const entries = log.entries
        .filter((e) => !levels || levels.includes(e.level))
        .slice(-Math.min(Math.max(params.limit ?? 100, 1), MAX_CONSOLE));
      if (params.clear) log.entries = [];
      return { startedNow: started, since: log.since, entries };
    },

    async metrics(contents) {
      await cdp.send(contents, "Performance.enable");
      const { metrics } = await cdp.send<{ metrics: { name: string; value: number }[] }>(
        contents,
        "Performance.getMetrics",
      );
      await cdp.send(contents, "Performance.disable").catch(() => {});
      const wanted = [
        "Documents",
        "Frames",
        "JSEventListeners",
        "Nodes",
        "LayoutCount",
        "RecalcStyleCount",
        "LayoutDuration",
        "RecalcStyleDuration",
        "ScriptDuration",
        "TaskDuration",
        "JSHeapUsedSize",
        "JSHeapTotalSize",
      ];
      const runtime = Object.fromEntries(
        metrics
          .filter((m) => wanted.includes(m.name))
          .map((m) => [
            m.name,
            /Duration$/.test(m.name)
              ? `${Math.round(m.value * 1000)} ms`
              : /Size$/.test(m.name)
                ? `${(m.value / 1048576).toFixed(1)} MB`
                : m.value,
          ]),
      );
      // Web vitals and timing as the page saw them (buffered entries, so a load that's over still counts).
      const page = await evaluate<Record<string, unknown>>(
        contents,
        `(async () => {
          const nav = performance.getEntriesByType("navigation")[0];
          const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
          const observe = (type) => new Promise((resolve) => {
            try {
              const seen = [];
              const o = new PerformanceObserver((list) => seen.push(...list.getEntries()));
              o.observe({ type, buffered: true });
              setTimeout(() => { o.disconnect(); resolve(seen); }, 50);
            } catch { resolve([]); }
          });
          const [lcp, shifts, longTasks, events] = await Promise.all([observe("largest-contentful-paint"), observe("layout-shift"), observe("longtask"), observe("event")]);
          const last = lcp.at(-1);
          const resources = performance.getEntriesByType("resource");
          return {
            url: location.href,
            ttfb: nav ? Math.round(nav.responseStart) : null,
            fcp: paint["first-contentful-paint"] ?? null,
            lcp: last ? Math.round(last.startTime) : null,
            lcpElement: last?.element ? last.element.tagName.toLowerCase() + (last.element.id ? "#" + last.element.id : "") + (last.url ? " " + last.url.slice(0, 120) : "") : null,
            cls: Math.round(shifts.filter((s) => !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0) * 1000) / 1000,
            domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
            load: nav ? Math.round(nav.loadEventEnd) : null,
            longTasks: longTasks.length,
            totalBlockingTime: Math.round(longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0)),
            slowestInteraction: events.length ? Math.round(Math.max(...events.map((e) => e.duration))) : null,
            resources: resources.length,
            transferKb: Math.round(resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
            domElements: document.getElementsByTagName("*").length,
          };
        })()`,
      );
      return { ...page, url: typeof page.url === "string" ? safeUrl(contents, page.url) : page.url, runtime };
    },

    async trace(contents, params: { seconds?: number; reload?: boolean; interaction?: string }) {
      if (tracing.size) throw new Error("Another trace is being recorded; try again when it's done.");
      tracing.add(contents.id);
      const seconds = Math.min(Math.max(params.seconds ?? (params.reload || params.interaction ? 3 : 5), 1), 30);
      let interactionError: string | undefined;
      const events: TraceEvent[] = [];
      let complete = () => {};
      const finished = new Promise<void>((resolve) => (complete = resolve));
      const onMessage = (_event: unknown, method: string, p: any) => {
        if (method === "Tracing.dataCollected") for (const e of p.value) events.push(e);
        else if (method === "Tracing.tracingComplete") complete();
      };
      contents.debugger.on("message", onMessage);
      const startedAt = Date.now();
      try {
        await cdp.send(contents, "Tracing.start", {
          transferMode: "ReportEvents",
          traceConfig: {
            recordMode: "recordAsMuchAsPossible",
            includedCategories: TRACE_CATEGORIES.filter((c) => c !== "-*"),
            excludedCategories: ["*"],
          },
        });
        if (params.reload) await reloadAndWait(contents);
        // What the agent wants to measure: it runs inside the recording, as the user's action would.
        if (params.interaction) {
          await evaluate(contents, `(async () => {\n${params.interaction}\n})()`).catch(
            (err: Error) => void (interactionError = clip(safe(contents, err.message), 500)),
          );
        }
        await sleep(seconds * 1000);
        await cdp.send(contents, "Tracing.end");
        await Promise.race([finished, sleep(60_000)]);
      } finally {
        contents.debugger.removeListener("message", onMessage);
        tracing.delete(contents.id);
      }
      const url = contents.getURL();
      const analysis = analyzeTrace(events, { url });
      analysis.url = safeUrl(contents, url);
      // The trace itself, for Chrome DevTools' Performance panel (Load profile…). The newest ones are kept.
      mkdirSync(tracesDir, { recursive: true });
      let host = "page";
      try {
        host = new URL(url).host.replace(/[^\w.-]+/g, "_") || "page";
      } catch {}
      const file = join(tracesDir, `trace-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${host}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          traceEvents: events,
          metadata: { source: "Rune Browser", startTime: new Date(startedAt).toISOString() },
        }),
      );
      const traces = readdirSync(tracesDir)
        .filter((f) => f.startsWith("trace-"))
        .sort();
      for (const old of traces.slice(0, Math.max(0, traces.length - KEEP_TRACES)))
        rmSync(join(tracesDir, old), { force: true });
      return {
        analysis,
        summary: describeTrace(analysis),
        file,
        events: events.length,
        seconds,
        ...(interactionError ? { interactionError } : {}),
      };
    },

    async accessibility(contents, params: { selector?: string; limit?: number }) {
      const limit = Math.min(Math.max(params.limit ?? 300, 10), 2000);
      await cdp.send(contents, "DOM.enable");
      await cdp.send(contents, "Accessibility.enable");
      try {
        let rootBackend: number | undefined;
        if (params.selector) {
          const nodeId = await nodeFor(contents, params.selector);
          rootBackend = (await cdp.send(contents, "DOM.describeNode", { nodeId })).node.backendNodeId;
        }
        const { nodes } = await cdp.send<{ nodes: any[] }>(contents, "Accessibility.getFullAXTree");
        const byId = new Map(nodes.map((n) => [n.nodeId, n]));
        const root = rootBackend !== undefined ? nodes.find((n) => n.backendDOMNodeId === rootBackend) : nodes[0];
        if (!root) throw new Error("No accessibility node for that element");
        const lines: string[] = [];
        const prop = (n: any, name: string) => n.properties?.find((p: any) => p.name === name)?.value?.value;
        const visit = (n: any, depth: number) => {
          if (lines.length >= limit) return;
          const role = n.role?.value ?? "";
          const name = n.name?.value ?? "";
          const show = !n.ignored && !(role === "generic" && !name) && role !== "none" && role !== "InlineTextBox";
          if (show) {
            const flags = [
              "focused",
              "checked",
              "selected",
              "expanded",
              "disabled",
              "required",
              "invalid",
              "pressed",
              "level",
              "url",
            ]
              .map((p) => [p, prop(n, p)] as const)
              .filter(([, v]) => v !== undefined && v !== false && v !== "false")
              .map(([p, v]) =>
                v === true || v === "true" ? p : `${p}=${p === "url" ? safeUrl(contents, String(v)) : v}`,
              );
            const value = n.value?.value;
            lines.push(
              `${"  ".repeat(depth)}${role}${name ? ` "${clip(safe(contents, String(name)), 200)}"` : ""}${value !== undefined && value !== "" ? ` value="${clip(safe(contents, String(value)), 100)}"` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`,
            );
          }
          for (const id of n.childIds ?? []) {
            const child = byId.get(id);
            if (child) visit(child, show ? depth + 1 : depth);
          }
        };
        visit(root, 0);
        return { lines, truncated: lines.length >= limit, total: nodes.length };
      } finally {
        await cdp.send(contents, "Accessibility.disable").catch(() => {});
        await cdp.send(contents, "DOM.disable").catch(() => {});
      }
    },

    async styles(contents, params: { selector: string; properties?: string[] }) {
      const sheets = new Map<string, { url: string; line: number }>();
      const onMessage = (_event: unknown, method: string, p: any) => {
        if (method === "CSS.styleSheetAdded")
          sheets.set(p.header.styleSheetId, {
            url: p.header.sourceURL || (p.header.isInline ? "inline <style>" : ""),
            line: p.header.startLine ?? 0,
          });
      };
      contents.debugger.on("message", onMessage);
      try {
        await cdp.send(contents, "DOM.enable");
        await cdp.send(contents, "CSS.enable");
        const nodeId = await nodeFor(contents, params.selector);
        const [{ node }, matched, { computedStyle }, box] = await Promise.all([
          cdp.send(contents, "DOM.describeNode", { nodeId }),
          cdp.send(contents, "CSS.getMatchedStylesForNode", { nodeId }),
          cdp.send<{ computedStyle: { name: string; value: string }[] }>(contents, "CSS.getComputedStyleForNode", {
            nodeId,
          }),
          cdp.send(contents, "DOM.getBoxModel", { nodeId }).catch(() => null),
        ]);
        const attrs: string[] = node.attributes ?? [];
        const attr = (name: string) => attrs[attrs.indexOf(name) + 1] ?? "";
        const element = `<${node.localName}${attrs.includes("id") ? `#${attr("id")}` : ""}${attrs.includes("class") ? `.${attr("class").trim().split(/\s+/).join(".")}` : ""}>`;
        const declarations = (style: any) =>
          (style?.cssProperties ?? [])
            .filter((p: any) => p.value !== undefined && !p.implicit && (p.text || style.cssText !== undefined))
            .map(
              (p: any) => `${p.name}: ${p.value}${p.important ? " !important" : ""}${p.disabled ? " (disabled)" : ""}`,
            );
        const rules = [
          ...(matched.inlineStyle
            ? [{ selector: "element.style", origin: "inline", source: "", props: declarations(matched.inlineStyle) }]
            : []),
          ...[...(matched.matchedCSSRules ?? [])].reverse().map((m: any) => {
            const sheet = sheets.get(m.rule.styleSheetId);
            const line = m.rule.style?.range ? m.rule.style.range.startLine + 1 : null;
            return {
              selector: m.rule.selectorList?.text ?? "",
              origin: m.rule.origin,
              media: (m.rule.media ?? []).map((q: any) => q.text).join(", "),
              source: sheet?.url
                ? `${safeUrl(contents, sheet.url)}${line ? `:${line}` : ""}`
                : m.rule.origin === "user-agent"
                  ? "browser default"
                  : "",
              props: declarations(m.rule.style),
            };
          }),
        ].filter((r) => r.props.length);
        const defaults = [
          "display",
          "position",
          "box-sizing",
          "width",
          "height",
          "margin",
          "padding",
          "border",
          "color",
          "background-color",
          "font-family",
          "font-size",
          "font-weight",
          "line-height",
          "z-index",
          "overflow",
          "opacity",
          "visibility",
          "transform",
          "flex",
          "flex-direction",
          "align-items",
          "justify-content",
          "gap",
          "grid-template-columns",
          "top",
          "left",
          "right",
          "bottom",
        ];
        const want = params.properties?.length ? params.properties : defaults;
        const computed = Object.fromEntries(
          computedStyle.filter((c) => want.includes(c.name)).map((c) => [c.name, c.value]),
        );
        // The box model: content, padding, border and margin edges (quads: x1,y1 … x4,y4).
        const size = (quad?: number[]) =>
          quad
            ? {
                x: Math.round(quad[0]!),
                y: Math.round(quad[1]!),
                width: Math.round(quad[2]! - quad[0]!),
                height: Math.round(quad[5]! - quad[1]!),
              }
            : null;
        const model = box?.model;
        return {
          element,
          box: model
            ? {
                content: size(model.content),
                padding: size(model.padding),
                border: size(model.border),
                margin: size(model.margin),
              }
            : "not rendered (display: none, or not in the layout)",
          rules,
          computed,
        };
      } finally {
        contents.debugger.removeListener("message", onMessage);
        await cdp.send(contents, "CSS.disable").catch(() => {});
        await cdp.send(contents, "DOM.disable").catch(() => {});
      }
    },

    async storage(contents) {
      const web = options.isWebTab(contents);
      const url = contents.getURL();
      const { cookies } = await cdp.send<{ cookies: any[] }>(contents, "Network.getCookies", { urls: [url] });
      const value = (name: string, v: string) =>
        web && (isSensitiveName(name, true) || v.length > 40) ? REDACTED : clip(safe(contents, v), 200);
      const stores = await evaluate<{
        local: [string, string][];
        session: [string, string][];
        indexedDB: unknown;
        caches: string[];
        serviceWorkers: string[];
      }>(
        contents,
        `(async () => {
          const entries = (s) => { try { return Object.keys(s).slice(0, 200).map((k) => [k, String(s.getItem(k))]); } catch { return []; } };
          const withTimeout = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
          let indexed = [];
          try {
            const dbs = (await withTimeout(indexedDB.databases())) ?? [];
            indexed = await Promise.all(dbs.slice(0, 20).map(async ({ name, version }) => {
              const stores = await withTimeout(new Promise((resolve) => {
                const req = indexedDB.open(name);
                req.onupgradeneeded = () => { req.transaction.abort(); resolve(null); };
                req.onerror = () => resolve(null);
                req.onsuccess = async () => {
                  const db = req.result;
                  const names = [...db.objectStoreNames];
                  const counts = await Promise.all(names.map((n) => new Promise((r) => {
                    try { const c = db.transaction(n, "readonly").objectStore(n).count(); c.onsuccess = () => r(c.result); c.onerror = () => r(null); } catch { r(null); }
                  })));
                  db.close();
                  resolve(names.map((n, i) => ({ name: n, records: counts[i] })));
                };
              }));
              return { name, version, stores };
            }));
          } catch {}
          let cacheNames = [];
          try { cacheNames = await withTimeout(caches.keys()) ?? []; } catch {}
          let workers = [];
          try { workers = ((await withTimeout(navigator.serviceWorker.getRegistrations())) ?? []).map((r) => r.scope); } catch {}
          return { local: entries(localStorage), session: entries(sessionStorage), indexedDB: indexed, caches: cacheNames, serviceWorkers: workers };
        })()`,
      );
      const storage = (list: [string, string][]) =>
        list.map(([k, v]) => ({ key: k, size: v.length, value: value(k, v) }));
      return {
        url: safeUrl(contents, url),
        valuesHidden: web,
        cookies: cookies.map((c) => ({
          name: c.name,
          value: web ? REDACTED : clip(c.value, 200),
          domain: c.domain,
          path: c.path,
          expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session",
          size: c.size,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite ?? null,
        })),
        localStorage: storage(stores.local),
        sessionStorage: storage(stores.session),
        indexedDB: stores.indexedDB,
        cacheStorage: stores.caches,
        serviceWorkers: stores.serviceWorkers.map((s) => safeUrl(contents, s)),
      };
    },

    async coverage(contents, params: { reload?: boolean; seconds?: number }) {
      const scripts = new Map<string, { url: string; length: number }>();
      const sheets = new Map<string, { url: string; length: number }>();
      const onMessage = (_event: unknown, method: string, p: any) => {
        if (method === "Debugger.scriptParsed" && p.url) scripts.set(p.scriptId, { url: p.url, length: p.length ?? 0 });
        else if (method === "CSS.styleSheetAdded")
          sheets.set(p.header.styleSheetId, {
            url: p.header.sourceURL || "inline <style>",
            length: p.header.length ?? 0,
          });
      };
      contents.debugger.on("message", onMessage);
      try {
        await cdp.send(contents, "Debugger.enable");
        await cdp.send(contents, "Profiler.enable");
        await cdp.send(contents, "Profiler.startPreciseCoverage", { callCount: false, detailed: true });
        await cdp.send(contents, "DOM.enable");
        await cdp.send(contents, "CSS.enable");
        await cdp.send(contents, "CSS.startRuleUsageTracking");
        if (params.reload ?? true) await reloadAndWait(contents);
        await sleep(Math.min(Math.max(params.seconds ?? 2, 0), 30) * 1000);
        const { result } = await cdp.send<{
          result: {
            scriptId: string;
            url: string;
            functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[];
          }[];
        }>(contents, "Profiler.takePreciseCoverage");
        const { ruleUsage } = await cdp.send<{
          ruleUsage: { styleSheetId: string; startOffset: number; endOffset: number; used: boolean }[];
        }>(contents, "CSS.stopRuleUsageTracking");
        const files: { url: string; type: "js" | "css"; totalKb: number; unusedKb: number; unusedPercent: number }[] =
          [];
        const add = (url: string, type: "js" | "css", total: number, used: number) => {
          if (!total) return;
          const unused = Math.max(0, total - used);
          files.push({
            url: safeUrl(contents, url),
            type,
            totalKb: Math.round(total / 102.4) / 10,
            unusedKb: Math.round(unused / 102.4) / 10,
            unusedPercent: Math.round((unused / total) * 100),
          });
        };
        for (const script of result) {
          const length =
            scripts.get(script.scriptId)?.length ??
            Math.max(0, ...script.functions.flatMap((f) => f.ranges.map((r) => r.endOffset)));
          if (!script.url || !length) continue;
          // Ranges come outermost first; inner ones override (DevTools' way of counting used bytes).
          const used = new Uint8Array(length);
          for (const fn of script.functions)
            for (const r of fn.ranges) used.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, length));
          add(
            script.url,
            "js",
            length,
            used.reduce((sum, b) => sum + b, 0),
          );
        }
        const usedCss = new Map<string, number>();
        for (const r of ruleUsage)
          if (r.used) usedCss.set(r.styleSheetId, (usedCss.get(r.styleSheetId) ?? 0) + r.endOffset - r.startOffset);
        for (const [id, sheet] of sheets) add(sheet.url, "css", sheet.length, usedCss.get(id) ?? 0);
        files.sort((a, b) => b.unusedKb - a.unusedKb);
        const total = files.reduce((sum, f) => sum + f.totalKb, 0);
        const unused = files.reduce((sum, f) => sum + f.unusedKb, 0);
        return {
          totalKb: Math.round(total * 10) / 10,
          unusedKb: Math.round(unused * 10) / 10,
          files: files.slice(0, 40),
        };
      } finally {
        contents.debugger.removeListener("message", onMessage);
        for (const command of [
          "Profiler.stopPreciseCoverage",
          "Profiler.disable",
          "Debugger.disable",
          "CSS.disable",
          "DOM.disable",
        ])
          await cdp.send(contents, command).catch(() => {});
      }
    },

    /** An element, a part or the whole of the page as an image (also what's scrolled out of view). */
    async screenshot(contents, params: { selector?: string; fullPage?: boolean; maxWidth?: number }) {
      const { cssLayoutViewport, cssContentSize } = await cdp.send(contents, "Page.getLayoutMetrics");
      let clip: { x: number; y: number; width: number; height: number };
      if (params.selector) {
        const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
          contents,
          `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
          })()`,
        );
        if (!rect) throw new Error(`Nothing matches ${params.selector}`);
        if (rect.width < 1 || rect.height < 1) throw new Error(`${params.selector} isn't visible (it has no size)`);
        // A little room around it.
        const pad = 8;
        clip = {
          x: Math.max(0, rect.x - pad),
          y: Math.max(0, rect.y - pad),
          width: rect.width + pad * 2,
          height: Math.min(rect.height + pad * 2, 8000),
        };
      } else if (params.fullPage) {
        clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 12000) };
      } else {
        clip = {
          x: cssLayoutViewport.pageX,
          y: cssLayoutViewport.pageY,
          width: cssLayoutViewport.clientWidth,
          height: cssLayoutViewport.clientHeight,
        };
      }
      // Kept to a size models read well.
      const scale = Math.min(1, (params.maxWidth ?? 1280) / clip.width, 8000 / clip.height);
      // Webviews are transparent where a page sets no background, which a JPEG turns black: white, like a browser.
      const transparent = await evaluate<boolean>(
        contents,
        `[document.documentElement, document.body].every((el) => !el || /^(transparent|rgba\\(0, 0, 0, 0\\))$/.test(getComputedStyle(el).backgroundColor))`,
      ).catch(() => false);
      const css = transparent
        ? await contents.insertCSS(":root { background-color: #fff !important; }").catch(() => null)
        : null;
      const { data } = await cdp
        .send<{ data: string }>(contents, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 80,
          captureBeyondViewport: true,
          clip: { ...clip, scale },
        })
        .finally(() => css && contents.removeInsertedCSS(css).catch(() => {}));
      return {
        data,
        width: Math.round(clip.width * scale),
        height: Math.round(clip.height * scale),
        truncated: !!params.fullPage && cssContentSize.height > 12000,
      };
    },

    /** Puts files (paths the server checked: in the agent's chat folder) into a file input, like picking them. */
    async upload(contents, params: { selector?: string; index?: number; files?: string[] }) {
      const files = (params.files ?? []).filter((f) => typeof f === "string" && f);
      if (!files.length) throw new Error("No files to upload");
      const selector = params.selector || 'input[type="file"]';
      const { root } = await cdp.send<{ root: { nodeId: number } }>(contents, "DOM.getDocument", { depth: 0 });
      const { nodeIds } = await cdp.send<{ nodeIds: number[] }>(contents, "DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector,
      });
      const nodeId = nodeIds[Math.max(0, Math.floor(params.index ?? 0))];
      if (!nodeId) throw new Error(`Nothing matches ${selector}${nodeIds.length ? ` at index ${params.index}` : ""}`);
      const { node } = await cdp.send<{ node: { nodeName: string; attributes?: string[] } }>(
        contents,
        "DOM.describeNode",
        { nodeId },
      );
      const attrs = node.attributes ?? [];
      const attr = (name: string) => {
        const i = attrs.findIndex((a, j) => j % 2 === 0 && a.toLowerCase() === name);
        return i === -1 ? null : (attrs[i + 1] ?? "");
      };
      if (node.nodeName !== "INPUT" || attr("type")?.toLowerCase() !== "file")
        throw new Error(`${selector} isn't a file input (<input type="file">)`);
      if (files.length > 1 && attr("multiple") === null) throw new Error("This file input takes only one file");
      await cdp.send(contents, "DOM.setFileInputFiles", { nodeId, files });
      return { count: files.length, accept: attr("accept") ?? "" };
    },

    async emulate(
      contents,
      params: {
        reset?: boolean;
        device?: string;
        width?: number;
        height?: number;
        scale?: number;
        mobile?: boolean;
        network?: string;
        cpu?: number;
        colorScheme?: string;
        reducedMotion?: string;
      },
    ) {
      const state = { ...(emulated.get(contents.id) ?? {}) };
      if (params.reset) {
        await cdp.send(contents, "Emulation.clearDeviceMetricsOverride").catch(() => {});
        await cdp.send(contents, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
        await cdp
          .send(contents, "Emulation.setUserAgentOverride", { userAgent: contents.getUserAgent() })
          .catch(() => {});
        await cdp
          .send(contents, "Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          })
          .catch(() => {});
        await cdp.send(contents, "Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
        await cdp.send(contents, "Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => {});
        emulated.delete(contents.id);
        return { emulating: {} };
      }
      const device = params.device ? devices[params.device] : undefined;
      if (params.device && !device)
        throw new Error(`Unknown device ${params.device}. Devices: ${Object.keys(devices).join(", ")}`);
      if (device || params.width || params.height) {
        const width = Math.round(params.width ?? device?.width ?? 0);
        const height = Math.round(params.height ?? device?.height ?? 0);
        const mobile = params.mobile ?? device?.mobile ?? false;
        await cdp.send(contents, "Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: params.scale ?? device?.scale ?? 0,
          mobile,
        });
        await cdp.send(contents, "Emulation.setTouchEmulationEnabled", {
          enabled: mobile,
          maxTouchPoints: mobile ? 5 : 1,
        });
        await cdp.send(contents, "Emulation.setUserAgentOverride", {
          userAgent: device?.userAgent ?? contents.getUserAgent(),
        });
        Object.assign(state, { device: params.device ?? "custom", width, height, mobile });
      }
      if (params.network) {
        const n = networks[params.network];
        if (!n) throw new Error(`Unknown network ${params.network}. Networks: ${Object.keys(networks).join(", ")}`);
        const conditions = {
          offline: n.offline,
          latency: n.latency,
          downloadThroughput: n.download,
          uploadThroughput: n.upload,
        };
        await cdp.send(contents, "Network.emulateNetworkConditions", conditions).catch(async () => {
          await cdp.send(contents, "Network.enable");
          await cdp.send(contents, "Network.emulateNetworkConditions", conditions);
        });
        state.network = params.network;
      }
      if (params.cpu !== undefined) {
        const rate = Math.min(Math.max(params.cpu, 1), 20);
        await cdp.send(contents, "Emulation.setCPUThrottlingRate", { rate });
        state.cpu = `${rate}x slower`;
      }
      if (params.colorScheme || params.reducedMotion) {
        const features = [
          ...((params.colorScheme ?? state.colorScheme)
            ? [{ name: "prefers-color-scheme", value: String(params.colorScheme ?? state.colorScheme) }]
            : []),
          ...((params.reducedMotion ?? state.reducedMotion)
            ? [{ name: "prefers-reduced-motion", value: String(params.reducedMotion ?? state.reducedMotion) }]
            : []),
        ];
        await cdp.send(contents, "Emulation.setEmulatedMedia", { media: "", features });
        if (params.colorScheme) state.colorScheme = params.colorScheme;
        if (params.reducedMotion) state.reducedMotion = params.reducedMotion;
      }
      emulated.set(contents.id, state);
      return { emulating: state };
    },
  };

  /** Runs a command on a page, attached for it for as long as it takes (console capture stays). */
  async function run(contents: WebContents, command: string, params: unknown) {
    const fn = commands[command];
    if (!fn) throw new Error(`Unknown DevTools command ${command}`);
    if (!cdp.acquire(contents, `devtools:${command}`)) throw new Error("Can't attach DevTools to this page");
    try {
      return await fn(contents, params ?? {});
    } finally {
      // Emulation lasts until it's reset, so its connection stays too.
      if (command !== "emulate" || emulated.has(contents.id) === false) cdp.release(contents, `devtools:${command}`);
    }
  }

  const fromWindow = (event: Electron.IpcMainInvokeEvent) => event.sender === options.getWindow()?.webContents;
  ipcMain.handle("rune:devtools", (event, id: unknown, command: unknown, params: unknown) => {
    const target = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!fromWindow(event) || !target || target.getType() !== "webview" || target.hostWebContents !== event.sender)
      throw new Error("Unknown page");
    return run(target, String(command), params);
  });

  return {
    /** A new page: app previews keep their console from the start (web tabs once an agent asks). */
    track(contents: WebContents) {
      if (!options.isWebTab(contents)) captureConsole(contents);
    },
  };
}
