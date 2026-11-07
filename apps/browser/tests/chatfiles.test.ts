// A folder per chat (agent/ChatFiles.ts) and the agent's file tools in it
// (agent/fileTools.ts): scoped to the folder, kept with earlier chats,
// deleted with the chat, and served to the chat for thumbnails.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { ChatFiles } from "../src/server/agent/ChatFiles";
import { fileTools } from "../src/server/agent/fileTools";
import type { ToolResult } from "../src/server/agent/Mcp";
import type { ToolEnv } from "../src/server/agent/tools";
import { readConfig } from "../src/server/Config";
import { Apps } from "../src/server/db/Apps";
import { core } from "../src/server/services";
import type { ChatFile } from "../src/shared/api";
import { startServer } from "./lib/server";

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

describe("chat folders", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-chatfiles-"));
  const outside = mkdtempSync(join(tmpdir(), "rune-outside-"));
  writeFileSync(join(outside, "secret.txt"), "not for agents");
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("the agent's file tools work in its chat's folder, and nowhere else", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const files = yield* ChatFiles;
        const tab = (yield* apps.create("default", "web", "https://example.com")).id;
        const messages: { role: string; content: string }[] = [];
        const saved: ChatFile[] = [];
        const env: ToolEnv = {
          tabId: tab,
          label: "Website agent",
          log: () => Effect.void,
          message: (role, content) => Effect.sync(() => void messages.push({ role, content })),
          saved: (file) => Effect.sync(() => void saved.push(file)),
        };
        const tools = yield* fileTools(env);
        const run = (name: string, args: object) =>
          tools
            .find((t) => t.name === name)!
            .run(args)
            .pipe(Effect.map((r) => ({ text: textOf(r), error: !!r.isError })));
        const dir = yield* files.dir(tab);

        const wrote = yield* run("write_file", { path: "notes/plan.md", content: "- [ ] find flights\n- [ ] book" });
        const edited = yield* run("edit_file", {
          path: "notes/plan.md",
          old_text: "- [ ] find flights",
          new_text: "- [x] find flights",
        });
        const read = yield* run("read_file", { path: "notes/plan.md" });
        const paged = yield* run("read_file", { path: "notes/plan.md", offset: 2, limit: 1 });
        yield* run("write_file", { path: "data.json", content: "{}" });
        const listed = yield* run("list_files", {});
        const shown = yield* run("show_files", { paths: ["notes/plan.md", "missing.txt"] });

        // Out of bounds: other folders, Rune Browser's own bookkeeping, symlinks leading out.
        symlinkSync(outside, join(dir, "link"));
        const escapes = [
          yield* run("read_file", { path: "../../secret.txt" }),
          yield* run("read_file", { path: join(outside, "secret.txt") }),
          yield* run("write_file", { path: ".rune/attachments/x.json", content: "{}" }),
          yield* run("read_file", { path: "link/secret.txt" }),
          yield* run("write_file", { path: "link/new.txt", content: "x" }),
          yield* run("delete_file", { path: "." }),
        ];
        const deleted = yield* run("delete_file", { path: "data.json" });
        return { dir, wrote, edited, read, paged, listed, shown, escapes, deleted, messages, saved };
      }),
    );
    expect(result.wrote).toEqual({ text: "Wrote notes/plan.md (29 B).", error: false });
    expect(result.edited.error).toBe(false);
    expect(result.read.text).toBe("    1  - [x] find flights\n    2  - [ ] book\n");
    expect(result.paged.text).toBe("    2  - [ ] book\n");
    expect(result.listed.text).toContain("notes/plan.md  (29 B, text/markdown)");
    expect(result.listed.text).toContain("data.json");
    expect(result.shown).toMatchObject({ error: true, text: expect.stringContaining("missing.txt") });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("files");
    expect(JSON.parse(result.messages[0]!.content)).toMatchObject([
      { name: "notes/plan.md", path: join(result.dir, "notes", "plan.md"), mime: "text/markdown" },
    ]);
    // Writing a file marks it as the call's output.
    expect(result.saved.map((f) => f.name)).toEqual(["notes/plan.md", "data.json"]);
    for (const escape of result.escapes) expect(escape.error).toBe(true);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(result.deleted.error).toBe(false);
    expect(existsSync(join(result.dir, "data.json"))).toBe(false);
  });

  test("an earlier chat keeps its folder; clearing or deleting a chat deletes it", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const apps = yield* Apps;
        const files = yield* ChatFiles;
        const tab = (yield* apps.create("default", "app", null)).id;
        const first = yield* files.dir(tab);
        writeFileSync(join(first, "a.txt"), "first chat");
        yield* apps.addMessage(tab, "user", "First");
        yield* apps.newChat(tab);
        const second = yield* files.dir(tab);
        const chat = (yield* apps.chats(tab))[0]!.id;
        // Files of earlier chats are still found (their thumbnails in the chat).
        const found = yield* files.find(tab, join(first, "a.txt"));
        const notOurs = yield* files.find(tab, join(outside, "secret.txt"));
        yield* apps.addMessage(tab, "user", "Second");
        yield* apps.openChat(tab, chat);
        const reopened = yield* files.dir(tab);
        const archived = (yield* apps.chats(tab))[0]!.id;
        const deleted = yield* apps.deleteChat(tab, archived);
        if (deleted) yield* files.forget(tab, deleted.folder);
        const secondGone = !existsSync(second);
        yield* files.forget(tab, yield* apps.clearMessages(tab));
        const firstGone = !existsSync(first);
        const fresh = yield* files.dir(tab);
        return { first, second, found, notOurs, reopened, secondGone, firstGone, fresh };
      }),
    );
    expect(result.second).not.toBe(result.first);
    expect(result.found).toMatchObject({ name: "a.txt", size: 10 });
    expect(result.notOurs).toBeNull();
    expect(result.reopened).toBe(result.first);
    expect(result.secondGone).toBe(true);
    expect(result.firstGone).toBe(true);
    expect(result.fresh).not.toBe(result.first);
  });
});

describe("chat files over the API", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  afterAll(() => server?.stop());

  test("the chat's folder is listed, and its images served for thumbnails", async () => {
    server = await startServer();
    const tab = await server.api<{ id: string }>("/api/apps", { method: "POST", json: { kind: "app" } });
    const shot = await server.api<{ path: string }>(`/api/apps/${tab.id}/attachments`, {
      method: "POST",
      json: { name: "shot.png", mime: "image/png", data: Buffer.from("png").toString("base64") },
    });
    const listed = await server.api<{ dir: string; files: ChatFile[] }>(`/api/apps/${tab.id}/files`);
    expect(listed.files).toMatchObject([{ name: "attachments/shot.png", path: shot.path, mime: "image/png" }]);
    mkdirSync(join(listed.dir, "out"), { recursive: true });
    writeFileSync(join(listed.dir, "out", "page.html"), "<script>alert(1)</script>");

    const raw = (path: string, tabId = tab.id) =>
      fetch(`${server.url}/api/apps/${tabId}/files/raw?path=${encodeURIComponent(path)}&token=${server.token}`);
    const image = await raw(shot.path);
    expect(image.headers.get("content-type")).toBe("image/png");
    // Anything but images only downloads, so nothing runs from here.
    const page = await raw(join(listed.dir, "out", "page.html"));
    expect(page.headers.get("content-type")).toBe("application/octet-stream");
    expect(page.headers.get("content-disposition")).toContain("attachment");
    // Only the tab's own chat files.
    const other = await server.api<{ id: string }>("/api/apps", { method: "POST", json: { kind: "app" } });
    expect((await raw(shot.path, other.id)).status).toBe(404);
    expect((await raw(join(listed.dir, "..", "..", "..", "settings.json"))).status).toBe(404);
    expect((await raw(join(listed.dir, ".rune", "attachments"))).status).toBe(404);
  });
});
