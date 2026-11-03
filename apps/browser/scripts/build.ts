// Production build:
//   dist/renderer  – SolidJS app (Vite)
//   dist/electron  – Electron main + preload (Bun bundler)
//   dist/server    – Bun server compiled to a standalone executable
import { rm } from "node:fs/promises";
import { build as viteBuild } from "vite";
import { buildElectron } from "./electron";

const exe = process.platform === "win32" ? ".exe" : "";
const serverBinary = `rune-server${exe}`;

await rm("dist", { recursive: true, force: true });

console.log("› renderer");
await viteBuild({ configFile: "vite.config.ts", logLevel: "warn" });

console.log("› electron");
await buildElectron();

console.log("› server");
await Bun.$`bun build --compile --minify --sourcemap src/server/index.ts --outfile dist/server/${serverBinary}`.quiet();

console.log("✓ build complete — run `bun run start` to launch");
