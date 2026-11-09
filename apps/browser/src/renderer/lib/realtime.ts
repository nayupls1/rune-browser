// The renderer's connection to the hub: agent output, app status and logs,
// tab list changes, and requests from the server (the agents' page tools).
import { createSignal } from "solid-js";
import { Socket, type TopicMessage } from "../../shared/hub";
import { serverReady } from "./api";

// The window's id: requests about its tabs come here (Hub.ts).
const socket = new Socket(
  `${window.rune.serverUrl.replace(/^http/, "ws")}/api/ws?role=renderer&window=${encodeURIComponent(window.rune.window.id)}&token=${encodeURIComponent(window.rune.token)}`,
  serverReady,
);

/** Tells the server which tabs this window has (agents' requests about them come here). */
export const reportTabs = (ids: string[]) => socket.setTabs(ids);

const [connected, setConnected] = createSignal(false);
socket.onConnection(setConnected);
export { connected as realtimeConnected };

/** Calls `fn` whenever the connection (re)opens, e.g. to refetch what may have been missed. */
export function onConnected(fn: () => void) {
  return socket.onConnection((connected) => {
    if (connected) fn();
  });
}

export function watchTopic(topic: string, fn: (msg: TopicMessage) => void) {
  return socket.subscribe(topic, fn);
}

type RpcHandler = (params: any) => unknown;
const rpcHandlers = new Map<string, RpcHandler>();

/** Registers a handler for server → renderer requests. */
export function handleRpc(method: string, fn: RpcHandler) {
  rpcHandlers.set(method, fn);
}

// For the e2e checks: what the server's requests to the window do, without an agent turn.
(window as unknown as { __runeRpc?: (method: string, params: unknown) => unknown }).__runeRpc = (method, params) => {
  const fn = rpcHandlers.get(method);
  if (!fn) throw new Error(`Unknown request: ${method}`);
  return fn(params);
};

socket.onRpc = (method, params) => {
  const fn = rpcHandlers.get(method);
  if (!fn) throw new Error(`Unknown request: ${method}`);
  return fn(params);
};
