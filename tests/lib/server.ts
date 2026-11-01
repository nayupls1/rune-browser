// Starts the real Bun server on a free port with a throwaway data dir.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function freePort() {
  return new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** `dataDir`: an existing one (e.g. an old database to migrate); removed on stop either way. */
export async function startServer(options: { dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "rune-server-test-"));
  const token = crypto.randomUUID();
  // The free port can be taken by someone else before the server binds it: then
  // the server exits, and it's started again on another one.
  let started: { proc: Bun.Subprocess; port: number } | undefined;
  for (let attempt = 1; !started; attempt++) {
    const port = await freePort();
    const proc = Bun.spawn([process.execPath, "src/server/index.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        RUNE_DATA_DIR: dataDir,
        RUNE_ALLOWED_ORIGIN: "app://rune",
        RUNE_TOKEN: token,
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    // The first start on Windows CI can take over 10s (a cold start, and refused connections take ~2s there).
    const deadline = Date.now() + 25_000; // within the 30 s a test (or hook) gets
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) })).ok) {
          started = { proc, port };
          break;
        }
      } catch {
        // not up yet
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        if (attempt < 3) break;
        throw new Error(`server did not start: it exited (${proc.exitCode ?? proc.signalCode}) three times`);
      }
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error(`server did not start within 25s (port ${port})`);
      }
      await Bun.sleep(50);
    }
  }
  const { proc, port } = started;
  const url = `http://127.0.0.1:${port}`;

  const api = async <T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init?.headers },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  return {
    url,
    port,
    token,
    /** The hub WebSocket URL (authenticated). */
    wsUrl: `${url.replace("http", "ws")}/api/ws?token=${token}`,
    dataDir,
    api,
    async stop() {
      proc.kill();
      await proc.exited;
      // Windows keeps files locked a moment after their processes end (or, for app
      // processes the killed server couldn't stop, longer): best effort there.
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (err) {
        if (process.platform !== "win32") throw err;
      }
    },
  };
}
