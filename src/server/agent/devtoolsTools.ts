// DevTools for agents: what Chrome DevTools shows about the page in the tab
// (an app's preview, or the website in a web tab), so an agent can test pages
// and find out what's wrong on its own: console, metrics and web vitals,
// performance traces, accessibility tree, CSS rules, storage, coverage and
// emulation. The work happens in Electron's main process (main/devtools.ts),
// reached through the Rune Browser window. On web tabs, cookie values and tokens
// stay hidden there.
import { Effect, Schema } from "effect";
import type { DevtoolsCommand } from "../../shared/api";
import type { TraceAnalysis } from "../../shared/trace";
import { Hub } from "../Hub";
import { NoArgs, text, tool } from "./Mcp";
import { dataTools } from "./output";
import type { ToolEnv } from "./tools";

interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  source?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 1);

export const devtoolsTools = Effect.fn(function* (env: ToolEnv, options: { site: boolean }) {
  const hub = yield* Hub;
  const data = yield* dataTools(env);
  const devtools = <T>(command: DevtoolsCommand, params: object = {}, timeoutMs = 30_000) =>
    hub.rpc<T>("devtools", { tabId: env.tabId, command, params }, timeoutMs);
  const where = options.site ? "the page in the user's tab" : "the app's preview";

  // Emulation changes what the user sees: it's undone when the turn ends.
  let emulating = false;
  yield* Effect.addFinalizer(() =>
    emulating ? devtools("emulate", { reset: true }).pipe(Effect.ignore) : Effect.void,
  );

  return [
    data(
      "console_logs",
      `Console messages and uncaught errors of ${where} (console.log/warn/error, exceptions with their stack, and the browser's own messages: failed requests, CSP, deprecations), oldest first.${
        options.site
          ? " On a website, capturing starts the first time you ask: reload the page or redo the steps to see what happens then."
          : ""
      }`,
      Schema.Struct({
        level: Schema.optionalKey(
          Schema.Literals(["all", "warnings", "errors"]).annotate({
            description: "errors: errors and exceptions only; warnings: also warnings. Default all.",
          }),
        ),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "The last N messages (default 100)" })),
        clear: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Empty the log after reading, to see only what comes next" }),
        ),
      }),
      ({ level, limit, clear }) =>
        devtools<{ startedNow: boolean; since: number; entries: ConsoleEntry[] }>("console", {
          level: level === "all" ? undefined : level,
          limit,
          clear,
        }).pipe(
          Effect.map(({ startedNow, entries }) => {
            if (!entries.length)
              return startedNow
                ? "Started capturing the console now; nothing yet. Reload the page or redo the steps, then ask again."
                : "No console messages.";
            const lines = entries.map(
              (e) =>
                `[${new Date(e.at).toISOString().slice(11, 23)}] ${e.level.toUpperCase()} ${e.text}${e.source ? `  (${e.source})` : ""}`,
            );
            return `${lines.join("\n")}${startedNow ? "\n(Capturing started just now.)" : ""}`;
          }),
        ),
    ),

    data(
      "page_metrics",
      `Performance numbers of ${where} right now: web vitals as the page measured them (TTFB, FCP, LCP and its element, CLS, total blocking time, slowest interaction), load timing, resources and bytes, DOM size, JS heap, and the time spent on layout, styles and scripts so far.`,
      NoArgs,
      () => devtools<object>("metrics").pipe(Effect.map(json)),
    ),

    data(
      "performance_trace",
      `Record a performance trace of ${where}, like DevTools' Performance panel, and get its analysis: web vitals, long tasks and what ran in them, where the main thread's time went, the hottest functions (with file:line), layouts forced by scripts, layout shifts and their elements, slow, large, render-blocking and failed requests. \`reload\` traces the page loading; \`interaction\` runs JavaScript in the page once recording has started (click a button, type, scroll, open a dialog) to trace what it does. The trace file is saved for Chrome DevTools.`,
      Schema.Struct({
        reload: Schema.optionalKey(Schema.Boolean.annotate({ description: "Reload the page and record its load" })),
        interaction: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "JavaScript to run in the page after recording starts (the body of an async function), e.g. document.querySelector('#add').click()",
          }),
        ),
        seconds: Schema.optionalKey(
          Schema.Finite.annotate({
            description: "How long to record after the reload or interaction (1–30; default 3, or 5 with neither)",
          }),
        ),
      }),
      ({ reload, interaction, seconds }) =>
        devtools<{
          analysis: TraceAnalysis;
          summary: string;
          file: string;
          events: number;
          seconds: number;
          interactionError?: string;
        }>("trace", { reload, interaction, seconds }, 150_000).pipe(
          Effect.tap((r) =>
            env.log(
              `Recorded a performance trace (${r.seconds} s${reload ? ", with a reload" : interaction ? ", with an interaction" : ""}). Saved for Chrome DevTools' Performance panel: ${r.file}`,
            ),
          ),
          Effect.map(
            (r) =>
              `${r.interactionError ? `The interaction threw: ${r.interactionError}\n\n` : ""}${r.summary}\n\n(${r.events} trace events; the trace is saved at ${r.file} and the user can open it in Chrome DevTools.)`,
          ),
        ),
    ),

    data(
      "accessibility_tree",
      `The accessibility tree of ${where} (or of one element), as screen readers get it: roles, names, values and states (focused, checked, expanded, disabled…). Good for checking labels and structure, and for finding elements by their role and name.`,
      Schema.Struct({
        selector: Schema.optionalKey(Schema.String.annotate({ description: "Only this element and what's in it" })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "At most this many lines (default 300)" })),
      }),
      ({ selector, limit }) =>
        devtools<{ lines: string[]; truncated: boolean }>("accessibility", { selector, limit }).pipe(
          Effect.map((r) =>
            r.lines.length
              ? `${r.lines.join("\n")}${r.truncated ? "\n… (more; use a selector or a higher limit)" : ""}`
              : "Nothing accessible there.",
          ),
        ),
    ),

    data(
      "element_styles",
      `The CSS of an element in ${where}, like DevTools' Styles panel: every rule that applies (selector, declarations, stylesheet file:line, media query; the winning ones first), its box model (content, padding, border, margin) and computed values.`,
      Schema.Struct({
        selector: Schema.String,
        properties: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "Computed properties to show (default: the layout and text ones)",
          }),
        ),
      }),
      ({ selector, properties }) =>
        devtools<{
          element: string;
          box: unknown;
          rules: { selector: string; origin: string; media?: string; source: string; props: string[] }[];
          computed: Record<string, string>;
        }>("styles", { selector, properties }).pipe(
          Effect.map((r) =>
            [
              `${r.element}`,
              `Box: ${json(r.box)}`,
              "",
              "Rules (winning first):",
              ...r.rules.map(
                (rule) =>
                  `${rule.selector}${rule.media ? ` @media ${rule.media}` : ""} { ${rule.props.join("; ")} }${rule.source ? `  — ${rule.source}` : ""}`,
              ),
              "",
              "Computed:",
              ...Object.entries(r.computed).map(([k, v]) => `${k}: ${v}`),
            ].join("\n"),
          ),
        ),
    ),

    data(
      "page_storage",
      `What ${where} stores: cookies (name, domain, expiry, flags${options.site ? "; values hidden" : ""}), localStorage and sessionStorage${options.site ? " (credential-like values hidden)" : ""}, IndexedDB databases with their stores and record counts, Cache Storage and service workers.`,
      NoArgs,
      () => devtools<object>("storage").pipe(Effect.map(json)),
    ),

    data(
      "code_coverage",
      `How much of ${where}'s JavaScript and CSS is actually used, per file (like DevTools' Coverage panel): reloads the page (unless reload is false), waits, and lists files by unused bytes.`,
      Schema.Struct({
        reload: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Reload to measure the load (default true)" }),
        ),
        seconds: Schema.optionalKey(
          Schema.Finite.annotate({ description: "How long to wait after loading (default 2)" }),
        ),
      }),
      ({ reload, seconds }) =>
        devtools<{
          totalKb: number;
          unusedKb: number;
          files: { url: string; type: string; totalKb: number; unusedKb: number; unusedPercent: number }[];
        }>("coverage", { reload, seconds }, 90_000).pipe(
          Effect.map((r) =>
            r.files.length
              ? [
                  `${r.unusedKb} of ${r.totalKb} kB unused.`,
                  ...r.files.map(
                    (f) => `${f.unusedPercent}% unused · ${f.unusedKb}/${f.totalKb} kB · ${f.type} · ${f.url}`,
                  ),
                ].join("\n")
              : "No scripts or stylesheets were measured.",
          ),
        ),
    ),

    tool(
      "emulate",
      `Make ${where} behave like another device or connection, to test it there: a device (viewport, pixel ratio, touch, user agent) or a size, a slow or offline network, a slower CPU, dark or light mode, reduced motion. Applies until reset (reset: true) or the end of your turn. Take a screenshot to see the result.`,
      Schema.Struct({
        device: Schema.optionalKey(Schema.Literals(["iphone-15", "iphone-se", "pixel-8", "ipad", "laptop", "desktop"])),
        width: Schema.optionalKey(Schema.Finite),
        height: Schema.optionalKey(Schema.Finite),
        mobile: Schema.optionalKey(Schema.Boolean),
        network: Schema.optionalKey(Schema.Literals(["offline", "slow-3g", "fast-3g", "slow-4g", "none"])),
        cpu_slowdown: Schema.optionalKey(
          Schema.Finite.annotate({ description: "1 = normal, 4 = a mid-range phone, 6 = a low-end one" }),
        ),
        color_scheme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
        reduced_motion: Schema.optionalKey(Schema.Literals(["reduce", "no-preference"])),
        reset: Schema.optionalKey(Schema.Boolean.annotate({ description: "Back to normal" })),
      }),
      (args) =>
        devtools<{ emulating: Record<string, unknown> }>("emulate", {
          reset: args.reset,
          device: args.device,
          width: args.width,
          height: args.height,
          mobile: args.mobile,
          network: args.network,
          cpu: args.cpu_slowdown,
          colorScheme: args.color_scheme,
          reducedMotion: args.reduced_motion,
        }).pipe(
          Effect.tap((r) => Effect.sync(() => (emulating = Object.keys(r.emulating).length > 0))),
          Effect.map((r) =>
            Object.keys(r.emulating).length
              ? `Emulating: ${json(r.emulating)}`
              : text("Emulation is off: the page is back to normal."),
          ),
        ),
    ),
  ];
});
