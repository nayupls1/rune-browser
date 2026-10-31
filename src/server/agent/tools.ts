// The tools agents get from Rune Browser (over MCP). Page tools reach the page open in
// a tab — a website, or an app's preview — through the Rune Browser window (RPC over
// the hub). App tools run and inspect the app's project; site tools save
// customizations for websites.
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { hostOf, inspectedStyles, pageKey, scopeMatches } from "../../shared/web";
import { Apps } from "../db/Apps";
import { PageChanges, pageChangeError } from "../db/PageChanges";
import { Sites } from "../db/Sites";
import { Hub } from "../Hub";
import { isIcon, searchIcons } from "../icons";
import { presets } from "../workspace/presets";
import { AppData } from "../workspace/AppData";
import { AppTools } from "../workspace/AppTools";
import { Scheduler } from "../scheduler/Scheduler";
import { DEFAULT_TIMEOUT_SEC, describeTrigger, scheduleProblem } from "../../shared/schedule";
import { Projects } from "../workspace/Projects";
import { Runtime } from "../workspace/Runtime";
import { Workspace } from "../workspace/Workspace";
import { Permissions, WEBSITE_AGENT } from "../security/Permissions";
import { Secrets } from "../security/Secrets";
import { ChatFiles } from "./ChatFiles";
import { saveOutput } from "./fileTools";
import { NoArgs, text, tool } from "./Mcp";
import { sharedContext, shareRefusal } from "./sharedTabs";
import { topics } from "../../shared/hub";
import {
  isImageIcon,
  isReservedSecretName,
  SECRET_NAME_PATTERN,
  type AppTool,
  type ChatFile,
  type ChatMessage,
  type PageChange,
  type PageChangeSpec,
  type Schedule,
  type ScheduleSpec,
  type ScheduleTask,
  type ScheduleTrigger,
  type LogLine,
  type RuntimeStatus,
} from "../../shared/api";

const transpiler = new Bun.Transpiler({ loader: "js" });

const ICON_FILE_MAX = 100_000;
const iconTypes: Record<string, { mime: string; magic?: (b: Uint8Array) => boolean }> = {
  png: { mime: "image/png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  jpg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  jpeg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  gif: { mime: "image/gif", magic: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  webp: { mime: "image/webp", magic: (b) => new TextDecoder().decode(b.subarray(8, 12)) === "WEBP" },
  ico: { mime: "image/x-icon", magic: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
  svg: { mime: "image/svg+xml", magic: (b) => /<svg[\s>]/i.test(new TextDecoder().decode(b)) },
};

/** An image in the project as a data URL for the tab's icon. Only files inside the project (after symlinks). */
export async function readIconFile(projectDir: string, path: string): Promise<string | { error: string }> {
  const type = iconTypes[extname(path).slice(1).toLowerCase()];
  if (!type) return { error: `${path}: use a PNG, SVG, ICO, JPEG, GIF or WebP file.` };
  let file: string;
  try {
    const root = await realpath(projectDir);
    file = await realpath(resolve(root, path));
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel)) return { error: `${path} isn't inside the project.` };
    if ((await stat(file)).size > ICON_FILE_MAX) return { error: `${path} is too big for an icon (at most 100 kB).` };
  } catch {
    return { error: `${path} doesn't exist in the project.` };
  }
  const bytes = new Uint8Array(await readFile(file));
  if (type.magic && !type.magic(bytes))
    return { error: `${path} isn't a valid ${extname(path).slice(1).toUpperCase()} image.` };
  return `data:${type.mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

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
  /** Adds another kind of message to the chat (e.g. a request for a secret). */
  readonly message: (role: ChatMessage["role"], content: string) => Effect.Effect<void>;
  /** Who the agent is, for the audit log ("App builder · Claude (haiku)"). */
  readonly label: string;
  /** A file the tool call saved in the chat's folder: the chat shows it with the call. */
  readonly saved?: (file: ChatFile) => Effect.Effect<void>;
}

// --- Page tools ------------------------------------------------------------------------

export const pageTools = Effect.fn(function* (env: ToolEnv, options: { site: boolean }) {
  const hub = yield* Hub;
  const chatFiles = yield* ChatFiles;
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) =>
    hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const evalIn = <T>(code: string) => call<T>("page.eval", { code });

  const where = options.site ? "the page in the user's tab" : "the app's preview";
  return [
    tool("get_page", `The URL, title, viewport and visible text of ${where}.`, NoArgs, () =>
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

    tool(
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

    tool(
      "run_js",
      `Run JavaScript in ${where} and get the result. \`code\` is the body of an async function: use \`return\` (JSON-serializable).${
        options.site
          ? " Changes made this way are lost on reload; use set_site_override to keep them."
          : " Good for checking behavior; change the source files for real changes."
      } With save_as, the whole result goes into a file in the chat's folder instead (data you collected or fetched, an export), and you get only its size.`,
      Schema.Struct({
        code: Schema.String,
        save_as: Schema.optionalKey(
          Schema.String.annotate({ description: "A path in the chat's folder for the result, e.g. data/prices.json" }),
        ),
      }),
      ({ code, save_as }) =>
        Effect.gen(function* () {
          const limit = save_as ? 5_000_000 : 20_000;
          const result = yield* evalIn<string>(`(async () => {
          const __result = await (async () => {
${code}
          })();
          if (__result === undefined) return "undefined";
          if (typeof __result === "string" && ${save_as ? "true" : "false"}) return __result.length > ${limit} ? __result.slice(0, ${limit}) : __result;
          try {
            const s = JSON.stringify(__result, null, 1);
            return s === undefined ? String(__result) : s.length > ${limit} ? s.slice(0, ${limit}) + "…" : s;
          } catch {
            return String(__result);
          }
        })()`);
          if (!save_as) return result;
          const file = yield* saveOutput(chatFiles, env, save_as, result);
          return `Saved the result in ${file.name} (${result.length} characters). read_file reads it.`;
        }),
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
      options.site
        ? "Open a URL in the tab and wait for it to load."
        : "Open a path of the app in the preview (e.g. /settings) and wait for it to load.",
      Schema.Struct({ url: Schema.String }),
      ({ url }) =>
        // Websites only: local files (file://) and the browser's own pages stay out of the agent's reach.
        options.site && /^(?!https?:|about:blank)[a-z][\w+.-]*:(\/\/|[^\d])/i.test(url.trim())
          ? Effect.succeed(text(`Only websites (http or https) can be opened, not ${url.slice(0, 80)}.`, true))
          : call<{ url: string; title: string }>("page.navigate", { url }, 45_000).pipe(
              Effect.tap((page) => (options.site ? env.log(`Opened ${page.url.slice(0, 80)}`) : Effect.void)),
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

// --- Tool registry ---------------------------------------------------------------------

const describeTool = (t: AppTool) => {
  const params = Object.entries(t.params).map(
    ([name, p]) => `${name}${p.required ? "" : "?"}: ${p.type}${p.description ? ` (${p.description})` : ""}`,
  );
  return `- ${t.id}: ${t.title}${t.description ? ` — ${t.description}` : ""}${t.readOnly ? " [read-only]" : ""}${params.length ? `\n    params: ${params.join("; ")}` : ""}${t.input ? `\n    input: text (${t.input})` : ""}`;
};

/** The apps' tools (their actions and data), for any agent. Other apps' need the user's OK. */
export const registryTools = Effect.fn(function* (env: ToolEnv) {
  const registry = yield* AppTools;
  const apps = yield* Apps;
  const own = yield* apps.get(env.tabId);
  const self = own?.kind === "app" ? own.id : null;

  return [
    tool(
      "list_app_tools",
      "What the apps in this workspace can do: each app's actions and the basic tools Rune Browser derives from its data (list/get/add/update/delete per table), with their params. Use one with use_app_tool. Using another app's tools needs the user's OK.",
      Schema.Struct({
        app: Schema.optionalKey(Schema.String.annotate({ description: "An app id, to list only its tools" })),
      }),
      ({ app }) =>
        Effect.gen(function* () {
          if (!own) return text("This tab no longer exists.", true);
          const catalog = (yield* registry.catalog(own.workspaceId)).filter((info) => !app || info.appId === app);
          if (!catalog.length)
            return app ? text(`No app "${app}" in this workspace.`, true) : "No apps in this workspace yet.";
          return catalog
            .map((info) => {
              const tools = info.tools.filter((t) => !t.path);
              const head = `## ${info.appName} (app: ${info.appId})${info.appId === self ? " — this app" : ""}`;
              return `${head}\n${tools.length ? tools.map(describeTool).join("\n") : "No tools (no actions, no data yet)."}`;
            })
            .join("\n\n");
        }),
    ),

    tool(
      "use_app_tool",
      "Run one of an app's tools (see list_app_tools). Leave out `app` for this tab's own app. Returns the tool's message and result as JSON.",
      Schema.Struct({
        app: Schema.optionalKey(Schema.String),
        tool: Schema.String,
        params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        input: Schema.optionalKey(Schema.String),
      }),
      ({ app, tool: toolId, params, input }) =>
        Effect.gen(function* () {
          const appId = app ?? self;
          if (!appId) return text("Say which app (list_app_tools shows their ids).", true);
          const result = yield* registry.call({ kind: "agent", tabId: env.tabId, label: env.label }, appId, toolId, {
            params,
            input,
          });
          const data = result.data === undefined ? "" : JSON.stringify(result.data, null, 1);
          const body = `${result.ok ? "" : `Failed (${result.status}): `}${result.message}${data ? `\n${data.length > 20_000 ? `${data.slice(0, 20_000)}…` : data}` : ""}`;
          return result.ok ? body : text(body, true);
        }).pipe(Effect.catchTag("AppToolError", (e) => Effect.succeed(text(e.message, true)))),
    ),
  ];
});

// --- Schedules -------------------------------------------------------------------------

const TriggerArgs = {
  at: Schema.optionalKey(
    Schema.String.annotate({ description: "Run once at this time (ISO 8601, e.g. 2026-11-02T08:00:00+01:00)" }),
  ),
  cron: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Or repeat: a cron expression in local time, e.g. "0 8 * * 1-5" (at most every 5 minutes)',
    }),
  ),
  event: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Or on an event: "rune.started", "app.started", "app.crashed" (this app), or a name the app sends to $RUNE_API_URL/events',
    }),
  ),
};

/** The app agent's schedules: background runs of this app's tools or commands. */
export const scheduleTools = Effect.fn(function* (env: ToolEnv) {
  const scheduler = yield* Scheduler;
  const permissions = yield* Permissions;
  const apps = yield* Apps;
  const appId = env.tabId;

  const triggerOf = (args: { at?: string; cron?: string; event?: string }): ScheduleTrigger | string => {
    const given = [args.at, args.cron, args.event].filter((v) => v !== undefined);
    if (given.length !== 1) return "Give exactly one of at, cron or event.";
    if (args.at) return { type: "once", at: new Date(args.at).toISOString() };
    if (args.cron) return { type: "cron", cron: args.cron };
    const e = args.event!;
    return {
      type: "event",
      event:
        e === "rune.started" ? e : e === "app.started" || e === "app.crashed" ? `${e}:${appId}` : `app:${appId}:${e}`,
    };
  };
  const allowed = Effect.gen(function* () {
    const app = yield* apps.get(appId);
    return yield* permissions.ask({
      agentTab: appId,
      subject: appId,
      action: "agent.schedule",
      resource: appId,
      title: `Let the agent in "${app?.name ?? "this app"}" run things on a schedule?`,
      detail:
        "It wants to run the app's tools or commands in the background, also when no tab is open. You see every schedule and run in Schedules, and can pause or delete them.",
      timeoutMs: 120_000,
    });
  });
  const describe = (s: Schedule) =>
    `- ${s.id}: ${s.name}${s.paused ? " [paused]" : ""} — ${describeTrigger(s.trigger)} — ${s.task.type === "tool" ? `tool ${s.task.tool}` : s.task.type === "command" ? `command: ${s.task.command}` : `prompt: ${s.task.prompt.slice(0, 80)}`}${
      s.nextRunAt ? `; next ${s.nextRunAt}` : ""
    }${s.lastRun ? `; last run ${s.lastRun.status}: ${s.lastRun.message}` : ""}`;

  return [
    tool("list_schedules", "This app's schedules (background runs), with their next and last runs.", NoArgs, () =>
      scheduler
        .list({ appId })
        .pipe(Effect.map((list) => (list.length ? list.map(describe).join("\n") : "No schedules yet."))),
    ),

    tool(
      "create_schedule",
      "Run one of this app's tools (see list_app_tools; params as for use_app_tool) or a command in its sandbox in the background: once, repeating, or on an event. It runs without a tab open; the user sees it in Schedules and can pause or delete it. Commands don't get the app's secrets; use a tool (an action in rune.json) for work that needs them.",
      Schema.Struct({
        name: Schema.String.annotate({ description: "Short, for the user, e.g. 'Fetch new articles'" }),
        ...TriggerArgs,
        tool: Schema.optionalKey(Schema.String),
        params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        command: Schema.optionalKey(Schema.String),
        notify: Schema.optionalKey(Schema.Literals(["always", "failure", "never"])),
        timeoutSec: Schema.optionalKey(Schema.Finite),
      }),
      ({ name, at, cron, event, tool: toolId, params, command, notify, timeoutSec }) =>
        Effect.gen(function* () {
          const trigger = triggerOf({ at, cron, event });
          if (typeof trigger === "string") return text(trigger, true);
          if (!toolId === !command) return text("Give either tool or command.", true);
          const task: ScheduleTask = toolId
            ? { type: "tool", appId, tool: toolId, ...(params ? { params } : {}) }
            : { type: "command", appId, command: command! };
          const spec: ScheduleSpec = {
            name,
            trigger,
            task,
            notify: notify ?? "failure",
            timeoutSec: Math.round(timeoutSec ?? DEFAULT_TIMEOUT_SEC),
          };
          const problem = scheduleProblem(spec);
          if (problem) return text(problem, true);
          if (!(yield* allowed))
            return text("The user didn't allow schedules for this app. Tell them what you would have scheduled.", true);
          const schedule = yield* scheduler.create(spec, { by: "agent", tabId: appId });
          yield* env.log(`Scheduled “${schedule.name}” (${describeTrigger(schedule.trigger)})`);
          return `Created:\n${describe(schedule)}`;
        }).pipe(Effect.catchTag("ScheduleError", (e) => Effect.succeed(text(e.message, true)))),
    ),

    tool(
      "update_schedule",
      "Change one of this app's schedules: pause or resume it, rename it, or give it a new time (at, cron or event).",
      Schema.Struct({
        id: Schema.String,
        paused: Schema.optionalKey(Schema.Boolean),
        name: Schema.optionalKey(Schema.String),
        ...TriggerArgs,
      }),
      ({ id, paused, name, at, cron, event }) =>
        Effect.gen(function* () {
          const current = yield* scheduler.get(id);
          if (!current || current.task.appId !== appId) return text(`No schedule ${id} for this app.`, true);
          const timing = at !== undefined || cron !== undefined || event !== undefined;
          const trigger = timing ? triggerOf({ at, cron, event }) : current.trigger;
          if (typeof trigger === "string") return text(trigger, true);
          const spec: ScheduleSpec | undefined =
            timing || name
              ? {
                  name: name ?? current.name,
                  trigger,
                  task: current.task,
                  notify: current.notify,
                  timeoutSec: current.timeoutSec,
                }
              : undefined;
          if (spec && !(yield* allowed)) return text("The user didn't allow schedules for this app.", true);
          const saved = yield* scheduler.update(id, { spec, paused });
          return `Updated:\n${describe(saved)}`;
        }).pipe(Effect.catchTag("ScheduleError", (e) => Effect.succeed(text(e.message, true)))),
    ),

    tool("delete_schedule", "Delete one of this app's schedules.", Schema.Struct({ id: Schema.String }), ({ id }) =>
      Effect.gen(function* () {
        const current = yield* scheduler.get(id);
        if (!current || current.task.appId !== appId) return text(`No schedule ${id} for this app.`, true);
        yield* scheduler.remove(id);
        yield* env.log(`Deleted the schedule “${current.name}”`);
        return `Deleted ${id}.`;
      }),
    ),

    tool(
      "run_schedule",
      "Run one of this app's schedules now and wait for the result (to test it).",
      Schema.Struct({ id: Schema.String }),
      ({ id }) =>
        Effect.gen(function* () {
          const current = yield* scheduler.get(id);
          if (!current || current.task.appId !== appId) return text(`No schedule ${id} for this app.`, true);
          const run = yield* scheduler.runNow(id);
          if (run.status !== "running") return text(`${run.status}: ${run.message}`, true);
          // Waits for it (within the schedule's timeout).
          for (let i = 0; i < current.timeoutSec * 2 + 10; i++) {
            yield* Effect.sleep("500 millis");
            const done = (yield* scheduler.runs({ scheduleId: id, limit: 5 })).find((r) => r.id === run.id);
            if (done && done.status !== "running") {
              const body = `${done.status}: ${done.message}${done.output ? `\n${done.output.slice(-8000)}` : ""}`;
              return done.status === "ok" ? body : text(body, true);
            }
          }
          return text("Still running; check list_schedules later.", true);
        }).pipe(Effect.catchTag("ScheduleError", (e) => Effect.succeed(text(e.message, true)))),
    ),
  ];
});

// --- App tools -------------------------------------------------------------------------

const describeStatus = (status: RuntimeStatus, logs: LogLine[]) => {
  const head =
    status.state === "running"
      ? `Running (${status.mode === "dev" ? "dev server" : "built app"}) at ${status.url}.`
      : status.state === "crashed"
        ? `Not running: ${status.error ?? "it crashed"}.`
        : status.state === "stopped"
          ? "Stopped."
          : `Still ${status.state}…`;
  const tail = logs.map((l) => (l.stream === "err" ? `! ${l.text}` : l.text)).join("\n");
  return tail ? `${head}\n\nRecent output:\n${tail}` : head;
};

export const appTools = Effect.fn(function* (env: ToolEnv) {
  const secrets = yield* Secrets;
  const apps = yield* Apps;
  const workspace = yield* Workspace;
  const runtime = yield* Runtime;
  const appData = yield* AppData;
  const projects = yield* Projects;
  const hub = yield* Hub;
  const appId = env.tabId;

  const statusText = (lines = 40) =>
    Effect.gen(function* () {
      const status = yield* runtime.settled(appId, 90_000);
      return describeStatus(status, runtime.logs(appId, lines));
    });

  return [
    tool(
      "create_project",
      `Set up the app's project from a preset and start it. Presets: ${presets.map((p) => `${p.id} (${p.stack})`).join("; ")}.`,
      Schema.Struct({
        preset: Schema.Literals(presets.map((p) => p.id) as [string, ...string[]]),
        name: Schema.optionalKey(Schema.String.annotate({ description: "The app's name" })),
      }),
      ({ preset, name }) =>
        Effect.gen(function* () {
          const project = yield* projects.create(appId, preset, {
            name,
            by: { actor: "agent", actorLabel: env.label },
          });
          yield* env.log(`Created the project (${preset})`);
          const files = Object.keys(presets.find((p) => p.id === preset)!.files).sort();
          return `Created in ${project.dir}:\n${files.join("\n")}\nrune.json, src/tokens.css\n\n${yield* statusText(20)}`;
        }),
    ),

    tool("app_status", "Whether the app is running (and where), with its recent output.", NoArgs, () => statusText()),

    tool(
      "restart_app",
      "Restart the app: installs dependencies if package.json changed, then starts the dev server again. Use it after changing dependencies or rune.json, or when the app crashed. Returns its status and output.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          yield* runtime.restart(appId);
          const status = yield* runtime.settled(appId, 120_000);
          yield* env.log(status.state === "running" ? "Restarted the app" : `App ${status.state}`);
          return describeStatus(status, runtime.logs(appId, 40));
        }),
    ),

    tool(
      "app_logs",
      "Recent output of the app's processes (dev server, installs, builds).",
      Schema.Struct({ lines: Schema.optionalKey(Schema.Finite) }),
      ({ lines }) =>
        Effect.sync(() => {
          const logs = runtime.logs(appId, Math.min(Math.max(lines ?? 80, 1), 500));
          return logs.map((l) => (l.stream === "err" ? `! ${l.text}` : l.text)).join("\n") || "No output yet.";
        }),
    ),

    tool(
      "run_command",
      "Run a shell command in the app's sandbox (project folder, the app's environment and database). For `bun add <package>`, scripts, migrations, tests. Times out after 2 minutes (or timeout_seconds).",
      Schema.Struct({ command: Schema.String, timeout_seconds: Schema.optionalKey(Schema.Finite) }),
      ({ command, timeout_seconds }) =>
        Effect.gen(function* () {
          const result = yield* runtime.exec(appId, command, Math.min(Math.max(timeout_seconds ?? 120, 1), 600) * 1000);
          yield* env.log(`Ran \`${command.length > 70 ? `${command.slice(0, 69)}…` : command}\``);
          const head = result.timedOut ? "Timed out." : `Exit code ${result.code}.`;
          return text(`${head}\n${result.output || "(no output)"}`, result.timedOut || result.code !== 0);
        }),
    ),

    tool(
      "app_data",
      "The data the app stored (kept by Rune Browser outside the project, at DATABASE_PATH and RUNE_FILES_DIR): its tables with columns and row counts, or with `table` a page of that table's rows (optionally only rows containing `search`). Read-only; change data through the app or run_command.",
      Schema.Struct({
        table: Schema.optionalKey(Schema.String),
        search: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.Finite),
        offset: Schema.optionalKey(Schema.Finite),
      }),
      ({ table, search, limit, offset }) =>
        Effect.gen(function* () {
          if (!table) {
            const overview = yield* appData.overview(appId);
            if (overview.error) return text(overview.error, true);
            const tables = overview.tables.map(
              (t) =>
                `- ${t.name} (${t.rows} rows): ${t.columns.map((c) => `${c.name}${c.type ? ` ${c.type}` : ""}`).join(", ")}`,
            );
            return [
              tables.length ? `Tables:\n${tables.join("\n")}` : "No tables yet.",
              `Files: ${overview.files.count} (${overview.files.bytes} bytes)`,
            ].join("\n");
          }
          return yield* appData.rows(appId, table, { search, limit: Math.min(limit ?? 20, 100), offset }).pipe(
            Effect.map((page) => {
              const json = JSON.stringify(page.rows, null, 1);
              return `${page.total} rows${search ? ` containing "${search}"` : ""}; showing ${page.offset + 1}–${page.offset + page.rows.length}:\n${json.length > 20_000 ? `${json.slice(0, 20_000)}…` : json}`;
            }),
            Effect.catchTag("AppDataError", (e) => Effect.succeed(text(e.message, true))),
          );
        }),
    ),

    tool(
      "set_app_info",
      "Set the app's name (short, shown in Rune Browser's sidebar) and icon: a Lucide icon name (find one with search_icons), or icon_file, an image in the project (PNG, SVG, ICO, JPEG, GIF or WebP, at most 100 kB, square works best), e.g. a logo or favicon you made for it.",
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        icon: Schema.optionalKey(Schema.String),
        icon_file: Schema.optionalKey(
          Schema.String.annotate({ description: "Path of an image, relative to the project folder" }),
        ),
      }),
      ({ name, icon, icon_file }) =>
        Effect.gen(function* () {
          if (icon && !isIcon(icon)) return text(`Unknown icon "${icon}". Use search_icons to find one.`, true);
          let image: string | undefined;
          if (icon_file) {
            const project = yield* workspace.info(appId);
            if (!project) return text("The app has no project yet.", true);
            const result = yield* Effect.promise(() => readIconFile(project.dir, icon_file));
            if (typeof result !== "string") return text(result.error, true);
            image = result;
          }
          const wanted = image ?? icon;
          const summary = yield* apps.setInfo(appId, { name: name?.trim() || undefined, icon: wanted });
          if (!summary) return "The app no longer exists.";
          yield* hub.publish({ type: "app", topic: topics.apps, app: summary });
          // The user's own choice of icon stays.
          const kept = wanted !== undefined && summary.icon !== wanted;
          const shown =
            image && !kept
              ? ` (icon from ${icon_file})`
              : summary.icon && !isImageIcon(summary.icon)
                ? ` (${summary.icon})`
                : "";
          return `Saved: ${summary.name}${shown}.${kept ? " The user chose the tab's icon themselves, so it stays." : ""}`;
        }),
    ),

    tool(
      "list_secrets",
      "Names of the secrets (API keys, passwords) the app gets as environment variables (its own, its workspace's, allowed global ones), and global secrets the user could allow it to use. Values are never shown.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const { own, workspace, global, globalNotAllowed } = yield* secrets.available(appId);
          const line = (label: string, names: string[]) => `${label}: ${names.length ? names.join(", ") : "none"}`;
          return [
            line("The app's secrets (process.env)", own),
            line("Secrets shared by its workspace (process.env)", workspace),
            line("Global secrets it may use (process.env)", global),
            line("Global secrets it may not use yet (request_secret asks the user)", globalNotAllowed),
          ].join("\n");
        }),
    ),

    tool(
      "request_secret",
      "Ask the user for a secret the app needs (e.g. an API key), which the app then gets as process.env.NAME. Never ask for secrets in chat, and never write secret values into files. The user enters it in a form; it can take a while, so don't wait: write the code to read process.env.NAME and handle it missing.",
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
      }),
      ({ name, description }) =>
        Effect.gen(function* () {
          if (!SECRET_NAME_PATTERN.test(name) || isReservedSecretName(name)) {
            return text(
              `"${name}" can't be used: use capital letters, digits and _ (like STRIPE_KEY), and not names Rune Browser sets itself.`,
              true,
            );
          }
          const { own, workspace, global } = yield* secrets.available(appId);
          if ([...own, ...workspace, ...global].includes(name))
            return `${name} is already available as process.env.${name}.`;
          yield* env.message("secret", JSON.stringify({ name, description: description.slice(0, 500) }));
          return `Asked the user for ${name}. Once they add it, the app restarts and gets it as process.env.${name}.`;
        }),
    ),

    tool(
      "search_icons",
      "Find Lucide icon names by keywords (e.g. 'money', 'calendar check').",
      Schema.Struct({ query: Schema.String }),
      ({ query }) =>
        Effect.sync(() => {
          const names = searchIcons(query);
          return names.length ? names.join(", ") : "No icons found. Try a more general word.";
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
  const context = yield* Effect.context<Apps | Runtime | AppTools | AppData>();
  const others = Effect.gen(function* () {
    const self = yield* apps.get(env.tabId);
    const all = yield* apps.list();
    return { self, tabs: self ? all.filter((t) => t.workspaceId === self.workspaceId && t.id !== self.id) : [] };
  });

  return [
    tool(
      "list_tabs",
      "The user's other tabs in this workspace (apps and web pages), with ids for read_tab. Only names: read_tab gets what's in one, after the user allows it.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const { self, tabs } = yield* others;
          if (!tabs.length) return "No other tabs in this workspace.";
          return tabs
            .map((t) => {
              const refusal = self ? shareRefusal(self, t) : null;
              return `- ${t.id}: ${t.name} (${t.kind === "web" ? "web page" : "app"})${refusal ? " — can't be shared with you" : ""}`;
            })
            .join("\n");
        }),
    ),

    tool(
      "read_tab",
      "Read another tab of this workspace, after the user allows it: an app's tools and data layout (plus a web page's text, for the website agent), and the last reply of that tab's agent. Use it when the user refers to another tab, or a result from one would help.",
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
          const reader = self.kind === "web" ? "website agent" : "app builder";
          const allowed = yield* permissions.ask({
            agentTab: self.id,
            subject: self.id,
            action: "agent.tab",
            resource: source.id,
            title: `Let the ${reader} in “${self.name}” read “${source.name}”?`,
            detail:
              source.kind === "web"
                ? `It wants to read what the page in “${source.name}” shows (${source.url ?? "no page"}) and the last reply of its agent.`
                : `It wants to see what the app “${source.name}” can do (its tools), how its data is laid out (tables and columns, not their rows)${self.kind === "web" ? ", what its page shows" : ""} and the last reply of its agent.`,
            timeoutMs: 120_000,
          });
          if (!allowed) return text(`The user didn't allow reading “${source.name}”.`, true);
          // The page's text only for agents without tools of their own (sharedTabs.ts).
          const page =
            self.kind === "web"
              ? yield* hub
                  .rpc<{ url: string; title: string; text: string; selection?: string } | null>(
                    "page.read",
                    { tabId: source.id },
                    45_000,
                  )
                  .pipe(Effect.orElseSucceed(() => null))
              : null;
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
