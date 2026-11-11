// The tools the website agent gets from Rune Browser (over MCP). Page tools reach
// the page open in the tab through the Rune Browser window (RPC over the hub);
// site tools save customizations for websites.
import { Effect, Schema } from "effect";
import { hostOf, inspectedStyles, pageKey, scopeMatches } from "../../shared/web";
import { Apps } from "../db/Apps";
import { PageChanges, pageChangeError } from "../db/PageChanges";
import { Sites } from "../db/Sites";
import { Hub } from "../Hub";
import { Permissions, WEBSITE_AGENT } from "../security/Permissions";
import { ChatFiles } from "./ChatFiles";
import { saveOutput } from "./fileTools";
import { NoArgs, text, tool } from "./Mcp";
import { dataTools, MAX_SAVED } from "./output";
import { sharedContext, shareRefusal } from "./sharedTabs";
import { topics } from "../../shared/hub";
import type { ChatFile, ChatMessage, PageChange, PageChangeSpec } from "../../shared/api";

const transpiler = new Bun.Transpiler({ loader: "js" });

/** Throws with the parser's message if the JavaScript doesn't parse. */
export function checkSyntax(js: string) {
  try {
    transpiler.transformSync(`(() => {\n${js}\n})`);
  } catch (err) {
    throw new Error(`JavaScript syntax error: ${err instanceof Error ? err.message : err}`);
  }
}

export interface ToolEnv {
  /** The tab (and its page) the agent works on. */
  readonly tabId: string;
  /** Adds a line of activity to the chat ("Customized example.com"). */
  readonly log: (line: string) => Effect.Effect<void>;
  /** Adds another kind of message to the chat. */
  readonly message: (role: ChatMessage["role"], content: string) => Effect.Effect<void>;
  /** Who the agent is, for the audit log ("Website agent · Claude (haiku)"). */
  readonly label: string;
  /** A file the tool call saved in the chat's folder: the chat shows it with the call. */
  readonly saved?: (file: ChatFile) => Effect.Effect<void>;
}

// --- Page tools ------------------------------------------------------------------------

export const pageTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const chatFiles = yield* ChatFiles;
  const data = yield* dataTools(env);
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) =>
    hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const evalIn = <T>(code: string) => call<T>("page.eval", { code });

  const where = "the page in the user's tab";
  return [
    data("get_page", `The URL, title, viewport and visible text of ${where}.`, NoArgs, () =>
      evalIn<object>(`(() => {
            const text = (document.body?.innerText ?? "").replace(/\\n{3,}/g, "\\n\\n");
            return {
              url: location.href,
              title: document.title,
              viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight },
              text: text.length > 12000 ? text.slice(0, 12000) + "…" : text,
            };
          })()`).pipe(Effect.map((page) => JSON.stringify(page, null, 1))),
    ),

    data(
      "inspect",
      `Elements of ${where} matching a CSS selector: count, outer HTML (truncated), position and key computed styles.`,
      Schema.Struct({ selector: Schema.String, limit: Schema.optionalKey(Schema.Finite) }),
      ({ selector, limit }) =>
        evalIn<object>(`((selector, limit, keys) => {
          const els = [...document.querySelectorAll(selector)];
          return {
            count: els.length,
            elements: els.slice(0, limit).map((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const html = el.outerHTML;
              return {
                html: html.length > 3000 ? html.slice(0, 3000) + "…" : html,
                rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
                styles: Object.fromEntries(keys.map((k) => [k, cs.getPropertyValue(k)])),
              };
            }),
          };
        })(${JSON.stringify(selector)}, ${Math.min(Math.max(limit ?? 5, 1), 20)}, ${JSON.stringify(inspectedStyles)})`).pipe(
          Effect.map((result) => JSON.stringify(result, null, 1)),
        ),
    ),

    data(
      "run_js",
      `Run JavaScript in ${where} and get the result. \`code\` is the body of an async function: use \`return\` (JSON-serializable). Changes made this way are lost on reload; use set_site_override to keep them. With save_as, the whole result goes into a file in the chat's folder instead (data you collected or fetched, an export), and you get only its size.`,
      Schema.Struct({ code: Schema.String }),
      ({ code }) =>
        evalIn<string>(`(async () => {
          const __result = await (async () => {
${code}
          })();
          if (__result === undefined) return "undefined";
          if (typeof __result === "string") return __result.slice(0, ${MAX_SAVED});
          try {
            const s = JSON.stringify(__result, null, 1);
            return s === undefined ? String(__result) : s.slice(0, ${MAX_SAVED});
          } catch {
            return String(__result);
          }
        })()`),
    ),

    tool(
      "screenshot",
      `See ${where}: a screenshot as the user sees it right now. With selector, just that element (and what's around it), even if it's scrolled out of view; with full_page, the whole page from top to bottom. Use it to check how things look, not only what the DOM says. With save_as, it's saved as a file in the chat's folder instead of shown to you (to upload it, show it to the user or keep it for later; read_file shows it to you).`,
      Schema.Struct({
        selector: Schema.optionalKey(Schema.String.annotate({ description: "Only this element" })),
        full_page: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "The whole page, not only what's on screen" }),
        ),
        save_as: Schema.optionalKey(
          Schema.String.annotate({ description: "A path in the chat's folder, e.g. screenshots/home.jpg" }),
        ),
      }),
      ({ selector, full_page, save_as }) =>
        Effect.gen(function* () {
          // Saved ones go through DevTools too: it paints the page's background (a capture can be transparent).
          const shot =
            selector || full_page || save_as
              ? yield* call<{ data: string; width: number; height: number; truncated: boolean }>(
                  "devtools",
                  { command: "screenshot", params: { selector, fullPage: full_page } },
                  45_000,
                )
              : { data: yield* call<string>("page.capture"), truncated: false };
          const note = shot.truncated
            ? [{ type: "text" as const, text: "The page is very long: this shows its first 12000 pixels." }]
            : [];
          if (save_as) {
            const name = /\.jpe?g$/i.test(save_as) ? save_as : `${save_as.replace(/\.\w+$/, "")}.jpg`;
            const file = yield* saveOutput(chatFiles, env, name, Buffer.from(shot.data, "base64"), { unique: true });
            return {
              content: [{ type: "text" as const, text: `Saved the screenshot as ${file.name}.` }, ...note],
            };
          }
          return { content: [{ type: "image" as const, data: shot.data, mimeType: "image/jpeg" }, ...note] };
        }),
    ),

    tool(
      "navigate",
      "Open a URL in the tab and wait for it to load.",
      Schema.Struct({ url: Schema.String }),
      ({ url }) =>
        // Websites only: local files (file://) and the browser's own pages stay out of the agent's reach.
        /^(?!https?:|about:blank)[a-z][\w+.-]*:(\/\/|[^\d])/i.test(url.trim())
          ? Effect.succeed(text(`Only websites (http or https) can be opened, not ${url.slice(0, 80)}.`, true))
          : call<{ url: string; title: string }>("page.navigate", { url }, 45_000).pipe(
              Effect.tap((page) => env.log(`Opened ${page.url.slice(0, 80)}`)),
              Effect.map((page) => `Loaded ${page.url} — ${page.title}`),
            ),
    ),

    tool("reload", `Reload ${where} and wait for it to load.`, NoArgs, () =>
      call<{ url: string }>("page.reload", {}, 45_000).pipe(Effect.map((page) => `Reloaded ${page.url}`)),
    ),
  ];
});

// --- Website tools ------------------------------------------------------------------

/** Where a change applies: this page, this host, or a pattern. */
const scopeFor = (type: "site" | "pattern" | "page", url: string, pattern?: string): PageChangeSpec["scope"] => ({
  type,
  value: type === "page" ? pageKey(url) : type === "site" ? hostOf(url) : (pattern ?? ""),
});

export const siteTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const sites = yield* Sites;
  const pageChanges = yield* PageChanges;
  const permissions = yield* Permissions;
  const currentUrl = hub
    .rpc<{ url: string }>("page.info", { tabId: env.tabId })
    .pipe(
      Effect.flatMap(({ url }) =>
        /^https?:/i.test(url) ? Effect.succeed(url) : Effect.fail(new Error("No website is open in this tab")),
      ),
    );
  const currentHost = hub.rpc<{ url: string }>("page.info", { tabId: env.tabId }).pipe(
    Effect.flatMap(({ url }) => {
      const host = hostOf(url);
      return host ? Effect.succeed(host) : Effect.fail(new Error("No website is open in this tab"));
    }),
  );

  /** Changing what pages show needs the user's OK (per site or pattern, or remembered). */
  const allowChange = (spec: PageChangeSpec) => {
    const resource = spec.scope.type === "page" ? spec.scope.value.split("/")[0]! : spec.scope.value;
    const where = spec.scope.type === "pattern" ? `pages matching ${resource}` : resource;
    return permissions.ask({
      agentTab: env.tabId,
      subject: WEBSITE_AGENT,
      action: "agent.site",
      resource,
      title: `Let the website agent change ${where}?`,
      detail: `It wants to add or change “${spec.title}” (${spec.action}${spec.action === "script" || spec.action === "button" ? ", with JavaScript" : ""}), applied whenever you open ${where} in Rune Browser. You can turn it off or remove it later.`,
      timeoutMs: 120_000,
    });
  };

  /** Publishes the change, applies it to the page and reports how it went. */
  const applied = (change: PageChange, done: string) =>
    Effect.gen(function* () {
      yield* hub.publish({ type: "page-changes", topic: topics.sites });
      const result = yield* hub
        .rpc<{ changesEnabled?: boolean; changeErrors?: Record<string, string> }>(
          "page.applyOverride",
          { tabId: env.tabId },
          45_000,
        )
        .pipe(Effect.orElseSucceed(() => ({}) as { changesEnabled?: boolean; changeErrors?: Record<string, string> }));
      yield* env.log(`${done.split(" (")[0]}: ${change.title}`);
      const error = result.changeErrors?.[change.id];
      if (error) return text(`${done}, but it failed on the page: ${error}`, true);
      const url = yield* currentUrl.pipe(Effect.orElseSucceed(() => ""));
      if (!scopeMatches(change.scope, url))
        return `${done}. It doesn't apply to the current page (scope ${change.scope.type}: ${change.scope.value}).`;
      return result.changesEnabled
        ? `${done}; applied to the page.`
        : `${done}, but customizations are turned off in Settings (or Rune Browser is in safe mode), so it isn't applied.`;
    });

  return [
    tool(
      "get_site_override",
      "The current site's customization (CSS and JavaScript applied whenever it loads in Rune Browser).",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const host = yield* currentHost;
          const override = yield* sites.get(host);
          return override
            ? JSON.stringify({ host, enabled: override.enabled, css: override.css, js: override.js }, null, 1)
            : `No customization for ${host} yet.`;
        }),
    ),

    tool(
      "set_site_override",
      'Replace the current site\'s customization and apply it to the page. Send the complete CSS and JS (omit one to keep it unchanged, use "" to clear it). Changing the JS reloads the page. Returns errors thrown by the JS.',
      Schema.Struct({ css: Schema.optionalKey(Schema.String), js: Schema.optionalKey(Schema.String) }),
      ({ css, js }) =>
        Effect.gen(function* () {
          const host = yield* currentHost;
          if (js) yield* Effect.try(() => checkSyntax(js));
          // Changing what a site runs needs the user's OK (once per site, or remembered).
          const allowed = yield* permissions.ask({
            agentTab: env.tabId,
            subject: WEBSITE_AGENT,
            action: "agent.site",
            resource: host,
            title: `Let the website agent customize ${host}?`,
            detail: `It wants to save ${js?.trim() ? "CSS and JavaScript" : "CSS"} that is applied whenever you open ${host} in Rune Browser. You can turn it off or remove it later.`,
            timeoutMs: 120_000,
          });
          if (!allowed)
            return text(
              `The user didn't allow customizing ${host}. Nothing was saved; tell them what you would have changed.`,
              true,
            );
          const saved = yield* sites.save(host, { css, js, enabled: true });
          yield* hub.publish({ type: "site", topic: topics.sites, host });
          const result = yield* hub.rpc<{ applied: boolean; error?: string }>(
            "page.applyOverride",
            { tabId: env.tabId },
            45_000,
          );
          yield* env.log(`Customized ${host}`);
          if (result.error) return text(`Saved, but the JavaScript threw: ${result.error}`, true);
          const sizes = `CSS ${saved.css.length} chars, JS ${saved.js.length} chars`;
          return result.applied
            ? `Saved and applied to ${host} (${sizes}).`
            : `Saved for ${host} (${sizes}), but customizations are turned off in Settings, so it isn't applied.`;
        }),
    ),

    tool(
      "list_page_changes",
      "The page changes that apply to the current page (and the rest of this site's): id, title, scope, action, whether it's on.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const url = yield* currentUrl;
          const host = hostOf(url);
          const all = yield* pageChanges.list();
          const here = all.filter((c) => scopeMatches(c.scope, url));
          const site = all.filter(
            (c) => !here.includes(c) && (c.scope.value === host || c.scope.value.startsWith(`${host}/`)),
          );
          const line = (c: PageChange) =>
            `- ${c.id} ${c.enabled ? "[on]" : "[off]"} ${c.title} — ${c.action}${c.selector ? ` ${c.selector}` : ""} (${c.scope.type}: ${c.scope.value})`;
          return [
            here.length ? `On this page:\n${here.map(line).join("\n")}` : "No page changes apply to this page.",
            site.length ? `Elsewhere on ${host}:\n${site.map(line).join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
        }),
    ),

    tool(
      "add_page_change",
      [
        "Add one change to web pages; it's applied right away and on every load, also to content the page adds later. Prefer one change per thing the user asked for, with a short title they'll recognize. Returns its id and any error.",
        "Actions: hide (selector); style (selector, value: CSS declarations); text (selector, value: the new text); attribute (selector, name, value); insert (selector, value: HTML, position); button (selector, value: label, onClick: JavaScript run with `event` and `button`, position); css (value: a stylesheet); script (value: JavaScript run once per load; onElement(selector, fn) helps with dynamic pages).",
        "Scope: site (the default: every page of this host, so the change stays when the user navigates), pattern (wildcards, e.g. *.example.com/* for subdomains too, or example.com/watch* for one section), or page (this exact page only: use it only when the user asks for just this page).",
        "Call list_page_changes first: if a change for the same thing exists, improve it with update_page_change instead of adding another.",
      ].join(" "),
      Schema.Struct({
        title: Schema.String,
        scope: Schema.optionalKey(Schema.Literals(["site", "pattern", "page"])),
        pattern: Schema.optionalKey(Schema.String.annotate({ description: "For scope pattern" })),
        action: Schema.Literals(["hide", "style", "text", "attribute", "insert", "button", "css", "script"]),
        selector: Schema.optionalKey(Schema.String),
        value: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        position: Schema.optionalKey(Schema.Literals(["before", "after", "prepend", "append"])),
        onClick: Schema.optionalKey(Schema.String),
      }),
      ({ scope = "site", pattern, ...fields }) =>
        Effect.gen(function* () {
          const url = yield* currentUrl;
          const spec: PageChangeSpec = { ...fields, scope: scopeFor(scope, url, pattern) };
          const problem = pageChangeError(spec);
          if (problem) return text(problem, true);
          if (!(yield* allowChange(spec)))
            return text(
              `The user didn't allow changing ${spec.scope.value}. Nothing was saved; tell them what you would have changed.`,
              true,
            );
          const change = yield* pageChanges.create(spec, "agent");
          return yield* applied(change, `Added ${change.id} (“${change.title}”)`);
        }),
    ),

    tool(
      "update_page_change",
      "Change a page change (see list_page_changes): give its id and only the fields to change, or enabled to turn it on or off. scope (with pattern) moves it, e.g. from one page to the whole site.",
      Schema.Struct({
        id: Schema.String,
        enabled: Schema.optionalKey(Schema.Boolean),
        scope: Schema.optionalKey(Schema.Literals(["site", "pattern", "page"])),
        pattern: Schema.optionalKey(Schema.String.annotate({ description: "For scope pattern" })),
        title: Schema.optionalKey(Schema.String),
        selector: Schema.optionalKey(Schema.String),
        value: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        position: Schema.optionalKey(Schema.Literals(["before", "after", "prepend", "append"])),
        onClick: Schema.optionalKey(Schema.String),
      }),
      ({ id, enabled, scope, pattern, ...fields }) =>
        Effect.gen(function* () {
          const current = yield* pageChanges.get(id);
          if (!current) return text(`No page change ${id}.`, true);
          const spec: PageChangeSpec = {
            ...current,
            ...fields,
            ...(scope ? { scope: scopeFor(scope, yield* currentUrl, pattern) } : {}),
          };
          const problem = pageChangeError(spec);
          if (problem) return text(problem, true);
          if (!(yield* allowChange(spec))) return text(`The user didn't allow changing ${spec.scope.value}.`, true);
          const saved = (yield* pageChanges.update(id, { spec, enabled }))!;
          return yield* applied(saved, `Updated ${saved.id} (“${saved.title}”, ${saved.enabled ? "on" : "off"})`);
        }),
    ),

    tool(
      "remove_page_change",
      "Remove a page change (see list_page_changes).",
      Schema.Struct({ id: Schema.String }),
      ({ id }) =>
        Effect.gen(function* () {
          const current = yield* pageChanges.get(id);
          if (!current) return text(`No page change ${id}.`, true);
          yield* pageChanges.remove(id);
          yield* hub.publish({ type: "page-changes", topic: topics.sites });
          yield* hub.rpc("page.applyOverride", { tabId: env.tabId }, 45_000).pipe(Effect.ignore);
          yield* env.log(`Removed the page change “${current.title}”`);
          return `Removed ${id}.`;
        }),
    ),
  ];
});

// --- Other tabs (shared tab context) ---------------------------------------------------

/** list_tabs and read_tab: another tab of the workspace, with the user's OK (sharedTabs.ts says what may be shared). */
export const tabTools = Effect.fn(function* (env: ToolEnv) {
  const apps = yield* Apps;
  const permissions = yield* Permissions;
  const hub = yield* Hub;
  const context = yield* Effect.context<Apps>();
  const others = Effect.gen(function* () {
    const self = yield* apps.get(env.tabId);
    const all = yield* apps.list();
    // Private windows' tabs aren't there for agents.
    return {
      self,
      tabs: self ? all.filter((t) => t.workspaceId === self.workspaceId && t.id !== self.id && !t.private) : [],
    };
  });

  return [
    tool(
      "list_tabs",
      "The user's other tabs in this workspace, with ids for read_tab. Only names: read_tab gets what's in one, after the user allows it.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const { self, tabs } = yield* others;
          if (!tabs.length) return "No other tabs in this workspace.";
          return tabs
            .map((t) => {
              const refusal = self ? shareRefusal(self, t) : null;
              return `- ${t.id}: ${t.name}${t.url ? ` (${t.url})` : ""}${refusal ? " — can't be shared with you" : ""}`;
            })
            .join("\n");
        }),
    ),

    tool(
      "read_tab",
      "Read another tab of this workspace, after the user allows it: what its page shows, and the last reply of that tab's agent. Use it when the user refers to another tab, or a result from one would help.",
      Schema.Struct({ tab: Schema.String.annotate({ description: "The tab's id from list_tabs, or its exact name" }) }),
      ({ tab }) =>
        Effect.gen(function* () {
          const { self, tabs } = yield* others;
          if (!self) return text("This tab no longer exists.", true);
          const named = tabs.filter((t) => t.name.toLowerCase() === tab.trim().toLowerCase());
          const source = tabs.find((t) => t.id === tab) ?? (named.length === 1 ? named[0] : undefined);
          if (!source)
            return text(
              named.length > 1
                ? `Several tabs are called “${tab}”: use its id from list_tabs.`
                : `No tab “${tab}” in this workspace (see list_tabs).`,
              true,
            );
          const refusal = shareRefusal(self, source);
          if (refusal) return text(refusal, true);
          const allowed = yield* permissions.ask({
            agentTab: self.id,
            subject: self.id,
            action: "agent.tab",
            resource: source.id,
            title: `Let the website agent in “${self.name}” read “${source.name}”?`,
            detail: `It wants to read what the page in “${source.name}” shows (${source.url ?? "no page"}) and the last reply of its agent.`,
            timeoutMs: 120_000,
          });
          if (!allowed) return text(`The user didn't allow reading “${source.name}”.`, true);
          const page = yield* hub
            .rpc<{ url: string; title: string; text: string; selection?: string } | null>(
              "page.read",
              { tabId: source.id },
              45_000,
            )
            .pipe(Effect.orElseSucceed(() => null));
          const reply = (yield* apps.messages(source.id)).filter((m) => m.role === "assistant").at(-1);
          return yield* Effect.provide(
            sharedContext(self, [
              { tabId: source.id, ...(page ? { page } : {}), ...(reply ? { messageId: reply.id } : {}) },
            ]),
            context,
          ).pipe(
            Effect.tap(() => env.log(`Read “${source.name}”`)),
            Effect.map((shared): string | ReturnType<typeof text> => shared.text),
            Effect.catch((message: string) => Effect.succeed(text(message, true))),
          );
        }),
    ),
  ];
});
