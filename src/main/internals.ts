// What Rune Browser's internal pages need from the main process (shared/internalPages.ts):
// rune://version, rune://gpu and rune://flags. Only Rune Browser's window asks.
import { app, ipcMain } from "electron";
import { arch, release, type, version } from "node:os";
import { cleanFlagState, type FlagsInfo, type FlagState } from "../shared/flags";
import type { GpuReport, VersionInfo } from "../shared/internalPages";
import { readFlags, writeFlags } from "./flags";
import { webUserAgent } from "./web";
import type { AppWindows } from "./windows";

/** Complete GPU info can take a while (it starts the GPU's info collection); basic info after this long. */
const COMPLETE_GPU_INFO_MS = 4000;

export function setupInternals(options: {
  windows: AppWindows;
  /** The flags in effect since startup. */
  appliedFlags: FlagState;
  safeMode: boolean;
}) {
  const fromWindow = (event: Electron.IpcMainInvokeEvent) => options.windows.isUi(event.sender);

  ipcMain.handle("rune:internals-version", (event): VersionInfo | null => {
    if (!fromWindow(event)) return null;
    let os = `${type()} ${release()} (${arch()})`;
    try {
      os = `${type()} ${version()} ${release()} (${arch()})`;
    } catch {}
    return {
      rune: app.getVersion(),
      packaged: app.isPackaged,
      chromium: process.versions.chrome ?? "",
      electron: process.versions.electron ?? "",
      v8: process.versions.v8 ?? "",
      node: process.versions.node ?? "",
      os,
      userAgent: webUserAgent(),
      commandLine: process.argv.join(" "),
      executablePath: process.execPath,
      profilePath: app.getPath("userData"),
    };
  });

  ipcMain.handle("rune:internals-gpu", async (event): Promise<GpuReport | null> => {
    if (!fromWindow(event)) return null;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), COMPLETE_GPU_INFO_MS));
    const info =
      (await Promise.race([app.getGPUInfo("complete").catch(() => null), timeout])) ??
      (await app.getGPUInfo("basic").catch(() => ({})));
    return {
      featureStatus: app.getGPUFeatureStatus() as unknown as Record<string, string>,
      info: info as Record<string, unknown>,
    };
  });

  const flagsInfo = (): FlagsInfo => ({
    state: readFlags(),
    applied: options.appliedFlags,
    safeMode: options.safeMode,
  });
  ipcMain.handle("rune:internals-flags", (event) => (fromWindow(event) ? flagsInfo() : null));
  ipcMain.handle("rune:internals-set-flag", (event, id: unknown, value: unknown) => {
    if (!fromWindow(event) || typeof id !== "string" || typeof value !== "string") return null;
    writeFlags(cleanFlagState({ ...readFlags(), [id]: value }, process.platform));
    return flagsInfo();
  });
  ipcMain.handle("rune:internals-reset-flags", (event) => {
    if (!fromWindow(event)) return null;
    writeFlags({});
    return flagsInfo();
  });
}
