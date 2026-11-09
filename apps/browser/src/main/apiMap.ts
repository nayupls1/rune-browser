// Sends web tabs' API calls, as shapes (shared/endpoints.ts), to the server's
// API map in batches. Values never get this far: main/network.ts only hands
// over what observe() keeps.
import type { Observation } from "../shared/endpoints";
import type { ServerHandle } from "./server";

const FLUSH_MS = 2000;
/** Calls waiting per workspace; a site making far more between flushes loses the rest (they're alike anyway). */
const MAX_QUEUED = 400;

export function apiMapReporter(getServer: () => ServerHandle | undefined) {
  const queues = new Map<string, Observation[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flush() {
    timer = undefined;
    const server = getServer();
    if (!server) return;
    for (const [workspaceId, observations] of [...queues]) {
      queues.delete(workspaceId);
      for (let i = 0; i < observations.length; i += 200) {
        await fetch(`${server.url}/api/endpoints/observe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
          body: JSON.stringify({ workspaceId, observations: observations.slice(i, i + 200) }),
        }).catch((err) => console.warn("Saving to the API map failed:", err));
      }
    }
  }

  return (workspaceId: string, observation: Observation) => {
    const queue = queues.get(workspaceId) ?? [];
    if (queue.length >= MAX_QUEUED) return;
    queue.push(observation);
    queues.set(workspaceId, queue);
    timer ??= setTimeout(() => void flush(), FLUSH_MS);
  };
}
