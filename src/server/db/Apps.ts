// Tabs (apps and web tabs) and their chat history.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { AgentChoice, AppMode, AppSummary, ChatMessage, ChatSummary, ProviderId, TabKind } from "../../shared/api";
import { hostOf } from "../../shared/web";
import { now, orDieAll, type OrDie } from "./Db";

interface AppRow {
  id: string;
  workspace_id: string;
  kind: TabKind;
  name: string;
  name_locked: number;
  icon: string | null;
  icon_locked: number;
  pinned: number;
  url: string | null;
  favicon: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  session_provider: string | null;
  mode: string;
  position: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  chat_folder: string | null;
}

export interface AppRecord extends AppSummary {
  nameLocked: boolean;
  agent: AgentChoice | null;
  /** The provider session to resume, if it belongs to that provider. */
  session: { provider: ProviderId; id: string } | null;
  mode: AppMode;
}

const toSummary = (r: AppRow): AppSummary => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind,
  name: r.name,
  icon: r.icon,
  url: r.url,
  favicon: r.favicon,
  pinned: r.pinned === 1,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.closed_at ? { closedAt: r.closed_at } : {}),
});

const toRecord = (r: AppRow): AppRecord => ({
  ...toSummary(r),
  nameLocked: r.name_locked === 1,
  agent: r.provider ? { provider: r.provider as ProviderId, model: r.model, effort: r.effort } : null,
  session: r.session_id && r.session_provider ? { provider: r.session_provider as ProviderId, id: r.session_id } : null,
  mode: r.mode === "live" ? "live" : "dev",
});

interface MessageRow {
  id: number;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
}

interface ChatRow {
  id: number;
  app_id: string;
  title: string;
  session_id: string | null;
  session_provider: string | null;
  folder: string | null;
  created_at: string;
  updated_at: string;
  count: number;
}

const toChat = (r: ChatRow): ChatSummary => ({
  id: r.id,
  title: r.title,
  messages: r.count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const row = (id: string) =>
    sql<AppRow>`SELECT * FROM apps WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0] ?? null));
  const touch = (id: string) => sql`UPDATE apps SET updated_at = ${sql.literal(now)} WHERE id = ${id}`;
  const summary = (id: string) => row(id).pipe(Effect.map((r) => (r ? toSummary(r) : null)));
  /** After the last tab of a workspace. */
  const lastPosition = (workspaceId: string) =>
    sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM apps WHERE workspace_id = ${workspaceId})`;

  /** Moves the current chat's messages into a new earlier chat, and forgets the provider session (it goes with them). */
  const archive = (appId: string) =>
    Effect.gen(function* () {
      const current =
        yield* sql<MessageRow>`SELECT * FROM messages WHERE app_id = ${appId} AND chat_id IS NULL ORDER BY id`;
      if (!current.length) return null;
      const app = (yield* row(appId))!;
      const first = current.find((m) => m.role === "user") ?? current[0]!;
      const title = first.content.replace(/\s+/g, " ").trim().slice(0, 80) || "Chat";
      const [chat] = yield* sql<{
        id: number;
      }>`INSERT INTO chats (app_id, title, session_id, session_provider, folder, created_at, updated_at)
        VALUES (${appId}, ${title}, ${app.session_id}, ${app.session_provider}, ${app.chat_folder}, ${current[0]!.created_at}, ${current.at(-1)!.created_at}) RETURNING id`;
      yield* sql`UPDATE messages SET chat_id = ${chat!.id} WHERE app_id = ${appId} AND chat_id IS NULL`;
      yield* sql`UPDATE apps SET session_id = NULL, session_provider = NULL, chat_folder = NULL, updated_at = ${sql.literal(now)} WHERE id = ${appId}`;
      return chat!.id;
    });

  const repo = {
    /** The open tabs. */
    list: () =>
      sql<AppRow>`SELECT * FROM apps WHERE closed_at IS NULL ORDER BY position, created_at, rowid`.pipe(
        Effect.map((rows) => rows.map(toSummary)),
      ),

    /** Closed app tabs, kept to be opened again: the most recently closed first. */
    closed: () =>
      sql<AppRow>`SELECT * FROM apps WHERE closed_at IS NOT NULL ORDER BY closed_at DESC`.pipe(
        Effect.map((rows) => rows.map(toSummary)),
      ),

    close: (id: string) =>
      sql`UPDATE apps SET closed_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(Effect.andThen(summary(id))),

    /** Opens a closed app again, last in a workspace. */
    reopen: (id: string, workspaceId: string) =>
      sql`UPDATE apps SET closed_at = NULL, workspace_id = ${workspaceId}, position = ${lastPosition(workspaceId)}, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    get: (id: string) => row(id).pipe(Effect.map((r) => (r ? toRecord(r) : null))),

    create: (workspaceId: string, kind: TabKind, url: string | null) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const name = kind === "web" ? hostOf(url) || "New tab" : "New app";
        yield* sql`INSERT INTO apps (id, workspace_id, kind, name, url, position)
          VALUES (${id}, ${workspaceId}, ${kind}, ${name}, ${url}, ${lastPosition(workspaceId)})`;
        return (yield* summary(id))!;
      }),

    /** Web tab navigation: remembers the URL, favicon and (unless renamed) the page title. */
    updateWebTab: (id: string, fields: { url?: string; title?: string; favicon?: string | null }) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r || r.kind !== "web") return null;
        const title = fields.title?.trim();
        yield* sql`UPDATE apps SET
          url = ${fields.url ?? r.url},
          favicon = ${fields.favicon !== undefined ? fields.favicon : r.favicon},
          name = ${title && !r.name_locked ? title.slice(0, 120) : r.name},
          updated_at = ${sql.literal(now)}
          WHERE id = ${id}`;
        return yield* summary(id);
      }),

    /** A rename by the user: page titles and the agent leave the name alone from now on. */
    rename: (id: string, name: string) =>
      sql`UPDATE apps SET name = ${name}, name_locked = 1, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    /** Name and icon chosen by the agent (not over the user's). */
    setInfo: (id: string, info: { name?: string; icon?: string | null }) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const name = info.name && !r.name_locked ? info.name.slice(0, 80) : r.name;
        const icon = info.icon !== undefined && !r.icon_locked ? info.icon : r.icon;
        yield* sql`UPDATE apps SET name = ${name}, icon = ${icon}, updated_at = ${sql.literal(now)} WHERE id = ${id}`;
        return yield* summary(id);
      }),

    /** An icon the user chose (the agent leaves it alone from now on), or null for the default again. */
    setIcon: (id: string, icon: string | null) =>
      sql`UPDATE apps SET icon = ${icon}, icon_locked = ${icon === null ? 0 : 1}, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    /** Kept loaded (the renderer doesn't unload it when it's idle). */
    setPinned: (id: string, pinned: boolean) =>
      sql`UPDATE apps SET pinned = ${pinned ? 1 : 0} WHERE id = ${id}`.pipe(Effect.andThen(summary(id))),

    setAgent: (id: string, agent: AgentChoice) =>
      sql`UPDATE apps SET provider = ${agent.provider}, model = ${agent.model}, effort = ${agent.effort} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),

    setSession: (id: string, session: { provider: ProviderId; id: string } | null) =>
      sql`UPDATE apps SET session_id = ${session?.id ?? null}, session_provider = ${session?.provider ?? null} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),

    /** Moves a tab to another workspace. */
    move: (id: string, workspaceId: string) =>
      sql
        .withTransaction(
          Effect.all([
            sql`UPDATE apps SET workspace_id = ${workspaceId}, position = ${lastPosition(workspaceId)}, updated_at = ${sql.literal(now)} WHERE id = ${id}`,
            // Its history goes along.
            sql`UPDATE snapshots SET workspace_id = ${workspaceId} WHERE tab_id = ${id}`,
          ]),
        )
        .pipe(Effect.andThen(summary(id))),

    /** Puts a workspace's tabs in this order (ids of other workspaces are ignored). */
    reorder: (workspaceId: string, ids: readonly string[]) =>
      sql
        .withTransaction(
          Effect.forEach(
            ids,
            (id, i) => sql`UPDATE apps SET position = ${i} WHERE id = ${id} AND workspace_id = ${workspaceId}`,
            { discard: true },
          ),
        )
        .pipe(
          Effect.andThen(
            sql<AppRow>`SELECT * FROM apps WHERE workspace_id = ${workspaceId} ORDER BY position, created_at, rowid`,
          ),
          Effect.map((rows) => rows.map(toSummary)),
        ),

    setMode: (id: string, mode: AppMode) => sql`UPDATE apps SET mode = ${mode} WHERE id = ${id}`.pipe(Effect.asVoid),

    /** When Rune Browser starts, apps left being edited are done: no agent is working on them anymore. */
    finishEditing: () => sql`UPDATE apps SET mode = 'live' WHERE kind = 'app' AND mode = 'dev'`.pipe(Effect.asVoid),

    touch: (id: string) => touch(id).pipe(Effect.asVoid),

    /** Copies a tab's name, icon, URL and agent settings (not its chat) to a new tab. */
    duplicate: (id: string) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const copyId = crypto.randomUUID();
        yield* sql`INSERT INTO apps (id, workspace_id, kind, name, icon, icon_locked, url, favicon, provider, model, effort, mode, position)
          VALUES (${copyId}, ${r.workspace_id}, ${r.kind}, ${`${r.name} copy`}, ${r.icon}, ${r.icon_locked}, ${r.url}, ${r.favicon}, ${r.provider}, ${r.model}, ${r.effort}, ${r.mode}, ${lastPosition(r.workspace_id)})`;
        return (yield* summary(copyId))!;
      }),

    remove: (id: string) => sql`DELETE FROM apps WHERE id = ${id}`.pipe(Effect.asVoid),

    /** The current chat. */
    messages: (appId: string) =>
      sql<MessageRow>`SELECT * FROM messages WHERE app_id = ${appId} AND chat_id IS NULL ORDER BY id`.pipe(
        Effect.map((rows) => rows.map(toMessage)),
      ),

    /** Earlier chats, newest first. */
    chats: (appId: string) =>
      sql<ChatRow>`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS count FROM chats c WHERE c.app_id = ${appId} ORDER BY c.updated_at DESC, c.id DESC`.pipe(
        Effect.map((rows) => rows.map(toChat)),
      ),

    chatMessages: (appId: string, chatId: number) =>
      sql<MessageRow>`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.app_id = ${appId} AND c.id = ${chatId} ORDER BY m.id`.pipe(
        Effect.map((rows) => rows.map(toMessage)),
      ),

    /** Keeps the current chat as an earlier one (with its provider session) and starts a new one. Nothing to keep: nothing happens. */
    newChat: (appId: string) => sql.withTransaction(archive(appId)).pipe(Effect.asVoid),

    /** Makes an earlier chat the current one again; the current one is kept as an earlier one. False if there's no such chat. */
    openChat: (appId: string, chatId: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const chat =
            (yield* sql<ChatRow>`SELECT *, 0 AS count FROM chats WHERE id = ${chatId} AND app_id = ${appId}`)[0];
          if (!chat) return false;
          yield* archive(appId);
          yield* sql`UPDATE messages SET chat_id = NULL WHERE chat_id = ${chatId}`;
          yield* sql`UPDATE apps SET session_id = ${chat.session_id}, session_provider = ${chat.session_provider}, chat_folder = ${chat.folder}, updated_at = ${sql.literal(now)} WHERE id = ${appId}`;
          yield* sql`DELETE FROM chats WHERE id = ${chatId}`;
          return true;
        }),
      ),

    /** Deletes an earlier chat; its folder of files (to delete too), or false if there's no such chat. */
    deleteChat: (appId: string, chatId: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const found = yield* sql<{
            folder: string | null;
          }>`SELECT folder FROM chats WHERE id = ${chatId} AND app_id = ${appId}`;
          if (!found.length) return false as const;
          yield* sql`DELETE FROM messages WHERE chat_id = ${chatId}`;
          yield* sql`DELETE FROM chats WHERE id = ${chatId}`;
          return { folder: found[0]!.folder };
        }),
      ),

    /** The current chat's folder of files (agent/ChatFiles.ts): made on first use. Null for an unknown tab. */
    chatFolder: (appId: string) =>
      Effect.gen(function* () {
        const r = yield* row(appId);
        if (!r) return null;
        if (r.chat_folder) return r.chat_folder;
        const folder = crypto.randomUUID();
        yield* sql`UPDATE apps SET chat_folder = ${folder} WHERE id = ${appId} AND chat_folder IS NULL`;
        return (yield* row(appId))?.chat_folder ?? folder;
      }),

    /** Every chat folder of a tab: the current chat's (if it has one) and the earlier chats'. */
    chatFolders: (appId: string) =>
      sql<{ folder: string }>`SELECT chat_folder AS folder FROM apps WHERE id = ${appId} AND chat_folder IS NOT NULL
        UNION SELECT folder FROM chats WHERE app_id = ${appId} AND folder IS NOT NULL`.pipe(
        Effect.map((rows) => rows.map((r) => r.folder)),
      ),

    addMessage: (appId: string, role: ChatMessage["role"], content: string) =>
      sql<MessageRow>`INSERT INTO messages (app_id, role, content) VALUES (${appId}, ${role}, ${content}) RETURNING *`.pipe(
        Effect.map((rows) => toMessage(rows[0]!)),
      ),

    /**
     * Deletes the current chat and forgets the agent session, so the next message starts fresh (earlier chats stay).
     * Returns the chat's folder of files, to delete too.
     */
    clearMessages: (appId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const folder = (yield* row(appId))?.chat_folder ?? null;
          yield* sql`DELETE FROM messages WHERE app_id = ${appId} AND chat_id IS NULL`;
          yield* sql`UPDATE apps SET session_id = NULL, session_provider = NULL, chat_folder = NULL, updated_at = ${sql.literal(now)} WHERE id = ${appId}`;
          return folder;
        }),
      ),
  };
  return repo;
});

export class Apps extends Context.Service<Apps, OrDie<Effect.Success<typeof make>>>()("rune/Apps") {}

export const layer = Layer.effect(Apps, Effect.map(make, orDieAll));
