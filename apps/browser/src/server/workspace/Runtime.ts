// Runs apps. While an app is being edited (dev mode) Rune Browser runs its dev server,
// which reloads on every change; when it's done (live mode) Rune Browser builds it and
// runs its start command. Either way the app listens on a port Rune Browser assigns
// and the renderer shows it in a preview tab. Processes run in the app's
// sandbox and stop with the server.
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Context, Effect, Fiber, FiberMap, Layer, Semaphore } from "effect";
import type { AppMode, LogLine, Manifest, RuntimeStatus } from "../../shared/api";
import { topics } from "../../shared/hub";
import { AiTokens } from "../ai/AiTokens";
import { ServerConfig } from "../Config";
import { Apps } from "../db/Apps";
import { Audit } from "../security/Audit";
import { Secrets } from "../security/Secrets";
import { Hub } from "../Hub";
import { AppData } from "./AppData";
import { killTree, Sandbox, spawnProcess } from "./Sandbox";
import { Workspace } from "./Workspace";

const MAX_LOG_LINES = 2000;

export interface RuntimeShape {
  readonly status: (appId: string) => Effect.Effect<RuntimeStatus>;
  readonly logs: (appId: string, limit?: number) => LogLine[];
  /** Adds a line from Rune Browser itself to the app's logs. */
  readonly note: (appId: string, text: string) => void;
  /** Starts the app in its mode unless it's already running (or has no project). */
  readonly ensure: (appId: string) => Effect.Effect<RuntimeStatus>;
  /** (Re)starts the app: installs dependencies if they changed, builds in live mode. */
  readonly restart: (appId: string) => Effect.Effect<RuntimeStatus>;
  readonly stop: (appId: string) => Effect.Effect<void>;
  /**
   * Restarts the app in the background if it's running or on its way (its
   * environment or files changed); `crashed` restarts a crashed one too.
   */
  readonly refresh: (appId: string, options?: { crashed?: boolean }) => Effect.Effect<void>;
  /** Switches between dev (being edited) and live (done), restarting the app. */
  readonly setMode: (appId: string, mode: AppMode) => Effect.Effect<RuntimeStatus>;
  /** Waits until the app is running, crashed or stopped (or the timeout passes). */
  readonly settled: (appId: string, timeoutMs?: number) => Effect.Effect<RuntimeStatus>;
  /** Runs a one-off command in the app's sandbox (installs, scripts, migrations). */
  readonly exec: (
    appId: string,
    command: string,
    timeoutMs?: number,
  ) => Effect.Effect<{ code: number | null; output: string; timedOut: boolean }>;
  /** Stops the app and forgets it (the app was deleted). */
  readonly forget: (appId: string) => Effect.Effect<void>;
}

export class Runtime extends Context.Service<Runtime, RuntimeShape>()("rune/Runtime") {}

const freePort = (preferred?: number | null) =>
  new Promise<number>((resolve, reject) => {
    const tryListen = (port: number) => {
      const srv = createServer();
      srv.once("error", () => (port ? tryListen(0) : reject(new Error("No free port"))));
      srv.listen(port, "127.0.0.1", () => {
        const { port: chosen } = srv.address() as { port: number };
        srv.close(() => resolve(chosen));
      });
    };
    tryListen(preferred ?? 0);
  });

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          socket.end();
          resolve(true);
        },
        connectError: () => resolve(false),
        data: () => {},
      },
    }).catch(() => resolve(false));
  });

interface State {
  status: RuntimeStatus;
  logs: LogLine[];
  /** Secret values the app's processes got: masked in its logs and command output. */
  redact: string[];
  port: number | null;
  /** Said that the app seems to listen on another port (once per start). */
  portHint: boolean;
  lock: Semaphore.Semaphore;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const aiTokens = yield* AiTokens;
  const secrets = yield* Secrets;
  const audit = yield* Audit;
  const apps = yield* Apps;
  const hub = yield* Hub;
  const sandbox = yield* Sandbox;
  const workspace = yield* Workspace;
  const appData = yield* AppData;
  const sessions = yield* FiberMap.make<string>();
  const states = new Map<string, State>();

  const stateOf = (appId: string): State => {
    let state = states.get(appId);
    if (!state) {
      state = {
        status: {
          mode: "dev",
          state: "stopped",
          url: null,
          port: null,
          exitCode: null,
          error: null,
          startedAt: null,
          sandbox: "none",
        },
        logs: [],
        redact: [],
        port: null,
        portHint: false,
        lock: Semaphore.makeUnsafe(1),
      };
      states.set(appId, state);
    }
    return state;
  };

  const setStatus = (appId: string, patch: Partial<RuntimeStatus>) => {
    const state = stateOf(appId);
    state.status = { ...state.status, ...patch };
    hub.publishUnsafe({ type: "runtime", topic: topics.app(appId), appId, status: state.status });
  };

  /** Masks the app's secret values (best effort: an app could still print them encoded). */
  const redact = (appId: string, text: string) => {
    let out = text;
    for (const value of stateOf(appId).redact) out = out.replaceAll(value, "••••••");
    return out;
  };

  const log = (appId: string, stream: LogLine["stream"], text: string) => {
    const state = stateOf(appId);
    const lines = redact(appId, text)
      .replace(/\r/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\n")
      .filter((line, i, all) => line.length > 0 || i < all.length - 1)
      .map((line): LogLine => ({ at: Date.now(), stream, text: line }));
    if (!lines.length) return;
    // A server that ignores $PORT never shows up: say so when its output names another port.
    if (stream !== "system" && state.status.state === "starting" && !state.portHint && state.port) {
      const other = lines
        .map((l) => /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/.exec(l.text)?.[1])
        .find((p) => p && Number(p) !== state.port);
      if (other) {
        state.portHint = true;
        lines.push({
          at: Date.now(),
          stream: "system",
          text: `The app seems to listen on port ${other}, but Rune Browser shows it on $PORT (${state.port}). Make its server use $PORT (or ask the agent to).`,
        });
      }
    }
    state.logs.push(...lines);
    if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
    hub.publishUnsafe({ type: "log", topic: topics.logs(appId), appId, lines });
  };

  /** Environment Rune Browser provides to the app's processes. Its data lives outside the project (AppData.ts). */
  const appEnv = (appId: string, mode: AppMode, port: number | null) =>
    Effect.map(appData.ensure(appId), (data): Record<string, string> => ({
      ...(port ? { PORT: String(port), HOST: "127.0.0.1", APP_URL: `http://127.0.0.1:${port}` } : {}),
      DATABASE_PATH: data.database,
      DATABASE_URL: `file:${data.database}`,
      RUNE_FILES_DIR: data.files,
      RUNE_APP_ID: appId,
      RUNE_MODE: mode,
      // Rune Browser's API for apps (other apps' data, with the user's OK). Server-side only, like AI.
      RUNE_API_URL: `${config.url}/app-api/v1`,
      RUNE_API_TOKEN: aiTokens.tokenFor(appId),
      // AI through Rune Browser (src/ai.ts in the presets). Server-side only: the token is the app's key.
      RUNE_AI_URL: `${config.url}/ai/v1`,
      RUNE_AI_TOKEN: aiTokens.tokenFor(appId),
      NODE_ENV: mode === "live" ? "production" : "development",
    }));

  /** Starts a command in the sandbox; stopping the scope kills it. */
  const spawnIn = (appId: string, command: string, env: Record<string, string>) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const spec = yield* sandbox.spawnSpec({ dir: workspace.dir(appId), command, env, binds: [appData.dir(appId)] });
        const child = spawnProcess(spec);
        child.stdout!.on("data", (chunk: Buffer) => log(appId, "out", chunk.toString()));
        child.stderr!.on("data", (chunk: Buffer) => log(appId, "err", chunk.toString()));
        const exited = new Promise<number | null>((resolve) => {
          child.once("exit", (code) => resolve(code));
          child.once("error", (err) => {
            log(appId, "system", `Couldn't start: ${err.message}`);
            resolve(-1);
          });
        });
        return { child, exited };
      }),
      ({ child }) => Effect.promise(() => killTree(child)),
    );

  /** Runs a command to completion (installs, builds). */
  const runToEnd = (appId: string, command: string, env: Record<string, string>, timeoutMs = 10 * 60_000) =>
    Effect.scoped(
      Effect.gen(function* () {
        log(appId, "system", `$ ${command}`);
        const { exited } = yield* spawnIn(appId, command, env);
        const code = yield* Effect.promise(() => exited).pipe(
          Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed("timeout" as const) }),
        );
        return code;
      }),
    );

  const installStamp = (appId: string) => join(workspace.stateDir(appId), "installed");

  /** Whether dependencies changed since the last successful install. */
  const needsInstall = (appId: string, manifest: Manifest) => {
    const dir = workspace.dir(appId);
    if (!manifest.install && !existsSync(join(dir, "package.json"))) return false;
    if (!existsSync(installStamp(appId))) return true;
    if (!manifest.install && !existsSync(join(dir, "node_modules"))) return true;
    const stamp = statSync(installStamp(appId)).mtimeMs;
    return ["package.json", "bun.lock", "bun.lockb"].some((f) => {
      const path = join(dir, f);
      return existsSync(path) && statSync(path).mtimeMs > stamp;
    });
  };

  const fail = (appId: string, error: string, exitCode: number | null = null) => {
    log(appId, "system", error);
    setStatus(appId, { state: "crashed", error, exitCode, url: null });
  };

  /** One run of the app: install → (build) → serve, until it exits or is stopped. */
  const session = (appId: string, mode: AppMode) =>
    Effect.gen(function* () {
      const state = stateOf(appId);
      state.portHint = false;
      const kind = yield* sandbox.kind;
      setStatus(appId, { mode, sandbox: kind, exitCode: null, error: null, url: null, port: null, startedAt: null });
      const manifest = yield* workspace
        .manifest(appId)
        .pipe(Effect.catch((err) => Effect.sync(() => (fail(appId, err.message), undefined))));
      if (manifest === undefined) return;
      if (manifest === null) {
        setStatus(appId, { state: "stopped" });
        return;
      }
      const env = yield* appEnv(appId, mode, null);
      // The app's secrets: for build and serve, not for installing dependencies.
      const secretEnv = yield* secrets
        .envFor(appId)
        .pipe(
          Effect.catchTag("VaultLocked", (e) =>
            Effect.sync(
              () => (log(appId, "system", `${e.message}; starting without secrets`), {} as Record<string, string>),
            ),
          ),
        );
      const names = Object.keys(secretEnv);
      state.redact = Object.values(secretEnv)
        .filter((v) => v.length >= 4)
        .sort((a, b) => b.length - a.length);
      if (names.length) {
        log(appId, "system", `Secrets: ${names.join(", ")}`);
        yield* audit.record({
          actor: "rune",
          actorLabel: "Rune Browser",
          tabId: appId,
          action: "secret.inject",
          target: names.join(", "),
          detail: `Started in ${mode} mode`,
        });
      }

      if (needsInstall(appId, manifest)) {
        setStatus(appId, { state: "installing" });
        const code = yield* runToEnd(appId, manifest.install ?? "bun install", env);
        if (code !== 0)
          return fail(
            appId,
            code === "timeout"
              ? "Installing dependencies timed out"
              : `Installing dependencies failed (exit code ${code})`,
          );
        writeFileSync(installStamp(appId), new Date().toISOString());
      }

      if (mode === "live" && manifest.build) {
        setStatus(appId, { state: "building" });
        const code = yield* runToEnd(appId, manifest.build, { ...secretEnv, ...env });
        if (code !== 0)
          return fail(appId, code === "timeout" ? "The build timed out" : `The build failed (exit code ${code})`);
      }

      const port = yield* Effect.promise(() => freePort(state.port));
      state.port = port;
      const command = mode === "live" ? manifest.start : manifest.dev;
      setStatus(appId, { state: "starting", port });
      log(appId, "system", `$ ${command}  (PORT=${port}, ${kind === "bwrap" ? "sandboxed" : "not sandboxed"})`);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { exited } = yield* spawnIn(appId, command, { ...secretEnv, ...(yield* appEnv(appId, mode, port)) });
          const ready = yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (!(yield* Effect.promise(() => listening(port)))) yield* Effect.sleep(250);
              setStatus(appId, {
                state: "running",
                url: `http://127.0.0.1:${port}`,
                startedAt: new Date().toISOString(),
              });
            }),
          );
          const code = yield* Effect.promise(() => exited);
          yield* Fiber.interrupt(ready);
          const wasRunning = stateOf(appId).status.state === "running";
          fail(appId, `The app ${wasRunning ? "stopped" : "exited before it was ready"} (exit code ${code})`, code);
        }),
      );
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => setStatus(appId, { state: "stopped", url: null }))));

  const start = (appId: string, mode: AppMode) =>
    stateOf(appId).lock.withPermits(1)(
      Effect.gen(function* () {
        yield* FiberMap.remove(sessions, appId);
        // Not "stopped" from here on, even before the session gets going (reading the manifest, secrets…):
        // whoever started it waits for it (settled) instead of giving up at once.
        setStatus(appId, { state: "starting", url: null, port: null, error: null, exitCode: null });
        yield* FiberMap.run(sessions, appId, session(appId, mode));
        // Let the session publish its first status.
        yield* Effect.yieldNow;
        return stateOf(appId).status;
      }),
    );

  const modeOf = (appId: string) => apps.get(appId).pipe(Effect.map((app) => app?.mode ?? "dev"));

  const settled = (appId: string, timeoutMs = 120_000) =>
    Effect.gen(function* () {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { state } = stateOf(appId).status;
        if (state === "running" || state === "crashed" || state === "stopped" || Date.now() > deadline)
          return stateOf(appId).status;
        yield* Effect.sleep(200);
      }
    });

  return {
    status: (appId) => Effect.sync(() => stateOf(appId).status),
    logs: (appId, limit = 200) => stateOf(appId).logs.slice(-limit),

    ensure: (appId) =>
      Effect.gen(function* () {
        const { state } = stateOf(appId).status;
        if (state !== "stopped" && state !== "crashed") return stateOf(appId).status;
        if (!(yield* workspace.info(appId))) return stateOf(appId).status;
        return yield* start(appId, yield* modeOf(appId));
      }),

    restart: (appId) => Effect.flatMap(modeOf(appId), (mode) => start(appId, mode)),

    stop: (appId) => stateOf(appId).lock.withPermits(1)(FiberMap.remove(sessions, appId)),

    refresh: (appId, options) =>
      Effect.gen(function* () {
        const { state } = stateOf(appId).status;
        if (state === "stopped" || (state === "crashed" && !options?.crashed)) return;
        yield* Effect.forkDetach(Effect.flatMap(modeOf(appId), (mode) => start(appId, mode)));
      }),

    setMode: (appId, mode) => apps.setMode(appId, mode).pipe(Effect.andThen(start(appId, mode))),

    settled,

    exec: (appId, command, timeoutMs = 120_000) =>
      Effect.scoped(
        Effect.gen(function* () {
          const mode = yield* modeOf(appId);
          let output = "";
          // The app's port too, so commands can talk to the running app (curl $APP_URL/…).
          const spec = yield* sandbox.spawnSpec({
            dir: workspace.dir(appId),
            command,
            env: yield* appEnv(appId, mode, stateOf(appId).port),
            binds: [appData.dir(appId)],
          });
          const child = yield* Effect.acquireRelease(
            Effect.sync(() => spawnProcess(spec)),
            (c) => Effect.promise(() => killTree(c)),
          );
          const append = (chunk: Buffer) => {
            output = `${output}${chunk.toString()}`.slice(-20_000);
          };
          child.stdout!.on("data", append);
          child.stderr!.on("data", append);
          const code = yield* Effect.promise(
            () =>
              new Promise<number | null>(
                (resolve) => (child.once("exit", resolve), child.once("error", () => resolve(-1))),
              ),
          ).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed("timeout" as const) }));
          return {
            code: code === "timeout" ? null : code,
            // eslint-disable-next-line no-control-regex
            output: redact(appId, output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim()),
            timedOut: code === "timeout",
          };
        }),
      ),

    note: (appId, text) => log(appId, "system", text),

    forget: (appId) =>
      FiberMap.remove(sessions, appId).pipe(
        Effect.andThen(
          Effect.sync(() => {
            states.delete(appId);
            aiTokens.revoke(appId);
          }),
        ),
      ),
  } satisfies RuntimeShape;
});

export const layer = Layer.effect(Runtime, make);
