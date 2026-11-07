// Files the user gives an agent with a message (pasted screenshots, dropped
// files): kept in the chat's folder (attachments/, see ChatFiles.ts), shown in
// the chat, and handed to the provider: images (and PDFs, for Claude) as
// content the model sees, text files inlined in the prompt, anything else by
// its path.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import type { Attachment } from "../../shared/api";
import { ChatFiles, freeName, META_DIR, safeName } from "./ChatFiles";

export class AttachmentError extends Data.TaggedError("AttachmentError")<{ readonly message: string }> {}

export const MAX_ATTACHMENT = 20 * 1024 * 1024;
/** Text files up to this size go into the prompt. */
const INLINE_TEXT = 200 * 1024;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** An attachment on disk, for a provider. */
export type AttachedFile = Attachment;

const ID = /^[a-f0-9-]{36}$/;

const textLike = (mime: string, name: string) =>
  mime.startsWith("text/") ||
  /^application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh|sql|graphql)/.test(mime) ||
  /\.(txt|md|csv|tsv|json|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|log|ini|env\.example)$/i.test(
    name,
  );

export interface AttachmentsShape {
  readonly save: (
    tabId: string,
    input: { name: string; mime: string; data: Uint8Array },
  ) => Effect.Effect<Attachment, AttachmentError>;
  readonly get: (tabId: string, id: string) => Effect.Effect<AttachedFile | null>;
  /** The prompt with the text files in it, and the files for the provider (images, PDFs, other files by path). */
  readonly forTurn: (
    prompt: string,
    files: readonly AttachedFile[],
  ) => Effect.Effect<{ prompt: string; files: AttachedFile[] }>;
}

export class Attachments extends Context.Service<Attachments, AttachmentsShape>()("rune/Attachments") {}

export const make = Effect.gen(function* () {
  const chatFiles = yield* ChatFiles;
  const metaOf = (folder: string, id: string) => join(folder, META_DIR, "attachments", `${id}.json`);

  return {
    save: (tabId, { name, mime, data }) =>
      Effect.gen(function* () {
        if (!data.length) return yield* new AttachmentError({ message: "The file is empty." });
        if (data.length > MAX_ATTACHMENT)
          return yield* new AttachmentError({
            message: `${name} is too large (at most ${MAX_ATTACHMENT / 1048576} MB).`,
          });
        const folder = yield* chatFiles
          .dir(tabId)
          .pipe(Effect.mapError((e) => new AttachmentError({ message: e.message })));
        const id = crypto.randomUUID();
        const dir = join(folder, "attachments");
        mkdirSync(dir, { recursive: true });
        mkdirSync(join(folder, META_DIR, "attachments"), { recursive: true });
        const fileName = freeName(dir, safeName(name));
        const meta: Attachment = {
          id,
          name: fileName,
          mime: mime || "application/octet-stream",
          size: data.length,
          path: join(dir, fileName),
        };
        yield* Effect.promise(async () => {
          await writeFile(meta.path, data);
          await writeFile(metaOf(folder, id), JSON.stringify(meta));
        });
        return meta;
      }),

    // In any of the tab's chats: earlier chats show their attachments too.
    get: (tabId, id) =>
      Effect.gen(function* () {
        if (!ID.test(id)) return null;
        for (const folder of yield* chatFiles.folders(tabId)) {
          const metaFile = metaOf(folder, id);
          if (!existsSync(metaFile)) continue;
          const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Attachment;
          return existsSync(meta.path) ? meta : null;
        }
        return null;
      }),

    forTurn: (prompt, files) =>
      Effect.gen(function* () {
        const inline: string[] = [];
        const rest: AttachedFile[] = [];
        for (const file of files) {
          if (
            !IMAGE_TYPES.has(file.mime) &&
            file.mime !== "application/pdf" &&
            textLike(file.mime, file.name) &&
            file.size <= INLINE_TEXT
          ) {
            const content = yield* Effect.promise(() => readFile(file.path, "utf8"));
            inline.push(`<attached-file name="${file.name}">\n${content}\n</attached-file>`);
          } else rest.push(file);
        }
        const others = rest.filter((f) => !IMAGE_TYPES.has(f.mime) && f.mime !== "application/pdf");
        const notes = others.length
          ? `\n\nFiles the user attached, in this chat's folder (read_file reads them):\n${others.map((f) => `- attachments/${f.name} (${f.path})`).join("\n")}`
          : "";
        return { prompt: `${inline.length ? `${inline.join("\n\n")}\n\n` : ""}${prompt}${notes}`, files: rest };
      }),
  } satisfies AttachmentsShape;
});

export const layer = Layer.effect(Attachments, make);
