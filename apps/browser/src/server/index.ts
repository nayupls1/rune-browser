// The Rune Browser server: an Effect program. Services are layers; the HTTP router
// serves the API, the hub WebSocket and the MCP endpoint for agents. Closing
// the program (signal, Electron going away) stops agent turns.
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Fiber, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { readConfig } from "./Config";
import { cors, routes } from "./Http";
import { services } from "./services";

const config = readConfig(process.env);

const server = HttpRouter.serve(Layer.mergeAll(routes, cors(config.allowedOrigin)), {
  disableLogger: true,
  disableListenLog: true,
}).pipe(
  Layer.provide(services(config)),
  Layer.provide(
    BunHttpServer.layer({
      hostname: "127.0.0.1",
      port: config.port,
      // Agent tools can take a while; don't cut requests off.
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

// When spawned by Electron, stdin is a pipe owned by the main process. If
// Rune Browser dies without shutting us down cleanly, the pipe closes and we exit too.
if (process.env.RUNE_PARENT === "electron") {
  process.stdin.on("close", () => process.kill(process.pid, "SIGTERM"));
  process.stdin.resume();
}

BunRuntime.runMain(main);
