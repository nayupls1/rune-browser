// Headless tabs (main/headless.ts): the website agent's requests from the server
// (agent/headlessTools.ts) go to the main process, and the agent's tab lists the
// ones open for it above its composer (components/Chat.tsx), where the user can
// open a page in a real tab or close it.
import { createSignal } from "solid-js";
import type { HeadlessInfo, HeadlessOpenRequest } from "../../shared/api";
import { handleRpc } from "./realtime";

const headless = window.rune.web.headless;

const [open, setOpen] = createSignal<HeadlessInfo[]>([]);
headless.onChanged(setOpen);
void headless.list().then(setOpen, () => {});

/** The headless tabs the agent of a tab has open. */
export const headlessTabsOf = (tabId: string) => open().filter((h) => h.tabId === tabId);

/** Closes a headless tab (the agent is told it's gone if it uses it again). */
export const closeHeadlessTab = (id: string) => void headless.close(id).catch(() => {});

const str = (value: unknown) => (typeof value === "string" ? value : "");
const hosts = (value: unknown) => (Array.isArray(value) ? value.filter((h) => typeof h === "string") : []);

handleRpc("headless.open", (params) =>
  headless.open({
    tabId: str(params.tabId),
    workspaceId: str(params.workspaceId),
    url: str(params.url),
    logins: params.logins === true,
    hosts: hosts(params.hosts),
  } satisfies HeadlessOpenRequest),
);
handleRpc("headless.navigate", (params) => headless.navigate(str(params.id), str(params.url), hosts(params.hosts)));
handleRpc("headless.eval", (params) => headless.eval(str(params.id), str(params.code)));
handleRpc("headless.close", (params) => headless.close(str(params.id)));
handleRpc("headless.closeTab", (params) => headless.closeTab(str(params.tabId)));
