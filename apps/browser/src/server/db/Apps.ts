// Tabs and their chat history. (The table is still called apps, from when tabs could be apps.)
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { AgentChoice, AppSummary, ChatMessage, ChatSummary, ProviderId } from "../../shared/api";
import { trimHistory, type TabHistory } from "../../shared/tabHistory";
import { hostOf } from "../../shared/web";
import { isPrivateWindow } from "../../shared/windows";
import { now, orDieAll, type OrDie } from "./Db";

interface AppRow {
  id: string;
  workspace_id: string;
  name: string;
  name_locked: number;
  icon: string | null;
  pinned: number;
  url: string | null;
  favicon: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  session_provider: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  chat_folder: string | null;
  window_id: string | null;
  history: string | null;
}

const parseHistory = (json: string | null): TabHistory | null => {
  if (!json) return null;
  try {
    return trimHistory(JSON.parse(json) as TabHistory);
  } catch {
    return null;
  }
};

export interface AppRecord extends AppSummary {
  nameLocked: boolean;
  agent: AgentChoice | null;
  /** The provider session to resume, if it belongs to that provider. */
  session: { provider: ProviderId; id: string } | null;
}

const toSummary = (r: AppRow): AppSummary => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  icon: r.icon,
  url: r.url,
  favicon: r.favicon,
  pinned: r.pinned === 1,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  windowId: r.window_id,
  private: isPrivateWindow(r.window_id),
});

const toRecord = (r: AppRow): AppRecord => ({
  ...toSummary(r),
  nameLocked: r.name_locked === 1,
  agent: r.provider ? { provider: r.provider as ProviderId, model: r.model, effort: r.effort } : null,
  session: r.session_id && r.session_provider ? { provider: r.session_provider as ProviderId, id: r.session_id } : null,
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

  /** Where tabs made without a window go (an agent's scheduled run): the first open window (POST /api/windows). */
  let homeWindow: string | null = null;

  const repo = {
    setHomeWindow: (id: string | null) => Effect.sync(() => void (homeWindow = id)),
    /** Writes the write-ahead log into the database and empties it (after private tabs were deleted: nothing of them stays there). */
    checkpoint: () => sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.asVoid),

    list: () =>
      sql<AppRow>`SELECT * FROM apps ORDER BY position, created_at, rowid`.pipe(
        Effect.map((rows) => rows.map(toSummary)),
      ),

    get: (id: string) => row(id).pipe(Effect.map((r) => (r ? toRecord(r) : null))),

    create: (workspaceId: string, url: string | null, windowId: string | null = null) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const name = hostOf(url) || "New tab";
        yield* sql`INSERT INTO apps (id, workspace_id, name, url, position, window_id)
          VALUES (${id}, ${workspaceId}, ${name}, ${url}, ${lastPosition(workspaceId)}, ${windowId ?? homeWindow})`;
        return (yield* summary(id))!;
      }),

    /** Navigation: remembers the URL, favicon and (unless renamed) the page title. */
    updatePage: (id: string, fields: { url?: string; title?: string; favicon?: string | null }) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const title = fields.title?.trim();
        yield* sql`UPDATE apps SET
          url = ${fields.url ?? r.url},
          favicon = ${fields.favicon !== undefined ? fields.favicon : r.favicon},
          name = ${title && !r.name_locked ? title.slice(0, 120) : r.name},
          updated_at = ${sql.literal(now)}
          WHERE id = ${id}`;
        return yield* summary(id);
      }),

    /** The tab's back/forward history (shared/tabHistory.ts), null if none is kept. */
    history: (id: string) =>
      sql<{ history: string | null }>`SELECT history FROM apps WHERE id = ${id}`.pipe(
        Effect.map((rows) => parseHistory(rows[0]?.history ?? null)),
      ),

    /** Keeps the tab's back/forward history (trimmed); private tabs keep none. False for an unknown tab. */
    setHistory: (id: string, history: TabHistory | null) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return false;
        const kept = isPrivateWindow(r.window_id) ? null : trimHistory(history);
        yield* sql`UPDATE apps SET history = ${kept ? JSON.stringify(kept) : null} WHERE id = ${id}`;
        return true;
      }),

    /** A rename by the user: page titles leave the name alone from now on. */
    rename: (id: string, name: string) =>
      sql`UPDATE apps SET name = ${name}, name_locked = 1, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    /** An icon the user chose, or null for the default (the site's favicon) again. */
    setIcon: (id: string, icon: string | null) =>
      sql`UPDATE apps SET icon = ${icon}, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
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
      sql`UPDATE apps SET workspace_id = ${workspaceId}, position = ${lastPosition(workspaceId)}, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    /** Moves a tab to another window: last in its workspace there, or where it was (tabs a window takes in). */
    setWindow: (id: string, windowId: string, place: "last" | "same" = "last") =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const position = place === "last" ? lastPosition(r.workspace_id) : r.position;
        yield* sql`UPDATE apps SET window_id = ${windowId}, position = ${position}, updated_at = ${sql.literal(now)} WHERE id = ${id}`;
        return yield* summary(id);
      }),

    /** The user had these tabs on screen just now. */
    markUsed: (ids: readonly string[]) =>
      ids.length
        ? sql`UPDATE apps SET last_used_at = ${sql.literal(now)} WHERE id IN ${sql.in(ids)}`.pipe(Effect.asVoid)
        : Effect.void,

    /** When each tab was last used (since it was made, if never), for tab cleanup. */
    usage: () =>
      sql<{
        id: string;
        workspace_id: string;
        pinned: number;
        window_id: string | null;
        last_used: string;
      }>`SELECT id, workspace_id, pinned, window_id, COALESCE(last_used_at, created_at) AS last_used FROM apps`.pipe(
        Effect.map((rows) =>
          rows.map((r) => ({
            id: r.id,
            workspaceId: r.workspace_id,
            pinned: r.pinned === 1,
            private: isPrivateWindow(r.window_id),
            lastUsed: Date.parse(r.last_used),
          })),
        ),
      ),

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

    touch: (id: string) => touch(id).pipe(Effect.asVoid),

    /** Copies a tab's name, icon, URL, back/forward history and agent settings (not its chat) to a new tab. */
    duplicate: (id: string) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const copyId = crypto.randomUUID();
        yield* sql`INSERT INTO apps (id, workspace_id, name, icon, url, favicon, provider, model, effort, position, window_id, history)
          VALUES (${copyId}, ${r.workspace_id}, ${`${r.name} copy`}, ${r.icon}, ${r.url}, ${r.favicon}, ${r.provider}, ${r.model}, ${r.effort}, ${lastPosition(r.workspace_id)}, ${r.window_id}, ${r.history})`;
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
