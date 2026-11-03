// The Rune Browser server: an Effect program. Services are layers; the HTTP router
// serves the API, the hub WebSocket and the MCP endpoint for agents. Closing
// the program (signal, Electron going away) stops agent turns and app processes.
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Fiber, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { readConfig, type SecretsKey } from "./Config";
import { cors, routes } from "./Http";
import { services } from "./services";

/**
 * Electron sends the secrets key as the first line on stdin (not in the
 * environment or arguments, which other processes of the user can read).
 */
function keyFromParent(): Promise<SecretsKey | "locked"> {
  // `bun run dev` only: the server restarts on changes and can't read stdin again.
  if (process.env.RUNE_DEV_SECRETS_KEY)
    return Promise.resolve(JSON.parse(process.env.RUNE_DEV_SECRETS_KEY) as SecretsKey);
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => done("locked"), 10_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        const message = JSON.parse(buffer.slice(0, end)) as { secretsKey?: SecretsKey | null };
        done(message.secretsKey?.key ? message.secretsKey : "locked");
      } catch {
        done("locked");
      }
    };
    const done = (key: SecretsKey | "locked") => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(key);
    };
    process.stdin.on("data", onData);
  });
}

const fromElectron = process.env.RUNE_PARENT === "electron";
const config = readConfig(process.env, fromElectron ? await keyFromParent() : null);

const server = HttpRouter.serve(Layer.mergeAll(routes, cors(config.allowedOrigin)), {
  disableLogger: true,
  disableListenLog: true,
}).pipe(
  Layer.provide(services(config)),
  Layer.provide(
    BunHttpServer.layer({
      hostname: "127.0.0.1",
      port: config.port,
      // Agent tools and app builds can take a while; don't cut requests off.
      idleTimeout: 0,
      websocket: { idleTimeout: 120, sendPings: true },
    }),
  ),
);

const main = Layer.launch(server).pipe(
  Effect.onExit(() => Effect.sync(() => console.log("[server] stopped"))),
  Effect.forkChild,
  Effect.tap(() => Effect.sync(() => console.log(`[server] listening on ${config.url}/`))),
  Effect.flatMap(Fiber.join),
);

// When spawned by Electron, stdin is a pipe owned by the main process. If the
// app dies without shutting us down cleanly, the pipe closes and we exit too.
if (process.env.RUNE_PARENT === "electron") {
  process.stdin.on("close", () => process.kill(process.pid, "SIGTERM"));
  process.stdin.resume();
}

BunRuntime.runMain(main);
