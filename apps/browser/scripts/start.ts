// Runs the production build (`bun run build` first) unpackaged.
import { existsSync } from "node:fs";
import { launchElectron } from "./electron";

if (!existsSync("dist/electron/main.cjs")) {
  console.error("No build found — run `bun run build` first.");
  process.exit(1);
}

// Extra CLI args are forwarded to Electron, e.g. `bun run start --inspect`.
const electron = await launchElectron({}, process.argv.slice(2));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => electron.kill(signal));
}
process.exit(await electron.exited);
