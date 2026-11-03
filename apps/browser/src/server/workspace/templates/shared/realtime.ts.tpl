// Realtime updates over one WebSocket (/api/live). The server publishes on a
// topic after every write; clients subscribe (src/live.ts) and refetch or use
// the data right away. Clients can also publish to each other (presence,
// cursors, typing indicators): those messages aren't stored anywhere.
import type { Server, WebSocketHandler } from "bun";

let server: Server<unknown> | undefined;

export const realtime = {
  /** Connects publish() to the running server. Call once after serve(). */
  attach(s: Server<unknown>) {
    server = s;
  },

  /** Route handler for "/api/live". */
  upgrade(req: Request, s: Server<unknown>) {
    server ??= s;
    return s.upgrade(req, { data: {} }) ? undefined : new Response("Expected a WebSocket", { status: 426 });
  },

  /** Sends a message to every client subscribed to `topic`. Call it after changing data. */
  publish(topic: string, data?: unknown) {
    server?.publish(topic, JSON.stringify({ topic, data }));
  },

  websocket: {
    message(ws, raw) {
      let msg: { subscribe?: string; unsubscribe?: string; publish?: string; data?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.subscribe) ws.subscribe(msg.subscribe);
      if (msg.unsubscribe) ws.unsubscribe(msg.unsubscribe);
      if (msg.publish) ws.publish(msg.publish, JSON.stringify({ topic: msg.publish, data: msg.data }));
    },
  } satisfies WebSocketHandler<unknown>,
};
