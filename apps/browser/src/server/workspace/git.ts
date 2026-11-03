// Git for Rune Browser itself: cloning projects into new app tabs (Workspace.ts)
// and repositories attached to a tab for its agent (Sources.ts), pulling them
// again, and reading their state. It runs with your own Git setup (credential
// helpers, SSH keys and agent), so private repositories work, but never
// prompts: Rune Browser has no terminal to answer in. No hooks run.
import { basename } from "node:path";
import { Effect } from "effect";
import { agentEnv } from "../providers/process";

/**
 * What a link to a repository means: https links (GitHub's /tree/<branch>
 * pages too), SSH links (git@host:owner/repo, ssh://), host/owner/repo
 * without a scheme and GitHub's owner/repo. null when it isn't one; local
 * paths and file:// links are for "Import a folder".
 */
export function parseGitSource(
  input: string,
  branch?: string,
): { url: string; branch: string | null; name: string } | null {
  let text = input.trim();
  let ref = branch?.trim() || null;
  if (!text || /\s/.test(text)) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(text) && !text.includes("..")) text = `https://github.com/${text}`;
  else if (/^[\w-]+(\.[\w-]+)+\/[^\s]+$/.test(text) && !/^[\w-]+:/.test(text)) text = `https://${text}`;
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@[\w.-]+(?::\d+)?[:/][^\s]+$/.test(text);
  if (!ssh && !/^https:\/\/[^\s/]+\/[^\s]+$/i.test(text)) return null;
  if (!ssh) {
    const url = new URL(text);
    // A page on GitHub, GitLab or Gitea/Forgejo showing a branch: …/owner/repo/tree/<branch> (or /-/tree/, /src/branch/).
    const page = /^(\/[^/]+\/[^/]+?)(?:\.git)?(?:\/-)?\/(?:tree|src\/branch)\/([^/]+)/.exec(url.pathname);
    if (page) {
      url.pathname = page[1]!;
      ref ??= decodeURIComponent(page[2]!);
    }
    url.search = "";
    url.hash = "";
    // Credentials in the link would end up in .git/config and the UI.
    url.username = "";
    url.password = "";
    text = url.toString();
  }
  text = text.replace(/\/+$/, "");
  if (ref !== null && !/^[\w./-]{1,200}$/.test(ref)) return null;
  const name = basename(text.replace(/\.git$/i, "").replace(/:/g, "/"));
  if (!name || name === "." || name === "..") return null;
  return { url: text, branch: ref, name };
}

/** How cloning or pulling is going. */
export interface GitProgress {
  readonly phase: string;
  /** 0–100 when git says. */
  readonly percent: number | null;
}

/** git's progress lines ("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s") as a phase and a percentage. */
export function parseGitProgress(line: string): GitProgress | null {
  const match = /^(?:remote: )?([A-Z][\w ]+?):\s+(\d{1,3})%(?:\s+\(\d+\/\d+\))?(?:,\s*(.+))?$/.exec(
    line.trim().replace(/,? done\.?$/, ""),
  );
  if (!match) return null;
  const detail = match[3]
    ?.split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" · ");
  return { phase: detail ? `${match[1]} (${detail})` : match[1]!, percent: Math.min(100, Number(match[2])) };
}

/** The line of git's output that says what went wrong, said plainly where it's a common case. */
export function cloneError(output: string) {
  const lines = output.split("\n").filter((l) => /^(fatal|error|ERROR|remote: )/.test(l));
  const text = (lines.at(-1) ?? output.split("\n").at(-1) ?? "").replace(/^(fatal|error): /, "").trim();
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(output)) {
    return `${text}. If it's private, sign in to Git on this computer first (for GitHub: gh auth login) or use an SSH link.`;
  }
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(output))
    return `${text}. Your SSH key isn't set up for this host (or needs a passphrase: add it to ssh-agent).`;
  if (/Remote branch .* not found/i.test(output)) return text;
  if (/not found|does not exist/i.test(text))
    return `${text}. Check the link (private repositories need you to be signed in to Git).`;
  return text;
}

/** Running git commands, by what started them (an app's import, a tab's source), so they can be cancelled. */
const running = new Map<string, () => void>();
export const cancelGit = (key: string) => {
  const cancel = running.get(key);
  cancel?.();
  return !!cancel;
};

export interface GitResult {
  code: number | null;
  /** The last lines of its output (stderr, and stdout with `output`). */
  err: string;
  out: string;
  cancelled: boolean;
}

/**
 * Runs git with your Git setup and without prompts or hooks. Progress lines
 * go to onProgress; `cancelKey` lets cancelGit stop it.
 */
export const runGit = (
  args: string[],
  options: {
    cwd?: string;
    noHooks: string;
    onProgress?: (p: GitProgress) => void;
    cancelKey?: string;
    timeoutMs?: number;
  },
) =>
  Effect.callback<GitResult>((resume) => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["git", "-c", `core.hooksPath=${options.noHooks}`, ...args], {
        cwd: options.cwd,
        env: {
          ...agentEnv(),
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
          LANG: "C",
          LC_ALL: "C",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
    } catch {
      resume(
        Effect.succeed({
          code: -1,
          err: "git isn't installed (or not on Rune Browser's PATH)",
          out: "",
          cancelled: false,
        }),
      );
      return;
    }
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      proc.kill();
    };
    if (options.cancelKey) running.set(options.cancelKey, stop);
    const timer = setTimeout(stop, options.timeoutMs ?? 15 * 60_000);
    const lines: string[] = [];
    let last = 0;
    const readErr = async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        // Progress lines end in \r while they update.
        const parts = buffer.split(/[\r\n]/);
        buffer = parts.pop() ?? "";
        for (const line of parts.filter((l) => l.trim())) {
          const progress = parseGitProgress(line);
          if (!progress) lines.push(line.trim());
          else if (options.onProgress && (Date.now() - last > 150 || progress.percent === 100)) {
            last = Date.now();
            options.onProgress(progress);
          }
        }
      }
      if (buffer.trim()) lines.push(buffer.trim());
    };
    void (async () => {
      const [, out, code] = await Promise.all([
        readErr(),
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      if (options.cancelKey && running.get(options.cancelKey) === stop) running.delete(options.cancelKey);
      resume(Effect.succeed({ code, err: lines.slice(-20).join("\n"), out, cancelled }));
    })();
    return Effect.sync(stop);
  });

/** A shallow clone (with submodules) of `url` into `target`. */
export const clone = (options: {
  url: string;
  branch: string | null;
  target: string;
  noHooks: string;
  onProgress?: (p: GitProgress) => void;
  cancelKey?: string;
}) =>
  runGit(
    [
      "clone",
      "--progress",
      "--depth",
      "1",
      "--recurse-submodules",
      "--shallow-submodules",
      ...(options.branch ? ["--branch", options.branch] : []),
      "--",
      options.url,
      options.target,
    ],
    options,
  );
