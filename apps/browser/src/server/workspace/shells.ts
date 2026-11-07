// Which shell app commands (install, dev, build, start, run_command, scheduled
// commands) run in. Settings → Apps picks one; "auto" is /bin/sh on Linux and
// macOS and Bun's own cross-platform shell on Windows, where there is no sh.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ShellInfo } from "../../shared/api";

const windows = process.platform === "win32";

/** The command line to run `command` with `shell` (from detectShells, or a path). */
export interface ShellCommand {
  readonly argv: string[];
  /** Windows: pass the arguments as they are (cmd.exe does its own parsing). */
  readonly verbatim?: boolean;
}

interface Candidate {
  id: string;
  label: string;
  /** Names to look up on PATH, or absolute paths. */
  find: string[];
}

const programFiles = [
  process.env.ProgramFiles,
  process.env["ProgramFiles(x86)"],
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
].filter((dir): dir is string => !!dir);

const candidates: Candidate[] = windows
  ? [
      { id: "pwsh", label: "PowerShell 7", find: ["pwsh"] },
      { id: "powershell", label: "Windows PowerShell", find: ["powershell"] },
      { id: "cmd", label: "Command Prompt", find: [process.env.ComSpec ?? "cmd"] },
      // Git for Windows' bash (bin\bash.exe sets up its own PATH), never WSL's bash.exe in System32.
      { id: "git-bash", label: "Git Bash", find: programFiles.map((dir) => join(dir, "Git", "bin", "bash.exe")) },
      { id: "nu", label: "Nushell", find: ["nu"] },
    ]
  : [
      { id: "sh", label: "sh", find: ["/bin/sh"] },
      { id: "bash", label: "Bash", find: ["bash"] },
      { id: "zsh", label: "Zsh", find: ["zsh"] },
      { id: "fish", label: "Fish", find: ["fish"] },
      { id: "dash", label: "Dash", find: ["dash"] },
      { id: "nu", label: "Nushell", find: ["nu"] },
      { id: "pwsh", label: "PowerShell", find: ["pwsh"] },
    ];

function locate(names: string[]): string | null {
  for (const name of names) {
    if (/[\\/]/.test(name)) {
      if (existsSync(name)) return name;
    } else {
      const found = Bun.which(name);
      if (found) return found;
    }
  }
  return null;
}

let detected: ShellInfo[] | null = null;

/** The shells on this machine (Bun's shell is always there). Looked up once. */
export function detectShells(): ShellInfo[] {
  if (detected) return detected;
  const found: ShellInfo[] = [{ id: "bun", label: "Bun shell (cross-platform)", path: null }];
  for (const candidate of candidates) {
    const path = locate(candidate.find);
    if (path) found.push({ id: candidate.id, label: candidate.label, path });
  }
  detected = found;
  return found;
}

/** What "auto" means here. */
export const autoShell = (): string => (windows ? "bun" : "sh");

/** Resolves the setting to a shell id or an absolute path; unknown or missing shells fall back to auto. */
export function resolveShell(setting: string): { id: string; path: string | null } {
  const choice = setting === "auto" || !setting ? autoShell() : setting;
  if (choice === "bun") return { id: "bun", path: null };
  const known = detectShells().find((s) => s.id === choice);
  if (known) return { id: known.id, path: known.path };
  if (/[\\/]/.test(choice) && existsSync(choice)) return { id: "custom", path: choice };
  const fallback = autoShell();
  return fallback === "bun"
    ? { id: "bun", path: null }
    : { id: fallback, path: detectShells().find((s) => s.id === fallback)?.path ?? "/bin/sh" };
}

/** How a shell takes a command line, by its file name. */
function flavor(path: string): "posix" | "powershell" | "cmd" {
  const name = basename(path)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix"; // sh, bash, zsh, fish, nu, …: all take -c
}

/**
 * The argv that runs `command` in the chosen shell. `bun` is how to run Bun's
 * shell (`bun exec`), with the environment it needs.
 */
export function shellCommand(
  shell: { id: string; path: string | null },
  command: string,
  bun: { path: string },
): ShellCommand {
  if (shell.id === "bun" || !shell.path) return { argv: [bun.path, "exec", command] };
  switch (flavor(shell.path)) {
    case "powershell":
      return { argv: [shell.path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
    case "cmd":
      // Like Node's `shell: true`: /s strips the outer quotes, so the command keeps its own.
      return { argv: [shell.path, "/d", "/s", "/c", `"${command}"`], verbatim: true };
    default:
      return { argv: [shell.path, "-c", command] };
  }
}
