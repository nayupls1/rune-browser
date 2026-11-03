// Files waiting to go with a tab's next message (pasted screenshots, dropped
// or picked files). They're uploaded right away (server: agent/Attachments.ts)
// and sent by id with the message (store.ts: sendPrompt).
import { createStore } from "solid-js/store";
import type { Attachment } from "../../shared/api";
import { api } from "./api";

const MAX_FILES = 10;
/** Big images are scaled down to this (longest side) before they're sent: models don't need more. */
const MAX_SIDE = 2000;

const [pending, setPending] = createStore<Record<string, Attachment[]>>({});
const [uploading, setUploading] = createStore<Record<string, number>>({});

export const attachmentsOf = (tabId: string) => pending[tabId] ?? [];
export const uploadingCount = (tabId: string) => uploading[tabId] ?? 0;

/** Where an attachment can be seen (an <img> src: carries the window's token). */
export const attachmentUrl = (tabId: string, id: string) =>
  `${window.rune.serverUrl}/api/apps/${tabId}/attachments/${id}?token=${encodeURIComponent(window.rune.token)}`;

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** A large image as a smaller PNG/JPEG; anything else as it is. */
async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3 * 1024 * 1024) return file;
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: file.type === "image/png" ? "image/png" : "image/jpeg", quality: 0.88 });
}

/** Uploads files for the tab's next message. Returns an error to show, if any. */
export async function addAttachments(tabId: string, files: File[]): Promise<string | null> {
  const room = MAX_FILES - attachmentsOf(tabId).length;
  if (room <= 0) return `At most ${MAX_FILES} files per message.`;
  const errors: string[] = [];
  setUploading(tabId, (n) => (n ?? 0) + Math.min(files.length, room));
  for (const file of files.slice(0, room)) {
    try {
      const blob = await shrink(file);
      const name =
        file.name ||
        `Screenshot ${new Date().toLocaleTimeString()}.${(blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
      const saved = await api.uploadAttachment(tabId, {
        name,
        mime: blob.type || file.type || "application/octet-stream",
        data: await toBase64(blob),
      });
      setPending(tabId, (list) => [...(list ?? []), saved]);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(tabId, (n) => Math.max(0, (n ?? 1) - 1));
    }
  }
  if (files.length > room) errors.push(`Only ${MAX_FILES} files go with one message.`);
  return errors.length ? errors.join(" ") : null;
}

export const removeAttachment = (tabId: string, id: string) =>
  setPending(tabId, (list) => (list ?? []).filter((a) => a.id !== id));
export const clearAttachments = (tabId: string) => setPending(tabId, []);
