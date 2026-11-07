// App projects for tests, with commands that work in every shell app commands
// run in (sh on Linux and macOS, Bun's own shell on Windows): their "servers"
// are Bun scripts in the project rather than shell one-liners.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Keeps a script running, like a server. */
const STAY = "setInterval(() => {}, 1 << 30);";

/** Makes `code` (Bun) the app's dev server, which keeps running after it; in live mode the app only stays up. */
export function devScript(dir: string, code: string) {
  writeFileSync(join(dir, "dev.ts"), `${code}\n${STAY}\n`);
  writeFileSync(join(dir, "stay.ts"), `${STAY}\n`);
  writeFileSync(join(dir, "rune.json"), JSON.stringify({ install: "true", dev: "bun dev.ts", start: "bun stay.ts" }));
}

/** A dev server that writes an environment variable's value to `file` (empty if unset). */
export const writesVariable = (dir: string, name: string, file: string) =>
  devScript(dir, `await Bun.write(${JSON.stringify(file)}, process.env[${JSON.stringify(name)}] ?? "");`);
