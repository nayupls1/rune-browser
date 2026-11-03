// The hub: WebSocket clients subscribe to topics and the server pushes chat
// events, runtime status, logs and other changes on them. The renderer also
// answers RPC requests, which is how agents reach pages open in its tabs. Each
// window's renderer says which tabs it has, so a request about a tab goes to
// the window it's in.
import { Context, Data, Effect, Layer } from "effect";
import type { Socket } from "effect/socket";
import { isValidTopic, type ClientMessage, type ServerMessage, type TopicMessage } from "../shared/hub";
import { isPrivateWindow } from "../shared/windows";

export class RpcError extends Data.TaggedError("RpcError")<{ readonly message: string }> {}

interface Client {
  readonly renderer: boolean;
  /** A private window's renderer: only asked about its own tabs. */
  readonly private: boolean;
  /** The tabs in the client's window (renderers report them). */
  tabs: Set<string>;
  readonly topics: Set<string>;
  readonly send: (text: string) => void;
}

export interface HubShape {
  readonly publish: (msg: TopicMessage) => Effect.Effect<void>;
  /** Fire-and-forget publish for non-Effect callers (process output handlers). */
  readonly publishUnsafe: (msg: TopicMessage) => void;
  /** Asks the Rune Browser window to do something (e.g. run JS in a page) and waits for the answer. */
  readonly rpc: <T>(method: string, params: unknown, timeoutMs?: number) => Effect.Effect<T, RpcError>;
  /** Serves one WebSocket connection until it closes. */
  readonly serve: (socket: Socket.Socket, options: { renderer: boolean; window?: string }) => Effect.Effect<void>;
  readonly rendererConnected: Effect.Effect<boolean>;
  /** Server-side listeners get every published message (the scheduler reacts to apps starting). Returns a remover. */
  readonly listen: (fn: (msg: TopicMessage) => void) => () => void;
}

export class Hub extends Context.Service<Hub, HubShape>()("rune/Hub") {}

export const make = Effect.sync((): HubShape => {
  const clients = new Set<Client>();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextRpcId = 0;

  const listeners = new Set<(msg: TopicMessage) => void>();
  const publishUnsafe = (msg: TopicMessage) => {
    const text = JSON.stringify(msg);
    for (const client of clients) if (client.topics.has(msg.topic)) client.send(text);
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch (err) {
        console.error("hub listener failed:", err);
      }
    }
  };

  /** The window a request goes to: the one with the tab it's about, else the newest normal window. */
  const renderer = (tabId?: unknown) => {
    const renderers = [...clients].reverse().filter((c) => c.renderer);
    return (
      (typeof tabId === "string" ? renderers.find((c) => c.tabs.has(tabId)) : undefined) ??
      renderers.find((c) => !c.private)
    );
  };

  const onMessage = (client: Client, raw: string) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "subscribe":
        if (isValidTopic(msg.topic)) client.topics.add(msg.topic);
        break;
      case "unsubscribe":
        client.topics.delete(msg.topic);
        break;
      case "tabs":
        if (client.renderer && Array.isArray(msg.ids))
          client.tabs = new Set(msg.ids.filter((id): id is string => typeof id === "string").slice(0, 5000));
        break;
      case "rpc-result": {
        if (!client.renderer) break;
        const call = pending.get(msg.id);
        if (!call) break;
        pending.delete(msg.id);
        if (msg.error !== undefined) call.reject(new Error(msg.error));
        else call.resolve(msg.result);
        break;
      }
    }
  };

  const decoder = new TextDecoder();

  return {
    publish: (msg) => Effect.sync(() => publishUnsafe(msg)),
    publishUnsafe,
    rendererConnected: Effect.sync(() => !!renderer()),
    listen: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    rpc: <T>(method: string, params: unknown, timeoutMs = 30_000) =>
      Effect.callback<T, RpcError>((resume) => {
        const target = renderer((params as { tabId?: unknown } | null)?.tabId);
        if (!target) return resume(Effect.fail(new RpcError({ message: "The Rune Browser window is not connected" })));
        const id = ++nextRpcId;
        const timer = setTimeout(() => {
          pending.delete(id);
          resume(Effect.fail(new RpcError({ message: `${method} timed out after ${timeoutMs / 1000}s` })));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resume(Effect.succeed(v as T))),
          reject: (e) => (clearTimeout(timer), resume(Effect.fail(new RpcError({ message: e.message })))),
        });
        target.send(JSON.stringify({ type: "rpc", id, method, params } satisfies ServerMessage));
        return Effect.sync(() => {
          clearTimeout(timer);
          pending.delete(id);
        });
      }),

    serve: (socket, options) =>
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const client: Client = {
          renderer: options.renderer,
          private: isPrivateWindow(options.window),
          tabs: new Set(),
          topics: new Set(),
          send: (text) => Effect.runFork(Effect.ignore(writer.write(text))),
        };
        clients.add(client);
        yield* Effect.addFinalizer(() => Effect.sync(() => clients.delete(client)));
        const reader = yield* socket.reader;
        for (;;) {
          const batch = yield* reader.pull;
          for (const chunk of batch) onMessage(client, typeof chunk === "string" ? chunk : decoder.decode(chunk));
        }
      }).pipe(Effect.scoped, Effect.ignore),
  };
});

export const layer = Layer.effect(Hub, make);
