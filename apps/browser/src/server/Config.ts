// Server configuration, read once from the environment. Electron passes the
// port, the renderer's origin, the API token and its userData dir.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";

export interface ServerConfigShape {
  /** Where all persistent state lives. */
  readonly dataDir: string;
  /** Rune Browser's own caches (an empty hooks folder for git). */
  readonly cacheDir: string;
  /** Empty working directory for agents (the website agent has no project of its own, and model lists). */
  readonly agentDir: string;
  readonly port: number;
  /** Base URL of this server, e.g. http://127.0.0.1:41807 */
  readonly url: string;
  /** The renderer's origin; the only browser origin allowed to call the API. */
  readonly allowedOrigin: string;
  /** Required on API requests when set (Electron always sets one). */
  readonly token: string | null;
  /** A new profile starts without first-run setup (RUNE_SKIP_ONBOARDING=1: checks and scripts; main/server.ts passes it only unpackaged). */
  readonly skipOnboarding: boolean;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()("rune/ServerConfig") {}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfigShape {
  const dataDir = resolve(env.RUNE_DATA_DIR ?? ".data");
  const cacheDir = join(dataDir, "cache");
  const agentDir = join(dataDir, "agent");
  for (const dir of [dataDir, cacheDir, agentDir]) mkdirSync(dir, { recursive: true });
  const port = Number(env.PORT ?? 3000);
  return {
    dataDir,
    cacheDir,
    agentDir,
    port,
    url: `http://127.0.0.1:${port}`,
    allowedOrigin: env.RUNE_ALLOWED_ORIGIN ?? "http://localhost:5173",
    token: env.RUNE_TOKEN || null,
    skipOnboarding: env.RUNE_SKIP_ONBOARDING === "1",
  };
}

export const layer = (env?: Record<string, string | undefined>) =>
  Layer.effect(
    ServerConfig,
    Effect.sync(() => readConfig(env)),
  );
