// Removing folders that app processes just used. Windows keeps a process's
// files locked a moment after it ends, so busy files are retried for a while.
import { rm } from "node:fs/promises";

const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export async function removeDir(path: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rm(path, { recursive: true, force: true });
    } catch (err) {
      if (attempt >= 20 || !BUSY.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await Bun.sleep(150);
    }
  }
}
