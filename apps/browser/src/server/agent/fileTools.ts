// The agent's own workspace: its chat's folder (ChatFiles.ts). Every agent,
// the website agent too, can list, read, write, edit and delete files there
// without asking (notes, lists of what it did, temporary files during a long
// task, what it saved from pages), and show files to the user in the chat.
// Nothing beyond the folder is reachable. Files cost no context until the
// agent reads one, and then only the part it asks for.
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import type { ChatFile } from "../../shared/api";
import { Workspace } from "../workspace/Workspace";
import { ChatFiles, freeName, type ChatFilesShape } from "./ChatFiles";
import { text, tool } from "./Mcp";
import type { ToolEnv } from "./tools";

/** Text an agent writes in one go, and what read_file returns at most. */
const MAX_WRITE = 5 * 1024 * 1024;
const MAX_READ_CHARS = 60_000;
const DEFAULT_LINES = 500;
/** Images read_file shows the model (larger ones by description only). */
const MAX_IMAGE = 5 * 1024 * 1024;
const VIEWABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const kb = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} kB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/** Whether bytes look like text (no NUL bytes in the first 8 kB). */
const isText = (bytes: Uint8Array) => !bytes.subarray(0, 8192).includes(0);

/**
 * Saves what a tool produced (a screenshot, a script's result) in the chat's
 * folder; the chat shows it with the tool call. `name` is a path in the
 * folder; with `unique`, a taken name gets a number instead of being replaced.
 */
export const saveOutput = (
  files: ChatFilesShape,
  env: ToolEnv,
  name: string,
  data: Uint8Array | string,
  options: { unique?: boolean } = {},
) =>
  Effect.gen(function* () {
    const wanted = yield* files.resolve(env.tabId, name);
    const path = options.unique ? join(dirname(wanted), freeName(dirname(wanted), basename(wanted))) : wanted;
    yield* Effect.promise(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    });
    const file = (yield* files.describe(yield* files.dir(env.tabId), path))!;
    if (env.saved) yield* env.saved(file);
    return file;
  });

export const fileTools = Effect.fn(function* (env: ToolEnv, options: { project?: boolean } = {}) {
  const files = yield* ChatFiles;
  const workspace = yield* Workspace;
  const known = yield* files.dir(env.tabId).pipe(Effect.orElseSucceed(() => null));
  const where = known ? `this chat's folder (${known})` : "this chat's folder";

  return [
    tool(
      "list_files",
      `List the files in ${where}: the user's attachments (attachments/), what you saved (screenshots, exports) and your own notes. Paths, sizes and types, newest first; read one with read_file only when you need it.`,
      Schema.Struct({ path: Schema.optionalKey(Schema.String.annotate({ description: "Only this folder in it" })) }),
      ({ path }) =>
        Effect.gen(function* () {
          const { files: list } = yield* files.list(env.tabId, path);
          if (!list.length) return path ? `Nothing in ${path}.` : `${where} is empty.`;
          return list.map((f) => `${f.name}  (${kb(f.size)}, ${f.mime})`).join("\n");
        }),
    ),

    tool(
      "read_file",
      `Read a file in ${where}. Text comes with line numbers, ${DEFAULT_LINES} lines at a time (offset and limit for more); images are shown to you. Paths are relative to the folder.`,
      Schema.Struct({
        path: Schema.String,
        offset: Schema.optionalKey(Schema.Finite.annotate({ description: "First line (1 = the start)" })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "How many lines" })),
      }),
      ({ path, offset, limit }) =>
        Effect.gen(function* () {
          const target = yield* files.resolve(env.tabId, path);
          const file = yield* files.describe(yield* files.dir(env.tabId), target);
          if (!file) return text(`${path} doesn't exist. list_files shows what's there.`, true);
          if (VIEWABLE_IMAGES.has(file.mime)) {
            if (file.size > MAX_IMAGE) return text(`${path} is an image too large to show (${kb(file.size)}).`, true);
            const data = yield* Effect.promise(() => readFile(target));
            return {
              content: [
                { type: "text" as const, text: `${file.name} (${kb(file.size)})` },
                { type: "image" as const, data: data.toString("base64"), mimeType: file.mime },
              ],
            };
          }
          const bytes = new Uint8Array(yield* Effect.promise(() => readFile(target)));
          if (!isText(bytes))
            return `${file.name} is a binary file (${file.mime}, ${kb(file.size)}); it can't be read as text.`;
          const lines = new TextDecoder().decode(bytes).split("\n");
          const from = Math.max(1, Math.floor(offset ?? 1));
          const count = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LINES)), 5000);
          let out = "";
          let shown = 0;
          for (let i = from - 1; i < Math.min(lines.length, from - 1 + count); i++) {
            const line = `${String(i + 1).padStart(5)}  ${lines[i]}\n`;
            if (out.length + line.length > MAX_READ_CHARS) break;
            out += line;
            shown++;
          }
          const last = from - 1 + shown;
          return last < lines.length
            ? `${out}… lines ${from}–${last} of ${lines.length}; read on with offset ${last + 1}.`
            : out || `${file.name} is empty.`;
        }),
    ),

    tool(
      "write_file",
      `Create or replace a text file in ${where} (folders are made as needed). For notes, lists of what you've done, data you collected and drafts; no need to ask the user.`,
      Schema.Struct({ path: Schema.String, content: Schema.String }),
      ({ path, content }) =>
        Effect.gen(function* () {
          if (content.length > MAX_WRITE) return text(`That's too much for one file (at most 5 MB).`, true);
          const file = yield* saveOutput(files, env, path, content);
          return `Wrote ${file.name} (${kb(file.size)}).`;
        }),
    ),

    tool(
      "edit_file",
      `Change a text file in ${where}: replaces old_text (which must appear exactly once, unless replace_all) with new_text.`,
      Schema.Struct({
        path: Schema.String,
        old_text: Schema.String,
        new_text: Schema.String,
        replace_all: Schema.optionalKey(Schema.Boolean),
      }),
      ({ path, old_text, new_text, replace_all }) =>
        Effect.gen(function* () {
          const target = yield* files.resolve(env.tabId, path);
          const current = yield* Effect.tryPromise({
            try: () => readFile(target, "utf8"),
            catch: () => new Error(`${path} doesn't exist. write_file creates it.`),
          });
          if (!old_text) return text("old_text is empty.", true);
          const count = current.split(old_text).length - 1;
          if (!count) return text(`old_text isn't in ${path}.`, true);
          if (count > 1 && !replace_all)
            return text(`old_text is in ${path} ${count} times: give more of it, or replace_all.`, true);
          const next = replace_all ? current.split(old_text).join(new_text) : current.replace(old_text, () => new_text);
          yield* Effect.promise(() => writeFile(target, next));
          return `Edited ${path}${count > 1 ? ` (${count} places)` : ""}.`;
        }),
    ),

    tool(
      "delete_file",
      `Delete a file or folder in ${where} (temporary files you no longer need).`,
      Schema.Struct({ path: Schema.String }),
      ({ path }) =>
        Effect.gen(function* () {
          const target = yield* files.resolve(env.tabId, path);
          if (target === (yield* files.dir(env.tabId)))
            return text("That's the whole folder; delete what's in it instead.", true);
          yield* Effect.promise(() => rm(target, { recursive: true, force: true }));
          return `Deleted ${path}.`;
        }),
    ),

    tool(
      "show_files",
      `Show files of ${where} to the user in the chat, as cards they can open (images, PDFs, pages, text, video). Use it for what you made for them: a screenshot, an export, a report. Mentioning a file's path in \`backticks\` in your reply works too.`,
      Schema.Struct({
        paths: Schema.Array(Schema.String).annotate({ description: "Paths in the chat's folder" }),
      }),
      ({ paths }) =>
        Effect.gen(function* () {
          const dir = yield* files.dir(env.tabId);
          const shown: ChatFile[] = [];
          const missing: string[] = [];
          for (const path of paths.slice(0, 20)) {
            const target = yield* files.resolve(env.tabId, path);
            const file = yield* files.describe(dir, target);
            if (file) shown.push(file);
            else missing.push(path);
          }
          if (shown.length) yield* env.message("files", JSON.stringify(shown));
          if (missing.length) return text(`Not found: ${missing.join(", ")}. list_files shows what's there.`, true);
          return `Showed ${shown.map((f) => f.name).join(", ")} to the user.`;
        }),
    ),
    ...(options.project
      ? [
          tool(
            "copy_to_project",
            `Copy a file from ${where} into the app's project (an image the user attached or a screenshot, for the app to use), e.g. to public/hero.png.`,
            Schema.Struct({
              path: Schema.String.annotate({ description: "The file in the chat's folder" }),
              to: Schema.String.annotate({ description: "Where in the project, relative to it" }),
            }),
            ({ path, to }) =>
              Effect.gen(function* () {
                const source = yield* files.resolve(env.tabId, path);
                if (!(yield* files.describe(yield* files.dir(env.tabId), source)))
                  return text(`${path} doesn't exist. list_files shows what's there.`, true);
                const root = yield* workspace.ensureDir(env.tabId);
                const target = resolve(root, to);
                const rel = relative(root, target);
                if (!rel || rel.startsWith("..") || isAbsolute(rel))
                  return text(`${to} isn't inside the project.`, true);
                yield* Effect.tryPromise({
                  try: async () => {
                    await mkdir(dirname(target), { recursive: true });
                    // Symlinks in the project can't lead the copy out of it.
                    const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dirname(target))]);
                    const inside = relative(realRoot, realDir);
                    if (inside.startsWith("..") || isAbsolute(inside))
                      throw new Error(`${to} isn't inside the project.`);
                    await copyFile(source, target);
                  },
                  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                });
                return `Copied ${path} to ${rel.split("\\").join("/")} in the project.`;
              }),
          ),
        ]
      : []),
  ];
});
