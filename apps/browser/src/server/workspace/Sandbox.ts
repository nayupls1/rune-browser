// Where app processes run. With bubblewrap (Linux) every app gets a light
// sandbox of its own: it sees the system read-only (with the usual developer
// tools: git, curl, compilers, and the toolchains in your home folder), its
// project folder read-write (and its data folder) and a private /tmp, with its
// own process and IPC namespaces, so an app can't read your files or other
// apps. Without it (or on Windows and macOS), processes run directly in the
// project folder. Commands run in the shell chosen in Settings (shells.ts).
import { spawn as spawnChild, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { SandboxInfo, SandboxKind } from "../../shared/api";
import { ServerConfig, type ServerConfigShape } from "../Config";
import { Settings } from "../db/Settings";
import { detectShells, resolveShell, shellCommand } from "./shells";

const windows = process.platform === "win32";

export interface SpawnSpec {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Windows: the arguments go to the process as they are (cmd.exe). */
  readonly verbatim?: boolean;
}

export interface SandboxShape {
  /** What the current settings resolve to on this machine. */
  readonly kind: Effect.Effect<SandboxKind>;
  /** How to run `command` (a shell command line) for an app. `binds`: more folders it may read and write (its data). */
  readonly spawnSpec: (options: {
    dir: string;
    command: string;
    env: Record<string, string>;
    binds?: readonly string[];
  }) => Effect.Effect<SpawnSpec>;
  /** Directory with `bun`, `bunx` and `node` for app processes and agents. */
  readonly binDir: string;
  /** What app processes get here: sandbox, shells, toolchains (Settings → Apps). */
  readonly info: Effect.Effect<SandboxInfo>;
}

export class Sandbox extends Context.Service<Sandbox, SandboxShape>()("rune/Sandbox") {}

/** Starts a process from a spawn spec: its own process group (POSIX), no console window (Windows). */
export function spawnProcess(spec: SpawnSpec): ChildProcess {
  const [file, ...args] = spec.argv;
  return spawnChild(file!, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so it can be killed with its children. On Windows that would
    // give it a console of its own; taskkill /T finds the children there instead.
    detached: !windows,
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim ?? false,
  });
}

/** Kills a process and everything it started. */
export async function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (windows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await Promise.race([exited, Bun.sleep(3000)]);
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig); // the whole process group
    } catch {
      child.kill(sig);
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}

/**
 * `bun`, `bunx` and `node` that always work: the Bun Rune Browser runs on (from
 * source), or the compiled server acting as Bun (BUN_BE_BUN). On Windows
 * they're links to the executable (Bun acts as bunx when called that), since
 * shells there don't run scripts without an extension.
 */
function writeShims(config: ServerConfigShape) {
  const dir = join(config.dataDir, "bin");
  mkdirSync(dir, { recursive: true });
  const bun = config.bunCommand.path;
  if (windows) {
    for (const name of ["bun.exe", "bunx.exe", "node.exe"]) {
      const path = join(dir, name);
      try {
        const [have, want] = [statSync(path, { throwIfNoEntry: false }), statSync(bun)];
        if (have && have.size === want.size && have.mtimeMs >= want.mtimeMs) continue;
        rmSync(path, { force: true });
      } catch {
        continue; // in use by a running app: keep it
      }
      try {
        linkSync(bun, path);
      } catch {
        copyFileSync(bun, path); // another drive
      }
    }
    return dir;
  }
  const beBun = Object.keys(config.bunCommand.env).length > 0;
  const script = (args: string) =>
    `#!/bin/sh\n${beBun ? "BUN_BE_BUN=1 " : ""}exec ${JSON.stringify(bun)} ${args}"$@"\n`;
  const shims: Record<string, string | null> = {
    bun: beBun ? script("") : null,
    node: beBun ? script("") : null,
    bunx: script("x "),
  };
  for (const [name, content] of Object.entries(shims)) {
    const path = join(dir, name);
    rmSync(path, { force: true });
    if (content === null)
      symlinkSync(bun, path); // run as `node`, Bun behaves like Node
    else writeFileSync(path, content, { mode: 0o755 });
  }
  return dir;
}

async function bwrapWorks() {
  if (process.platform !== "linux" || !Bun.which("bwrap")) return false;
  try {
    const proc = Bun.spawn(
      ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "true"],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Binds a top-level system path the way it exists on the host (dir or symlink like /bin → usr/bin). */
function systemPath(path: string): string[] {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return ["--symlink", readlinkSync(path), path];
    return ["--ro-bind", path, path];
  } catch {
    return [];
  }
}

/** System folders the sandbox shows read-only, besides /usr and the /bin, /lib… links. */
const systemFolders = ["/etc", "/opt", "/nix", "/home/linuxbrew/.linuxbrew"];

/**
 * Where version managers keep the runtimes they install, in your home folder.
 * Only these are shown (read-only), never the rest of it: no ~/.ssh,
 * ~/.gitconfig or ~/.cargo/credentials. `env`: what the tool needs to find
 * them from another HOME.
 */
const toolchains: { path: string; env?: string }[] = [
  { path: ".local/share/mise/installs" },
  { path: ".asdf/installs" },
  { path: ".nvm/versions" },
  { path: ".volta", env: "VOLTA_HOME" },
  { path: ".rustup", env: "RUSTUP_HOME" },
  { path: ".cargo/bin" },
  { path: ".pyenv", env: "PYENV_ROOT" },
  { path: ".rbenv", env: "RBENV_ROOT" },
  { path: ".nodenv", env: "NODENV_ROOT" },
  { path: ".goenv", env: "GOENV_ROOT" },
  { path: ".sdkman/candidates" },
  { path: ".local/share/fnm" },
  { path: ".local/share/pnpm" },
  { path: ".local/share/uv/python" },
  { path: ".bun/bin" },
  { path: ".deno/bin" },
  { path: "go/bin" },
  { path: ".ghcup/bin" },
  { path: ".dotnet", env: "DOTNET_ROOT" },
];

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Git works out of the box: an identity for commits (not yours), and no "dubious ownership" errors. */
const gitconfig = `[user]
\tname = Rune Browser
\temail = rune@localhost
[init]
\tdefaultBranch = main
[safe]
\tdirectory = *
[advice]
\tdetachedHead = false
`;

/** The Windows variables programs can't do without (the rest of the environment is cleared, as on Linux). */
const windowsKeep = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "SystemDrive",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
  "COMPUTERNAME",
  "USERNAME",
];

/** Reads an environment variable the way Windows does: case doesn't matter. */
const hostEnv = (name: string) =>
  process.env[name] ?? Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* Settings;
  const binDir = writeShims(config);
  const bunCache = join(config.cacheDir, "bun");
  mkdirSync(bunCache, { recursive: true });
  const available = yield* Effect.promise(bwrapWorks);
  const home = homedir();
  const hostPath = (hostEnv("PATH") ?? "").split(delimiter).filter((p) => p && isAbsolute(p));
  const bunShim = join(binDir, windows ? "bun.exe" : "bun");

  const kind = settings
    .get()
    .pipe(Effect.map(({ apps }): SandboxKind => (apps.sandbox === "none" || !available ? "none" : "bwrap")));

  /** The folders the sandbox shows read-only besides the system, and the PATH inside it. */
  const view = (apps: { sandboxToolchains: boolean; sandboxReadOnly: readonly string[] }) => {
    const found = apps.sandboxToolchains
      ? toolchains.map((t) => ({ ...t, path: join(home, t.path) })).filter((t) => existsSync(t.path))
      : [];
    const extra = apps.sandboxReadOnly.filter((p) => isAbsolute(p)).map((p) => resolve(p));
    const readOnly = [...found.map((t) => t.path), ...extra.filter((p) => existsSync(p))];
    const visible = ["/usr", "/bin", "/sbin", "/lib", "/lib64", ...systemFolders, ...readOnly];
    // Your PATH, where the sandbox can see it. Version managers' shims need their config from your home, so they're left out.
    const path = [
      binDir,
      ...hostPath.filter((p) => visible.some((root) => under(p, root)) && !/[\\/](mise|asdf)[\\/]shims$/.test(p)),
    ];
    // Toolchains not on PATH (Rune Browser started from a launcher, without your shell's setup): mise's current versions.
    const mise = join(home, ".local/share/mise/installs");
    if (found.some((t) => t.path === mise) && !path.some((p) => under(p, mise))) {
      for (const tool of readdirSync(mise)) {
        const latest = join(mise, tool, "latest");
        path.push(existsSync(join(latest, "bin")) ? join(latest, "bin") : latest);
      }
    }
    for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) if (!path.includes(dir)) path.push(dir);
    const env: Record<string, string> = {};
    for (const t of found) if (t.env) env[t.env] = t.path;
    return { readOnly, extra, path: [...new Set(path)], env };
  };

  /** Rune Browser's HOME for the app's processes (inside the project, so its tools' config stays with it). */
  const prepareHome = (dir: string) => {
    const appHome = join(dir, ".rune", "home");
    mkdirSync(appHome, { recursive: true });
    const git = join(appHome, ".gitconfig");
    if (!existsSync(git)) writeFileSync(git, gitconfig);
    return appHome;
  };

  return {
    binDir,
    kind,
    info: Effect.gen(function* () {
      const { apps } = yield* settings.get();
      const current = yield* kind;
      const seen = view(apps);
      return {
        platform: process.platform,
        bwrapAvailable: available,
        kind: current,
        shells: detectShells(),
        shell: resolveShell(apps.shell),
        readOnly: current === "bwrap" ? seen.readOnly : [],
        path: current === "bwrap" ? seen.path : [binDir, ...hostPath],
      } satisfies SandboxInfo;
    }),
    spawnSpec: ({ dir, command, env, binds = [] }) =>
      Effect.gen(function* () {
        const { apps } = yield* settings.get();
        const appHome = prepareHome(dir);
        const shell = resolveShell(apps.shell);
        const run = shellCommand(shell, command, { path: bunShim });
        const base: Record<string, string> = {
          HOME: appHome,
          BUN_INSTALL_CACHE_DIR: bunCache,
          TMPDIR: "/tmp",
          LANG: process.env.LANG ?? "C.UTF-8",
          NO_COLOR: "1",
          ...env,
        };
        if ((yield* kind) === "none") {
          if (windows) {
            const tmp = join(dir, ".rune", "tmp");
            const appData = join(appHome, "AppData");
            for (const d of [tmp, join(appData, "Roaming"), join(appData, "Local")]) mkdirSync(d, { recursive: true });
            const keep: Record<string, string> = {};
            for (const name of windowsKeep) {
              const value = hostEnv(name);
              if (value !== undefined) keep[name] = value;
            }
            return {
              argv: run.argv,
              verbatim: run.verbatim,
              env: {
                ...keep,
                ...base,
                // The compiled server acts as Bun through bun.exe only with this (no wrapper scripts here).
                ...config.bunCommand.env,
                USERPROFILE: appHome,
                APPDATA: join(appData, "Roaming"),
                LOCALAPPDATA: join(appData, "Local"),
                TMPDIR: tmp,
                TEMP: tmp,
                TMP: tmp,
                PATH: [binDir, ...hostPath].join(delimiter),
              },
              cwd: dir,
            };
          }
          return {
            argv: run.argv,
            env: { ...base, PATH: [binDir, ...hostPath].join(delimiter) || "/usr/bin:/bin" },
            cwd: dir,
          };
        }
        const seen = view(apps);
        const sandboxEnv = { ...seen.env, ...base, PATH: seen.path.join(":"), TMPDIR: "/tmp" };
        // A shell from elsewhere (a custom path) is shown too, read-only.
        const shellBind =
          shell.path && !["/usr", "/bin", ...systemFolders, ...seen.readOnly].some((root) => under(shell.path!, root))
            ? ["--ro-bind-try", shell.path, shell.path]
            : [];
        // Your additions could include Rune Browser's own data (other apps, secrets): it's hidden again below.
        const hidesData = seen.extra.some((p) => under(config.dataDir, p));
        const argv = [
          Bun.which("bwrap") ?? "/usr/bin/bwrap",
          "--die-with-parent",
          "--new-session",
          "--unshare-pid",
          "--unshare-ipc",
          "--unshare-uts",
          "--unshare-cgroup-try",
          "--hostname",
          "rune",
          ...systemPath("/usr"),
          ...["/bin", "/sbin", "/lib", "/lib64", "/lib32"].flatMap(systemPath),
          ...systemFolders.flatMap((p) => ["--ro-bind-try", p, p]),
          // resolv.conf is often a link into /run (systemd-resolved).
          "--ro-bind-try",
          "/run/systemd/resolve",
          "/run/systemd/resolve",
          ...seen.readOnly.flatMap((p) => ["--ro-bind-try", p, p]),
          ...shellBind,
          ...(hidesData ? ["--tmpfs", config.dataDir] : []),
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/tmp",
          "--ro-bind",
          binDir,
          binDir,
          "--ro-bind",
          config.bunCommand.path,
          config.bunCommand.path,
          "--bind",
          bunCache,
          bunCache,
          "--bind",
          dir,
          dir,
          ...binds.flatMap((path) => ["--bind", path, path]),
          "--chdir",
          dir,
          "--",
          ...run.argv,
        ];
        // The environment goes to bwrap as its own (exactly this, nothing inherited) and on to
        // the app: never in the arguments, which every process on the machine can read.
        return { argv, env: sandboxEnv, cwd: dir };
      }),
  } satisfies SandboxShape;
});

export const layer = Layer.effect(Sandbox, make);
