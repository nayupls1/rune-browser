// Chats of a tab: a new chat keeps the current one (with its agent session),
// earlier ones open again in its place, and can be deleted.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { DEFAULT_WORKSPACE } from "../src/shared/api";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { core } from "../src/server/services";

const dataDir = mkdtempSync(join(tmpdir(), "rune-chats-"));
const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
afterAll(async () => {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

test("new chat, earlier chats, reopening and deleting", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const apps = yield* Apps;
      const tab = yield* apps.create(DEFAULT_WORKSPACE, "app", null);
      const texts = (list: readonly { content: string }[]) => list.map((m) => m.content);
      // Nothing to keep: a new chat changes nothing.
      yield* apps.newChat(tab.id);
      const none = yield* apps.chats(tab.id);

      yield* apps.addMessage(tab.id, "user", "Build   a habit tracker\nwith streaks");
      yield* apps.addMessage(tab.id, "assistant", "Done.");
      yield* apps.setSession(tab.id, { provider: "claude", id: "session-1" });
      yield* apps.newChat(tab.id);
      const afterNew = {
        current: texts(yield* apps.messages(tab.id)),
        chats: yield* apps.chats(tab.id),
        session: (yield* apps.get(tab.id))!.session,
      };

      yield* apps.addMessage(tab.id, "user", "Something else");
      yield* apps.setSession(tab.id, { provider: "codex", id: "session-2" });
      const first = afterNew.chats[0]!.id;
      const opened = yield* apps.openChat(tab.id, first);
      const afterOpen = {
        current: texts(yield* apps.messages(tab.id)),
        chats: (yield* apps.chats(tab.id)).map((c) => c.title),
        session: (yield* apps.get(tab.id))!.session,
      };
      const second = (yield* apps.chats(tab.id))[0]!.id;
      const kept = texts(yield* apps.chatMessages(tab.id, second));
      const deleted = yield* apps.deleteChat(tab.id, second);
      const missing = [yield* apps.openChat(tab.id, 999), yield* apps.deleteChat("other-tab", first)];
      // Clearing only drops the current chat.
      yield* apps.newChat(tab.id);
      yield* apps.addMessage(tab.id, "user", "Short-lived");
      yield* apps.clearMessages(tab.id);
      const afterClear = { current: (yield* apps.messages(tab.id)).length, chats: (yield* apps.chats(tab.id)).length };
      // Deleting the tab deletes its chats.
      yield* apps.remove(tab.id);
      const gone = (yield* apps.chats(tab.id)).length;
      return { none, afterNew, opened, afterOpen, kept, deleted, missing, afterClear, gone };
    }),
  );
  expect(result.none).toEqual([]);
  expect(result.afterNew.current).toEqual([]);
  expect(result.afterNew.chats).toMatchObject([{ title: "Build a habit tracker with streaks", messages: 2 }]);
  expect(result.afterNew.session).toBeNull();
  expect(result.opened).toBe(true);
  expect(result.afterOpen).toEqual({
    current: ["Build   a habit tracker\nwith streaks", "Done."],
    chats: ["Something else"],
    session: { provider: "claude", id: "session-1" },
  });
  expect(result.kept).toEqual(["Something else"]);
  expect(result.deleted).toEqual({ folder: null });
  expect(result.missing).toEqual([false, false]);
  expect(result.afterClear).toEqual({ current: 0, chats: 1 });
  expect(result.gone).toBe(0);
});
