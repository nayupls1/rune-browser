// Child process helpers for provider CLIs.
import type { Subprocess } from "bun";

/** The binary to run: the configured path, or `name` found on PATH. */
export function findBinary(name: string, configured: string): string | null {
  if (configured) return configured;
  return Bun.which(name);
}

/** Runs a command to completion (with a timeout) and collects its output. */
export async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env as Record<string, string> | undefined,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 15_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Calls `fn` for every line the stream produces. Resolves when it ends. */
export async function readLines(stream: ReadableStream<Uint8Array>, fn: (line: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) fn(line);
    }
  }
  if (buffer.trim()) fn(buffer.trim());
}

/** Keeps the last `max` characters of a process's stderr, for error messages. */
export function tailOf(stream: ReadableStream<Uint8Array>, max = 4000) {
  let tail = "";
  void readLines(stream, (line) => {
    tail = `${tail}\n${line}`.slice(-max);
  }).catch(() => {});
  return () => tail.trim();
}

export function kill(proc: Subprocess) {
  if (proc.exitCode === null && !proc.killed) proc.kill();
}

/**
 * The environment for agent processes: the server's, without Rune Browser's own
 * variables (RUNE_TOKEN is the renderer's API key; an agent with a shell
 * could otherwise use Rune Browser's API, e.g. to grant itself permissions).
 */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("RUNE_")) env[key] = value;
  }
  return { ...env, ...extra };
}
