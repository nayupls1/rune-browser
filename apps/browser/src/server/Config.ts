// Server configuration, read once from the environment. Electron passes the
// port, the renderer's origin, the API token and its userData dir.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";

export interface ServerConfigShape {
  /** Where all persistent state lives. */
  readonly dataDir: string;
  /** One project folder per app. */
  readonly appsDir: string;
  /** Shared caches for app processes (bun install cache). */
  readonly cacheDir: string;
  /** Empty working directory for agents that don't work on a project (website agent, model lists). */
  readonly agentDir: string;
  readonly port: number;
  /** Base URL of this server, e.g. http://127.0.0.1:41807 */
  readonly url: string;
  /** The renderer's origin; the only browser origin allowed to call the API. */
  readonly allowedOrigin: string;
  /** Required on API requests when set (Electron always sets one). */
  readonly token: string | null;
  /** Runs `bun` for app processes (installs, dev servers). */
  readonly bunCommand: { readonly path: string; readonly env: Record<string, string> };
  /**
   * The key secrets are encrypted with, handed over by Electron (protected by
   * the OS keychain there). "locked": Electron couldn't unlock it. null: no
   * parent (standalone server, tests): a key file in the data dir is used.
   */
  readonly secretsKey: SecretsKey | "locked" | null;
}

export interface SecretsKey {
  /** 32 bytes, hex. */
  readonly key: string;
  readonly protection: "keychain" | "file";
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()("rune/ServerConfig") {}

const compiled = () => import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

export function readConfig(
  env: Record<string, string | undefined> = process.env,
  secretsKey: SecretsKey | "locked" | null = null,
): ServerConfigShape {
  const dataDir = resolve(env.RUNE_DATA_DIR ?? ".data");
  const appsDir = join(dataDir, "apps");
  const cacheDir = join(dataDir, "cache");
  const agentDir = join(dataDir, "agent");
  for (const dir of [dataDir, appsDir, cacheDir, agentDir]) mkdirSync(dir, { recursive: true });
  const port = Number(env.PORT ?? 3000);
  return {
    dataDir,
    appsDir,
    cacheDir,
    agentDir,
    port,
    url: `http://127.0.0.1:${port}`,
    allowedOrigin: env.RUNE_ALLOWED_ORIGIN ?? "http://localhost:5173",
    token: env.RUNE_TOKEN || null,
    // The compiled server is a Bun executable itself; BUN_BE_BUN makes it act as the bun CLI.
    bunCommand: compiled() ? { path: process.execPath, env: { BUN_BE_BUN: "1" } } : { path: process.execPath, env: {} },
    secretsKey,
  };
}

export const layer = (env?: Record<string, string | undefined>) =>
  Layer.effect(
    ServerConfig,
    Effect.sync(() => readConfig(env)),
  );
