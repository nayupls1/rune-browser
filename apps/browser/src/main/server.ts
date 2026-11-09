import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadSecretsKey } from "./secretsKey";

export interface ServerHandle {
  url: string;
  /** Required on every API request; only Rune Browser's own window gets it. */
  token: string;
  /** Resolves once the server answers (it takes a few hundred ms to start); rejects if it never does. */
  ready: Promise<void>;
  stop: () => void;
}

export interface ServerOptions {
  allowedOrigin: string;
  /** The server stopped without being asked to (it crashed): its exit and its last error output. */
  onExit?: (exit: { code: number | null; signal: string | null; stderr: string[] }) => void;
}

/** How much of the server's error output is kept for a crash report. */
const STDERR_LINES = 40;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * In dev we run the TypeScript source directly with Bun (with --watch, so the
 * server hot-restarts on change). In production we run the standalone binary
 * produced by `bun build --compile`, so end users don't need Bun installed.
 */
function serverCommand(): { command: string; args: string[] } {
  if (process.env.VITE_DEV_SERVER_URL) {
    const bun = process.env.RUNE_BUN_PATH || "bun";
    return { command: bun, args: ["--watch", join(app.getAppPath(), "src/server/index.ts")] };
  }

  const binary = process.platform === "win32" ? "rune-server.exe" : "rune-server";
  const dir = app.isPackaged ? join(process.resourcesPath, "server") : join(app.getAppPath(), "dist/server");
  return { command: join(dir, binary), args: [] };
}

async function waitForHealthy(url: string, child: ChildProcess, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    // Often: the windows wait for it.
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

/** Starts the server: resolves once it's spawned, before it answers (see ServerHandle.ready). */
export async function startServer({ allowedOrigin, onExit }: ServerOptions): Promise<ServerHandle> {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("hex");
  const { command, args } = serverCommand();
  let secretsKey: ReturnType<typeof loadSecretsKey> = null;
  try {
    secretsKey = loadSecretsKey();
  } catch (err) {
    console.error("Couldn't load the secrets key:", err);
  }

  const child = spawn(command, args, {
    env: {
      ...process.env,
      PORT: String(port),
      RUNE_ALLOWED_ORIGIN: allowedOrigin,
      RUNE_TOKEN: token,
      RUNE_PARENT: "electron",
      RUNE_DATA_DIR: join(app.getPath("userData"), "data"),
      // Dev only: `bun --watch` restarts the server, which then can't read stdin again.
      ...(process.env.VITE_DEV_SERVER_URL && secretsKey ? { RUNE_DEV_SECRETS_KEY: JSON.stringify(secretsKey) } : {}),
    },
    // stdin stays piped so the server can detect when the app goes away. Its errors pass through
    // here, so the last of them can go into a crash report.
    stdio: ["pipe", "inherit", "pipe"],
    windowsHide: true,
  });

  const stderr: string[] = [];
  let partial = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    try {
      process.stderr.write(chunk);
    } catch {
      // no console (the packaged app on Windows)
    }
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop() ?? "";
    stderr.push(...lines.filter((l) => l.trim()).map((l) => l.slice(0, 500)));
    stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
  });

  // Only once it's up: failing to start is reported by startServer's caller.
  let running = false;
  let stopping = false;
  child.on("exit", (code, signal) => {
    if (!running || stopping) return;
    onExit?.({ code, signal, stderr: partial.trim() ? [...stderr, partial.slice(0, 500)] : [...stderr] });
  });

  // The secrets key goes over stdin, not the environment (other processes of the user can read that).
  child.stdin!.write(`${JSON.stringify({ secretsKey })}\n`);

  const stop = () => {
    stopping = true;
    if (child.exitCode === null && !child.killed) child.kill();
  };

  // Not waited for here: the windows open meanwhile (their requests wait for `ready`).
  const ready = waitForHealthy(url, child).then(
    () => void (running = true),
    (err) => {
      stop();
      throw err;
    },
  );
  ready.catch(() => {});

  return { url, token, ready, stop };
}
