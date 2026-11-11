// The HTTP API (for the renderer), the hub WebSocket and the MCP endpoint.
import { Data, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  IMAGE_ICON_MAX,
  IMAGE_ICON_PATTERN,
  isEmojiIcon,
  isImageIcon,
  providerIds,
  workspaceOfScope,
  workspaceScope,
  type NetworkRule,
  type ReplayOverrides,
  type ReplayResult,
  type AppDetail,
  type AppSummary,
  type HealthResponse,
  type PermissionAction,
  type ProviderId,
} from "../shared/api";
import { topics } from "../shared/hub";
import { isPrivateWindow, tabFate, WINDOW_ID_PATTERN } from "../shared/windows";
import { Settings as SettingsSchema, WorkspaceSettings } from "../shared/settings";
import { Agent } from "./agent/Agent";
import { Mcp } from "./agent/Mcp";
import { PageContextInput } from "./agent/prompts";
import { MAX_SHARED_TABS, SharedTabInput } from "./agent/sharedTabs";
import { Audit } from "./security/Audit";
import { Permissions, WEBSITE_AGENT } from "./security/Permissions";
import { ServerConfig } from "./Config";
import { Apps } from "./db/Apps";
import { BookmarkError, Bookmarks } from "./bookmarks/Bookmarks";
import { bookmarkSources } from "./bookmarks/sources";
import { parseBookmarksHtml } from "../shared/bookmarks";
import { isRecordable } from "../shared/visits";
import { isIcon } from "./icons";
import { Network } from "./db/Network";
import { ResponseOverrides } from "./db/ResponseOverrides";
import { Endpoints } from "./db/Endpoints";
import { Visits } from "./db/Visits";
import { describeEndpoint, type Observation } from "../shared/endpoints";
import { Settings } from "./db/Settings";
import { PageChanges, pageChangeError } from "./db/PageChanges";
import { ScheduleError, Scheduler } from "./scheduler/Scheduler";
import { Sites } from "./db/Sites";
import { ModError, Mods } from "./mods/Mods";
import { decodeShareCode } from "../shared/mods";
import { Workspaces } from "./db/Workspaces";
import { History, type By, type HistoryError } from "./history/History";
import { Hub } from "./Hub";
import { Providers } from "./providers/Providers";
import { Tabs } from "./Tabs";
import { SourceError, Sources } from "./sources/Sources";
import { Attachments, IMAGE_TYPES, MAX_ATTACHMENT } from "./agent/Attachments";
import { ChatFiles, lookupPath } from "./agent/ChatFiles";
import { Jobs } from "./agent/Jobs";

class HttpFail extends Data.TaggedError("HttpFail")<{ readonly status: number; readonly message: string }> {}

const fail = (status: number, message: string) => Effect.fail(new HttpFail({ status, message }));
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const noContent = HttpServerResponse.empty({ status: 204 });

/** Turns HttpFail (and other expected failures) into JSON error responses. */
const handle = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpFail, R>) =>
  effect.pipe(Effect.catchTag("HttpFail", (e) => Effect.succeed(json({ error: e.message }, e.status))));

const param = (name: string) => Effect.map(HttpRouter.params, (params) => params[name] ?? "");

const body = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* req.text.pipe(Effect.orElseSucceed(() => ""));
  if (!text.trim()) return {} as unknown;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return yield* fail(400, "Invalid JSON");
  }
});

/** The request body decoded with a schema (400 with the problems otherwise). */
const decodeBody = <S extends Schema.Codec<unknown>>(schema: S) =>
  Effect.flatMap(body, (input) => {
    try {
      return Effect.succeed(Schema.decodeUnknownSync(schema)(input) as S["Type"]);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  });

const str = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const WindowId = Schema.String.check(Schema.isPattern(WINDOW_ID_PATTERN, { message: "not a window id" }));

// --- Auth ----------------------------------------------------------------------------

/**
 * Only Rune Browser's renderer may use the API. Requests need the token Electron gave
 * the renderer, and browsers must come from the renderer's origin: websites in
 * web tabs can reach 127.0.0.1 too.
 */
const guard = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.url, "http://localhost");
      // MCP has tokens of its own (per agent turn).
      if (req.method === "OPTIONS" || url.pathname === "/api/health" || url.pathname.startsWith("/mcp/")) {
        return yield* effect;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.allowedOrigin) return json({ error: "Forbidden" }, 403);
      if (config.token) {
        const given = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
        if (given !== config.token) return json({ error: "Unauthorized" }, 401);
      }
      return yield* effect;
    }),
  { global: true },
);

// --- Routes ----------------------------------------------------------------------------

const health = HttpRouter.add(
  "GET",
  "/api/health",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return json({
      ok: true,
      uptime: process.uptime(),
      bun: Bun.version,
      dataDir: config.dataDir,
    } satisfies HealthResponse);
  }),
);

const ws = HttpRouter.add(
  "GET",
  "/api/ws",
  Effect.gen(function* () {
    const hub = yield* Hub;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(req.url, "http://localhost");
    const socket = yield* req.upgrade.pipe(Effect.orElseSucceed(() => null));
    if (!socket) return json({ error: "Expected a WebSocket upgrade" }, 426);
    yield* hub.serve(socket, {
      renderer: url.searchParams.get("role") === "renderer",
      window: url.searchParams.get("window") ?? undefined,
    });
    return noContent;
  }),
);

const mcp = HttpRouter.add(
  "*",
  "/mcp/:token",
  Effect.gen(function* () {
    const server = yield* Mcp;
    const req = yield* HttpServerRequest.HttpServerRequest;
    // Streamable HTTP: we only answer POSTs (with JSON); no server-initiated streams.
    if (req.method === "GET") return HttpServerResponse.empty({ status: 405 });
    if (req.method === "DELETE") return noContent;
    if (req.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const token = yield* param("token");
    const input = yield* req.json.pipe(Effect.orElseSucceed(() => null));
    if (input === null) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const result = yield* server.handle(token, input).pipe(Effect.orElseSucceed(() => "unknown" as const));
    if (result === "unknown") return json({ error: "Unknown session" }, 404);
    return result === null ? HttpServerResponse.empty({ status: 202 }) : json(result);
  }),
);

const providerRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/providers",
    Effect.gen(function* () {
      const providers = yield* Providers;
      return json(yield* providers.list);
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/providers/refresh",
    handle(
      Effect.gen(function* () {
        const providers = yield* Providers;
        const { id } = yield* decodeBody(Schema.Struct({ id: Schema.optionalKey(Schema.Literals(providerIds)) }));
        return json(yield* providers.refresh(id));
      }),
    ),
  ),
]);

const settingsRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/settings",
    Effect.gen(function* () {
      const settings = yield* Settings;
      return json(yield* settings.get());
    }),
  ),
  HttpRouter.route(
    "PUT",
    "/api/settings",
    handle(
      Effect.gen(function* () {
        const settings = yield* Settings;
        const providers = yield* Providers;
        const previous = yield* settings.get();
        const next = yield* decodeBody(SettingsSchema);
        yield* settings.save(next);
        yield* snapshot("settings", "Changed settings", true);
        // Re-check providers that were turned on/off or moved.
        for (const id of providerIds) {
          if (JSON.stringify(previous.providers[id]) !== JSON.stringify(next.providers[id]))
            yield* Effect.forkDetach(providers.refresh(id));
        }
        return json(next);
      }),
    ),
  ),
]);

// Files given to the agent with a message (agent/Attachments.ts).
const attachmentRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/api/apps/:id/attachments",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        if (!(yield* (yield* Apps).get(id))) return yield* fail(404, "Not found");
        const input = yield* decodeBody(
          Schema.Struct({ name: str(300), mime: str(200), data: str(Math.ceil((MAX_ATTACHMENT * 4) / 3) + 8) }),
        );
        const data = Buffer.from(input.data, "base64");
        const saved = yield* (yield* Attachments)
          .save(id, { name: input.name, mime: input.mime, data })
          .pipe(Effect.catchTag("AttachmentError", (e) => fail(400, e.message)));
        return json(saved, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/apps/:id/attachments/:attachment",
    handle(
      Effect.gen(function* () {
        const file = yield* (yield* Attachments).get(yield* param("id"), yield* param("attachment"));
        if (!file) return yield* fail(404, "Not found");
        return yield* serveChatFile(file);
      }),
    ),
  ),

  // The chat's folder (agent/ChatFiles.ts): what the user attached and the agent made.
  HttpRouter.route(
    "GET",
    "/api/apps/:id/files",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        if (!(yield* (yield* Apps).get(id))) return yield* fail(404, "Not found");
        return json(
          yield* (yield* ChatFiles).list(id).pipe(Effect.catchTag("ChatFileError", (e) => fail(400, e.message))),
        );
      }),
    ),
  ),
  // Paths the agent linked in the chat, for their chips: a file, a folder or missing, but only inside
  // the tab's chat folders (anything else is "outside", existing or not).
  HttpRouter.route(
    "POST",
    "/api/apps/:id/files/lookup",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        if (!(yield* (yield* Apps).get(id))) return yield* fail(404, "Not found");
        const { paths } = yield* decodeBody(
          Schema.Struct({ paths: Schema.Array(str(4000)).check(Schema.isMaxLength(100)) }),
        );
        const files = yield* ChatFiles;
        const current = yield* files.dir(id).pipe(Effect.orElseSucceed(() => null));
        const roots = [...new Set([current, ...(yield* files.folders(id))].filter((r): r is string => !!r))];
        return json(yield* Effect.promise(() => Promise.all(paths.map((p) => lookupPath(p, roots)))));
      }),
    ),
  ),
  // A file of one of the tab's chats, by its absolute path (thumbnails in the chat).
  HttpRouter.route(
    "GET",
    "/api/apps/:id/files/raw",
    handle(
      Effect.gen(function* () {
        const path = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams.get(
          "path",
        );
        const file = path ? yield* (yield* ChatFiles).find(yield* param("id"), path) : null;
        if (!file) return yield* fail(404, "Not found");
        return yield* serveChatFile(file);
      }),
    ),
  ),
]);

/** A chat's file for the renderer: only images inline; anything else downloads, so a page can't run from here. */
const serveChatFile = (file: { path: string; name: string; mime: string }) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(() => Bun.file(file.path).bytes());
    const inline = IMAGE_TYPES.has(file.mime);
    const name = file.name
      .split("/")
      .pop()!
      .replace(/[^\w.\- ()]+/g, "_");
    return HttpServerResponse.uint8Array(bytes, {
      status: 200,
      contentType: inline ? file.mime : "application/octet-stream",
      headers: {
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

// Code attached to a tab for its agent: folders of yours and Git repositories (sources/Sources.ts).
const sourceFail = <A, R>(effect: Effect.Effect<A, SourceError, R>) =>
  effect.pipe(Effect.catchTag("SourceError", (e) => fail(400, e.message)));
const sourceOf = (tabId: string, id: string) =>
  Effect.gen(function* () {
    const source = yield* (yield* Sources).get(id);
    if (!source || source.tabId !== tabId) return yield* fail(404, "Not found");
    return source;
  });
const sourceRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/apps/:id/sources",
    handle(
      Effect.gen(function* () {
        return json(yield* (yield* Sources).list(yield* param("id")));
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/apps/:id/sources",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        if (!(yield* (yield* Apps).get(id))) return yield* fail(404, "Not found");
        const input = yield* decodeBody(
          Schema.Struct({
            folder: Schema.optionalKey(str(4000)),
            git: Schema.optionalKey(str(2000)),
            branch: Schema.optionalKey(str(200)),
          }),
        );
        if (!input.git === !input.folder) return yield* fail(400, "Give either git or folder");
        const sources = yield* Sources;
        const source = yield* sourceFail(
          input.git ? sources.addGit(id, input.git, input.branch) : sources.addFolder(id, input.folder!),
        );
        yield* youDid(id, "source.add", source.name, source.url ?? source.path);
        return json(source, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/apps/:id/sources/:source",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const source = yield* sourceOf(id, yield* param("source"));
        yield* (yield* Sources).remove(source.id);
        yield* youDid(id, "source.remove", source.name, source.url ?? source.path);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/apps/:id/sources/:source/pull",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const source = yield* sourceOf(id, yield* param("source"));
        const pulled = yield* sourceFail((yield* Sources).pull(source.id));
        yield* youDid(id, "source.pull", source.name, source.url ?? source.path);
        return json(pulled);
      }),
    ),
  ),
]);

/** A tab with everything the renderer shows for it. */
const detail = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* Apps;
    const app = yield* apps.get(id);
    if (!app) return yield* fail(404, "Not found");
    const { nameLocked: _, session: __, ...summary } = app;
    return {
      ...summary,
      messages: yield* apps.messages(id),
      running: yield* (yield* Agent).isRunning(id),
      jobs: yield* (yield* Jobs).list(id),
      agent: app.agent,
    } satisfies AppDetail;
  });

const publishApp = (summary: AppSummary | null) =>
  Effect.gen(function* () {
    yield* (yield* Tabs).publish(summary);
  });

/** A snapshot of something the user changed in the UI (folded together while they keep changing it). */
const snapshot = (target: "settings" | "sites", summary: string, coalesce = false) =>
  Effect.gen(function* () {
    const history = yield* History;
    const by: By = { actor: "user", actorLabel: "You", summary, coalesceMs: coalesce ? 10 * 60 * 1000 : undefined };
    yield* history.record(target, by);
  });

/** Deletes a tab with everything that belongs to it (Tabs.remove), its agent stopped first. */
const removeApp = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Agent).stop(id);
    yield* (yield* Tabs).remove(id);
    yield* dropTabOverrides(id);
  });

/** A tab's response overrides go away with it. */
const dropTabOverrides = (tabId: string) =>
  Effect.gen(function* () {
    if (yield* (yield* ResponseOverrides).removeTab(tabId)) yield* publishNetwork("overrides");
  });

const appRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/apps",
    Effect.gen(function* () {
      const apps = yield* Apps;
      return json(yield* apps.list());
    }),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(
          Schema.Struct({
            // Extension pages (options, tabs extensions open) and local files the user opens are tabs too.
            url: Schema.optionalKey(
              str(8000).check(
                Schema.isPattern(/^(https?:\/\/|chrome-extension:\/\/[a-p]{32}\/|file:\/\/\/)/i, {
                  message: "url must be an http(s) URL",
                }),
              ),
            ),
            workspaceId: Schema.optionalKey(str(100)),
            windowId: Schema.optionalKey(WindowId),
          }),
        );
        const space = input.workspaceId ? yield* workspaces.get(input.workspaceId) : yield* workspaces.first();
        if (!space) return yield* fail(404, "No such workspace");
        const app = yield* apps.create(space.id, input.url ?? null, input.windowId ?? null);
        if (input.url) yield* visited({ ...app, url: null }, { url: input.url });
        yield* publishApp(app);
        return json(app, 201);
      }),
    ),
  ),

  HttpRouter.route(
    "GET",
    "/api/apps/:id",
    handle(
      Effect.gen(function* () {
        return json(yield* detail(yield* param("id")));
      }),
    ),
  ),

  HttpRouter.route(
    "PATCH",
    "/api/apps/:id",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const { name } = yield* decodeBody(Schema.Struct({ name: str(200) }));
        if (!name.trim()) return yield* fail(400, "name is required");
        const app = yield* apps.rename(yield* param("id"), name.trim());
        if (!app) return yield* fail(404, "Not found");
        yield* publishApp(app);
        return json(app);
      }),
    ),
  ),

  HttpRouter.route(
    "DELETE",
    "/api/apps/:id",
    Effect.gen(function* () {
      yield* removeApp(yield* param("id"));
      return noContent;
    }),
  ),

  // The tab's own icon (a Lucide name, an emoji or a small image), or null for the default.
  HttpRouter.route(
    "PUT",
    "/api/apps/:id/icon",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const { icon } = yield* decodeBody(Schema.Struct({ icon: Schema.NullOr(str(IMAGE_ICON_MAX)) }));
        if (icon !== null && !(isImageIcon(icon) ? IMAGE_ICON_PATTERN.test(icon) : isIcon(icon) || isEmojiIcon(icon))) {
          return yield* fail(400, "icon must be a Lucide icon name, an emoji or a base64 image data URL");
        }
        const app = yield* apps.setIcon(yield* param("id"), icon);
        if (!app) return yield* fail(404, "Not found");
        yield* publishApp(app);
        return json(app);
      }),
    ),
  ),

  // Pinned tabs stay loaded (the renderer unloads idle tabs, see lib/unload.ts).
  HttpRouter.route(
    "PUT",
    "/api/apps/:id/pinned",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const { pinned } = yield* decodeBody(Schema.Struct({ pinned: Schema.Boolean }));
        const app = yield* apps.setPinned(yield* param("id"), pinned);
        if (!app) return yield* fail(404, "Not found");
        yield* publishApp(app);
        return json(app);
      }),
    ),
  ),

  // Moving a tab to another workspace: it gets that workspace's session and permissions.
  HttpRouter.route(
    "POST",
    "/api/apps/:id/move",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const workspaces = yield* Workspaces;
        const id = yield* param("id");
        const { workspaceId } = yield* decodeBody(Schema.Struct({ workspaceId: str(100) }));
        const target = yield* workspaces.get(workspaceId);
        if (!target) return yield* fail(404, "No such workspace");
        const app = yield* apps.get(id);
        if (!app) return yield* fail(404, "Not found");
        // A private window has no workspaces: its tabs share the private session.
        if (app.private) return yield* fail(400, "Private tabs aren't in a workspace");
        if (app.workspaceId === workspaceId) return json(app);
        const moved = yield* (yield* Tabs).move(id, workspaceId);
        yield* youDid(id, "tab.move", target.name);
        return json(moved);
      }),
    ),
  ),

  // Moving a tab to another window (dragged there, or "Move to new window"). Private tabs stay in private windows.
  HttpRouter.route(
    "POST",
    "/api/apps/:id/window",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const { windowId } = yield* decodeBody(Schema.Struct({ windowId: WindowId }));
        const app = yield* (yield* Apps).get(id);
        if (!app) return yield* fail(404, "Not found");
        if (app.private !== isPrivateWindow(windowId))
          return yield* fail(400, "Tabs don't move between private and normal windows");
        return json(yield* (yield* Tabs).moveToWindow(id, windowId));
      }),
    ),
  ),

  // Tabs report navigation: URL, page title (renames the tab) and favicon.
  HttpRouter.route(
    "PATCH",
    "/api/apps/:id/page",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const page = yield* decodeBody(
          Schema.Struct({
            url: Schema.optionalKey(str(8000)),
            title: Schema.optionalKey(str(1000)),
            favicon: Schema.optionalKey(Schema.NullOr(str(8000))),
          }),
        );
        const before = yield* apps.get(yield* param("id"));
        const tab = before && (yield* apps.updatePage(before.id, page));
        if (!before || !tab) return yield* fail(404, "Not found");
        yield* visited(before, page);
        return json(tab);
      }),
    ),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/duplicate",
    handle(
      Effect.gen(function* () {
        const copy = yield* (yield* Tabs).copy(yield* param("id"));
        if (!copy) return yield* fail(404, "Not found");
        return json(copy, 201);
      }),
    ),
  ),

  HttpRouter.route(
    "DELETE",
    "/api/apps/:id/messages",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const agent = yield* Agent;
        const id = yield* param("id");
        if (!(yield* apps.get(id))) return yield* fail(404, "Not found");
        if (yield* agent.isRunning(id)) return yield* fail(409, "Stop the agent before clearing the chat");
        yield* (yield* Jobs).endTab(id);
        yield* (yield* ChatFiles).forget(id, yield* apps.clearMessages(id));
        return noContent;
      }),
    ),
  ),

  // Chats of a tab: "new chat" keeps the current one as an earlier chat, which can be opened again or deleted.
  HttpRouter.route(
    "GET",
    "/api/apps/:id/chats",
    Effect.gen(function* () {
      return json(yield* (yield* Apps).chats(yield* param("id")));
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/apps/:id/chats/:chatId",
    Effect.gen(function* () {
      return json(yield* (yield* Apps).chatMessages(yield* param("id"), Number(yield* param("chatId"))));
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/apps/:id/chats",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const id = yield* param("id");
        if (!(yield* apps.get(id))) return yield* fail(404, "Not found");
        if (yield* (yield* Agent).isRunning(id)) return yield* fail(409, "Stop the agent before starting a new chat");
        yield* (yield* Jobs).endTab(id);
        yield* apps.newChat(id);
        return json({ messages: [], chats: yield* apps.chats(id) }, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/apps/:id/chats/:chatId/open",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const id = yield* param("id");
        if (yield* (yield* Agent).isRunning(id)) return yield* fail(409, "Stop the agent before switching chats");
        if (!(yield* apps.get(id))) return yield* fail(404, "Not found");
        yield* (yield* Jobs).endTab(id);
        if (!(yield* apps.openChat(id, Number(yield* param("chatId"))))) return yield* fail(404, "No such chat");
        return json({ messages: yield* apps.messages(id), chats: yield* apps.chats(id) });
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/apps/:id/chats/:chatId",
    handle(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const id = yield* param("id");
        const deleted = yield* apps.deleteChat(id, Number(yield* param("chatId")));
        if (!deleted) return yield* fail(404, "No such chat");
        yield* (yield* ChatFiles).forget(id, deleted.folder);
        yield* youDid(id, "chat.delete", null);
        return noContent;
      }),
    ),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/chat",
    handle(
      Effect.gen(function* () {
        const agent = yield* Agent;
        const request = yield* decodeBody(
          Schema.Struct({
            prompt: str(100_000),
            agent: Schema.optionalKey(
              Schema.Struct({
                provider: Schema.optionalKey(Schema.Literals(providerIds)),
                model: Schema.optionalKey(Schema.NullOr(str(300))),
                effort: Schema.optionalKey(Schema.NullOr(str(50))),
              }),
            ),
            page: Schema.optionalKey(PageContextInput),
            shared: Schema.optionalKey(Schema.Array(SharedTabInput).check(Schema.isMaxLength(MAX_SHARED_TABS))),
            attachments: Schema.optionalKey(Schema.Array(str(64)).check(Schema.isMaxLength(10))),
          }),
        );
        if (!request.prompt.trim()) return yield* fail(400, "prompt is required");
        yield* agent
          .start(yield* param("id"), {
            prompt: request.prompt.trim(),
            agent: request.agent as
              { provider?: ProviderId; model?: string | null; effort?: string | null } | undefined,
            page: request.page as never,
            shared: request.shared,
            ...(request.attachments?.length ? { attachments: request.attachments } : {}),
          })
          .pipe(Effect.catchTag("AgentError", (e) => fail(e.status, e.message)));
        return json({ ok: true }, 202);
      }),
    ),
  ),

  // The current chat's background jobs (agent/Jobs.ts); the user stops one from the chat.
  HttpRouter.route(
    "GET",
    "/api/apps/:id/jobs",
    Effect.gen(function* () {
      return json(yield* (yield* Jobs).list(yield* param("id")));
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/apps/:id/jobs/:jobId/stop",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const stopped = yield* (yield* Jobs).cancel(id, yield* param("jobId"));
        if (!stopped.length) return yield* fail(404, "No such running job");
        yield* youDid(id, "job.stop", stopped[0]!.title);
        return json(yield* (yield* Jobs).list(id));
      }),
    ),
  ),

  HttpRouter.route(
    "POST",
    "/api/apps/:id/stop",
    Effect.gen(function* () {
      const agent = yield* Agent;
      yield* agent.stop(yield* param("id"));
      return json({ ok: true });
    }),
  ),
]);

/**
 * The main process tells which windows are open, closed (to be reopened) and forgotten, at
 * startup and whenever that changes (shared/windows.ts: tabFate): private tabs whose window
 * closed and forgotten windows' tabs are deleted, and tabs of windows nobody knows go to the
 * first open window.
 */
const windowRoutes = HttpRouter.add(
  "POST",
  "/api/windows",
  handle(
    Effect.gen(function* () {
      const ids = Schema.Array(WindowId).check(Schema.isMaxLength(200));
      const sync = yield* decodeBody(Schema.Struct({ open: ids, closed: ids, forget: ids }));
      const apps = yield* Apps;
      const tabs = yield* Tabs;
      yield* apps.setHomeWindow(sync.open.find((id) => !isPrivateWindow(id)) ?? null);
      const changed = { deleted: 0, adopted: 0 };
      for (const tab of yield* apps.list()) {
        const fate = tabFate(tab, { open: [...sync.open], closed: [...sync.closed], forget: [...sync.forget] });
        if (fate === "keep") continue;
        if (fate === "delete") {
          yield* removeApp(tab.id);
          changed.deleted++;
        } else {
          yield* tabs.publish(yield* apps.setWindow(tab.id, fate.adopt, "same"));
          changed.adopted++;
        }
      }
      if (changed.deleted) yield* apps.checkpoint();
      return json(changed);
    }),
  ),
);

const siteRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/sites",
    Effect.gen(function* () {
      const sites = yield* Sites;
      return json(yield* sites.list());
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/sites/:host",
    Effect.gen(function* () {
      const sites = yield* Sites;
      return json(yield* sites.get(yield* param("host")));
    }),
  ),
  HttpRouter.route(
    "PUT",
    "/api/sites/:host",
    handle(
      Effect.gen(function* () {
        const sites = yield* Sites;
        const hub = yield* Hub;
        const fields = yield* decodeBody(
          Schema.Struct({
            css: Schema.optionalKey(str(200_000)),
            js: Schema.optionalKey(str(200_000)),
            enabled: Schema.optionalKey(Schema.Boolean),
          }),
        );
        const saved = yield* sites.save(yield* param("host"), fields);
        yield* hub.publish({ type: "site", topic: topics.sites, host: saved.host });
        yield* snapshot("sites", `Changed the customizations of ${saved.host}`, true);
        return json(saved);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/sites/:host",
    Effect.gen(function* () {
      const sites = yield* Sites;
      const hub = yield* Hub;
      const host = decodeURIComponent(yield* param("host"));
      yield* sites.remove(host);
      yield* hub.publish({ type: "site", topic: topics.sites, host });
      yield* snapshot("sites", `Removed the customizations of ${host}`);
      return noContent;
    }),
  ),
]);

// --- Page changes (web tabs) -------------------------------------------------------------

export const PageChangeBody = Schema.Struct({
  title: str(120),
  scope: Schema.Struct({ type: Schema.Literals(["page", "site", "pattern"]), value: str(500) }),
  action: Schema.Literals(["hide", "style", "text", "attribute", "insert", "button", "css", "script"]),
  selector: Schema.optionalKey(str(2000)),
  value: Schema.optionalKey(str(100_000)),
  name: Schema.optionalKey(str(200)),
  position: Schema.optionalKey(Schema.Literals(["before", "after", "prepend", "append"])),
  onClick: Schema.optionalKey(str(50_000)),
});

const pageChangeRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/page-changes",
    Effect.gen(function* () {
      return json(yield* (yield* PageChanges).list());
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/page-changes",
    handle(
      Effect.gen(function* () {
        const spec = yield* decodeBody(PageChangeBody);
        const problem = pageChangeError(spec);
        if (problem) return yield* fail(400, problem);
        const change = yield* (yield* PageChanges).create(spec, "user");
        yield* (yield* Hub).publish({ type: "page-changes", topic: topics.sites });
        yield* snapshot("sites", `Added the page change “${change.title}”`);
        return json(change);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/page-changes/:id",
    handle(
      Effect.gen(function* () {
        const { enabled, change: spec } = yield* decodeBody(
          Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean), change: Schema.optionalKey(PageChangeBody) }),
        );
        if (spec) {
          const problem = pageChangeError(spec);
          if (problem) return yield* fail(400, problem);
        }
        const saved = yield* (yield* PageChanges).update(yield* param("id"), { spec, enabled });
        if (!saved) return yield* fail(404, "Not found");
        yield* (yield* Hub).publish({ type: "page-changes", topic: topics.sites });
        const summary = spec
          ? `Changed the page change “${saved.title}”`
          : `Turned ${saved.enabled ? "on" : "off"} “${saved.title}”`;
        yield* snapshot("sites", summary, true);
        return json(saved);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/page-changes/:id",
    handle(
      Effect.gen(function* () {
        const changes = yield* PageChanges;
        const change = yield* changes.get(yield* param("id"));
        if (!change) return yield* fail(404, "Not found");
        yield* changes.remove(change.id);
        yield* (yield* Hub).publish({ type: "page-changes", topic: topics.sites });
        yield* snapshot("sites", `Removed the page change “${change.title}”`);
        return noContent;
      }),
    ),
  ),
]);

// --- Mods (mods/Mods.ts) -------------------------------------------------------------------

const modError = (e: ModError) => fail(e.status, e.message);

/** A mod given as JSON, a share code or a link. */
const ModInput = Schema.Struct({
  mod: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(str(2_000_000)),
  url: Schema.optionalKey(str(2000)),
});

const modJson = (input: typeof ModInput.Type) =>
  Effect.gen(function* () {
    if (input.mod !== undefined) return { json: input.mod, source: "file" };
    if (input.code) {
      const code = input.code;
      const json = yield* Effect.tryPromise({
        try: () => decodeShareCode(code),
        catch: (e) => new ModError({ status: 400, message: e instanceof Error ? e.message : String(e) }),
      });
      return { json, source: "code" };
    }
    if (input.url) return { json: yield* (yield* Mods).fetchJson(input.url), source: input.url };
    return yield* new ModError({ status: 400, message: "Give a mod, a share code or a link." });
  });

const modRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/mods",
    Effect.gen(function* () {
      return json(yield* (yield* Mods).list);
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/mods/gallery",
    Effect.gen(function* () {
      return json(yield* (yield* Mods).gallery);
    }),
  ),
  // What installing a mod would do, before the user decides.
  HttpRouter.route(
    "POST",
    "/api/mods/review",
    handle(
      Effect.gen(function* () {
        const { json: mod, source } = yield* modJson(yield* decodeBody(ModInput));
        return json({ ...(yield* (yield* Mods).review(mod)), source });
      }).pipe(Effect.catchTag("ModError", modError)),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/mods",
    handle(
      Effect.gen(function* () {
        const input = yield* decodeBody(Schema.Struct({ ...ModInput.fields, source: Schema.optionalKey(str(500)) }));
        const { json: mod, source } = yield* modJson(input);
        return json(yield* (yield* Mods).install(mod, input.source ?? source), 201);
      }).pipe(Effect.catchTag("ModError", modError)),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/mods/package",
    handle(
      Effect.gen(function* () {
        const input = yield* decodeBody(
          Schema.Struct({
            name: str(80).check(Schema.isPattern(/\S/, { message: "name is required" })),
            description: str(1000),
            author: str(80),
            pageChangeIds: Schema.Array(str(100)).check(Schema.isMaxLength(200)),
            theme: Schema.Boolean,
            extensions: Schema.Array(Schema.Struct({ id: str(32), name: str(80) })).check(Schema.isMaxLength(20)),
          }),
        );
        return json(yield* (yield* Mods).package(input));
      }).pipe(Effect.catchTag("ModError", modError)),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/mods/:id",
    handle(
      Effect.gen(function* () {
        const { enabled } = yield* decodeBody(Schema.Struct({ enabled: Schema.Boolean }));
        return json(yield* (yield* Mods).setEnabled(yield* param("id"), enabled));
      }).pipe(Effect.catchTag("ModError", modError)),
    ),
  ),
  // Returns the removed mod: the renderer removes the extensions it installed.
  HttpRouter.route(
    "DELETE",
    "/api/mods/:id",
    handle(
      Effect.gen(function* () {
        return json(yield* (yield* Mods).remove(yield* param("id")));
      }).pipe(Effect.catchTag("ModError", modError)),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/mods/:id/extensions",
    handle(
      Effect.gen(function* () {
        const { installed } = yield* decodeBody(
          Schema.Struct({ installed: Schema.Array(str(32)).check(Schema.isMaxLength(20)) }),
        );
        return json(yield* (yield* Mods).recordExtensions(yield* param("id"), installed));
      }).pipe(Effect.catchTag("ModError", modError)),
    ),
  ),
]);

// --- Schedules -----------------------------------------------------------------------------

export const ScheduleBody = Schema.Struct({
  name: str(100),
  trigger: Schema.Union([
    Schema.Struct({ type: Schema.Literal("once"), at: str(40) }),
    Schema.Struct({ type: Schema.Literal("cron"), cron: str(100) }),
    Schema.Struct({ type: Schema.Literal("event"), event: str(200) }),
  ]),
  prompt: str(20_000),
  target: Schema.Struct({
    workspaceId: str(100),
    tabId: Schema.NullOr(str(64)),
    url: Schema.NullOr(str(8000)),
  }),
  agent: Schema.NullOr(
    Schema.Struct({
      provider: Schema.Literals(providerIds),
      model: Schema.NullOr(str(200)),
      effort: Schema.NullOr(str(40)),
    }),
  ),
  notify: Schema.Literals(["always", "failure", "never"]),
  timeoutSec: Schema.Finite,
});

const scheduleFail = <A, R>(effect: Effect.Effect<A, ScheduleError, R>) =>
  effect.pipe(Effect.catchTag("ScheduleError", (e) => fail(e.status, e.message)));

const scheduleRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/schedules",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(
        yield* (yield* Scheduler).list({
          workspaceId: params.get("workspace") ?? undefined,
        }),
      );
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/schedules/runs",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(
        yield* (yield* Scheduler).runs({
          scheduleId: params.get("schedule") ?? undefined,
          workspaceId: params.get("workspace") ?? undefined,
          before: Number(params.get("before")) || undefined,
          limit: Number(params.get("limit")) || undefined,
        }),
      );
    }),
  ),
  HttpRouter.route(
    "GET",
    "/api/schedules/upcoming",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(
        yield* (yield* Scheduler).upcoming({
          workspaceId: params.get("workspace") ?? undefined,
          limit: Number(params.get("limit")) || undefined,
        }),
      );
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/schedules",
    handle(
      Effect.gen(function* () {
        const spec = yield* decodeBody(ScheduleBody);
        const schedule = yield* scheduleFail((yield* Scheduler).create(spec));
        yield* youDid(spec.target.tabId ?? `workspace:${spec.target.workspaceId}`, "schedule.create", schedule.name);
        return json(schedule);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/schedules/:id",
    handle(
      Effect.gen(function* () {
        const { spec, paused } = yield* decodeBody(
          Schema.Struct({ spec: Schema.optionalKey(ScheduleBody), paused: Schema.optionalKey(Schema.Boolean) }),
        );
        return json(yield* scheduleFail((yield* Scheduler).update(yield* param("id"), { spec, paused })));
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/schedules/:id",
    handle(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const schedule = yield* scheduler.get(yield* param("id"));
        if (!schedule) return yield* fail(404, "Not found");
        yield* scheduler.remove(schedule.id);
        yield* youDid(schedule.target.tabId ?? `workspace:${schedule.workspaceId}`, "schedule.delete", schedule.name);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/schedules/:id/run",
    handle(
      Effect.gen(function* () {
        return json(yield* scheduleFail((yield* Scheduler).runNow(yield* param("id"))));
      }),
    ),
  ),
]);

// --- History -------------------------------------------------------------------------------

const historyTarget = Schema.Literals(["sites", "settings"]);

const historyFail = <A, R>(effect: Effect.Effect<A, HistoryError, R>) =>
  effect.pipe(Effect.catchTag("HistoryError", (e) => fail(e.status, e.message)));

const historyRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/history",
    Effect.gen(function* () {
      const history = yield* History;
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(
        yield* history.list({
          target: params.get("target") ?? undefined,
          before: params.get("before") ? Number(params.get("before")) : undefined,
          limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        }),
      );
    }),
  ),
  // A snapshot right now (e.g. before trying something by hand).
  HttpRouter.route(
    "POST",
    "/api/history",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const { target } = yield* decodeBody(Schema.Struct({ target: historyTarget }));
        const entry = yield* history.record(target, { actor: "user", actorLabel: "You", summary: "Saved a snapshot" });
        return entry ? json(entry, 201) : noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/history/:id",
    handle(
      Effect.gen(function* () {
        return json(yield* historyFail((yield* History).detail(Number(yield* param("id")))));
      }),
    ),
  ),
  // Everything back to one moment: settings and site customizations.
  HttpRouter.route(
    "POST",
    "/api/history/:id/restore-all",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const entry = yield* historyFail(history.entry(Number(yield* param("id"))));
        const result = yield* historyFail(history.restoreAll(entry.id));
        yield* youDid(
          null,
          "history.restoreAll",
          entry.at,
          `${result.restored.length} restored: ${result.restored.join(", ")}`,
        );
        return json(result);
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/history/:id/restore",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const entry = yield* historyFail(history.entry(Number(yield* param("id"))));
        yield* historyFail(history.restore(entry.id));
        yield* youDid(null, "history.restore", entry.summary, `${entry.target} · ${entry.at}`);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/history/:id/undo",
    handle(
      Effect.gen(function* () {
        const history = yield* History;
        const entry = yield* historyFail(history.entry(Number(yield* param("id"))));
        const result = yield* historyFail(history.undo(entry.id));
        yield* youDid(null, "history.undo", entry.summary, entry.target);
        return json(result);
      }),
    ),
  ),
]);

// --- Workspaces ----------------------------------------------------------------------------

const publishWorkspace = (id: string) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const hub = yield* Hub;
    const space = yield* workspaces.get(id);
    if (space) yield* hub.publish({ type: "workspace", topic: topics.workspaces, workspace: space });
    return space;
  });

const workspaceName = str(80).check(Schema.isPattern(/\S/, { message: "name is required" }));

const workspaceRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/workspaces",
    Effect.gen(function* () {
      const workspaces = yield* Workspaces;
      return json(yield* workspaces.list());
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/workspaces",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(
          Schema.Struct({ name: workspaceName, icon: Schema.optionalKey(Schema.NullOr(str(80))) }),
        );
        const created = yield* workspaces.create(input.name.trim(), input.icon ?? null);
        yield* publishWorkspace(created.id);
        yield* snapshot("settings", `Created the workspace ${created.name}`);
        return json(created, 201);
      }),
    ),
  ),
  // The order of the workspace icons at the bottom of the sidebar.
  HttpRouter.route(
    "PUT",
    "/api/workspaces/order",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const { ids } = yield* decodeBody(
          Schema.Struct({ ids: Schema.Array(str(100)).check(Schema.isMaxLength(500)) }),
        );
        yield* workspaces.reorder(ids);
        yield* snapshot("settings", "Reordered the workspaces", true);
        return json(yield* workspaces.list());
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/workspaces/:id",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const input = yield* decodeBody(
          Schema.Struct({
            name: Schema.optionalKey(workspaceName),
            icon: Schema.optionalKey(Schema.NullOr(str(80))),
            settings: Schema.optionalKey(WorkspaceSettings),
          }),
        );
        const id = yield* param("id");
        const updated = yield* workspaces.update(id, { ...input, name: input.name?.trim() });
        if (!updated) return yield* fail(404, "Not found");
        yield* snapshot("settings", `Changed the workspace ${updated.name}`, true);
        return json(yield* publishWorkspace(id));
      }),
    ),
  ),
  // Its split views (tabs side by side). Saved as given, made consistent with its tabs.
  HttpRouter.route(
    "PUT",
    "/api/workspaces/:id/splits",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const id = yield* param("id");
        const { splits } = yield* decodeBody(
          Schema.Struct({
            splits: Schema.Array(
              Schema.Struct({
                id: str(100),
                direction: Schema.Literals(["row", "column"]),
                tabs: Schema.Array(str(100)),
                sizes: Schema.Array(Schema.Number),
              }),
            ).check(Schema.isMaxLength(100)),
          }),
        );
        const updated = yield* workspaces.setSplits(
          id,
          splits.map((s) => ({ ...s, tabs: [...s.tabs], sizes: [...s.sizes] })),
        );
        if (!updated) return yield* fail(404, "Not found");
        return json(yield* publishWorkspace(id));
      }),
    ),
  ),
  // The order of its tabs in the sidebar. Tabs left out (made meanwhile) go after the others.
  HttpRouter.route(
    "PUT",
    "/api/workspaces/:id/order",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const apps = yield* Apps;
        const id = yield* param("id");
        const { ids } = yield* decodeBody(Schema.Struct({ ids: Schema.Array(str(100)) }));
        const current = yield* workspaces.appIds(id);
        if (!(yield* workspaces.get(id))) return yield* fail(404, "Not found");
        const known = new Set(current);
        const listed = [...new Set(ids)].filter((x) => known.has(x));
        const order = [...listed, ...current.filter((x) => !listed.includes(x))];
        const tabs = yield* apps.reorder(id, order);
        for (const tab of tabs) yield* publishApp(tab);
        return json(tabs);
      }),
    ),
  ),
  // Deletes the workspace with its tabs (and their chats), its permissions and its browsing data.
  HttpRouter.route(
    "DELETE",
    "/api/workspaces/:id",
    handle(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const permissions = yield* Permissions;
        const hub = yield* Hub;
        const id = yield* param("id");
        const space = yield* workspaces.get(id);
        if (!space) return yield* fail(404, "Not found");
        if ((yield* workspaces.count()) <= 1) return yield* fail(400, "The last workspace can't be deleted");
        const appIds = yield* workspaces.appIds(id);
        yield* (yield* Scheduler).forgetWorkspace(id, appIds);
        for (const appId of appIds) yield* removeApp(appId);
        yield* permissions.forget(workspaceScope(id));
        yield* (yield* Network).removeWorkspace(id);
        yield* (yield* ResponseOverrides).removeWorkspace(id);
        yield* (yield* Endpoints).remove(id);
        yield* (yield* Visits).clear(id, null);
        yield* workspaces.remove(id);
        yield* youDid(null, "workspace.delete", space.name);
        yield* snapshot("settings", `Deleted the workspace ${space.name}`);
        yield* hub.publish({ type: "workspace-deleted", topic: topics.workspaces, workspaceId: id });
        return noContent;
      }),
    ),
  ),
]);

// --- Permissions and the audit log ----------------------------------------------------------

/**
 * An audit entry for something the user did in the UI. `where`: a tab id, a
 * permission subject ("workspace:<id>", "website-agent"), or null.
 */
const youDid = (where: string | null, action: string, target: string | null, detail: string | null = null) =>
  Effect.gen(function* () {
    const audit = yield* Audit;
    const workspaceId = where ? workspaceOfScope(where) : null;
    const tabId = where && !workspaceId && where !== WEBSITE_AGENT ? where : null;
    yield* audit.record({ actor: "user", actorLabel: "You", tabId, workspaceId, action, target, detail });
  });

const permissionRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/permissions",
    Effect.gen(function* () {
      const permissions = yield* Permissions;
      return json(yield* permissions.list);
    }),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/permissions/:id",
    handle(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        const id = Number(yield* param("id"));
        const revoked = yield* permissions.revoke(id);
        if (!revoked) return yield* fail(404, "Not found");
        yield* youDid(
          revoked.subject,
          "permission.revoke",
          `${revoked.action}${revoked.resource ? ` ${revoked.resource}` : ""}`,
          revoked.subjectName,
        );
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/permissions/pending",
    Effect.gen(function* () {
      const permissions = yield* Permissions;
      return json(yield* permissions.pending);
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/permissions/pending/:id",
    handle(
      Effect.gen(function* () {
        const permissions = yield* Permissions;
        // remember: true (this tab or agent) or "workspace" (every tab in its workspace).
        const { allow, remember } = yield* decodeBody(
          Schema.Struct({
            allow: Schema.Boolean,
            remember: Schema.Union([Schema.Boolean, Schema.Literal("workspace")]),
          }),
        );
        const scope = remember === "workspace" ? "workspace" : remember ? "subject" : false;
        if (!(yield* permissions.answer(yield* param("id"), allow, scope)))
          return yield* fail(404, "The request is no longer waiting");
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/audit",
    Effect.gen(function* () {
      const audit = yield* Audit;
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      const actor = params.get("actor");
      return json(
        yield* audit.list({
          tabId: params.get("tab") ?? undefined,
          workspaceId: params.get("workspace") ?? undefined,
          actor: actor === "user" || actor === "agent" || actor === "rune" ? actor : undefined,
          before: params.get("before") ? Number(params.get("before")) : undefined,
          limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        }),
      );
    }),
  ),
]);

// --- Network: rules for web tabs' requests, saved requests ------------------------------------

const headerValue = str(8000).check(
  Schema.isPattern(/^[^\r\n]*$/, { message: "header values can't contain line breaks" }),
);
const HeaderChanges = Schema.Record(Schema.String, Schema.NullOr(headerValue));
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Record keys aren't checked by the schema: header names are, here. */
const checkHeaderNames = (...records: (Record<string, unknown> | undefined)[]) =>
  Effect.gen(function* () {
    for (const record of records) {
      const keys = Object.keys(record ?? {});
      if (keys.length > 50) return yield* fail(400, "Too many headers");
      const bad = keys.find((k) => !HEADER_NAME.test(k));
      if (bad !== undefined) return yield* fail(400, `Invalid header name: ${bad.slice(0, 100)}`);
    }
  });
const RuleFields = Schema.Struct({
  workspaceId: Schema.NullOr(str(100)),
  pattern: str(500).check(Schema.isPattern(/\S/, { message: "pattern is required" })),
  action: Schema.Literals(["block", "modify"]),
  requestHeaders: Schema.optionalKey(HeaderChanges),
  responseHeaders: Schema.optionalKey(HeaderChanges),
  enabled: Schema.optionalKey(Schema.Boolean),
});
const Draft = Schema.Struct({
  method: Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,16}$/, { message: "invalid method" })),
  url: str(8000).check(Schema.isPattern(/^https?:\/\//i, { message: "only http(s) URLs" })),
  headers: Schema.Record(Schema.String, headerValue),
  body: Schema.NullOr(str(200_000)),
  sealed: Schema.NullOr(str(400_000)),
});
const Overrides = Schema.Struct({
  url: Schema.optionalKey(str(8000).check(Schema.isPattern(/^https?:\/\//i, { message: "only http(s) URLs" }))),
  method: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,16}$/, { message: "invalid method" }))),
  headers: Schema.optionalKey(HeaderChanges),
  body: Schema.optionalKey(Schema.NullOr(str(200_000))),
});

const publishNetwork = (what: "rules" | "requests" | "overrides") =>
  Effect.gen(function* () {
    const hub = yield* Hub;
    yield* hub.publish({ type: "network-changed", topic: topics.network, what });
  });

const ruleLabel = (rule: NetworkRule) => `${rule.action === "block" ? "Block" : "Change"} ${rule.pattern}`;

const ensureWorkspace = (id: string | null) =>
  Effect.gen(function* () {
    if (id !== null && !(yield* (yield* Workspaces).get(id))) return yield* fail(404, "No such workspace");
  });

/** Sends a saved request with its workspace's session (in Electron's main process, through the Rune Browser window). */
export const sendSaved = (id: string, overrides: ReplayOverrides) =>
  Effect.gen(function* () {
    const network = yield* Network;
    const hub = yield* Hub;
    const saved = yield* network.draftOf(id);
    if (!saved) return yield* fail(404, "Not found");
    const result = yield* hub
      .rpc<ReplayResult>(
        "network.replay",
        { workspaceId: saved.request.workspaceId, draft: saved.draft, overrides },
        45_000,
      )
      .pipe(Effect.mapError((err) => new HttpFail({ status: 502, message: err.message })));
    return { request: saved.request, result };
  });

// --- Response overrides (db/ResponseOverrides.ts, applied by main/overrides.ts) ----------------
// The website agent makes them (agent/networkTools.ts); the user sees and removes them.

const overrideLabel = (o: { title: string; pattern: string }) =>
  o.title === o.pattern ? o.pattern : `${o.title} (${o.pattern})`;

const overrideRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/response-overrides",
    Effect.gen(function* () {
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://x").searchParams;
      return json(yield* (yield* ResponseOverrides).list(params.get("workspace") ?? undefined));
    }),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/response-overrides/:id",
    handle(
      Effect.gen(function* () {
        const overrides = yield* ResponseOverrides;
        const current = yield* overrides.get(yield* param("id"));
        if (!current) return yield* fail(404, "Not found");
        yield* overrides.remove(current.id);
        yield* youDid(workspaceScope(current.workspaceId), "network.override.delete", overrideLabel(current));
        yield* publishNetwork("overrides");
        return noContent;
      }),
    ),
  ),
]);

const networkRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/network/rules",
    Effect.gen(function* () {
      const network = yield* Network;
      return json(yield* network.rules());
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/network/rules",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const fields = yield* decodeBody(RuleFields);
        yield* checkHeaderNames(fields.requestHeaders, fields.responseHeaders);
        yield* ensureWorkspace(fields.workspaceId);
        if ((yield* network.countRules()) >= 500) return yield* fail(400, "Too many rules");
        const rule = yield* network.addRule({
          workspaceId: fields.workspaceId,
          pattern: fields.pattern.trim(),
          action: fields.action,
          requestHeaders: fields.requestHeaders ?? {},
          responseHeaders: fields.responseHeaders ?? {},
          enabled: fields.enabled ?? true,
        });
        yield* youDid(
          rule.workspaceId ? workspaceScope(rule.workspaceId) : null,
          "network.rule.create",
          ruleLabel(rule),
        );
        yield* publishNetwork("rules");
        return json(rule, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "PATCH",
    "/api/network/rules/:id",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const fields = yield* decodeBody(
          Schema.Struct({
            ...RuleFields.fields,
            workspaceId: Schema.optionalKey(Schema.NullOr(str(100))),
            pattern: Schema.optionalKey(RuleFields.fields.pattern),
            action: Schema.optionalKey(RuleFields.fields.action),
          }),
        );
        yield* checkHeaderNames(fields.requestHeaders, fields.responseHeaders);
        if (fields.workspaceId !== undefined) yield* ensureWorkspace(fields.workspaceId);
        const rule = yield* network.updateRule(yield* param("id"), {
          ...fields,
          ...(fields.pattern ? { pattern: fields.pattern.trim() } : {}),
        });
        if (!rule) return yield* fail(404, "Not found");
        yield* youDid(
          rule.workspaceId ? workspaceScope(rule.workspaceId) : null,
          "network.rule.update",
          ruleLabel(rule),
          rule.enabled ? "on" : "off",
        );
        yield* publishNetwork("rules");
        return json(rule);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/network/rules/:id",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const rule = yield* network.getRule(yield* param("id"));
        if (!rule) return yield* fail(404, "Not found");
        yield* network.removeRule(rule.id);
        yield* youDid(
          rule.workspaceId ? workspaceScope(rule.workspaceId) : null,
          "network.rule.delete",
          ruleLabel(rule),
        );
        yield* publishNetwork("rules");
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/network/requests",
    Effect.gen(function* () {
      const network = yield* Network;
      const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
      return json(yield* network.saved(params.get("workspace") ?? undefined));
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/network/requests",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const { workspaceId, name, draft } = yield* decodeBody(
          Schema.Struct({
            workspaceId: str(100),
            name: str(120).check(Schema.isPattern(/\S/, { message: "name is required" })),
            draft: Draft,
          }),
        );
        yield* checkHeaderNames(draft.headers);
        yield* ensureWorkspace(workspaceId);
        const saved = yield* network.save(workspaceId, name.trim(), { ...draft, method: draft.method.toUpperCase() });
        yield* youDid(workspaceScope(workspaceId), "network.request.save", saved.name, `${saved.method} ${saved.url}`);
        yield* publishNetwork("requests");
        return json(saved, 201);
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/network/requests/:id",
    handle(
      Effect.gen(function* () {
        const network = yield* Network;
        const saved = yield* network.getSaved(yield* param("id"));
        if (!saved) return yield* fail(404, "Not found");
        yield* network.removeSaved(saved.id);
        yield* youDid(workspaceScope(saved.workspaceId), "network.request.delete", saved.name);
        yield* publishNetwork("requests");
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "POST",
    "/api/network/requests/:id/send",
    handle(
      Effect.gen(function* () {
        const overrides = yield* decodeBody(Schema.Struct({ overrides: Schema.optionalKey(Overrides) }));
        yield* checkHeaderNames(overrides.overrides?.headers);
        const { request, result } = yield* sendSaved(yield* param("id"), overrides.overrides ?? {});
        yield* youDid(
          workspaceScope(request.workspaceId),
          "network.request.send",
          request.name,
          `HTTP ${result.status}`,
        );
        return json(result);
      }),
    ),
  ),
]);

// --- Browsing history ----------------------------------------------------------------

const publishVisits = (workspaceId: string | null) =>
  Effect.gen(function* () {
    yield* (yield* Hub).publish({ type: "visits-changed", topic: topics.visits, workspaceId });
  });

/** A tab went somewhere (`tab` as it was before): history records it (shared/visits.ts), unless it's private. */
const visited = (
  tab: { id: string; workspaceId: string; url: string | null; private: boolean },
  page: { url?: string; title?: string; favicon?: string | null },
) =>
  Effect.gen(function* () {
    if (tab.private) return;
    if (yield* (yield* Visits).record(tab, page)) yield* publishVisits(tab.workspaceId);
  });

/** `?workspace=`: one workspace's history; without it, every workspace's. */
const optionalWorkspace = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const id = new URL(req.url, "http://localhost").searchParams.get("workspace");
  if (id) yield* ensureWorkspace(id);
  return id || null;
});

const visitRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/visits",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* optionalWorkspace;
        const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
        const before = Number(params.get("before")) || undefined;
        const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 5000);
        const search = (params.get("search") ?? "").slice(0, 200);
        const time = (name: string) => {
          const value = params.get(name);
          return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
        };
        const url = params.get("url")?.slice(0, 8000) || undefined;
        return json(
          yield* (yield* Visits).list({
            workspaceId,
            search,
            before,
            since: time("since"),
            until: time("until"),
            url,
            limit,
          }),
        );
      }),
    ),
  ),
  // The address bar's suggestions from a workspace's history.
  HttpRouter.route(
    "GET",
    "/api/visits/suggest",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* workspaceParam;
        const params = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams;
        const query = (params.get("q") ?? "").trim().slice(0, 200);
        const limit = Math.min(Math.max(Number(params.get("limit")) || 5, 1), 20);
        // Nothing typed yet: the pages visited most often and lately (the address bar shows them when it opens).
        return json(yield* (yield* Visits).suggest(workspaceId, query, limit));
      }),
    ),
  ),
  // A visit added by an extension (chrome.history.addUrl).
  HttpRouter.route(
    "POST",
    "/api/visits/add",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* workspaceParam;
        const { url, title } = yield* decodeBody(Schema.Struct({ url: str(8000), title: Schema.optional(str(1000)) }));
        if (!isRecordable(url)) return yield* fail(400, "Only web pages and files can be in the history");
        const added = yield* (yield* Visits).add(workspaceId, url, title ?? "");
        if (added) yield* publishVisits(workspaceId);
        return json({ added });
      }),
    ),
  ),
  // Deletes every visit to a page (chrome.history.deleteUrl).
  HttpRouter.route(
    "POST",
    "/api/visits/delete-url",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* optionalWorkspace;
        const { url } = yield* decodeBody(Schema.Struct({ url: str(8000) }));
        const removed = yield* (yield* Visits).removeUrl(url, workspaceId);
        if (removed) {
          yield* youDid(workspaceId && workspaceScope(workspaceId), "history.delete", `${removed} visits`);
          yield* publishVisits(workspaceId);
        }
        return json({ removed });
      }),
    ),
  ),
  // Deletes single visits by id.
  HttpRouter.route(
    "POST",
    "/api/visits/delete",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* optionalWorkspace;
        const { ids } = yield* decodeBody(
          Schema.Struct({ ids: Schema.Array(Schema.Int).check(Schema.isMaxLength(1000)) }),
        );
        const removed = yield* (yield* Visits).remove(ids, workspaceId);
        if (removed) {
          yield* youDid(workspaceId && workspaceScope(workspaceId), "history.delete", `${removed} visits`);
          yield* publishVisits(workspaceId);
        }
        return json({ removed });
      }),
    ),
  ),
  // The sites visited since a time (Clear browsing data clears their cookies and cache for a time range).
  HttpRouter.route(
    "GET",
    "/api/visits/origins",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* optionalWorkspace;
        const since = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://localhost").searchParams.get(
          "since",
        );
        if (!since || Number.isNaN(Date.parse(since))) return yield* fail(400, "since must be a time");
        return json(yield* (yield* Visits).origins(workspaceId, new Date(since).toISOString()));
      }),
    ),
  ),
  // Clears the history since a time (everything without one): the workspace's, or every workspace's.
  HttpRouter.route(
    "POST",
    "/api/visits/clear",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* optionalWorkspace;
        const { since, until } = yield* decodeBody(
          Schema.Struct({ since: Schema.NullOr(str(40)), until: Schema.optional(Schema.NullOr(str(40))) }),
        );
        if (since !== null && Number.isNaN(Date.parse(since))) return yield* fail(400, "since must be a time");
        if (until && Number.isNaN(Date.parse(until))) return yield* fail(400, "until must be a time");
        const from = since === null ? null : new Date(since).toISOString();
        const to = until ? new Date(until).toISOString() : null;
        const removed = yield* (yield* Visits).clear(workspaceId, from, to);
        yield* youDid(
          workspaceId && workspaceScope(workspaceId),
          "history.clear",
          from ? `since ${from}` : "all time",
          `${removed} visits`,
        );
        yield* publishVisits(workspaceId);
        return json({ removed });
      }),
    ),
  ),
]);

// --- The API endpoint map -----------------------------------------------------------

/** Whether the map leaves a host out (Settings: a site turned off covers its subdomains). */
const mapsHost = (off: readonly string[], host: string) => {
  const name = host.split(":")[0]!.toLowerCase();
  return !off.some((site) => name === site || name.endsWith(`.${site}`));
};

/** An observation from the main process, checked loosely: shapes are bounded in size, never values. */
const ObservationInput = Schema.Struct({
  host: str(260),
  site: str(260),
  method: str(16),
  path: str(2000),
  operation: Schema.NullOr(str(100)),
  query: Schema.Record(Schema.String, Schema.Unknown),
  headers: Schema.Record(Schema.String, Schema.Unknown),
  requestType: Schema.NullOr(str(200)),
  requestBody: Schema.Unknown,
  status: Schema.NullOr(Schema.Number),
  responseType: Schema.NullOr(str(200)),
  responseBody: Schema.Unknown,
});

const workspaceParam = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const id = new URL(req.url, "http://localhost").searchParams.get("workspace");
  if (!id) return yield* fail(400, "Missing workspace");
  yield* ensureWorkspace(id);
  return id;
});

const endpointRoutes = HttpRouter.addAll([
  // What web tabs saw (from Electron's main process, which turns requests into shapes).
  HttpRouter.route(
    "POST",
    "/api/endpoints/observe",
    handle(
      Effect.gen(function* () {
        const input = yield* decodeBody(
          Schema.Struct({
            workspaceId: str(100),
            observations: Schema.Array(ObservationInput).check(Schema.isMaxLength(200)),
          }),
        );
        const web = (yield* (yield* Settings).get()).web;
        if (!web.apiMap || !(yield* (yield* Workspaces).get(input.workspaceId))) return noContent;
        const kept = (input.observations as unknown as Observation[]).filter(
          (o) =>
            mapsHost(web.apiMapOff, o.host) && mapsHost(web.apiMapOff, o.site) && JSON.stringify(o).length < 256 * 1024,
        );
        if (kept.length) yield* (yield* Endpoints).record(input.workspaceId, kept);
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/endpoints",
    handle(
      Effect.gen(function* () {
        return json(yield* (yield* Endpoints).hosts(yield* workspaceParam));
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/endpoints/hosts/:host",
    handle(
      Effect.gen(function* () {
        return json(
          yield* (yield* Endpoints).endpoints(yield* workspaceParam, decodeURIComponent(yield* param("host"))),
        );
      }),
    ),
  ),
  HttpRouter.route(
    "DELETE",
    "/api/endpoints/hosts/:host",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* workspaceParam;
        const host = decodeURIComponent(yield* param("host"));
        yield* (yield* Endpoints).remove(workspaceId, host);
        yield* youDid(workspaceScope(workspaceId), "endpoints.delete", host);
        return noContent;
      }),
    ),
  ),
  // A site's part of the map: its own host's endpoints and what its pages called.
  HttpRouter.route(
    "DELETE",
    "/api/endpoints/sites/:site",
    handle(
      Effect.gen(function* () {
        const workspaceId = yield* workspaceParam;
        const site = decodeURIComponent(yield* param("site"));
        yield* (yield* Endpoints).removeSite(workspaceId, site);
        yield* youDid(workspaceScope(workspaceId), "endpoints.delete", site);
        return noContent;
      }),
    ),
  ),
]);

// --- Bookmarks (bookmarks/Bookmarks.ts) ----------------------------------------------------------

const bookmarkError = (e: BookmarkError) => fail(e.status, e.message);

const BookmarkIndex = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const bookmarkRoutes = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/bookmarks",
    Effect.gen(function* () {
      return json(yield* (yield* Bookmarks).tree);
    }),
  ),
  HttpRouter.route(
    "POST",
    "/api/bookmarks",
    handle(
      Effect.gen(function* () {
        const input = yield* decodeBody(
          Schema.Struct({
            parentId: Schema.optionalKey(str(40)),
            index: Schema.optionalKey(BookmarkIndex),
            title: Schema.optionalKey(str(10_000)),
            url: Schema.optionalKey(str(10_000)),
          }),
        );
        return json(yield* (yield* Bookmarks).create(input).pipe(Effect.catchTag("BookmarkError", bookmarkError)));
      }),
    ),
  ),
  // A new title or address, and/or a new place (chrome.bookmarks.update and move).
  HttpRouter.route(
    "PATCH",
    "/api/bookmarks/:id",
    handle(
      Effect.gen(function* () {
        const id = yield* param("id");
        const input = yield* decodeBody(
          Schema.Struct({
            title: Schema.optionalKey(str(10_000)),
            url: Schema.optionalKey(str(10_000)),
            parentId: Schema.optionalKey(str(40)),
            index: Schema.optionalKey(BookmarkIndex),
          }),
        );
        return json(yield* (yield* Bookmarks).edit(id, input).pipe(Effect.catchTag("BookmarkError", bookmarkError)));
      }),
    ),
  ),
  // A page or an empty folder; ?recursive=1 for a folder with everything in it.
  HttpRouter.route(
    "DELETE",
    "/api/bookmarks/:id",
    handle(
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const recursive = new URL(req.url, "http://localhost").searchParams.get("recursive") === "1";
        yield* (yield* Bookmarks)
          .remove(yield* param("id"), recursive)
          .pipe(Effect.catchTag("BookmarkError", bookmarkError));
        return noContent;
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/bookmarks/export",
    Effect.gen(function* () {
      return HttpServerResponse.text(yield* (yield* Bookmarks).html, {
        contentType: "text/html; charset=utf-8",
        headers: { "Content-Disposition": 'attachment; filename="bookmarks.html"' },
      });
    }),
  ),
  // Other browsers' profiles with bookmarks, to import from.
  HttpRouter.route(
    "GET",
    "/api/bookmarks/sources",
    Effect.sync(() => json(bookmarkSources().map((f) => f.source))),
  ),
  // From a browser profile (its id from /sources), or an exported HTML file.
  HttpRouter.route(
    "POST",
    "/api/bookmarks/import",
    handle(
      Effect.gen(function* () {
        const input = yield* decodeBody(
          Schema.Struct({ source: Schema.optionalKey(str(40)), html: Schema.optionalKey(str(50_000_000)) }),
        );
        const bookmarks = yield* Bookmarks;
        if (input.html !== undefined) {
          const data = parseBookmarksHtml(input.html);
          if (!data.bar.length && !data.other.length) return yield* fail(400, "There are no bookmarks in that file.");
          return json(
            yield* bookmarks.importBookmarks("a file", data).pipe(Effect.catchTag("BookmarkError", bookmarkError)),
          );
        }
        const found = bookmarkSources().find((f) => f.source.id === input.source);
        if (!found) return yield* fail(404, "That browser profile isn't there anymore.");
        const data = yield* Effect.try({
          try: () => found.read(),
          catch: (e) => new HttpFail({ status: 400, message: `Reading its bookmarks failed: ${e}` }),
        });
        return json(
          yield* bookmarks
            .importBookmarks(found.source.browser, data)
            .pipe(Effect.catchTag("BookmarkError", bookmarkError)),
        );
      }),
    ),
  ),
]);

export const routes = Layer.mergeAll(
  health,
  ws,
  mcp,
  providerRoutes,
  settingsRoutes,
  sourceRoutes,
  attachmentRoutes,
  appRoutes,
  windowRoutes,
  workspaceRoutes,
  historyRoutes,
  siteRoutes,
  pageChangeRoutes,
  modRoutes,
  scheduleRoutes,
  permissionRoutes,
  networkRoutes,
  overrideRoutes,
  endpointRoutes,
  visitRoutes,
  bookmarkRoutes,
  guard,
);

export const cors = (allowedOrigin: string) =>
  HttpRouter.cors({
    allowedOrigins: [allowedOrigin],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Disposition"],
    maxAge: 600,
  });
