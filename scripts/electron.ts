import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
// Outside of Electron, the `electron` package exports the path to its binary.
import electronBinary from "electron";
import { chmodSync, copyFileSync, renameSync, rmSync, statSync } from "node:fs";

// Bundles the Electron main + preload scripts (the window's, and the one of web
// tab sessions for extensions) with Bun. Electron ships its own
// Node runtime, so these target Node and are emitted as CommonJS (sandboxed
// preload scripts must be CJS).
export async function buildElectron({ dev = false } = {}) {
  const result = await Bun.build({
    entrypoints: ["src/main/index.ts", "src/preload/index.ts", "src/extension-preload/index.ts"],
    outdir: "dist/electron",
    root: "src",
    target: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: dev ? "inline" : "none",
    minify: !dev,
    naming: "[dir].cjs",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Electron build failed");
  }
  // The window's icon (main/index.ts): .ico on Windows, .png elsewhere.
  for (const icon of ["icon.png", "icon.ico"]) copyFileSync(`build/${icon}`, `dist/electron/${icon}`);
}

/**
 * Electron stores cookies (web tab logins) unencrypted unless this fuse in its
 * binary is on; then they're encrypted with the key in the OS keychain, like
 * Chrome's. The packaged app gets it from electron-builder.yml; for runs from
 * node_modules it's switched on here, once. The binary is replaced rather than
 * written to, since other instances may be running it.
 */
async function encryptCookies(binary: string) {
  const wire = await getCurrentFuseWire(binary);
  if (wire[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE) return;
  const copy = `${binary}.fuses-${process.pid}`;
  try {
    copyFileSync(binary, copy);
    await flipFuses(copy, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: process.platform === "darwin",
      [FuseV1Options.EnableCookieEncryption]: true,
    });
    chmodSync(copy, statSync(binary).mode);
    renameSync(copy, binary);
  } finally {
    rmSync(copy, { force: true });
  }
}

/** Launches the Electron app in the current directory. */
export async function launchElectron(env: Record<string, string | undefined> = {}, args: string[] = []) {
  await encryptCookies(electronBinary as unknown as string);
  const childEnv = { ...process.env, ...env };
  // Set by Electron-based hosts (VS Code, T3 Code, …) for their child processes;
  // if inherited, Electron would boot as plain Node and the app would crash.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  // Chromium refuses to run as root (containers, CI) with its sandbox on.
  const rootArgs = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  return Bun.spawn([electronBinary as unknown as string, ".", ...rootArgs, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: childEnv,
  });
}
