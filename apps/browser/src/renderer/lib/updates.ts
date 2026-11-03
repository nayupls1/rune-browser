// Updates of Rune Browser itself, as the main process reports them
// (main/updates.ts): shown in Settings → About, with a notice once one is
// downloaded.
import { createSignal } from "solid-js";
import type { UpdateChannel, UpdateInfo } from "../../shared/updates";
import { toast } from "../components/Toast";

const bridge = window.rune.updates;

const [info, setInfo] = createSignal<UpdateInfo | null>(null);
export const updateInfo = info;

const receive = (next: UpdateInfo | null) => {
  if (!next) return;
  const was = info()?.status;
  setInfo(next);
  if (next.status.state === "ready" && was?.state !== "ready" && !window.rune.offscreen) {
    toast({
      title: `Rune Browser ${next.status.version} is ready`,
      message: "It's installed when Rune Browser restarts (Settings → About).",
      kind: "success",
    });
  }
};

bridge.onChanged(receive);
void bridge.get().then(receive);

export const checkForUpdates = () => bridge.check().then(receive);
export const setUpdateChannel = (channel: UpdateChannel) => bridge.setChannel(channel).then(receive);
export const installUpdate = () => bridge.install();
