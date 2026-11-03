// Dev orchestrator: Vite dev server for the renderer (HMR), Bun-bundled
// main/preload that rebuild + restart Electron on change. The Electron main
// process itself spawns the Bun server with --watch.
import { watch } from "node:fs";
import type { Subprocess } from "bun";
import { createServer } from "vite";
import { buildElectron, launchElectron } from "./electron";

const vite = await createServer({ configFile: "vite.config.ts" });
await vite.listen();
const devServerUrl = vite.resolvedUrls?.local[0];
if (!devServerUrl) throw new Error("Vite dev server did not report a URL");
vite.printUrls();

let electron: Subprocess | undefined;
let restarting = false;

async function startElectron() {
  await buildElectron({ dev: true });
  electron = await launchElectron(
    {
      VITE_DEV_SERVER_URL: devServerUrl,
      RUNE_BUN_PATH: process.execPath,
    },
    process.argv.slice(2),
  );
  electron.exited.then(() => {
    // User closed the app → stop the whole dev session.
    if (!restarting) shutdown();
  });
}

async function restartElectron() {
  restarting = true;
  if (electron) {
    electron.kill();
    await electron.exited;
  }
  restarting = false;
  try {
    await startElectron();
  } catch (err) {
    console.error(err);
  }
}

async function shutdown() {
  electron?.kill();
  await vite.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let timer: Timer | undefined;
for (const dir of ["src/main", "src/preload", "src/shared"]) {
  watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log("[dev] main/preload changed, restarting Electron…");
      restartElectron();
    }, 100);
  });
}

await startElectron();
