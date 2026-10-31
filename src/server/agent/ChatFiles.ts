// A folder per chat (<data>/chats/<tab>/<folder>/): everything that goes into
// or comes out of the chat's agent lives there. The user's attachments
// (attachments/), what the agent saves (screenshots, exports, fetched data)
// and its own notes. Every agent works in it with Rune Browser's file tools
// (fileTools.ts), without approving each change and without reaching anything
// beyond it; the user opens what's there from the chat. An earlier chat keeps
// its folder; deleting the chat or the tab deletes it.
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Data, Effect, Layer } from "effect";
import type { ChatFile } from "../../shared/api";
import { ServerConfig } from "../Config";
import { Apps } from "../db/Apps";

export class ChatFileError extends Data.TaggedError("ChatFileError")<{ readonly message: string }> {}

/** Rune Browser's own bookkeeping in a chat folder (attachments' details): not listed, not for agents. */
export const META_DIR = ".rune";
/** At most this many files are listed. */
const MAX_LISTED = 500;

const FOLDER = /^[a-f0-9-]{36}$/;
const tabDir = (tabId: string) => tabId.replace(/[^\w-]/g, "");

/** A file's type from its name, without parameters ("; charset=utf-8"). */
export const mimeOf = (name: string) => {
  const ext = extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".ts" || ext === ".tsx") return "text/plain";
  return Bun.file(name).type.split(";")[0]!.trim() || "application/octet-stream";
};

/** A file name made safe for any file system ("my file (2).png" stays). */
export const safeName = (name: string) =>
  basename(name)
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120) || "file";

/** A name that isn't taken in `dir` yet: "shot.png", then "shot (2).png"… */
export function freeName(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; existsSync(join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
  return candidate;
}

export interface ChatFilesShape {
  /** The current chat's folder (made if needed). */
  readonly dir: (tabId: string) => Effect.Effect<string, ChatFileError>;
  /**
   * A path in the current chat's folder: relative to it or absolute inside it.
   * Never outside it (also through symlinks), never in Rune Browser's own `.rune`.
   */
  readonly resolve: (tabId: string, path: string) => Effect.Effect<string, ChatFileError>;
  /** What's in the current chat's folder (or a folder in it), newest first. */
  readonly list: (tabId: string, under?: string) => Effect.Effect<{ dir: string; files: ChatFile[] }, ChatFileError>;
  /** A file of any of the tab's chats (an earlier chat's too), by absolute path; null if it isn't one. */
  readonly find: (tabId: string, path: string) => Effect.Effect<ChatFile | null>;
  /** The folders of all of the tab's chats (that exist). */
  readonly folders: (tabId: string) => Effect.Effect<string[]>;
  /** Describes a file in a chat folder. */
  readonly describe: (dir: string, path: string) => Effect.Effect<ChatFile | null>;
  /** Deletes a chat's folder (by its id). */
  readonly forget: (tabId: string, folder: string | null) => Effect.Effect<void>;
  readonly forgetTab: (tabId: string) => Effect.Effect<void>;
}

export class ChatFiles extends Context.Service<ChatFiles, ChatFilesShape>()("rune/ChatFiles") {}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const apps = yield* Apps;
  const root = join(config.dataDir, "chats");
  const folderDir = (tabId: string, folder: string) => join(root, tabDir(tabId), folder);

  const dir = (tabId: string) =>
    Effect.gen(function* () {
      const folder = yield* apps.chatFolder(tabId);
      if (!folder) return yield* new ChatFileError({ message: "No such tab" });
      const path = folderDir(tabId, folder);
      yield* Effect.promise(() => mkdir(path, { recursive: true }));
      return path;
    });

  const describe = (base: string, path: string) =>
    Effect.promise(async (): Promise<ChatFile | null> => {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return null;
      return {
        name: relative(base, path).split(sep).join("/"),
        path,
        mime: mimeOf(path),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    });

  const resolvePath = (tabId: string, path: string) =>
    Effect.gen(function* () {
      const base = yield* dir(tabId);
      const trimmed = path.trim();
      const wanted = /^file:\/\//i.test(trimmed)
        ? yield* Effect.try(() => fileURLToPath(trimmed)).pipe(Effect.orElseSucceed(() => ""))
        : trimmed;
      if (!wanted) return yield* new ChatFileError({ message: "Give a path in the chat's folder." });
      const target = resolve(base, wanted);
      if (!inside(base, target))
        return yield* new ChatFileError({
          message: `${path} isn't in this chat's folder (${base}). Use a path relative to it.`,
        });
      const rel = relative(base, target);
      if (rel.split(sep)[0] === META_DIR)
        return yield* new ChatFileError({ message: `${path} is Rune Browser's own; use another name.` });
      // Symlinks can't lead out: the nearest existing folder on the way must still be inside.
      const real = yield* Effect.promise(async () => {
        const realBase = await realpath(base);
        let probe = target;
        while (!existsSync(probe) && probe !== base) probe = dirname(probe);
        return { realBase, realProbe: await realpath(probe).catch(() => realBase) };
      });
      if (!inside(real.realBase, real.realProbe))
        return yield* new ChatFileError({ message: `${path} leads out of this chat's folder.` });
      return target;
    });

  const walk = async (base: string, from: string, out: string[]) => {
    const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= MAX_LISTED) return;
      const path = join(from, entry.name);
      if (entry.isDirectory()) {
        if (from === base && entry.name === META_DIR) continue;
        await walk(base, path, out);
      } else if (entry.isFile()) out.push(path);
    }
  };

  const folders = (tabId: string) =>
    apps.chatFolders(tabId).pipe(
      Effect.map((ids) =>
        ids
          .filter((id) => FOLDER.test(id))
          .map((id) => folderDir(tabId, id))
          .filter((path) => existsSync(path)),
      ),
    );

  return {
    dir,
    resolve: resolvePath,
    describe,
    folders,

    list: (tabId, under) =>
      Effect.gen(function* () {
        const base = yield* dir(tabId);
        const from = under ? yield* resolvePath(tabId, under) : base;
        const paths: string[] = [];
        yield* Effect.promise(() => walk(base, from, paths));
        const files: ChatFile[] = [];
        for (const path of paths) {
          const file = yield* describe(base, path);
          if (file) files.push(file);
        }
        files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
        return { dir: base, files };
      }),

    find: (tabId, path) =>
      Effect.gen(function* () {
        if (!isAbsolute(path)) return null;
        for (const base of yield* folders(tabId)) {
          const target = resolve(path);
          if (!inside(base, target) || target === base) continue;
          if (relative(base, target).split(sep)[0] === META_DIR) return null;
          const real = yield* Effect.promise(async () => {
            const [b, t] = await Promise.all([realpath(base), realpath(target).catch(() => null)]);
            return t && inside(b, t);
          });
          return real ? yield* describe(base, target) : null;
        }
        return null;
      }),

    forget: (tabId, folder) =>
      folder && FOLDER.test(folder)
        ? Effect.promise(() => rm(folderDir(tabId, folder), { recursive: true, force: true }))
        : Effect.void,

    forgetTab: (tabId) => Effect.promise(() => rm(join(root, tabDir(tabId)), { recursive: true, force: true })),
  } satisfies ChatFilesShape;
});

export const layer = Layer.effect(ChatFiles, make);
