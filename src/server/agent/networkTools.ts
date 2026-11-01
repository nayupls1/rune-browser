// The website agent's view of the network: the tab's captured traffic (always
// with credentials redacted), sending requests again with the user's session
// (asks the user once per site; the session's cookies and tokens are used but
// never shown), and saved requests to send later without opening the site.
import { basename } from "node:path";
import { Effect, Schema } from "effect";
import type {
  NetworkEntry,
  NetworkEntrySummary,
  NetworkUse,
  ReplayOverrides,
  ReplayResult,
  RequestDraft,
  ResponseOverride,
} from "../../shared/api";
import {
  describeOverride,
  isLive,
  MAX_OVERRIDES,
  overrideFailures,
  overrideProblem,
  overrideSpec,
  scopeCovers,
} from "../../shared/overrides";
import { topics } from "../../shared/hub";
import { hostOf } from "../../shared/web";
import { Apps } from "../db/Apps";
import { Network } from "../db/Network";
import { ResponseOverrides } from "../db/ResponseOverrides";
import { Hub } from "../Hub";
import { Permissions, WEBSITE_AGENT, type PermissionsShape } from "../security/Permissions";
import { ChatFiles } from "./ChatFiles";
import { NoArgs, text, tool } from "./Mcp";
import { clip, dataTools, type Data } from "./output";
import type { ToolEnv } from "./tools";

export const Changes = {
  url: Schema.optionalKey(
    Schema.String.annotate({ description: "Send it to another URL (e.g. other query parameters)" }),
  ),
  method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.NullOr(Schema.String) })).annotate({
      description: "Headers to set; a null value removes one",
    }),
  ),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
};

export const toOverrides = (args: {
  url?: string;
  method?: string;
  headers?: readonly { name: string; value: string | null }[];
  body?: string | null;
}): ReplayOverrides => ({
  ...(args.url !== undefined ? { url: args.url } : {}),
  ...(args.method !== undefined ? { method: args.method } : {}),
  ...(args.headers ? { headers: Object.fromEntries(args.headers.map((h) => [h.name, h.value])) } : {}),
  ...(args.body !== undefined ? { body: args.body } : {}),
});

export const line = (e: NetworkEntrySummary) =>
  `#${e.id} ${e.method} ${e.status ?? (e.error ? "failed" : "pending")} ${e.type} ${e.url}${e.mimeType ? ` · ${e.mimeType}` : ""}${e.size ? ` · ${e.size} B` : ""}${
    e.durationMs !== null ? ` · ${e.durationMs} ms` : ""
  }${e.error ? ` · ${e.error}` : ""}${e.rule ? ` · rule: ${e.rule}` : ""}${e.override ? ` · overridden: ${e.override}` : ""}`;

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

/** A response: the status and headers always, the body returned or saved (save_as, fields). */
const describeResult = (r: ReplayResult): Data => ({
  head: [
    `HTTP ${r.status} ${r.statusText} · ${r.mimeType || "no content type"} · ${r.size} B · ${r.durationMs} ms · ${r.url}${
      r.truncated ? " · the body is cut off at 512 kB" : ""
    }`,
    "",
    headerLines(r.headers),
  ].join("\n"),
  body: r.body,
});

/** Sending requests with the user's session needs their OK, once per site (or remembered). */
export const contactPermission = (permissions: PermissionsShape, env: ToolEnv) => (url: string) =>
  Effect.gen(function* () {
    const host = hostOf(url);
    if (!host) return { host, allowed: false };
    const allowed = yield* permissions.ask({
      agentTab: env.tabId,
      subject: WEBSITE_AGENT,
      action: "agent.network",
      resource: host,
      title: `Let the website agent send requests to ${host}?`,
      detail: `It wants to send requests to ${host} with your session: your cookies and logins are used, but never shown to it. Requests can change things on the site (post, buy, delete).`,
      timeoutMs: 120_000,
    });
    return { host, allowed };
  });

export const refused = (host: string) =>
  text(`The user didn't allow sending requests to ${host || "that address"}. Nothing was sent.`, true);

/**
 * A captured request the agent uses: it stays in the log until the chat ends
 * (main/network.ts), so a reload's traffic doesn't push it out. Else why it's gone.
 */
export const usedRequest = Effect.fn(function* (env: ToolEnv, id: string) {
  const hub = yield* Hub;
  const files = yield* ChatFiles;
  const chat = yield* files.dir(env.tabId).pipe(
    Effect.map((dir) => basename(dir)),
    Effect.orElseSucceed(() => env.tabId),
  );
  const used = yield* hub.rpc<NetworkUse>("network.use", { tabId: env.tabId, id: id.replace(/^#/, ""), chat });
  return "entry" in used ? used.entry : text(`Request #${id.replace(/^#/, "")} isn't in the log. ${used.gone}`, true);
});

/** Reading the page's traffic (also for app builders, on their app's preview). */
export const networkReadTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const files = yield* ChatFiles;
  const data = yield* dataTools(env);
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) =>
    hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const use = (id: string) =>
    usedRequest(env, id).pipe(Effect.provideService(Hub, hub), Effect.provideService(ChatFiles, files));
  return [
    data(
      "network_requests",
      "The page's recent network requests, newest last (#id method status type url). By default only data (fetch/XHR, JSON, XML…); `all` for everything. Credentials are redacted. Use network_request for one request's headers and bodies.",
      Schema.Struct({
        query: Schema.optionalKey(Schema.String.annotate({ description: "Text in the URL, method, type or status" })),
        all: Schema.optionalKey(Schema.Boolean),
        limit: Schema.optionalKey(Schema.Finite),
      }),
      ({ query, all, limit }) =>
        call<NetworkEntrySummary[]>("network.list", {
          filter: { query, kind: all ? "all" : "data", limit: Math.min(Math.max(limit ?? 60, 1), 200) },
        }).pipe(
          Effect.map((list): Data => ({
            body: list.length ? list.map(line).join("\n") : null,
            value: list,
            empty: "No requests recorded yet (reload the page to capture its traffic).",
          })),
        ),
    ),

    data(
      "network_request",
      "One captured request: its headers, request body and response body (kept for structured data: JSON, XML, forms, text). Credentials are redacted. save_as and fields apply to the response body. Requests you look at or replay stay in the log until the chat ends, even after a reload.",
      Schema.Struct({ id: Schema.String }),
      ({ id }) =>
        use(id).pipe(
          Effect.map((e) =>
            !("content" in e)
              ? {
                  head: [
                    line(e),
                    "",
                    "Request headers:",
                    headerLines(e.requestHeaders),
                    ...(e.requestBody !== null ? ["", "Request body:", clip(e.requestBody)] : []),
                    "",
                    "Response headers:",
                    headerLines(e.responseHeaders),
                    "",
                    e.responseBody !== null ? "Response body:" : "",
                  ].join("\n"),
                  body: e.responseBody,
                  empty: `No response body: ${e.bodyNote ?? "none"}`,
                }
              : e,
          ),
        ),
    ),
  ];
});

export const networkTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const network = yield* Network;
  const apps = yield* Apps;
  const permissions = yield* Permissions;
  const files = yield* ChatFiles;
  const data = yield* dataTools(env);
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) =>
    hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const workspaceId = apps.get(env.tabId).pipe(Effect.map((app) => app?.workspaceId ?? null));

  const mayContact = contactPermission(permissions, env);

  return [
    ...(yield* networkReadTools(env)),
    ...(yield* overrideTools(env)),

    data(
      "replay_request",
      "Send a captured request again with the user's session (their cookies and logins are used but never shown to you), optionally changed. Returns the response (save_as and fields apply to its body). The user is asked the first time for each site.",
      Schema.Struct({ id: Schema.String, ...Changes }),
      ({ id, ...changes }) =>
        Effect.gen(function* () {
          const entryId = id.replace(/^#/, "");
          const entry = yield* usedRequest(env, entryId).pipe(
            Effect.provideService(Hub, hub),
            Effect.provideService(ChatFiles, files),
          );
          if ("content" in entry) return entry;
          const { host, allowed } = yield* mayContact(changes.url ?? entry.url);
          if (!allowed) return refused(host);
          const result = yield* call<ReplayResult>(
            "network.replay",
            { id: entryId, overrides: toOverrides(changes) },
            45_000,
          );
          yield* env.log(`Sent ${changes.method ?? entry.method} ${host}`);
          return describeResult(result);
        }),
    ),

    tool(
      "cancel_requests",
      "Cancel the page's pending requests (fetch, XHR, images still loading…) without reloading it, like the browser's Stop button. Says which were canceled.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const pendingOf = (list: NetworkEntrySummary[]) => list.filter((e) => e.status === null && !e.error);
          const all = { filter: { kind: "all", limit: 200 } };
          const before = pendingOf(yield* call<NetworkEntrySummary[]>("network.list", all));
          if (!before.length) return "No requests are pending.";
          yield* call("page.eval", { code: "(() => { window.stop(); return true; })()" });
          // The log hears about the canceled ones a moment later.
          yield* Effect.sleep("400 millis");
          const after = new Map((yield* call<NetworkEntrySummary[]>("network.list", all)).map((e) => [e.id, e]));
          const canceled = before.filter((e) => after.get(e.id)?.error);
          const still = before.filter((e) => {
            const now = after.get(e.id);
            return now && now.status === null && !now.error;
          });
          if (canceled.length)
            yield* env.log(`Canceled ${canceled.length} pending request${canceled.length === 1 ? "" : "s"}`);
          return [
            canceled.length
              ? `Canceled:\n${canceled.map((e) => line(after.get(e.id)!)).join("\n")}`
              : "Nothing was canceled.",
            ...(still.length
              ? [`Still open (streams and sockets aren't stopped this way):\n${still.map(line).join("\n")}`]
              : []),
          ].join("\n\n");
        }),
    ),

    tool(
      "save_request",
      "Save a captured request so it can be sent again later without opening the site (send_saved_request, or the user from the Network panel). Its credentials are kept sealed; the session's cookies are used when it's sent.",
      Schema.Struct({
        id: Schema.String,
        name: Schema.String.annotate({ description: "What it fetches, e.g. 'Unread notifications'" }),
      }),
      ({ id, name }) =>
        Effect.gen(function* () {
          const space = yield* workspaceId;
          if (!space) return text("This tab no longer exists.", true);
          const draft = yield* call<RequestDraft>("network.draft", { id: id.replace(/^#/, "") });
          const saved = yield* network.save(space, name.trim().slice(0, 120) || "Saved request", draft);
          yield* hub.publish({ type: "network-changed", topic: topics.network, what: "requests" });
          yield* env.log(`Saved the request “${saved.name}”`);
          return `Saved as ${saved.id}: ${saved.method} ${saved.url}${saved.hasCredentials ? " (with sealed credentials)" : ""}.`;
        }),
    ),

    tool("saved_requests", "Requests saved in this tab's workspace, to send with send_saved_request.", NoArgs, () =>
      Effect.gen(function* () {
        const space = yield* workspaceId;
        const list = space ? yield* network.saved(space) : [];
        return list.length
          ? list.map((r) => `${r.id} · ${r.name} · ${r.method} ${r.url}`).join("\n")
          : "No saved requests in this workspace.";
      }),
    ),

    data(
      "send_saved_request",
      "Send a saved request with the workspace's session, without opening the site, optionally changed. Returns the response (save_as and fields apply to its body). The user is asked the first time for each site.",
      Schema.Struct({ id: Schema.String, ...Changes }),
      ({ id, ...changes }) =>
        Effect.gen(function* () {
          const saved = yield* network.draftOf(id);
          if (!saved || saved.request.workspaceId !== (yield* workspaceId))
            return text(`No saved request ${id} in this workspace.`, true);
          const { host, allowed } = yield* mayContact(changes.url ?? saved.request.url);
          if (!allowed) return refused(host);
          const result = yield* hub.rpc<ReplayResult>(
            "network.replay",
            { workspaceId: saved.request.workspaceId, draft: saved.draft, overrides: toOverrides(changes) },
            45_000,
          );
          yield* env.log(`Sent “${saved.request.name}”`);
          return describeResult(result);
        }),
    ),
  ];
});

/** Changing what the site's requests return, to put the page in any state (main/overrides.ts applies them). */
export const overrideTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const apps = yield* Apps;
  const overrides = yield* ResponseOverrides;
  const permissions = yield* Permissions;
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) =>
    hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const pageUrl = call<{ url: string }>("page.info").pipe(
    Effect.map((p) => p.url),
    Effect.orElseSucceed(() => ""),
  );
  /** Changed: the web tabs get the new list before the tool returns, so a reload right after sees it. */
  const changed = Effect.gen(function* () {
    yield* hub.publish({ type: "network-changed", topic: topics.network, what: "overrides" });
    yield* hub.rpc("network.syncOverrides", {}, 10_000).pipe(Effect.ignore);
  });
  const line = (o: ResponseOverride, url: string) =>
    `${o.id} · ${o.title} · ${o.method ?? "any method"} ${o.pattern} · ${describeOverride(o)} · ${
      o.scope.type === "tab"
        ? o.scope.tabId === env.tabId
          ? "this tab"
          : "another tab"
        : o.scope.type === "site"
          ? `pages of ${o.scope.host}`
          : "the whole workspace"
    }${o.expiresAt ? ` · until ${o.expiresAt}` : ""}${isLive(o) ? "" : " · expired"}${
      scopeCovers(o.scope, url, (tab) => tab === env.tabId) ? "" : " · doesn't apply here"
    }`;

  return [
    tool(
      "override_response",
      [
        "Change what the page's API requests (fetch, XHR, EventSource) get back, to put the page in a state you want to see or test: other data, an empty list, an error status, a network failure, a slow answer, or one that never comes (the loading state).",
        "Only what you set changes; the rest comes from the site (set both status and body to answer without contacting the site). Matching requests get it until it's removed or expires; reload_page (or whatever makes the page fetch again) to see it.",
        "Use network_requests first to find the request and its real response. The user is asked the first time for each site, sees every override in the address bar and can remove it.",
      ].join(" "),
      Schema.Struct({
        title: Schema.String.annotate({ description: "What state it produces, e.g. 'Empty inbox', 'Save fails'" }),
        pattern: Schema.String.annotate({
          description: "Requests it answers: text the URL contains ('/api/feed'), or '*' wildcards over the whole URL",
        }),
        method: Schema.optionalKey(
          Schema.String.annotate({ description: "Only this method (GET, POST…); all by default" }),
        ),
        kind: Schema.optionalKey(
          Schema.Literals(["respond", "fail", "hang"]).annotate({
            description: "respond (default): status/headers/body; fail: a network error; hang: never answers",
          }),
        ),
        status: Schema.optionalKey(Schema.Finite.annotate({ description: "HTTP status (200–599)" })),
        body: Schema.optionalKey(
          Schema.String.annotate({ description: "The response body, e.g. JSON text; '' for none" }),
        ),
        headers: Schema.optionalKey(
          Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.NullOr(Schema.String) })).annotate({
            description: "Response headers to set; null removes one",
          }),
        ),
        failure: Schema.optionalKey(
          Schema.Literals(Object.keys(overrideFailures) as (keyof typeof overrideFailures)[]).annotate({
            description: "fail: how it fails (default Failed)",
          }),
        ),
        delayMs: Schema.optionalKey(Schema.Finite.annotate({ description: "Answer this much later (up to 120000)" })),
        scope: Schema.optionalKey(
          Schema.Literals(["tab", "site", "workspace"]).annotate({
            description:
              "tab (default): only this tab; site: every tab on this site; workspace: every tab in the workspace",
          }),
        ),
        minutes: Schema.optionalKey(
          Schema.Finite.annotate({
            description: "It goes away by itself after this many minutes (default 60); 0: when removed",
          }),
        ),
      }),
      (args) =>
        Effect.gen(function* () {
          const tab = yield* apps.get(env.tabId);
          if (!tab) return text("This tab no longer exists.", true);
          const url = (yield* pageUrl) || (tab.url ?? "");
          const host = hostOf(url);
          if (!host) return text("Open a web page in this tab first.", true);
          const scope =
            args.scope === "workspace"
              ? ({ type: "workspace" } as const)
              : args.scope === "site"
                ? ({ type: "site", host } as const)
                : ({ type: "tab", tabId: env.tabId } as const);
          const minutes = args.minutes ?? 60;
          const spec = overrideSpec({
            title: args.title,
            scope,
            pattern: args.pattern,
            method: args.method ?? null,
            kind: args.kind ?? "respond",
            status: args.status ?? null,
            body: args.body ?? null,
            headers: args.headers ? Object.fromEntries(args.headers.map((h) => [h.name, h.value])) : {},
            failure: args.failure ?? "Failed",
            delayMs: args.delayMs ?? 0,
            expiresAt:
              minutes > 0 ? new Date(Date.now() + Math.min(minutes, 7 * 24 * 60) * 60_000).toISOString() : null,
          });
          const problem = overrideProblem(spec);
          if (problem) return text(problem, true);
          if ((yield* overrides.count(tab.workspaceId)) >= MAX_OVERRIDES)
            return text("There are too many overrides in this workspace: remove some first.", true);
          const allowed = yield* permissions.ask({
            agentTab: env.tabId,
            subject: WEBSITE_AGENT,
            action: "agent.override",
            resource: host,
            title: `Let the website agent change what ${host} returns?`,
            detail: `It wants to replace the answers to some of ${host}'s requests in your tabs (other data, errors, slow or no answers) to see how the page handles them. The site itself isn't changed; you'll see every override in the address bar and can remove it.`,
            timeoutMs: 120_000,
          });
          if (!allowed) return text(`The user didn't allow changing what ${host} returns.`, true);
          const created = yield* overrides.create(tab.workspaceId, spec);
          yield* changed;
          yield* env.log(`Overrode ${created.pattern}: ${describeOverride(created)}`);
          return `Added ${line(created, url)}. Reload the page (or make it fetch again) to see it.`;
        }),
    ),

    tool(
      "response_overrides",
      "The response overrides in this tab's workspace (id · title · requests · what they do · where), and whether each applies to this tab's page.",
      NoArgs,
      () =>
        Effect.gen(function* () {
          const tab = yield* apps.get(env.tabId);
          const list = tab ? yield* overrides.list(tab.workspaceId) : [];
          const url = yield* pageUrl;
          return list.length ? list.map((o) => line(o, url)).join("\n") : "No response overrides in this workspace.";
        }),
    ),

    tool(
      "remove_response_override",
      "Remove a response override (by id), or with all: every override that applies to this tab, so the page gets the site's real answers again. Reload to see the page as it really is.",
      Schema.Struct({ id: Schema.optionalKey(Schema.String), all: Schema.optionalKey(Schema.Boolean) }),
      ({ id, all }) =>
        Effect.gen(function* () {
          const tab = yield* apps.get(env.tabId);
          const list = tab ? yield* overrides.list(tab.workspaceId) : [];
          const url = yield* pageUrl;
          const gone = all
            ? list.filter((o) => scopeCovers(o.scope, url, (t) => t === env.tabId))
            : list.filter((o) => o.id === id);
          if (!gone.length)
            return text(all ? "No overrides apply to this tab." : `No override ${id} in this workspace.`, !all);
          for (const o of gone) yield* overrides.remove(o.id);
          yield* changed;
          yield* env.log(
            gone.length === 1 ? `Removed the override “${gone[0]!.title}”` : `Removed ${gone.length} overrides`,
          );
          return `Removed ${gone.map((o) => `${o.id} (${o.title})`).join(", ")}.`;
        }),
    ),
  ];
});
