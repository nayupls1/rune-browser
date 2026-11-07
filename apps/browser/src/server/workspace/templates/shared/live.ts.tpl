// Realtime client. subscribe(topic, fn) gets every message published on the
// topic, by the server (realtime.publish) or other clients (publish below).
// Reconnects on its own; onReconnect lets you refetch what was missed.
type Listener = (data: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const reconnectListeners = new Set<() => void>();
let socket: WebSocket | undefined;
let retry = 0;
let connectedBefore = false;

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    for (const topic of listeners.keys()) ws.send(JSON.stringify({ subscribe: topic }));
    if (connectedBefore) for (const fn of reconnectListeners) fn();
    connectedBefore = true;
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { topic: string; data?: unknown };
    for (const fn of listeners.get(msg.topic) ?? []) fn(msg.data);
  };
  ws.onclose = () => setTimeout(connect, Math.min(250 * 2 ** retry++, 5000));
}

function send(msg: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/** Calls `fn` with every message on `topic`. Returns a function that unsubscribes. */
export function subscribe(topic: string, fn: Listener): () => void {
  if (!socket) connect();
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
    send({ subscribe: topic });
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) {
      listeners.delete(topic);
      send({ unsubscribe: topic });
    }
  };
}

/** Sends `data` to every other client subscribed to `topic`. */
export function publish(topic: string, data?: unknown) {
  if (!socket) connect();
  send({ publish: topic, data });
}

/** Calls `fn` when the connection comes back after dropping. */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}
