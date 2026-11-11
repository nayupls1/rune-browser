// Permissions in the renderer: permission requests waiting for the user
// (shown by PermissionHost), and a version counter that bumps when remembered
// permissions change, so views refetch.
import { createSignal } from "solid-js";
import type { PermissionRequest } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "./api";
import { onConnected, watchTopic } from "./realtime";

const [requests, setRequests] = createSignal<PermissionRequest[]>([]);
const [version, setVersion] = createSignal(0);

/** Requests waiting for an answer, oldest first. */
export { requests as permissionRequests };
/** Bumps when remembered permissions change. */
export { version as securityVersion };

// Agents ask in the normal windows: a private window has nothing to do with them.
watchTopic(topics.permissions, (msg) => {
  if (window.rune.window.private) return;
  if (msg.type === "permission-request")
    setRequests((list) => (list.some((r) => r.id === msg.request.id) ? list : [...list, msg.request]));
  else if (msg.type === "permission-resolved") setRequests((list) => list.filter((r) => r.id !== msg.id));
});

watchTopic(topics.activity, (msg) => {
  if (msg.type === "permissions-changed") setVersion((v) => v + 1);
});

// What was asked while disconnected.
onConnected(() => !window.rune.window.private && void api.pendingPermissions().then(setRequests, () => {}));

export async function answerPermission(id: string, allow: boolean, remember: boolean | "workspace") {
  setRequests((list) => list.filter((r) => r.id !== id));
  await api.answerPermission(id, allow, remember).catch(() => {});
}
